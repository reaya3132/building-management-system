"""
Custom logging handler that forwards ERROR / CRITICAL log records
to WhatsApp via CallMeBot + Claude AI analysis.

The handler fires in a background daemon thread so that logging
never blocks the FastAPI / asyncio event loop.
"""
from __future__ import annotations

import logging
import threading
import traceback


class WhatsAppAlertHandler(logging.Handler):
    """
    Logging handler that sends WhatsApp alerts for ERROR+ records.

    Attach to the root logger once at startup (see setup_whatsapp_log_handler).
    """

    # Module names whose log records should NOT trigger alerts
    # (to avoid infinite recursion or noisy low-value alerts)
    _SKIP_LOGGERS = frozenset(
        {
            "backend.services.error_notifier",
            "urllib3",
            "urllib3.connectionpool",
            "httpx",
            "httpcore",
            "requests",
        }
    )

    def __init__(self, level: int = logging.WARNING) -> None:
        super().__init__(level)

    def emit(self, record: logging.LogRecord) -> None:
        if record.name in self._SKIP_LOGGERS:
            return

        try:
            error_message = self.format(record)
            tb_str = ""
            if record.exc_info:
                tb_str = "".join(traceback.format_exception(*record.exc_info))

            # Path is available when the record comes from a request handler
            path = getattr(record, "path", "")
            error_type = record.name

            threading.Thread(
                target=self._fire,
                args=(error_message, tb_str, path, error_type, record.levelname),
                daemon=True,
            ).start()
        except Exception:  # noqa: BLE001
            self.handleError(record)

    @staticmethod
    def _fire(
        error_message: str,
        traceback_str: str,
        path: str,
        error_type: str,
        level: str = "ERROR",
    ) -> None:
        from backend.services.error_notifier import send_whatsapp_alert

        send_whatsapp_alert(
            error_message=error_message,
            traceback_str=traceback_str,
            path=path,
            error_type=error_type,
            level=level,
        )


def setup_whatsapp_log_handler() -> None:
    """
    Attach WhatsAppAlertHandler to the root logger.

    Safe to call multiple times (idempotent – adds handler only once).
    Call this once during application startup.
    """
    from backend.core.config import settings

    if not settings.external_alerts_enabled:
        logging.getLogger(__name__).info(
            "WhatsApp error alerts are disabled (ERROR_ALERTS_ENABLED=false or ENVIRONMENT=test)."
        )
        return

    root_logger = logging.getLogger()

    # Idempotency guard
    for existing in root_logger.handlers:
        if isinstance(existing, WhatsAppAlertHandler):
            return

    handler = WhatsAppAlertHandler(level=logging.WARNING)
    handler.setFormatter(
        logging.Formatter("%(levelname)s [%(name)s:%(lineno)d] %(message)s")
    )
    root_logger.addHandler(handler)
    logging.getLogger(__name__).info("WhatsApp error alert handler registered.")


def setup_console_log_handler() -> None:
    """
    Attach a StreamHandler to the root logger so full tracebacks always
    appear in Docker / uvicorn stdout regardless of uvicorn's log config.
    Safe to call multiple times (idempotent).
    """
    import sys
    root_logger = logging.getLogger()

    # Idempotency: skip if a StreamHandler already points to stdout
    for existing in root_logger.handlers:
        if isinstance(existing, logging.StreamHandler) and getattr(existing, 'stream', None) is sys.stdout:
            return

    handler = logging.StreamHandler(sys.stdout)
    handler.setLevel(logging.WARNING)
    handler.setFormatter(
        logging.Formatter(
            "%(asctime)s %(levelname)s [%(name)s:%(lineno)d] %(message)s"
        )
    )
    root_logger.addHandler(handler)
