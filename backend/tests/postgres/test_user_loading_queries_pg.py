"""Regression of test_user_loading_queries against the migrated PostgreSQL schema
(production schema + legal migration; see conftest.py). TEST_POSTGRES_URL only."""
from backend.tests.test_user_loading_queries import *  # noqa: F401,F403
