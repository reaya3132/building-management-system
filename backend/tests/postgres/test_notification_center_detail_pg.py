"""Regression of test_notification_center_detail against the migrated PostgreSQL
schema (real ON DELETE SET NULL). TEST_POSTGRES_URL only."""
from backend.tests.test_notification_center_detail import *  # noqa: F401,F403
