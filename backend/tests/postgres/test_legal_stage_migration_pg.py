"""add_legal_stage_tenants_committee_approval.sql and its rollback on a real PostgreSQL:
the new stage is added (pending) to every existing proceeding, nothing else changes,
a re-run adds nothing, and the rollback never removes work done in the stage."""
from __future__ import annotations

import pytest

from backend.configurations.legal.stages import STAGE_KEYS
from backend.tests.postgres import pg_utils as pg
from backend.tests.postgres.pg_utils import MIGRATIONS
from backend.tests.postgres.test_legal_migration_pg import _add_user, _ok, _stops, dbs  # noqa: F401  (fixture)

pytestmark = pytest.mark.asyncio

KEY = "tenants_committee_approval"
ADD = MIGRATIONS / "add_legal_stage_tenants_committee_approval.sql"
UNDO = MIGRATIONS / "rollback_legal_stage_tenants_committee_approval.sql"
OLD_KEYS = [k for k in STAGE_KEYS if k != KEY]
OTHER_ROWS = (f"SELECT md5(string_agg(concat_ws('|', id, proceeding_id, stage_key, status, resolved_at, resolved_by), ',' "
              f"ORDER BY id)) FROM legal_proceeding_stages WHERE stage_key <> '{KEY}'")


async def _proceedings_before_the_stage(db, count: int = 3) -> list[int]:
    """Proceedings opened before the new stage existed: rows for the five earlier stages only."""
    user = await _add_user(db)
    await pg.execute(db, "INSERT INTO contacts (kind, name, phone, created_at) VALUES ('person', 'x', '1', now())")
    contact = await pg.query(db, "SELECT max(id) FROM contacts")
    for _ in range(count):
        await pg.execute(db, "INSERT INTO legal_proceedings (contact_id, party_role, title, status, opened_at, created_by, "
                             f"created_at) VALUES ({contact}, 'other', 't', 'open', now(), {user}, now())")
    ids = list(await pg.query(db, "SELECT array_agg(id ORDER BY id) FROM legal_proceedings"))
    for pid in ids:
        for key in OLD_KEYS:
            await pg.execute(db, f"INSERT INTO legal_proceeding_stages (proceeding_id, stage_key, status) VALUES ({pid}, '{key}', 'pending')")
    # one already-worked stage, which must stay exactly as it is
    await pg.execute(db, f"UPDATE legal_proceeding_stages SET status = 'completed', resolved_at = now(), resolved_by = {user} "
                         f"WHERE proceeding_id = {ids[0]} AND stage_key = 'collection_messages'")
    return ids


async def test_adds_the_stage_pending_to_every_proceeding_and_rerun_adds_nothing(dbs):
    db = await dbs("stage_add")
    await pg.migrate(db)
    ids = await _proceedings_before_the_stage(db)
    schema, others = await pg.schema_snapshot(db), await pg.query(db, OTHER_ROWS)

    run = await _ok(db, ADD)
    assert any("3 stage row(s) added" in n for n in run.notices)
    assert await pg.query(db, f"SELECT count(*) FROM legal_proceeding_stages WHERE stage_key = '{KEY}' AND status = 'pending' "
                              "AND resolved_at IS NULL AND resolved_by IS NULL") == len(ids)
    assert await pg.query(db, "SELECT count(DISTINCT stage_key) FROM legal_proceeding_stages") == len(STAGE_KEYS)
    assert await pg.query(db, OTHER_ROWS) == others              # no other row changed
    assert await pg.schema_snapshot(db) == schema                # data only

    run = await _ok(db, ADD)                                      # re-run
    assert any("0 stage row(s) added" in n for n in run.notices)
    assert await pg.query(db, f"SELECT count(*) FROM legal_proceeding_stages WHERE stage_key = '{KEY}'") == len(ids)


async def test_without_proceedings_it_adds_nothing(dbs):
    db = await dbs("stage_empty")
    await pg.migrate(db)
    run = await _ok(db, ADD)
    assert any("0 stage row(s) added" in n for n in run.notices)


async def test_rollback_removes_only_unused_rows_of_the_stage(dbs):
    db = await dbs("stage_undo")
    await pg.migrate(db)
    ids = await _proceedings_before_the_stage(db, count=2)
    others = await pg.query(db, OTHER_ROWS)
    await _ok(db, ADD)

    # work done in the stage stops the rollback, and nothing changes
    await pg.execute(db, f"INSERT INTO legal_proceeding_entries (proceeding_id, entry_type, stage_key, content, created_by_user_id, "
                         f"created_at) SELECT {ids[0]}, 'note', '{KEY}', 'נשלח', created_by, now() FROM legal_proceedings WHERE id = {ids[0]}")
    await _stops(db, UNDO, "tenants_committee_approval is in use")
    await pg.execute(db, "DELETE FROM legal_proceeding_entries")
    await pg.execute(db, "INSERT INTO documents (entity_type, entity_id, file_path, uploaded_at, source_table, source_id, context_key) "
                         f"VALUES ('legal_proceeding', {ids[0]}, 'k', now(), '', 0, '{KEY}.committee_approval')")
    await _stops(db, UNDO, "tenants_committee_approval is in use")
    await pg.execute(db, "DELETE FROM documents WHERE entity_type = 'legal_proceeding'")
    assert await pg.query(db, f"SELECT count(*) FROM legal_proceeding_stages WHERE stage_key = '{KEY}'") == len(ids)

    run = await _ok(db, UNDO)
    assert any("2 stage row(s) removed" in n for n in run.notices)
    assert await pg.query(db, f"SELECT count(*) FROM legal_proceeding_stages WHERE stage_key = '{KEY}'") == 0
    assert await pg.query(db, OTHER_ROWS) == others
