"""PostgreSQL integration tests for collection (גבייה) amounts.

The regular suite runs on SQLite, which ignores ``SELECT ... FOR UPDATE`` and
cannot run the PostgreSQL migration files. These tests cover what only a real
PostgreSQL can show:

- the migration / rollback files (migrate → rollback → migrate, no data loss);
- concurrent reductions and initial-amount edits on a ``single`` task: each
  request alone is valid, together they would make the total negative —
  exactly one must succeed (the details-row lock serializes them).

They are skipped unless ``TEST_POSTGRES_URL`` is set, e.g.::

    TEST_POSTGRES_URL=postgresql+asyncpg://postgres:postgres@localhost:5432/postgres \\
        pytest tests/test_collection_postgres_integration.py -m integration

Safety: the URL is used only to CREATE a new, uniquely named database; every
test runs there and the database is dropped at the end. Existing databases
and their data are never touched.
"""
from __future__ import annotations

import asyncio
import os
import time
import uuid
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest
import pytest_asyncio
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine

from backend.db.base import Base
from backend.models.project import Project
from backend.models.user import User, UserRole
from backend.repositories.collection_task_repository import CollectionTaskRepository
from backend.schemas.collection_task import (
    AdjustmentCreate,
    CollectionTaskCreate,
    InitialAmountUpdate,
    LedgerItemCreate,
    LedgerItemUpdate,
)
from backend.services.collection_task_service import CollectionTaskService

PG_URL = os.getenv("TEST_POSTGRES_URL")
MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations"
MIGRATE = MIGRATIONS / "collection_adjustments_allow_reductions.sql"
ROLLBACK = MIGRATIONS / "rollback_collection_adjustments_allow_reductions.sql"
RACE_ROUNDS = 20

pytestmark = [
    pytest.mark.integration,
    pytest.mark.asyncio,
    pytest.mark.skipif(not PG_URL, reason="TEST_POSTGRES_URL is not set (PostgreSQL integration tests)"),
]


# ── a throwaway database ─────────────────────────────────────────────────────

@pytest_asyncio.fixture
async def pg_engine() -> AsyncEngine:
    """A new database with the app schema, dropped after the test."""
    import backend.main  # noqa: F401  (registers every model on the metadata)

    server = make_url(PG_URL)
    name = f"collection_it_{uuid.uuid4().hex[:12]}"
    admin = create_async_engine(server, isolation_level="AUTOCOMMIT")
    async with admin.connect() as conn:
        await conn.execute(text(f'CREATE DATABASE "{name}"'))
    engine = create_async_engine(server.set(database=name), pool_size=10)
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        yield engine
    finally:
        await engine.dispose()
        async with admin.connect() as conn:
            await conn.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        await admin.dispose()


class Env:
    """Seeded admin + project, and helpers that run one request-like unit of work each."""

    def __init__(self, engine: AsyncEngine, admin_id: int, project_id: int):
        self.engine = engine
        self.Session = async_sessionmaker(engine, expire_on_commit=False)
        self.admin_id = admin_id
        self.project_id = project_id

    async def create(self, collection_type: str = "single", initial: str | None = "100.00", items=()) -> int:
        async with self.Session() as s:
            admin = await s.get(User, self.admin_id)
            task_id = await CollectionTaskService(s, admin).create(CollectionTaskCreate(
                title="pg", collection_type=collection_type, project_id=self.project_id,
                billing_month=date(2026, 11, 1), assignee_ids=[self.admin_id],
                initial_amount=Decimal(initial) if initial else None, items=list(items),
            ), [admin])
            await s.commit()
            return task_id

    async def attempt(self, action, hold: float = 0.0) -> str:
        """Run ``action(service)`` in its own transaction; "ok" or the error code."""
        async with self.Session() as s:
            try:
                await action(CollectionTaskService(s, await s.get(User, self.admin_id)))
                if hold:
                    await asyncio.sleep(hold)  # keep the transaction (and its lock) open
                await s.commit()
                return "ok"
            except HTTPException as exc:
                await s.rollback()
                return exc.detail.get("code") if isinstance(exc.detail, dict) else str(exc.detail)

    async def total(self, task_id: int) -> Decimal:
        async with self.Session() as s:
            return await CollectionTaskRepository(s).total_for(task_id)


def reduce(task_id: int, amount: str):
    return lambda svc: svc.add_adjustment(task_id, AdjustmentCreate(amount=Decimal(amount), note="הפחתה"))


def set_initial(task_id: int, amount: str):
    return lambda svc: svc.update_initial_amount(task_id, InitialAmountUpdate(initial_amount=Decimal(amount)))


@pytest_asyncio.fixture
async def env(pg_engine: AsyncEngine) -> Env:
    async with async_sessionmaker(pg_engine, expire_on_commit=False)() as s:
        admin = User(email="pg-admin@test.com", password_hash="x", full_name="PG Admin",
                     role=UserRole.ADMIN.value, is_active=True, email_verified=True)
        project = Project(name="PG Project", is_active=True)
        s.add_all([admin, project])
        await s.commit()
        return Env(pg_engine, admin.id, project.id)


# ── migration / rollback ─────────────────────────────────────────────────────

async def _check_constraints(engine: AsyncEngine) -> dict[str, str]:
    async with engine.connect() as conn:
        rows = await conn.execute(text(
            "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint "
            "WHERE conrelid = 'collection_amount_adjustments'::regclass AND contype = 'c'"))
        return dict(rows.all())


async def _adjustments_fingerprint(engine: AsyncEngine) -> tuple:
    async with engine.connect() as conn:
        rows = await conn.execute(text("SELECT id, task_id, amount, note FROM collection_amount_adjustments ORDER BY id"))
        return tuple(rows.all())


async def _run_sql_file(engine: AsyncEngine, path: Path) -> None:
    """Run a migration file as psql would (its own BEGIN/COMMIT); raises on error."""
    async with engine.connect() as conn:
        raw = (await conn.get_raw_connection()).driver_connection
        try:
            await raw.execute(path.read_text(encoding="utf-8"))
        except Exception:
            await raw.execute("ROLLBACK")
            raise


async def test_migration_rollback_migration_keeps_data(env: Env):
    engine = env.engine
    # Put the database in today's state (before this change): amount > 0.
    async with engine.begin() as conn:
        await conn.execute(text("ALTER TABLE collection_amount_adjustments DROP CONSTRAINT ck_caa_amount_nonzero"))
        await conn.execute(text("ALTER TABLE collection_amount_adjustments "
                                "ADD CONSTRAINT ck_caa_amount_positive CHECK (amount > 0)"))
    task_id = await env.create(initial="1000.00")
    for amount in ("10.00", "0.50"):
        assert await env.attempt(lambda svc, a=amount: svc.add_adjustment(
            task_id, AdjustmentCreate(amount=Decimal(a), note="תוספת"))) == "ok"
    original = await _adjustments_fingerprint(engine)

    await _run_sql_file(engine, MIGRATE)
    await _run_sql_file(engine, MIGRATE)  # idempotent
    assert await _check_constraints(engine) == {"ck_caa_amount_nonzero": "CHECK ((amount <> (0)::numeric))"}
    assert await _adjustments_fingerprint(engine) == original
    assert await env.attempt(reduce(task_id, "-5.00")) == "ok"

    # A reduction exists: the rollback must refuse and change nothing.
    with_reduction = await _adjustments_fingerprint(engine)
    with pytest.raises(Exception, match="rollback aborted"):
        await _run_sql_file(engine, ROLLBACK)
    assert list(await _check_constraints(engine)) == ["ck_caa_amount_nonzero"]
    assert await _adjustments_fingerprint(engine) == with_reduction

    async with engine.begin() as conn:
        await conn.execute(text("DELETE FROM collection_amount_adjustments WHERE amount < 0"))
    await _run_sql_file(engine, ROLLBACK)
    await _run_sql_file(engine, ROLLBACK)  # idempotent
    assert await _check_constraints(engine) == {"ck_caa_amount_positive": "CHECK ((amount > (0)::numeric))"}
    assert await _adjustments_fingerprint(engine) == original

    await _run_sql_file(engine, MIGRATE)
    assert list(await _check_constraints(engine)) == ["ck_caa_amount_nonzero"]
    assert await _adjustments_fingerprint(engine) == original


# ── concurrency ──────────────────────────────────────────────────────────────

async def test_overlapping_reductions_second_waits_and_is_rejected(env: Env):
    task_id = await env.create(initial="1000.00")
    first = asyncio.create_task(env.attempt(reduce(task_id, "-600.00"), hold=1.5))
    await asyncio.sleep(0.3)  # let the first request take the lock
    started = time.monotonic()
    second = await env.attempt(reduce(task_id, "-600.00"))
    waited = time.monotonic() - started
    assert (await first, second) == ("ok", "total_negative")
    assert waited >= 1.0, f"the second request did not wait for the lock ({waited:.2f}s)"
    assert await env.total(task_id) == Decimal("400.00")


async def test_racing_reductions_exactly_one_succeeds(env: Env):
    for _ in range(RACE_ROUNDS):
        task_id = await env.create(initial="100.00")
        results = await asyncio.gather(env.attempt(reduce(task_id, "-60.00")), env.attempt(reduce(task_id, "-60.00")))
        assert sorted(results) == ["ok", "total_negative"]
        assert await env.total(task_id) == Decimal("40.00")


async def test_racing_initial_amount_edit_and_reduction_exactly_one_succeeds(env: Env):
    for _ in range(RACE_ROUNDS):
        task_id = await env.create(initial="1000.00")
        results = await asyncio.gather(
            env.attempt(set_initial(task_id, "500.00")), env.attempt(reduce(task_id, "-600.00")))
        assert sorted(results) == ["ok", "total_negative"]
        assert await env.total(task_id) >= 0


async def test_racing_reductions_to_exactly_zero_both_succeed(env: Env):
    task_id = await env.create(initial="100.00")
    results = await asyncio.gather(env.attempt(reduce(task_id, "-50.00")), env.attempt(reduce(task_id, "-50.00")))
    assert results == ["ok", "ok"]
    assert await env.total(task_id) == Decimal("0.00")


async def test_ledger_actions_under_the_lock(env: Env):
    task_id = await env.create("ledger", initial=None, items=[{"subject": "ועד", "amount": "10.00"}])
    async with env.Session() as s:
        svc = CollectionTaskService(s, await s.get(User, env.admin_id))
        item = await svc.add_ledger_item(task_id, LedgerItemCreate(subject="מים", amount=Decimal("5.00")))
        await svc.update_ledger_item(task_id, item.id, LedgerItemUpdate(amount=Decimal("7.00")))
        await svc.archive_ledger_item(task_id, item.id)
        await s.commit()
    assert await env.total(task_id) == Decimal("10.00")
    assert await env.attempt(reduce(task_id, "-1.00")) == "wrong_collection_type"
