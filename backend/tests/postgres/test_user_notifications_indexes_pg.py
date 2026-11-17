"""add_user_notifications_indexes_concurrently.sql and its rollback on a real PostgreSQL:
both indexes are built valid and exactly as the model defines them, a re-run changes
nothing, the rollback drops only these two, no data or other index changes, and an
interrupted (INVALID) build stops the file. TEST_POSTGRES_URL only."""
from __future__ import annotations

import pytest

from backend.tests.postgres import pg_utils as pg
from backend.tests.postgres.pg_utils import MIGRATIONS
from backend.tests.postgres.test_legal_migration_pg import _ok, _stops, dbs  # noqa: F401  (fixture)

pytestmark = pytest.mark.asyncio

ADD = MIGRATIONS / "add_user_notifications_indexes_concurrently.sql"
UNDO = MIGRATIONS / "rollback_user_notifications_indexes.sql"
NEW = ("ix_user_notifications_user_created", "ix_user_notifications_user_unread")
EXPECTED = {
    "ix_user_notifications_user_created":
        "CREATE INDEX ix_user_notifications_user_created ON public.user_notifications "
        "USING btree (user_id, created_at DESC, id DESC)",
    "ix_user_notifications_user_unread":
        "CREATE INDEX ix_user_notifications_user_unread ON public.user_notifications "
        "USING btree (user_id, created_at DESC, id DESC) WHERE (read_at IS NULL)",
}
INDEXES = ("SELECT indexname || ' ' || indexdef FROM pg_indexes WHERE tablename = 'user_notifications' "
           "ORDER BY indexname")
ROWS = ("SELECT count(*) || ':' || md5(string_agg(concat_ws('|', id, user_id, from_user_id, task_id, type, title, "
        "body, read_at, created_at), ',' ORDER BY id)) FROM user_notifications")


async def _rows(db, sql):
    conn = await pg.connect(db)
    try:
        return [r[0] for r in await conn.fetch(sql)]
    finally:
        await conn.close()


async def _existing(db):
    """A database as it is today: the table with data, without the two new indexes
    (the test schema comes from the models, which already define them)."""
    await pg.execute(db, "DROP INDEX ix_user_notifications_user_created; DROP INDEX ix_user_notifications_user_unread")
    await pg.execute(db, "INSERT INTO users (email, full_name, password_hash, role, is_active, created_at, "
                         "requires_password_change, email_verified) "
                         "SELECT 'n' || g || '@x.io', 'u' || g, 'x', 'Member', true, now(), false, true FROM generate_series(1, 5) g")
    await pg.execute(db, "INSERT INTO user_notifications (user_id, type, title, body, read_at, created_at) "
                         "SELECT (SELECT min(id) FROM users) + g % 5, 'task_message', 't' || g, 'b' || g, "
                         "CASE WHEN g % 3 = 0 THEN now() END, now() - g * interval '1 minute' "
                         "FROM generate_series(1, 300) g")


async def test_builds_both_indexes_as_defined_and_rerun_changes_nothing(dbs):
    db = await dbs("un_ix_add")
    await _existing(db)
    rows, before = await pg.query(db, ROWS), await _rows(db, INDEXES)

    run = await _ok(db, ADD)
    assert any("both notification-center indexes are valid" in n for n in run.notices)
    after = await _rows(db, INDEXES)
    for name, definition in EXPECTED.items():
        assert await pg.query(db, f"SELECT indisvalid FROM pg_index WHERE indexrelid = 'public.{name}'::regclass") is True
        assert await pg.query(db, f"SELECT pg_get_indexdef('public.{name}'::regclass)") == definition
    assert set(after) - set(before) == {f"{n} {d}" for n, d in EXPECTED.items()}   # only the two new ones
    assert set(before) <= set(after)                                                 # nothing removed
    assert await pg.query(db, ROWS) == rows                                           # data unchanged

    snapshot = await pg.schema_snapshot(db)
    await _ok(db, ADD)                                                                # re-run
    assert await pg.schema_snapshot(db) == snapshot
    assert await pg.query(db, ROWS) == rows


async def test_rollback_drops_only_the_two_indexes_and_can_rerun(dbs):
    db = await dbs("un_ix_undo")
    await _existing(db)
    before, rows = await _rows(db, INDEXES), await pg.query(db, ROWS)
    await _ok(db, ADD)

    run = await _ok(db, UNDO)
    assert any("indexes removed" in n for n in run.notices)
    assert await _rows(db, INDEXES) == before                                         # back to exactly before
    assert await pg.query(db, ROWS) == rows
    await _ok(db, UNDO)                                                               # re-run: nothing to drop
    await _ok(db, ADD)                                                                # and it can be applied again
    for name in NEW:
        assert await pg.query(db, f"SELECT to_regclass('public.{name}') IS NOT NULL") is True


async def test_migration_matches_the_model(dbs):
    """A database created by the models (create_all) gets the same two indexes."""
    db = await dbs("un_ix_model")
    for name, definition in EXPECTED.items():
        assert await pg.query(db, f"SELECT pg_get_indexdef('public.{name}'::regclass)") == definition
    await _ok(db, ADD)                                                                # nothing to do


async def test_an_invalid_index_stops_the_file(dbs):
    db = await dbs("un_ix_invalid")
    await _existing(db)
    await _ok(db, ADD)
    await pg.execute(db, "UPDATE pg_index SET indisvalid = false "
                         "WHERE indexrelid = 'public.ix_user_notifications_user_unread'::regclass")
    await _stops(db, ADD, "is INVALID")


async def test_an_index_with_another_definition_stops_the_file(dbs):
    db = await dbs("un_ix_other")
    await _existing(db)
    await pg.execute(db, "CREATE INDEX ix_user_notifications_user_created ON user_notifications (user_id)")
    before = await pg.schema_snapshot(db)
    await _stops(db, ADD, "unexpected definition")
    assert await pg.schema_snapshot(db) == before
