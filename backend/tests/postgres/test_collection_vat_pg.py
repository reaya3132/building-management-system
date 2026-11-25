"""collection_vat.sql, its rollback and the VAT totals on a real PostgreSQL.

- Every existing collection task keeps exactly the same total after the migration.
- The migrated schema equals the models; re-running is a no-op; the rollback stops
  before it would change an amount to pay.
- The SQL total (total_amount_expr) equals the Python rule (services/vat.py) for
  every rounding case, and the sum of the rounded lines equals the total.
"""
from __future__ import annotations

from decimal import Decimal

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from backend.models.collection_task import CollectionTaskDetails
from backend.repositories.collection_task_repository import total_amount_expr
from backend.services.vat import vat_breakdown
from backend.tests.postgres import pg_utils as pg
from backend.tests.postgres.pg_utils import ADJ_VAT_MIGRATION, ADJ_VAT_ROLLBACK, VAT_MIGRATION, VAT_ROLLBACK
from backend.tests.postgres.test_legal_migration_pg import _ok, _stops, dbs  # noqa: F401  (fixture)

pytestmark = pytest.mark.asyncio

D = Decimal

# The total BEFORE VAT support, straight from the source rows.
OLD_TOTALS = """
SELECT string_agg(d.task_id || '=' || CASE WHEN d.collection_type = 'single'
         THEN d.initial_amount + COALESCE((SELECT sum(a.amount) FROM collection_amount_adjustments a WHERE a.task_id = d.task_id), 0)
         ELSE COALESCE((SELECT sum(i.amount) FROM ledger_items i WHERE i.task_id = d.task_id AND i.archived_at IS NULL), 0)
       END, ',' ORDER BY d.task_id)
FROM collection_task_details d"""

# Columns (type, NOT NULL) and CHECK constraints of both tables. Defaults are left out
# (the renamed ledger table keeps its old sequence name); VAT_DEFAULTS checks them.
SCHEMA = """SELECT string_agg(item, E'\\n' ORDER BY item) FROM (
    SELECT c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || a.attnotnull::text AS item
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relname IN ('ledger_items', 'collection_task_details', 'collection_amount_adjustments')
       AND a.attnum > 0 AND NOT a.attisdropped
    UNION ALL SELECT conrelid::regclass::text || '.' || conname || pg_get_constraintdef(oid) FROM pg_constraint
     WHERE conrelid IN ('public.ledger_items'::regclass, 'public.collection_task_details'::regclass,
                        'public.collection_amount_adjustments'::regclass) AND contype = 'c') s"""


async def _pre_vat(db: str) -> None:
    """Today's production: legal + ledger upgrade, WITHOUT the VAT columns (create_all
    of the new models adds them to collection_task_details, so the rollback strips them)."""
    await pg.migrate(db)
    await pg.upgrade(db)
    await _ok(db, ADJ_VAT_ROLLBACK)
    await _ok(db, VAT_ROLLBACK)
    assert await pg.query(db, "SELECT count(*) FROM information_schema.columns WHERE column_name IN "
                              "('vat_included', 'vat_rate', 'initial_vat_included', 'initial_vat_rate')") == 0


async def _migrate_vat(db: str) -> None:
    """Both VAT files, in deploy order."""
    await _ok(db, VAT_MIGRATION)
    await _ok(db, ADJ_VAT_MIGRATION)


async def _seed(db: str) -> None:
    """Existing collection tasks (FKs off for the seed only): singles with adjustments
    (including reductions) and ledgers with active and archived items."""
    await pg.execute(db, """
        SET session_replication_role = replica;
        INSERT INTO collection_task_details (task_id, collection_type, project_id, billing_month, initial_amount,
                                             created_at, updated_at)
        SELECT g, CASE WHEN g % 2 = 0 THEN 'single' ELSE 'ledger' END, 1, date '2026-10-01',
               CASE WHEN g % 2 = 0 THEN g * 10.25 END, now(), now()
        FROM generate_series(1, 60) g;
        INSERT INTO collection_amount_adjustments (task_id, amount, note, created_by_user_id, created_at)
        SELECT g, CASE WHEN g % 4 = 0 THEN -1.05 ELSE 3.33 END, 'adj', 1, now()
        FROM generate_series(2, 60, 2) g;
        INSERT INTO ledger_items (task_id, subject, amount, sort_order, created_by_user_id, created_at, updated_at,
                                  archived_at, archived_by_user_id)
        SELECT t, 'item ' || n, round((t * 7 + n * 0.37)::numeric, 2), n, 1, now(), now(),
               CASE WHEN n = 3 THEN now() END, CASE WHEN n = 3 THEN 1 END
        FROM generate_series(1, 59, 2) t, generate_series(1, 4) n;""")


async def _new_totals(db: str) -> str:
    engine = create_async_engine(pg.sqlalchemy_url(db), poolclass=NullPool)
    try:
        async with engine.connect() as conn:
            rows = (await conn.execute(
                select(CollectionTaskDetails.task_id, total_amount_expr()).order_by(CollectionTaskDetails.task_id)
            )).all()
    finally:
        await engine.dispose()
    return ",".join(f"{task_id}={D(total):.2f}" for task_id, total in rows)


async def test_existing_totals_are_identical_after_the_migration(dbs):
    db = await dbs("vat_totals")
    await _pre_vat(db)
    await _seed(db)
    before = await pg.query(db, OLD_TOTALS)
    rows_before = await pg.query(db, "SELECT md5(string_agg(concat_ws('|', id, task_id, subject, amount, archived_at), ',' ORDER BY id)) FROM ledger_items")

    await _migrate_vat(db)

    assert await _new_totals(db) == before
    assert await pg.query(db, "SELECT md5(string_agg(concat_ws('|', id, task_id, subject, amount, archived_at), ',' ORDER BY id)) FROM ledger_items") == rows_before
    # Every existing row stays "saved before VAT support".
    assert await pg.query(db, "SELECT count(*) FROM ledger_items WHERE vat_included IS NOT NULL OR vat_rate IS NOT NULL") == 0
    assert await pg.query(db, "SELECT count(*) FROM collection_task_details "
                              "WHERE initial_vat_included IS NOT NULL OR initial_vat_rate IS NOT NULL") == 0


async def test_migrated_schema_matches_the_models_and_rerun_is_a_noop(dbs):
    migrated = await dbs("vat_schema")
    await _pre_vat(migrated)
    await _migrate_vat(migrated)
    modelled = await dbs("vat_model", "none")
    await pg.create_db(modelled)
    await pg.create_all(modelled, include_legal=True, ledger=True)
    assert await pg.query(migrated, SCHEMA) == await pg.query(modelled, SCHEMA)
    for db in (migrated, modelled):  # no default: legal rows stay NULL, the service sets both
        assert await pg.query(db, "SELECT count(*) FROM information_schema.columns WHERE column_default IS NOT NULL "
                                  "AND column_name IN ('vat_included', 'vat_rate', 'initial_vat_included', 'initial_vat_rate')") == 0

    snapshot = await pg.schema_snapshot(migrated)
    await _migrate_vat(migrated)
    assert await pg.schema_snapshot(migrated) == snapshot


async def test_constraints_on_postgresql(dbs):
    db = await dbs("vat_checks")
    await _pre_vat(db)
    await _migrate_vat(db)
    await _seed(db)
    replica = "SET session_replication_role = replica; "
    # A legal item can never hold VAT.
    with pytest.raises(Exception, match="ck_li_vat"):
        await pg.execute(db, replica + "INSERT INTO ledger_items (legal_proceeding_id, item_type, subject, amount, "
                                       "created_by_user_id, created_at, updated_at, vat_included, vat_rate) "
                                       "VALUES (1, 'addition', 'x', 1, 1, now(), now(), true, 0.18)")
    # Facts come in pairs, the rate is a fraction, a ledger task has no initial VAT.
    with pytest.raises(Exception, match="ck_li_vat"):
        await pg.execute(db, "UPDATE ledger_items SET vat_included = true WHERE id = (SELECT min(id) FROM ledger_items)")
    with pytest.raises(Exception, match="ck_li_vat_rate"):
        await pg.execute(db, "UPDATE ledger_items SET vat_included = true, vat_rate = 1 WHERE id = (SELECT min(id) FROM ledger_items)")
    with pytest.raises(Exception, match="ck_ctd_initial_vat"):
        await pg.execute(db, "UPDATE collection_task_details SET initial_vat_included = true, initial_vat_rate = 0.18 "
                             "WHERE collection_type = 'ledger'")


async def test_rollback_stops_before_changing_an_amount_to_pay(dbs):
    db = await dbs("vat_rollback")
    await _pre_vat(db)
    await _migrate_vat(db)
    await _seed(db)
    await pg.execute(db, "UPDATE ledger_items SET vat_included = true, vat_rate = 0.18 WHERE task_id = 1")
    await pg.execute(db, "UPDATE ledger_items SET vat_included = false, vat_rate = 0.18 WHERE task_id = 3")
    snapshot = await pg.schema_snapshot(db)
    await _stops(db, VAT_ROLLBACK, "rollback aborted")
    assert await pg.schema_snapshot(db) == snapshot  # nothing changed

    # Included-only VAT facts: the rollback runs and no total changes.
    await pg.execute(db, "UPDATE ledger_items SET vat_included = true WHERE task_id = 3")
    before = await _new_totals(db)
    await _ok(db, VAT_ROLLBACK)
    assert await pg.query(db, OLD_TOTALS) == before


async def test_sql_total_equals_python_for_every_rounding_case(dbs):
    db = await dbs("vat_math")
    await _pre_vat(db)
    await _migrate_vat(db)
    cases = []
    amounts = [D(a) / 100 for a in range(1, 3001, 3)] + [D("0.25"), D("1000.25"), D("33.33"), D("9999999999.99")]
    for task_id, rate in enumerate((D("0.1800"), D("0.1750"), D("0.0000"), D("0.1700")), start=1):
        for n, amount in enumerate(amounts):
            cases.append((task_id, n, amount, n % 2 == 0, rate))
    conn = await pg.connect(db)
    try:
        await conn.execute("SET session_replication_role = replica")
        await conn.executemany(
            "INSERT INTO collection_task_details (task_id, collection_type, project_id, billing_month, created_at, updated_at) "
            "VALUES ($1, 'ledger', 1, date '2026-10-01', now(), now())", [(t,) for t in range(1, 5)])
        await conn.executemany(
            "INSERT INTO ledger_items (task_id, subject, amount, sort_order, created_by_user_id, created_at, updated_at, "
            "vat_included, vat_rate) VALUES ($1, 's', $3, $2, 1, now(), now(), $4, $5)", cases)
    finally:
        await conn.close()

    expected = {}
    for task_id, _, amount, included, rate in cases:
        expected[task_id] = expected.get(task_id, D("0.00")) + vat_breakdown(amount, included, rate).gross
    assert await _new_totals(db) == ",".join(f"{t}={expected[t]:.2f}" for t in sorted(expected))


# ── adjustments (collection_adjustments_vat.sql) ─────────────────────────────

async def test_adjustment_rollback_stops_and_leaves_collection_vat_alone(dbs):
    db = await dbs("vat_adj_rollback")
    await _pre_vat(db)
    await _migrate_vat(db)
    await _seed(db)
    await pg.execute(db, "UPDATE collection_amount_adjustments SET vat_included = false, vat_rate = 0.18 "
                         "WHERE id = (SELECT min(id) FROM collection_amount_adjustments)")
    snapshot = await pg.schema_snapshot(db)
    await _stops(db, ADJ_VAT_ROLLBACK, "rollback aborted")
    assert await pg.schema_snapshot(db) == snapshot

    await pg.execute(db, "UPDATE collection_amount_adjustments SET vat_included = true, vat_rate = 0.18")
    before = await pg.query(db, OLD_TOTALS)
    await _ok(db, ADJ_VAT_ROLLBACK)
    assert await pg.query(db, OLD_TOTALS) == before
    # Only the adjustments' columns are gone; collection_vat.sql's stay.
    assert await pg.query(db, "SELECT count(*) FROM information_schema.columns WHERE table_name = "
                              "'collection_amount_adjustments' AND column_name IN ('vat_included', 'vat_rate')") == 0
    assert await pg.query(db, "SELECT count(*) FROM information_schema.columns WHERE table_name = "
                              "'ledger_items' AND column_name IN ('vat_included', 'vat_rate')") == 2


async def test_sql_total_equals_python_for_signed_adjustments(dbs):
    db = await dbs("vat_adj_math")
    await _pre_vat(db)
    await _migrate_vat(db)
    rate = D("0.1800")
    initial = D("100000.00")  # large enough that no mix of reductions goes below zero
    rows = []
    for n, agorot in enumerate(range(1, 3001, 3)):
        amount = D(agorot) / 100 * (-1 if n % 3 == 0 else 1)
        included = None if n % 5 == 0 else n % 2 == 0
        rows.append((1, amount, included, None if included is None else rate))
    rows += [(1, D("-0.25"), False, rate), (1, D("0.25"), False, rate), (1, D("-1000.25"), False, rate)]
    conn = await pg.connect(db)
    try:
        await conn.execute("SET session_replication_role = replica")
        await conn.execute(
            "INSERT INTO collection_task_details (task_id, collection_type, project_id, billing_month, initial_amount, "
            "initial_vat_included, initial_vat_rate, created_at, updated_at) "
            "VALUES (1, 'single', 1, date '2026-10-01', $1, true, 0.18, now(), now())", initial)
        await conn.executemany(
            "INSERT INTO collection_amount_adjustments (task_id, amount, note, created_by_user_id, created_at, "
            "vat_included, vat_rate) VALUES ($1, $2, 'n', 1, now(), $3, $4)", rows)
    finally:
        await conn.close()
    expected = initial + sum((vat_breakdown(a, i, r).gross for _, a, i, r in rows), D("0.00"))
    assert await _new_totals(db) == f"1={expected:.2f}"
    # A reduction mirrors the addition: -0.25 and +0.25 without VAT cancel exactly.
    assert vat_breakdown(D("-0.25"), False, rate).gross == -vat_breakdown(D("0.25"), False, rate).gross == D("-0.30")
