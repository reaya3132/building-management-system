"""Regression of test_notification_center_api against the migrated PostgreSQL schema
(row-value keyset comparison, the partial unread index). TEST_POSTGRES_URL only."""
from backend.tests.test_notification_center_api import *  # noqa: F401,F403
