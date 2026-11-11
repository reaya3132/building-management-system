"""upgrade_ledger_items_and_legal_fields.sql and its rollback on a real PostgreSQL."""
from __future__ import annotations

import pytest

from backend.tests.postgres import pg_utils as pg
from backend.tests.postgres.pg_utils import COLLECTION_MIGRATION, CONTACTS_MIGRATION, MIGRATION, ROLLBACK, UPGRADE, UPGRADE_ROLLBACK
from backend.tests.postgres.test_legal_migration_pg import _ok, _stops, dbs  # noqa: F401  (fixture)

pytestmark = pytest.mark.asyncio

ROWS = ("SELECT count(*) || ':' || md5(string_agg(concat_ws('|', id, task_id, subject, amount, sort_order, created_by_user_id, "
        "updated_by_user_id, created_at, updated_at, archived_at, archived_by_user_id), ',' ORDER BY id)) FROM {table}")


async def _previous_state(db):
    """The schema before the upgrade: legal_proceedings with the old columns."""
    await pg.migrate(db)
    await pg.to_previous_legal_fields(db)


async def _seed_collection_items(db, table="collection_ledger_items"):
    """Rows of an existing collection ledger (FKs off for the seed only)."""
    await pg.execute(db, "SET session_replication_role = replica; "
                         f"INSERT INTO {table} (task_id, subject, amount, sort_order, created_by_user_id, created_at, updated_at) "
                         "SELECT g, 'item ' || g, g * 1.5, g, 1, now(), now() FROM generate_series(1, 50) g; "
                         f"UPDATE {table} SET archived_at = now(), archived_by_user_id = 1 WHERE id % 10 = 0;")


async def test_upgrade_keeps_every_collection_row_and_rerun_is_a_noop(dbs):
    db = await dbs("up_rows")
    await _previous_state(db)
    await _seed_collection_items(db)
    before = await pg.query(db, ROWS.format(table="collection_ledger_items"))
    await _ok(db, UPGRADE)
    assert await pg.query(db, "SELECT to_regclass('public.collection_ledger_items')") is None
    assert await pg.query(db, ROWS.format(table="ledger_items")) == before
    assert await pg.query(db, "SELECT count(*) FROM ledger_items WHERE item_type IS NOT NULL OR legal_proceeding_id IS NOT NULL") == 0
    assert await pg.query(db, "SELECT count(*) FROM information_schema.columns WHERE table_name = 'legal_proceedings' "
                              "AND column_name IN ('apartment_number', 'claim_amount')") == 0
    assert await pg.query(db, "SELECT count(*) FROM information_schema.columns WHERE table_name = 'contacts' AND column_name = 'apartment_number'") == 1
    snapshot = await pg.schema_snapshot(db)
    await _ok(db, UPGRADE)
    assert await pg.schema_snapshot(db) == snapshot
    assert await pg.query(db, ROWS.format(table="ledger_items")) == before


async def test_upgraded_table_matches_the_model(dbs):
    upgraded = await dbs("up_model")
    await _previous_state(upgraded)
    await _ok(upgraded, UPGRADE)
    modelled = await dbs("up_fresh", "none")
    await pg.create_db(modelled)
    await pg.create_all(modelled, include_legal=True, ledger=True)
    query = """SELECT string_agg(item, E'\\n' ORDER BY item) FROM (
        SELECT a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || a.attnotnull::text AS item FROM pg_attribute a
         WHERE a.attrelid = 'public.ledger_items'::regclass AND a.attnum > 0 AND NOT a.attisdropped
        UNION ALL SELECT conname || pg_get_constraintdef(oid) FROM pg_constraint
         WHERE conrelid = 'public.ledger_items'::regclass AND contype = 'c'
        UNION ALL SELECT pg_get_constraintdef(oid) FROM pg_constraint
         WHERE conrelid = 'public.ledger_items'::regclass AND contype = 'f'
        UNION ALL SELECT indexname || substr(indexdef, position(' USING ' IN indexdef)) FROM pg_indexes
         WHERE tablename = 'ledger_items' AND indexname NOT LIKE '%pkey') s"""
    assert await pg.query(upgraded, query) == await pg.query(modelled, query)
    await _ok(modelled, UPGRADE)                                  # create_all already built it: nothing to do


async def test_upgrade_stops_when_both_tables_exist(dbs):
    db = await dbs("up_both")
    await _previous_state(db)
    await pg.execute(db, "CREATE TABLE ledger_items (id int)")
    before = await pg.schema_snapshot(db)
    await _stops(db, UPGRADE, "Both collection_ledger_items and ledger_items")
    assert await pg.schema_snapshot(db) == before


async def test_new_code_before_the_upgrade_fails_without_creating_a_table(dbs):
    db = await dbs("up_new_first")
    await _previous_state(db)
    with pytest.raises(Exception, match="already exists"):
        await pg.create_all(db, include_legal=True, ledger=True)
    assert await pg.query(db, "SELECT to_regclass('public.ledger_items')") is None


async def test_old_code_after_the_upgrade_fails_without_creating_a_table(dbs):
    db = await dbs("up_old_after")
    await _previous_state(db)
    await _ok(db, UPGRADE)
    with pytest.raises(Exception, match="already exists"):
        await pg.execute(db, pg._COLLECTION_LEDGER_DDL)
    assert await pg.query(db, "SELECT to_regclass('public.collection_ledger_items')") is None


async def test_upgrade_stops_on_incomplete_new_table(dbs):
    db = await dbs("up_partial")
    await _previous_state(db)
    await pg.execute(db, "ALTER TABLE collection_ledger_items RENAME TO ledger_items")
    await _stops(db, UPGRADE, "without the expected constraints")


async def test_upgrade_stops_when_proceedings_exist(dbs):
    db = await dbs("up_data")
    await _previous_state(db)
    await pg.execute(db, "SET session_replication_role = replica; "
                         "INSERT INTO legal_proceedings (contact_id, party_role, apartment_number, title, status, opened_at, created_by, created_at) "
                         "VALUES (1, 'other', '4', 't', 'open', now(), 1, now())")
    before = await pg.schema_snapshot(db)
    await _stops(db, UPGRADE, "holds 1 row")
    assert await pg.schema_snapshot(db) == before


async def test_rollback_restores_the_exact_schema_and_rows(dbs):
    db = await dbs("up_rb")
    await _previous_state(db)
    await _seed_collection_items(db)
    schema, rows = await pg.schema_snapshot(db), await pg.query(db, ROWS.format(table="collection_ledger_items"))
    await _ok(db, UPGRADE)
    await _ok(db, UPGRADE_ROLLBACK)
    assert await pg.schema_snapshot(db) == schema
    assert await pg.query(db, ROWS.format(table="collection_ledger_items")) == rows
    await _ok(db, UPGRADE_ROLLBACK)                               # already rolled back
    await _ok(db, UPGRADE)                                        # and upgradable again


@pytest.mark.parametrize("seed, needle", [
    ("INSERT INTO ledger_items (legal_proceeding_id, item_type, subject, amount, created_by_user_id, created_at, updated_at) "
     "VALUES (1, 'addition', 'x', 1, 1, now(), now())", "legal item"),
    ("INSERT INTO contacts (kind, name, phone, apartment_number, created_at) VALUES ('person', 'c', '050', '4', now())", "apartment number"),
    ("INSERT INTO legal_proceedings (contact_id, party_role, title, status, opened_at, created_by, created_at) "
     "VALUES (1, 'other', 't', 'open', now(), 1, now())", "legal_proceedings holds"),
], ids=["legal-item", "apartment", "proceeding"])
async def test_rollback_stops_before_losing_data(dbs, seed, needle):
    db = await dbs("up_rb_stop")
    await _previous_state(db)
    await _ok(db, UPGRADE)
    await pg.execute(db, f"SET session_replication_role = replica; {seed}")
    before = await pg.schema_snapshot(db)
    await _stops(db, UPGRADE_ROLLBACK, needle)
    assert await pg.schema_snapshot(db) == before


async def test_module_rollback_points_at_the_ledger_rollback_first(dbs):
    db = await dbs("up_mod_rb")
    await pg.migrate(db)
    await _ok(db, UPGRADE)
    await _stops(db, ROLLBACK, "objects outside the module depend on it")
    await _ok(db, UPGRADE_ROLLBACK)
    await pg.execute(db, "ALTER TABLE legal_proceedings DROP COLUMN apartment_number, DROP COLUMN claim_amount")
    await pg.execute(db, "ALTER TABLE contacts ADD COLUMN apartment_number varchar(32)")
    await _ok(db, ROLLBACK)


async def test_collection_migration_never_recreates_the_old_table(dbs):
    db = await dbs("up_collection")
    await _previous_state(db)
    await _ok(db, UPGRADE)
    await _seed_collection_items(db, "ledger_items")
    await _ok(db, COLLECTION_MIGRATION)
    assert await pg.query(db, "SELECT to_regclass('public.collection_ledger_items')") is None
    assert await pg.query(db, "SELECT count(*) FROM ledger_items") == 50


async def test_collection_migration_still_builds_the_table_before_the_upgrade(dbs):
    db = await dbs("up_collection_fresh")
    await pg.execute(db, "DROP TABLE collection_ledger_items")
    await _ok(db, COLLECTION_MIGRATION)
    assert await pg.query(db, "SELECT to_regclass('public.collection_ledger_items')::text") == "collection_ledger_items"


async def test_contacts_migration_adds_the_apartment_number(dbs):
    db = await dbs("up_contacts")
    await pg.execute(db, "ALTER TABLE contacts DROP COLUMN apartment_number")
    await pg.execute(db, "INSERT INTO contacts (kind, name, phone, created_at) VALUES ('person', 'c', '050', now())")
    await _stops(db, MIGRATION, "no apartment_number")
    await _ok(db, CONTACTS_MIGRATION)
    assert await pg.query(db, "SELECT count(*) FROM contacts WHERE apartment_number IS NULL") == 1
    await _ok(db, MIGRATION)


async def test_upgrade_adds_the_contact_column_itself(dbs):
    db = await dbs("up_contact_col")
    await _previous_state(db)
    await _ok(db, UPGRADE)
    assert await pg.query(db, "SELECT count(*) FROM information_schema.columns WHERE table_name = 'contacts' AND column_name = 'apartment_number'") == 1
