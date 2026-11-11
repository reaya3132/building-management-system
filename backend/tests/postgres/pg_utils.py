"""Helpers for the PostgreSQL-only tests (backend/tests/postgres).

Enabled by ``TEST_POSTGRES_URL`` = a server connection with CREATEDB rights, e.g.
``postgresql://postgres:x@localhost:55432/postgres``. Every test works in its OWN
throw-away database named ``legal_test_*``; the database named in the URL is only
used to create / drop those.

SQL migration files are executed statement by statement on one connection, with
the semantics of ``psql -v ON_ERROR_STOP=1 -f`` (the documented way to run them):
each top-level statement is sent on its own — so CREATE INDEX CONCURRENTLY works
outside BEGIN/COMMIT — and the first error stops the file and closes the connection,
which rolls back any open transaction. No psql/pg_dump binary is required.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import asyncpg
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

DSN_ENV = "TEST_POSTGRES_URL"
DSN = os.environ.get(DSN_ENV)
DB_PREFIX = "legal_test_"
MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations"
CONTACTS_MIGRATION = MIGRATIONS / "add_contacts.sql"
MIGRATION = MIGRATIONS / "add_legal_proceedings.sql"
INDEX_MIGRATION = MIGRATIONS / "add_legal_proceedings_indexes_concurrently.sql"
ROLLBACK = MIGRATIONS / "rollback_legal_proceedings.sql"
COLLECTION_MIGRATION = MIGRATIONS / "add_collection_tasks.sql"
UPGRADE = MIGRATIONS / "upgrade_ledger_items_and_legal_fields.sql"
UPGRADE_ROLLBACK = MIGRATIONS / "rollback_ledger_items_and_legal_fields.sql"
MARKER = "owner:add_legal_proceedings"
LEGAL_TABLES = ("contacts", "legal_proceedings", "legal_proceeding_stages",
                "legal_proceeding_entries", "legal_proceeding_assignees")
MODULE_TABLES = LEGAL_TABLES[1:]  # contacts is a general table with its own migration


def dsn_for(db: str) -> str:
    """The configured server URL pointing at database ``db`` (plain libpq form)."""
    parts = urlsplit(DSN.replace("postgresql+asyncpg://", "postgresql://"))
    return urlunsplit(parts._replace(path="/" + db))


def sqlalchemy_url(db: str) -> str:
    return dsn_for(db).replace("postgresql://", "postgresql+asyncpg://", 1)


async def connect(db: str) -> asyncpg.Connection:
    return await asyncpg.connect(dsn_for(db))


async def query(db: str, sql: str, *args):
    conn = await connect(db)
    try:
        return await conn.fetchval(sql, *args)
    finally:
        await conn.close()


async def execute(db: str, sql: str, *args) -> None:
    conn = await connect(db)
    try:
        await conn.execute(sql, *args)
    finally:
        await conn.close()


# ── databases ─────────────────────────────────────────────────────────────────

async def _admin() -> asyncpg.Connection:
    return await asyncpg.connect(DSN.replace("postgresql+asyncpg://", "postgresql://"))


async def create_db(name: str, template: str | None = None) -> str:
    assert name.startswith(DB_PREFIX), "tests only touch their own databases"
    conn = await _admin()
    try:
        await conn.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        await conn.execute(f'CREATE DATABASE "{name}"' + (f' TEMPLATE "{template}"' if template else ""))
    finally:
        await conn.close()
    return name


async def drop_db(name: str) -> None:
    assert name.startswith(DB_PREFIX)
    conn = await _admin()
    try:
        await conn.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
    finally:
        await conn.close()


# The ledger table before the upgrade (add_collection_tasks.sql).
_COLLECTION_LEDGER_DDL = """
CREATE TABLE collection_ledger_items (
    id SERIAL NOT NULL, task_id INTEGER NOT NULL, subject VARCHAR(255) NOT NULL, amount NUMERIC(12, 2) NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0, created_by_user_id INTEGER NOT NULL, updated_by_user_id INTEGER NULL,
    created_at TIMESTAMP NOT NULL, updated_at TIMESTAMP NOT NULL, archived_at TIMESTAMP NULL, archived_by_user_id INTEGER NULL,
    CONSTRAINT collection_ledger_items_pkey PRIMARY KEY (id),
    CONSTRAINT collection_ledger_items_task_id_fkey FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE RESTRICT,
    CONSTRAINT collection_ledger_items_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT collection_ledger_items_updated_by_user_id_fkey FOREIGN KEY (updated_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT collection_ledger_items_archived_by_user_id_fkey FOREIGN KEY (archived_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT ck_cli_amount_positive CHECK (amount > 0)
);
CREATE INDEX ix_cli_task_id ON collection_ledger_items (task_id);
CREATE INDEX ix_cli_task_id_active ON collection_ledger_items (task_id) WHERE archived_at IS NULL;
"""


async def create_all(db: str, *, include_legal: bool, ledger: bool = False) -> None:
    """Schema from the models. ``include_legal=False`` reproduces today's production
    schema: no module tables and no documents.context_key. ``ledger_items`` is built
    only with ``ledger=True`` (a database created entirely by the new code); otherwise
    the ledger comes from the production table and the upgrade file."""
    import backend.models  # noqa: F401  (registers every model)
    import backend.models.cems_models  # noqa: F401
    from backend.db.base import Base

    tables = [t for t in Base.metadata.sorted_tables
              if (include_legal or t.name not in LEGAL_TABLES) and (ledger or t.name != "ledger_items")]
    engine = create_async_engine(sqlalchemy_url(db), poolclass=NullPool)
    try:
        async with engine.begin() as conn:
            await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=tables))
    finally:
        await engine.dispose()
    if not include_legal:
        await execute(db, "ALTER TABLE documents DROP COLUMN context_key")


async def production_like(db: str, *, seed_documents: bool = True) -> str:
    """Fresh database with today's production schema (+ 2,000 existing documents),
    contacts applied by its own migration."""
    await create_db(db)
    await create_all(db, include_legal=False)
    await execute(db, _COLLECTION_LEDGER_DDL)
    run = await run_sql_file(db, CONTACTS_MIGRATION)
    assert run.ok, run.error
    if seed_documents:
        await execute(db, """
            INSERT INTO documents (entity_type, entity_id, file_path, file_name, description,
                                   uploaded_at, source_table, source_id)
            SELECT et, g, 'https://bucket/' || et || '/' || g || '.pdf', 'f' || g || '.pdf', 'd' || g,
                   now(), '', 0
            FROM unnest(ARRAY['project', 'apartment', 'transaction', 'supplier', 'unforeseen_expense']) et,
                 generate_series(1, 400) g""")
    return db


# ── running SQL files ─────────────────────────────────────────────────────────

def split_sql(script: str) -> list[str]:
    """Top-level statements of a script, honouring quotes, comments and $tag$ bodies."""
    statements, buf, i, n = [], [], 0, len(script)
    while i < n:
        ch = script[i]
        if script.startswith("--", i):
            j = script.find("\n", i)
            i = n if j == -1 else j + 1
            continue
        if script.startswith("/*", i):
            j = script.find("*/", i + 2)
            i = n if j == -1 else j + 2
            continue
        if ch in ("'", '"'):
            j = i + 1
            while j < n:
                if script[j] == ch and script.startswith(ch * 2, j):
                    j += 2
                    continue
                if script[j] == ch:
                    break
                j += 1
            buf.append(script[i:j + 1])
            i = j + 1
            continue
        if ch == "$":
            j = script.find("$", i + 1)
            tag = script[i:j + 1] if j != -1 else ""
            if tag and (tag == "$$" or tag[1:-1].replace("_", "").isalnum()):
                end = script.find(tag, j + 1)
                end = n if end == -1 else end + len(tag)
                buf.append(script[i:end])
                i = end
                continue
        if ch == ";":
            stmt = "".join(buf).strip()
            if stmt:
                statements.append(stmt)
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    tail = "".join(buf).strip()
    if tail:
        statements.append(tail)
    return statements


@dataclass
class SqlRun:
    ok: bool
    error: str = ""
    notices: list[str] = field(default_factory=list)


async def run_sql_file(db: str, path: Path) -> SqlRun:
    conn = await connect(db)
    notices: list[str] = []
    conn.add_log_listener(lambda _c, msg: notices.append(str(msg)))
    try:
        for stmt in split_sql(path.read_text(encoding="utf-8")):
            await conn.execute(stmt)
        return SqlRun(True, notices=notices)
    except asyncpg.PostgresError as exc:
        return SqlRun(False, error=str(exc), notices=notices)
    finally:
        await conn.close()  # an aborted transaction is rolled back here


async def migrate(db: str) -> None:
    for path in (MIGRATION, INDEX_MIGRATION):
        run = await run_sql_file(db, path)
        assert run.ok, f"{path.name}: {run.error}"


async def upgrade(db: str) -> None:
    run = await run_sql_file(db, UPGRADE)
    assert run.ok, f"{UPGRADE.name}: {run.error}"


async def to_previous_legal_fields(db: str) -> None:
    """Turn the current legal schema into the one before the upgrade file."""
    await execute(db, """
        ALTER TABLE contacts DROP COLUMN apartment_number;
        ALTER TABLE legal_proceedings
            ADD COLUMN apartment_number VARCHAR(32) NOT NULL,
            ADD COLUMN claim_amount NUMERIC(14, 2) NULL,
            ADD CONSTRAINT ck_lp_apartment_number CHECK (trim(apartment_number) <> ''),
            ADD CONSTRAINT ck_lp_amount CHECK (claim_amount IS NULL OR claim_amount > 0);""")


# ── inspection ────────────────────────────────────────────────────────────────

_SNAPSHOT_SQL = """
SELECT string_agg(item, E'\n' ORDER BY item) FROM (
    SELECT 'rel ' || c.relname || ' ' || c.relkind::text || coalesce(' comment=' || obj_description(c.oid, 'pg_class'), '')
      FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
    UNION ALL
    SELECT 'col ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
           || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
           || coalesce(' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), '')
           || coalesce(' comment=' || col_description(c.oid, a.attnum), '')
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'v') AND a.attnum > 0 AND NOT a.attisdropped
    UNION ALL
    SELECT 'con ' || c.relname || ' ' || k.conname || ' ' || pg_get_constraintdef(k.oid)
      FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid WHERE c.relnamespace = 'public'::regnamespace
    UNION ALL
    SELECT 'idx ' || indexdef FROM pg_indexes WHERE schemaname = 'public'
    UNION ALL
    SELECT 'nsp ' || nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
) s(item)
"""


async def schema_snapshot(db: str, *, with_comments: bool = True) -> str:
    """Catalogue-level description of the public schema (stands in for pg_dump -s)."""
    snap = await query(db, _SNAPSHOT_SQL)
    if not with_comments:
        snap = "\n".join(line.split(" comment=")[0] for line in snap.splitlines())
    return snap


async def documents_fingerprint(db: str) -> str:
    """Every pre-existing documents column of every row (context_key excluded)."""
    return await query(db, """
        SELECT count(*) || ':' || coalesce(md5(string_agg(concat_ws('|', id, entity_type, entity_id, file_path,
               file_name, description, uploaded_at, source_table, source_id, transaction_id,
               unforeseen_transaction_line_id, supplier_id), ',' ORDER BY id)), '')
        FROM documents""")


async def marked_tables(db: str) -> int:
    return await query(db, """
        SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
           AND obj_description(oid, 'pg_class') = $1""", MARKER)


async def context_key_marker(db: str) -> str | None:
    """The column comment, '' when the column has none, None when it does not exist."""
    return await query(db, """
        SELECT coalesce(col_description('documents'::regclass, attnum), '') FROM pg_attribute
         WHERE attrelid = 'documents'::regclass AND attname = 'context_key' AND NOT attisdropped""")


async def legal_tables_present(db: str) -> int:
    return await query(db, "SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace "
                           "AND relkind = 'r' AND relname = ANY($1::text[])", list(MODULE_TABLES))
