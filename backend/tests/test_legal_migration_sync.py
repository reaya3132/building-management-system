"""Legal proceedings — the SQL migration and the models must never drift apart.

Runs on the default (SQLite) test suite, without PostgreSQL: it parses
backend/migrations/add_legal_proceedings.sql and compares it with the SQLAlchemy
metadata. The full column/constraint/index comparison on a real PostgreSQL is
done by the migration itself (reference schema) and by the PostgreSQL run.
"""
from __future__ import annotations

import re
from pathlib import Path

from sqlalchemy import CheckConstraint, ForeignKeyConstraint, UniqueConstraint

from backend.configurations.legal.stages import STAGE1_KEY
from backend.models.contact import Contact
from backend.models.ledger_item import LedgerItem
from backend.models.legal_proceeding import (
    LegalProceeding,
    LegalProceedingAssignee,
    LegalProceedingEntry,
    LegalProceedingStage,
)

MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations"
SQL = (MIGRATIONS / "add_legal_proceedings.sql").read_text(encoding="utf-8")
CONTACTS_SQL = (MIGRATIONS / "add_contacts.sql").read_text(encoding="utf-8")
UPGRADE_SQL = (MIGRATIONS / "upgrade_ledger_items_and_legal_fields.sql").read_text(encoding="utf-8")
ROLLBACK_SQL = (MIGRATIONS / "rollback_ledger_items_and_legal_fields.sql").read_text(encoding="utf-8")
COLLECTION_SQL = (MIGRATIONS / "add_collection_tasks.sql").read_text(encoding="utf-8")
MODELS = (Contact, LegalProceeding, LegalProceedingStage, LegalProceedingEntry, LegalProceedingAssignee)


def _norm(expr: str) -> str:
    return re.sub(r"\s+", " ", expr).strip().lower()


def _balanced(text: str, start: int) -> str:
    """Contents of the parenthesised group opening at ``text[start] == '('``."""
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "(":
            depth += 1
        elif text[i] == ")":
            depth -= 1
            if depth == 0:
                return text[start + 1:i]
    raise AssertionError("unbalanced parentheses in migration")


def _sql_checks() -> dict[str, str]:
    checks = {}
    for m in re.finditer(r"CONSTRAINT\s+(\w+)\s+CHECK\s*\(", SQL):
        checks[m.group(1)] = _norm(_balanced(SQL, m.end() - 1))
    return checks


def _table_sql(table: str) -> str:
    m = re.search(rf"CREATE TABLE IF NOT EXISTS {table} \(", SQL)
    assert m, f"{table} missing from migration"
    return _balanced(SQL, m.end() - 1)


def test_stage1_key_in_sql_matches_configuration():
    check = _sql_checks()["ck_lpe_communication"]
    assert f"stage_key = '{STAGE1_KEY.lower()}'" in check
    # No other stage key literal may appear in that constraint.
    assert len(re.findall(r"stage_key = '([^']+)'", check)) == 1


def test_every_model_check_matches_sql_verbatim():
    sql_checks = _sql_checks()
    model_checks = {
        c.name: _norm(str(c.sqltext))
        for model in MODELS
        for c in model.__table__.constraints
        if isinstance(c, CheckConstraint)
    }
    assert set(model_checks) == set(sql_checks)
    for name, expr in model_checks.items():
        assert expr == sql_checks[name], name


def test_columns_nullability_and_named_constraints_match():
    for model in MODELS:
        table = model.__table__
        body = _table_sql(table.name)
        for col in table.columns:
            line = re.search(rf"^\s*{col.name}\s+([A-Z0-9(), ]+?)\s+(NOT NULL|NULL)\b", body, re.M)
            assert line, f"{table.name}.{col.name} missing from migration"
            assert (line.group(2) == "NOT NULL") == (not col.nullable), f"{table.name}.{col.name} nullability"
        sql_cols = re.findall(r"^\s{8}(\w+)\s+(?:SERIAL|INTEGER|VARCHAR|TEXT|BOOLEAN|TIMESTAMP|NUMERIC)", body, re.M)
        assert set(sql_cols) == {c.name for c in table.columns}, table.name
        for c in table.constraints:
            if isinstance(c, (UniqueConstraint, ForeignKeyConstraint)) and c.name:
                assert f"CONSTRAINT {c.name} " in body, c.name


def test_foreign_keys_on_delete_match():
    for model in MODELS:
        body = _norm(_table_sql(model.__table__.name))
        for fk in model.__table__.foreign_key_constraints:
            cols = ", ".join(fk.column_keys)
            ref = fk.elements[0].column.table.name
            ref_cols = ", ".join(e.column.name for e in fk.elements)
            expected = f"foreign key ({cols}) references {ref} ({ref_cols}) on delete {fk.ondelete.lower()}"
            assert expected in body, f"{model.__table__.name}: {expected}"


def test_indexes_match():
    sql_indexes = {
        m.group(1): _norm(m.group(3))
        for m in re.finditer(r"CREATE INDEX IF NOT EXISTS (\w+)\s+ON (\w+) \(([^)]*)\)", SQL)
    }
    model_indexes = {
        ix.name: _norm(", ".join(c.name for c in ix.columns))
        for model in MODELS
        for ix in model.__table__.indexes
    }
    assert model_indexes == sql_indexes


def test_contacts_definition_is_the_same_in_both_migrations():
    def table(text):
        m = re.search(r"CREATE TABLE IF NOT EXISTS contacts \(", text)
        return _norm(_balanced(text, m.end() - 1))

    def indexes(text):
        return sorted(_norm(i) for i in re.findall(r"CREATE INDEX IF NOT EXISTS ix_contacts_\w+ ON contacts \([^)]*\)", text))

    assert table(CONTACTS_SQL) == table(SQL)
    assert indexes(CONTACTS_SQL) == indexes(SQL)


def test_partial_landlord_index_matches():
    index = next(ix for ix in LegalProceeding.__table__.indexes if ix.name == "ix_lp_landlord_status")
    where = _norm(str(index.dialect_options["postgresql"]["where"]))
    assert f"ix_lp_landlord_status on legal_proceedings (landlord_contact_id, status) where {where};" in _norm(SQL)


def test_ledger_upgrade_matches_the_model():
    checks = {c.name: _norm(str(c.sqltext)) for c in LedgerItem.__table__.constraints if isinstance(c, CheckConstraint)}
    upgrade = _norm(UPGRADE_SQL)
    for name, expr in checks.items():
        if name != "ck_cli_amount_positive":  # exists since add_collection_tasks.sql
            assert f"add constraint {name} check ( {expr})" in upgrade, name
            assert f"drop constraint {name}" in _norm(ROLLBACK_SQL), name
    assert "ck_cli_amount_positive check (amount > 0)" in _norm(COLLECTION_SQL)
    for index in LedgerItem.__table__.indexes:
        assert index.name in UPGRADE_SQL or index.name in COLLECTION_SQL, index.name
    assert "uq_li" not in UPGRADE_SQL  # any number of base amounts per proceeding


def test_collection_migration_cannot_recreate_the_renamed_table():
    guard = COLLECTION_SQL.index("to_regclass('public.ledger_items') IS NULL")
    assert guard < COLLECTION_SQL.index("CREATE TABLE IF NOT EXISTS collection_ledger_items (") < COLLECTION_SQL.index("END $ledger$")
