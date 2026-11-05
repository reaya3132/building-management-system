"""Regression of test_apartment_personal_area against the migrated PostgreSQL schema
(production schema + legal migration; see conftest.py). TEST_POSTGRES_URL only."""
from backend.tests.test_apartment_personal_area import *  # noqa: F401,F403
