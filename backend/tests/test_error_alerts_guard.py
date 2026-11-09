"""External error alerts: never under ENVIRONMENT=test, unchanged everywhere else."""
from __future__ import annotations

import logging

import pytest

from backend.core import log_alert_handler
from backend.core.config import settings
from backend.services import error_notifier


class FakeRequests:
    def __init__(self):
        self.calls = []

    def post(self, url, json=None, timeout=None):
        self.calls.append(url)
        return type("R", (), {"status_code": 200, "text": ""})()


@pytest.fixture
def fake_requests(monkeypatch):
    fake = FakeRequests()
    monkeypatch.setattr(error_notifier, "requests", fake)
    monkeypatch.setattr(settings, "ERROR_ALERTS_ENABLED", True)
    monkeypatch.setattr(settings, "GREEN_API_INSTANCE_ID", "instance")
    monkeypatch.setattr(settings, "GREEN_API_TOKEN", "token")
    monkeypatch.setattr(settings, "ALERT_PHONE", "972500000000")
    error_notifier._last_alert_time.clear()
    return fake


@pytest.fixture
def clean_root():
    root = logging.getLogger()
    before = list(root.handlers)
    yield root
    root.handlers[:] = before


def _handlers(root):
    return [h for h in root.handlers if isinstance(h, log_alert_handler.WhatsAppAlertHandler)]


def test_test_environment_sends_nothing(fake_requests, monkeypatch, clean_root):
    monkeypatch.setenv("ENVIRONMENT", "test")
    error_notifier.send_whatsapp_alert("boom")
    log_alert_handler.setup_whatsapp_log_handler()
    assert fake_requests.calls == [] and _handlers(clean_root) == []


@pytest.mark.parametrize("environment", ["production", "development"])
def test_other_environments_keep_alerting(fake_requests, monkeypatch, clean_root, environment):
    monkeypatch.setenv("ENVIRONMENT", environment)
    error_notifier.send_whatsapp_alert("boom")
    log_alert_handler.setup_whatsapp_log_handler()
    assert len(fake_requests.calls) == 1 and len(_handlers(clean_root)) == 1


def test_flag_off_still_disables_alerts(fake_requests, monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setattr(settings, "ERROR_ALERTS_ENABLED", False)
    error_notifier.send_whatsapp_alert("boom")
    assert fake_requests.calls == []


def test_alert_never_calls_the_ai_analysis(fake_requests, monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")

    def forbidden(*a, **k):
        raise AssertionError("AI analysis must not run")

    monkeypatch.setattr(error_notifier, "analyze_error_with_claude", forbidden)
    error_notifier.send_whatsapp_alert("boom")
    assert len(fake_requests.calls) == 1
