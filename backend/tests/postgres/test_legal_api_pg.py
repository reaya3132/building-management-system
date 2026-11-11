"""Legal HTTP API (test_legal_api) against the migrated PostgreSQL schema
(row locks, NUMERIC amounts, explicit commits). TEST_POSTGRES_URL only."""
from backend.tests.test_legal_api import *  # noqa: F401,F403
