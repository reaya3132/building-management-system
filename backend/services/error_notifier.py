"""
Error notification service.

Sends WhatsApp alerts via Green API when errors occur,
with AI-powered analysis using Claude (Anthropic).
"""
from __future__ import annotations

import logging
import time
from datetime import datetime

import requests

logger = logging.getLogger(__name__)

# Rate limiting: track last alert time per error fingerprint
_last_alert_time: dict[str, float] = {}
_COOLDOWN_SECONDS = 60  # At least 60s between identical error alerts


def _is_rate_limited(error_key: str) -> bool:
    """Return True if this error fingerprint was alerted too recently."""
    now = time.time()
    last = _last_alert_time.get(error_key, 0.0)
    if now - last < _COOLDOWN_SECONDS:
        return True
    _last_alert_time[error_key] = now
    return False


def analyze_error_with_claude(error_message: str, traceback_str: str) -> str:
    """
    Analyze error using Claude API (synchronous).
    Returns a short Hebrew explanation of the error.
    """
    try:
        from backend.core.config import settings

        if not settings.ANTHROPIC_API_KEY:
            return "לא הוגדר ANTHROPIC_API_KEY – לא ניתן לנתח את השגיאה."

        import anthropic

        client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)

        prompt = (
            "אתה מומחה DevOps ופיתוח תוכנה. נתקלנו בשגיאה במערכת ניהול פרויקטים BMS.\n"
            "נתח את השגיאה הבאה ותן הסבר קצר בעברית (עד 4 משפטים):\n"
            "1. מה הבעיה\n"
            "2. מה הסיבה הכי סבירה\n"
            "3. מה לבדוק / לתקן\n\n"
            f"שגיאה:\n{error_message}\n\n"
            f"Traceback:\n{traceback_str[:3000] if traceback_str else 'לא זמין'}"
        )

        message = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=400,
            messages=[{"role": "user", "content": prompt}],
        )
        return message.content[0].text

    except Exception as exc:
        logger.warning("Claude AI analysis failed: %s", exc)
        return "לא ניתן לנתח את השגיאה כרגע."


def send_whatsapp_alert(
    error_message: str,
    traceback_str: str = "",
    path: str = "",
    error_type: str = "generic",
    level: str = "ERROR",
) -> None:
    """
    Send a WhatsApp alert via Green API including AI error analysis.

    Runs synchronously – call from a background thread to avoid blocking
    the main event loop.
    """
    from backend.core.config import settings

    if not settings.external_alerts_enabled:
        return

    if not settings.GREEN_API_INSTANCE_ID or not settings.GREEN_API_TOKEN or not settings.ALERT_PHONE:
        logger.warning(
            "ERROR_ALERTS_ENABLED=true but GREEN_API_INSTANCE_ID / GREEN_API_TOKEN / ALERT_PHONE are not set."
        )
        return

    # Rate limiting per error fingerprint
    error_key = f"{error_type}:{error_message[:60]}"
    if _is_rate_limited(error_key):
        return

    # Build the WhatsApp message
    now = datetime.now().strftime("%d/%m/%Y %H:%M:%S")
    traceback_display = traceback_str[:3000] if traceback_str else "לא זמין"
    severity_icon = "⚠️" if level.upper() == "WARNING" else "🚨"
    severity_label = level.upper()
    text = (
        f"{severity_icon} [{severity_label}] שגיאה במערכת BMS\n\n"
        f"📍 נתיב: {path or 'לא ידוע'}\n"
        f"⚡ מודול: {error_type}\n"
        f"❌ שגיאה: {error_message[:500]}\n\n"
        f"📋 Traceback:\n{traceback_display}\n\n"
        f"⏰ {now}"
    )

    try:
        # Green API: chatId format is {phone}@c.us
        chat_id = f"{settings.ALERT_PHONE}@c.us"
        url = (
            f"https://api.green-api.com"
            f"/waInstance{settings.GREEN_API_INSTANCE_ID}"
            f"/sendMessage/{settings.GREEN_API_TOKEN}"
        )
        payload = {"chatId": chat_id, "message": text}
        response = requests.post(url, json=payload, timeout=15)

        if response.status_code == 200:
            logger.info("WhatsApp error alert sent (error_type=%s)", error_type)
        else:
            logger.warning(
                "Green API returned status %s: %s",
                response.status_code,
                response.text[:200],
            )
    except Exception as exc:
        logger.warning("Failed to send WhatsApp alert: %s", exc)
