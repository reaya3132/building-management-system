"""Regression of test_transactions_api against the migrated PostgreSQL schema
(production schema + legal migration; see conftest.py). TEST_POSTGRES_URL only."""
from backend.tests.test_transactions_api import *  # noqa: F401,F403
