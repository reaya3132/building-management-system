"""PostgreSQL-only tests. Skipped (not failed) unless TEST_POSTGRES_URL is set.

Run:
    TEST_POSTGRES_URL=postgresql://postgres:x@localhost:55432/postgres \
        python -m pytest backend/tests/postgres -q

A disposable server is enough, e.g.
    docker run -d --name legalpg -e POSTGRES_PASSWORD=x -p 55432:5432 postgres:16

Every fixture of backend/tests/conftest.py stays available; only ``test_engine`` is
replaced: instead of SQLite + create_all, each test gets its own database built the
PRODUCTION way — today's schema, then the legal migration SQL files applied on top.
The built schema is kept as a template database, so each test only clones it.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from backend.tests.postgres import pg_utils

_HERE = Path(__file__).resolve().parent
_TEMPLATE = pg_utils.DB_PREFIX + "template"


def pytest_collection_modifyitems(config, items):
    if pg_utils.DSN:
        return
    skip = pytest.mark.skip(reason=f"{pg_utils.DSN_ENV} is not set (PostgreSQL-only test)")
    for item in items:
        if _HERE in Path(str(item.fspath)).resolve().parents:
            item.add_marker(skip)


@pytest.fixture(scope="session")
def migrated_template() -> str:
    """Production-like schema + legal migration, built once per session."""
    async def build():
        await pg_utils.production_like(_TEMPLATE, seed_documents=False)
        await pg_utils.migrate(_TEMPLATE)
        await pg_utils.upgrade(_TEMPLATE)
    asyncio.run(build())
    yield _TEMPLATE
    asyncio.run(pg_utils.drop_db(_TEMPLATE))


@pytest_asyncio.fixture
async def test_engine(migrated_template, request):
    db = await pg_utils.create_db(pg_utils.DB_PREFIX + "t_" + str(abs(hash(request.node.nodeid)) % 10**8),
                                  template=migrated_template)
    engine = create_async_engine(pg_utils.sqlalchemy_url(db), poolclass=NullPool)
    yield engine
    await engine.dispose()
    await pg_utils.drop_db(db)
