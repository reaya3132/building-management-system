"""Regression of test_task_archived_notifications against the migrated PostgreSQL
schema (real FK SET NULL, real concurrent transactions). TEST_POSTGRES_URL only."""
from backend.tests.test_task_archived_notifications import *  # noqa: F401,F403
