"""Legal proceedings migration / rollback on a real PostgreSQL (TEST_POSTGRES_URL).

Scenarios (each in its own throw-away database):
  S1  existing production schema + data -> migrate (+ CONCURRENTLY index)
  S2  re-run is a no-op
  S3  create_all already provisioned the module tables -> migrate verifies + adopts
  S4  fresh database provisioned by the new code (documents.context_key pre-exists)
  S5  mismatching definitions stop safely, leaving nothing behind
  S6  invalid / foreign / premature index
  S7  rollback safety stops
  S8  rollback: exact pre-migration schema, data intact, re-migratable
  OWN ownership: rollback never drops what the migration does not own
"""
from __future__ import annotations

import pytest
import pytest_asyncio

from backend.tests.postgres import pg_utils as pg
from backend.tests.postgres.pg_utils import INDEX_MIGRATION, MARKER, MIGRATION, ROLLBACK

pytestmark = pytest.mark.asyncio

INDEX_DEF = ("CREATE INDEX ix_documents_entity_context ON public.documents "
             "USING btree (entity_type, entity_id, context_key)")


async def _ok(db, path):
    run = await pg.run_sql_file(db, path)
    assert run.ok, f"{path.name} failed: {run.error}"
    return run


async def _stops(db, path, needle):
    run = await pg.run_sql_file(db, path)
    assert not run.ok, f"{path.name} should have stopped"
    assert needle in run.error, run.error
    return run


async def _no_ref_schema(db):
    assert await pg.query(db, "SELECT count(*) FROM pg_namespace WHERE nspname = 'legal_migration_ref'") == 0


@pytest_asyncio.fixture
async def dbs():
    created: list[str] = []

    async def make(suffix: str, kind: str = "production") -> str:
        name = pg.DB_PREFIX + suffix
        created.append(name)
        if kind == "production":
            await pg.production_like(name)
        elif kind == "fresh_new_code":  # the new code's create_all on an empty database
            await pg.create_db(name)
            await pg.create_all(name, include_legal=True)
        return name

    yield make
    for name in created:
        await pg.drop_db(name)


# ── S1 / S2 ──────────────────────────────────────────────────────────────────

async def test_s1_s2_migrate_existing_schema_then_rerun(dbs):
    db = await dbs("s1")
    docs_before = await pg.documents_fingerprint(db)
    assert docs_before.startswith("2000:")

    await _ok(db, MIGRATION)
    await _ok(db, INDEX_MIGRATION)
    assert await pg.query(db, "SELECT indisvalid FROM pg_index WHERE indexrelid = 'ix_documents_entity_context'::regclass")
    assert await pg.query(db, "SELECT pg_get_indexdef('ix_documents_entity_context'::regclass)") == INDEX_DEF
    await _no_ref_schema(db)
    assert await pg.documents_fingerprint(db) == docs_before
    assert await pg.query(db, "SELECT count(*) FROM documents WHERE context_key IS NOT NULL") == 0
    assert await pg.marked_tables(db) == 5
    assert await pg.context_key_marker(db) == MARKER  # added by the migration
    after_first = await pg.schema_snapshot(db)

    # S2: re-run changes nothing
    await _ok(db, MIGRATION)
    await _ok(db, INDEX_MIGRATION)
    assert await pg.schema_snapshot(db) == after_first
    assert await pg.documents_fingerprint(db) == docs_before


# ── S3 / S4 ──────────────────────────────────────────────────────────────────

async def test_s3_create_all_already_ran_is_verified_and_matches_sql_path(dbs):
    sql_path = await dbs("s3_sql")
    await pg.migrate(sql_path)

    db = await dbs("s3")
    docs_before = await pg.documents_fingerprint(db)
    await pg.create_all(db, include_legal=True)  # new code started before the migration
    assert await pg.context_key_marker(db) is None  # create_all never alters documents
    assert await pg.legal_tables_present(db) == 5
    assert await pg.marked_tables(db) == 0

    await _ok(db, MIGRATION)
    await _ok(db, INDEX_MIGRATION)
    assert await pg.marked_tables(db) == 5
    assert await pg.documents_fingerprint(db) == docs_before
    # Models and SQL produce the very same schema.
    assert await pg.schema_snapshot(db) == await pg.schema_snapshot(sql_path)


async def test_s4_fresh_database_keeps_pre_existing_context_key_unmarked(dbs):
    db = await dbs("s4", "fresh_new_code")
    assert await pg.context_key_marker(db) == ""
    await _ok(db, MIGRATION)
    assert await pg.context_key_marker(db) == ""  # not claimed: it existed before


# ── S5 ───────────────────────────────────────────────────────────────────────

MISMATCHES = [
    ("ALTER TABLE legal_proceedings DROP CONSTRAINT ck_lp_amount; "
     "ALTER TABLE legal_proceedings ADD CONSTRAINT ck_lp_amount CHECK (claim_amount >= 0)", "ck_lp_amount"),
    ("ALTER TABLE legal_proceedings ALTER COLUMN title TYPE varchar(100)", "legal_proceedings.title"),
    ("ALTER TABLE legal_proceeding_entries DROP CONSTRAINT fk_lpe_stage", "fk_lpe_stage"),
    ("ALTER TABLE legal_proceeding_stages DROP CONSTRAINT legal_proceeding_stages_proceeding_id_fkey; "
     "ALTER TABLE legal_proceeding_stages ADD CONSTRAINT legal_proceeding_stages_proceeding_id_fkey "
     "FOREIGN KEY (proceeding_id) REFERENCES legal_proceedings(id) ON DELETE CASCADE", "ON DELETE CASCADE"),
    ("ALTER TABLE contacts ADD COLUMN extra int", "contacts.extra"),
    ("DROP INDEX ix_lp_project_status; CREATE INDEX ix_lp_project_status ON legal_proceedings (status)",
     "ix_lp_project_status"),
]


@pytest.mark.parametrize("alter, needle", MISMATCHES, ids=[m[1] for m in MISMATCHES])
async def test_s5_mismatching_definition_stops_without_side_effects(dbs, alter, needle):
    db = await dbs("s5")
    await pg.create_all(db, include_legal=True)
    await pg.execute(db, alter)
    await _stops(db, MIGRATION, needle)
    await _no_ref_schema(db)
    assert await pg.context_key_marker(db) is None  # documents untouched: rolled back
    assert await pg.marked_tables(db) == 0


async def test_s5_context_key_with_other_type_stops(dbs):
    db = await dbs("s5_col", "fresh_new_code")
    await pg.execute(db, "ALTER TABLE documents ALTER COLUMN context_key TYPE varchar(80)")
    await _stops(db, MIGRATION, "unexpected definition")
    assert await pg.marked_tables(db) == 0


# ── S6 ───────────────────────────────────────────────────────────────────────

async def test_s6_invalid_index_stops_then_rebuilds(dbs):
    db = await dbs("s6")
    await pg.migrate(db)
    await pg.execute(db, "DROP INDEX CONCURRENTLY ix_documents_entity_context")
    await pg.execute(db, "CREATE INDEX CONCURRENTLY ix_documents_entity_context "
                         "ON documents (entity_type, entity_id, context_key)")
    # Simulate an interrupted CONCURRENTLY build (needs superuser on the test server).
    await pg.execute(db, "UPDATE pg_index SET indisvalid = false "
                         "WHERE indexrelid = 'ix_documents_entity_context'::regclass")
    await _stops(db, INDEX_MIGRATION, "INVALID")
    await pg.execute(db, "DROP INDEX CONCURRENTLY ix_documents_entity_context")
    await _ok(db, INDEX_MIGRATION)
    assert await pg.query(db, "SELECT indisvalid FROM pg_index WHERE indexrelid = 'ix_documents_entity_context'::regclass")


async def test_s6_index_with_other_definition_stops(dbs):
    db = await dbs("s6_def")
    await _ok(db, MIGRATION)
    await pg.execute(db, "CREATE INDEX ix_documents_entity_context ON documents (entity_id)")
    await _stops(db, INDEX_MIGRATION, "unexpected definition")


async def test_s6_index_file_before_migration_stops(dbs):
    db = await dbs("s6_pre")
    await _stops(db, INDEX_MIGRATION, "run add_legal_proceedings.sql first")


# ── S7 / S8 ──────────────────────────────────────────────────────────────────

async def test_s7_rollback_safety_stops_change_nothing(dbs):
    db = await dbs("s7")
    await pg.migrate(db)
    migrated = await pg.schema_snapshot(db)

    await pg.execute(db, "INSERT INTO contacts (kind, name, created_at) VALUES ('person', 'x', now())")
    await _stops(db, ROLLBACK, "holds 1 row")
    await pg.execute(db, "DELETE FROM contacts")

    await pg.execute(db, "INSERT INTO documents (entity_type, entity_id, file_path, uploaded_at, source_table, "
                         "source_id) VALUES ('legal_proceeding_entry', 1, 'k', now(), '', 0)")
    await _stops(db, ROLLBACK, "legal document")
    await pg.execute(db, "DELETE FROM documents WHERE entity_type = 'legal_proceeding_entry'")

    await pg.execute(db, "UPDATE documents SET context_key = 'other' WHERE id = 1")
    await _stops(db, ROLLBACK, "non-legal")
    await pg.execute(db, "UPDATE documents SET context_key = NULL WHERE id = 1")

    await pg.execute(db, "COMMENT ON INDEX ix_documents_entity_context IS NULL")
    await _stops(db, ROLLBACK, "without the ownership marker")
    await pg.execute(db, f"COMMENT ON INDEX ix_documents_entity_context IS '{MARKER}'")

    assert await pg.schema_snapshot(db) == migrated  # every stop left the schema untouched


async def test_s8_rollback_restores_exact_schema_and_allows_remigration(dbs):
    db = await dbs("s8")
    before = await pg.schema_snapshot(db)
    docs_before = await pg.documents_fingerprint(db)
    await pg.migrate(db)

    await _ok(db, ROLLBACK)
    assert await pg.schema_snapshot(db) == before
    assert await pg.documents_fingerprint(db) == docs_before

    await pg.migrate(db)  # migrate again after rollback
    assert await pg.marked_tables(db) == 5


async def test_s8_rollback_keeps_pre_existing_context_key(dbs):
    db = await dbs("s8_fresh", "fresh_new_code")
    await pg.migrate(db)
    run = await _ok(db, ROLLBACK)
    assert await pg.context_key_marker(db) == ""  # kept
    assert any("Kept documents.context_key" in n for n in run.notices)
    assert await pg.legal_tables_present(db) == 0


# ── OWN: ownership ───────────────────────────────────────────────────────────

async def test_own_rollback_without_migration_drops_nothing(dbs):
    """create_all provisioned everything but the migration never ran: nothing is
    marked, so rollback must keep every table and the column."""
    db = await dbs("own_unmarked", "fresh_new_code")
    before = await pg.schema_snapshot(db)
    run = await _ok(db, ROLLBACK)
    assert await pg.schema_snapshot(db) == before
    assert sum("no ownership marker" in n for n in run.notices) == 5
    assert any("Kept documents.context_key" in n for n in run.notices)


async def test_own_rollback_never_touches_objects_outside_the_module(dbs):
    """Rollback after a migration: the rest of the schema (every table, column,
    constraint, index and comment outside the module) is byte-for-byte unchanged."""
    db = await dbs("own_rest")
    await pg.execute(db, "COMMENT ON TABLE documents IS 'pre-existing comment'")
    await pg.execute(db, "CREATE INDEX ix_custom_documents_entity ON documents (entity_type)")
    before = await pg.schema_snapshot(db)
    await pg.migrate(db)
    await _ok(db, ROLLBACK)
    assert await pg.schema_snapshot(db) == before


FOREIGN_DEPENDENCIES = [
    ("view", "CREATE VIEW v_open_proceedings AS SELECT id FROM legal_proceedings WHERE status = 'open'"),
    ("fk", "CREATE TABLE other_module (id int PRIMARY KEY, contact_id int REFERENCES contacts (id))"),
    ("context_key index", "CREATE INDEX ix_other_module_ctx ON documents (context_key)"),
]


@pytest.mark.parametrize("kind, ddl", FOREIGN_DEPENDENCIES, ids=[d[0] for d in FOREIGN_DEPENDENCIES])
async def test_own_foreign_dependency_stops_rollback_before_any_change(dbs, kind, ddl):
    """An object outside the module that depends on what rollback would drop must stop
    it before ANYTHING is dropped — including the CONCURRENTLY index of step 2."""
    db = await dbs("own_dep")
    await pg.migrate(db)
    await pg.execute(db, ddl)
    migrated = await pg.schema_snapshot(db)
    await _stops(db, ROLLBACK, "objects outside the module depend on it")
    assert await pg.schema_snapshot(db) == migrated
