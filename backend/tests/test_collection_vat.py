"""Collection VAT (מע״מ): the calculation, the frozen rate, the API, the statement,
amounts saved before VAT support, and the isolation of the legal ledger.

Rule (services/vat.py), per amount, ROUND_HALF_UP to the agora:
  VAT excluded: vat = round(amount × rate);           to pay = amount + vat
  VAT included: vat = round(amount × rate / (1+rate)); to pay = amount
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from backend.api.v1.endpoints import collection_tasks as endpoints
from backend.core.config import parse_vat_rate, settings
from backend.models.collection_task import CollectionLedgerItem, CollectionTaskDetails
from backend.models.ledger_item import LedgerItem
from backend.repositories.collection_task_repository import CollectionTaskRepository
from backend.services.vat import VatBreakdown, sum_breakdowns, vat_breakdown
from backend.tests.test_collection_tasks_api import (  # noqa: F401  (fixtures)
    API,
    _audit_details,
    _auth,
    _code,
    _create,
    _ledger,
    _single,
    project,
)

D = Decimal


@pytest.fixture(autouse=True)
def _rate_18(monkeypatch):
    """Every test starts at 18%; a test changes it to model a later VAT_RATE."""
    monkeypatch.setattr(settings, "VAT_RATE", D("0.1800"))


# ── the calculation ──────────────────────────────────────────────────────────

class TestVatBreakdown:
    def test_example_from_the_spec(self):
        assert vat_breakdown(D("1000.00"), False, D("0.18")) == VatBreakdown(D("1000.00"), D("180.00"), D("1180.00"))
        assert vat_breakdown(D("1000.00"), True, D("0.18")) == VatBreakdown(D("847.46"), D("152.54"), D("1000.00"))

    @pytest.mark.parametrize("amount, included, rate, net, vat, gross", [
        # exact half agora rounds up (0.25 × 0.18 = 0.045 → 0.05)
        ("0.25", False, "0.18", "0.25", "0.05", "0.30"),
        ("0.25", False, "0.1800", "0.25", "0.05", "0.30"),
        # just below half (0.24 × 0.18 = 0.0432 → 0.04)
        ("0.24", False, "0.18", "0.24", "0.04", "0.28"),
        # the smallest amount
        ("0.01", False, "0.18", "0.01", "0.00", "0.01"),
        ("0.01", True, "0.18", "0.01", "0.00", "0.01"),
        # 1000.25 × 0.18 = 180.045 → 180.05 (a float would give 180.04)
        ("1000.25", False, "0.18", "1000.25", "180.05", "1180.30"),
        # included: 118 × 0.18 / 1.18 = 18 exactly
        ("118.00", True, "0.18", "100.00", "18.00", "118.00"),
        # a rate with four decimals: 1000 × 0.1750 = 175
        ("1000.00", False, "0.1750", "1000.00", "175.00", "1175.00"),
        ("33.33", True, "0.1750", "28.37", "4.96", "33.33"),
        # zero rate
        ("99.99", False, "0", "99.99", "0.00", "99.99"),
        ("99.99", True, "0.0000", "99.99", "0.00", "99.99"),
        # the largest amount the column holds
        # 999,999,999,999 agorot × 0.18 = 179,999,999,999.82 agorot → 180,000,000,000
        ("9999999999.99", False, "0.18", "9999999999.99", "1800000000.00", "11799999999.99"),
    ])
    def test_rounding_cases(self, amount, included, rate, net, vat, gross):
        assert vat_breakdown(D(amount), included, D(rate)) == VatBreakdown(D(net), D(vat), D(gross))

    def test_net_plus_vat_is_gross_for_many_amounts(self):
        for agorot in range(1, 5001, 7):
            amount = D(agorot) / 100
            for included in (True, False):
                b = vat_breakdown(amount, included, D("0.18"))
                assert b.net + b.vat == b.gross
                assert b.gross == (amount if included else amount + b.vat)

    def test_unknown_facts_have_no_breakdown(self):
        assert vat_breakdown(D("50.00"), None, None) == VatBreakdown(None, None, D("50.00"))

    def test_totals_are_the_sum_of_rounded_lines(self):
        parts = [vat_breakdown(D("0.25"), False, D("0.18")) for _ in range(3)]
        total = sum_breakdowns(parts)
        # 3 × 0.05, not round(0.75 × 0.18) = 0.14
        assert (total.net, total.vat, total.gross) == (D("0.75"), D("0.15"), D("0.90"))

    def test_a_single_unknown_line_hides_the_breakdown(self):
        total = sum_breakdowns([vat_breakdown(D("10.00"), False, D("0.18")), vat_breakdown(D("5.00"), None, None)])
        assert (total.net, total.vat, total.gross) == (None, None, D("16.80"))


class TestVatRateSetting:
    @pytest.mark.parametrize("raw, expected", [("0.18", "0.1800"), (" 0.175 ", "0.1750"), ("0", "0.0000")])
    def test_valid(self, raw, expected):
        assert parse_vat_rate(raw) == D(expected)

    @pytest.mark.parametrize("raw", [None, "", "  ", "abc", "18", "1", "-0.01", "0.18001", "NaN", "Infinity"])
    def test_missing_or_invalid_refuses_to_start(self, raw):
        with pytest.raises(ValueError, match="VAT_RATE"):
            parse_vat_rate(raw)


# ── the SQL total equals Python ──────────────────────────────────────────────

async def _sql_total(db, task_id: int) -> Decimal:
    return D(str(await CollectionTaskRepository(db).total_for(task_id))).quantize(D("0.01"))


@pytest.mark.asyncio
class TestApi:
    async def test_single_excluded_vat_on_the_initial_amount_only(self, test_client, test_db, admin_user, project):
        task = await _create(test_client, admin_user, _single(project.id, [admin_user.id], initial_vat_included=False))
        assert task["total_amount"] == "1180.00"
        assert task["initial_vat"] == {"vat_included": False, "vat_rate": "0.1800", "net_amount": "1000.00",
                                       "vat_amount": "180.00", "gross_amount": "1180.00"}
        assert task["total_net_amount"] is None and task["total_vat_amount"] is None

        # Adjustments carry no VAT: +200 adds exactly 200, -1380 is the exact floor.
        r = await test_client.post(f"{API}/{task['id']}/adjustments", headers=_auth(admin_user),
                                   json={"amount": "200.00", "note": "תוספת"})
        assert r.json()["total_amount"] == "1380.00"
        r = await test_client.post(f"{API}/{task['id']}/adjustments", headers=_auth(admin_user),
                                   json={"amount": "-1380.01", "note": "יותר מדי"})
        assert r.status_code == 422 and _code(r) == "total_negative"
        r = await test_client.post(f"{API}/{task['id']}/adjustments", headers=_auth(admin_user),
                                   json={"amount": "-1380.00", "note": "הכל"})
        assert r.json()["total_amount"] == "0.00"
        assert await _sql_total(test_db, task["id"]) == D("0.00")

    async def test_omitted_choice_means_included(self, test_client, admin_user, project):
        single = await _create(test_client, admin_user, _single(project.id, [admin_user.id]))
        assert single["total_amount"] == "1000.00"
        assert single["initial_vat"]["vat_included"] is True
        assert single["initial_vat"]["vat_amount"] == "152.54"
        ledger = await _create(test_client, admin_user, _ledger(project.id, [admin_user.id]))
        assert ledger["total_amount"] == "330.50"
        assert all(i["vat_included"] is True and i["vat_rate"] == "0.1800" for i in ledger["ledger_items"])

    async def test_ledger_mixed_items(self, test_client, test_db, admin_user, project):
        body = _ledger(project.id, [admin_user.id], items=[
            {"subject": "א", "amount": "1000.00", "vat_included": False},
            {"subject": "ב", "amount": "1000.00", "vat_included": True},
        ])
        task = await _create(test_client, admin_user, body)
        assert task["total_amount"] == "2180.00"
        assert (task["total_net_amount"], task["total_vat_amount"]) == ("1847.46", "332.54")
        assert [i["gross_amount"] for i in task["ledger_items"]] == ["1180.00", "1000.00"]
        assert await _sql_total(test_db, task["id"]) == D("2180.00")

        # The list and the month summary use the same SQL total.
        page = (await test_client.get(f"{API}/", params={"month": "2026-10"}, headers=_auth(admin_user))).json()
        assert page["items"][0]["total_amount"] == "2180.00"
        summary = (await test_client.get(f"{API}/summary", params={"month": "2026-10"}, headers=_auth(admin_user))).json()
        assert summary["total_amount"] == "2180.00"

        # Archiving an item removes its amount to pay from the total and the breakdown.
        r = await test_client.post(f"{API}/{task['id']}/ledger-items/{task['ledger_items'][0]['id']}/archive",
                                   headers=_auth(admin_user))
        assert r.json()["total_amount"] == "1000.00"

    async def test_sum_of_rounded_lines_equals_the_total(self, test_client, test_db, admin_user, project):
        items = [{"subject": f"s{n}", "amount": amount, "vat_included": included}
                 for n, (amount, included) in enumerate([("0.25", False), ("0.25", False), ("0.25", False),
                                                         ("33.33", True), ("1000.25", False), ("0.01", False)])]
        task = await _create(test_client, admin_user, _ledger(project.id, [admin_user.id], items=items))
        lines = sum(D(i["gross_amount"]) for i in task["ledger_items"])
        assert D(task["total_amount"]) == lines == await _sql_total(test_db, task["id"])
        assert D(task["total_net_amount"]) + D(task["total_vat_amount"]) == lines

    async def test_ledger_rejects_an_initial_vat_choice(self, test_client, admin_user, project):
        r = await test_client.post(f"{API}/", headers=_auth(admin_user),
                                   json=_ledger(project.id, [admin_user.id], initial_vat_included=False))
        assert r.status_code == 422

    async def test_a_rate_from_the_client_is_never_accepted(self, test_client, admin_user, project):
        r = await test_client.post(f"{API}/", headers=_auth(admin_user), json=_ledger(
            project.id, [admin_user.id], items=[{"subject": "x", "amount": "10.00", "vat_rate": "0.5"}]))
        assert r.status_code == 422

    async def test_a_new_vat_rate_never_changes_saved_amounts(self, test_client, test_db, admin_user, project, monkeypatch):
        task = await _create(test_client, admin_user, _ledger(project.id, [admin_user.id], items=[
            {"subject": "א", "amount": "1000.00", "vat_included": False}]))
        item_id = task["ledger_items"][0]["id"]
        monkeypatch.setattr(settings, "VAT_RATE", D("0.2000"))

        detail = (await test_client.get(f"{API}/{task['id']}", headers=_auth(admin_user))).json()
        assert detail["total_amount"] == "1180.00" and detail["ledger_items"][0]["vat_rate"] == "0.1800"

        # Subject only: the frozen rate stays.
        r = await test_client.patch(f"{API}/{task['id']}/ledger-items/{item_id}", headers=_auth(admin_user),
                                    json={"subject": "א מעודכן"})
        assert r.json()["item"]["vat_rate"] == "0.1800" and r.json()["total_amount"] == "1180.00"

        # A new item freezes the new rate; the old one keeps its own.
        r = await test_client.post(f"{API}/{task['id']}/ledger-items", headers=_auth(admin_user),
                                   json={"subject": "ב", "amount": "1000.00", "vat_included": False})
        assert r.json()["item"]["vat_rate"] == "0.2000" and r.json()["total_amount"] == "2380.00"

        # Changing the amount (or the choice) freezes the rate in force now.
        r = await test_client.patch(f"{API}/{task['id']}/ledger-items/{item_id}", headers=_auth(admin_user),
                                    json={"amount": "500.00"})
        assert r.json()["item"]["vat_rate"] == "0.2000" and r.json()["item"]["gross_amount"] == "600.00"
        logged = (await _audit_details(test_db, task["id"], "ledger_item_updated"))[-1]
        assert logged["before"]["vat_rate"] == "0.1800" and logged["after"]["vat_rate"] == "0.2000"

    async def test_initial_amount_choice_and_rate(self, test_client, test_db, admin_user, project, monkeypatch):
        task = await _create(test_client, admin_user, _single(project.id, [admin_user.id]))
        url = f"{API}/{task['id']}/initial-amount"
        # Only the choice changes: excluded now, rate frozen again.
        monkeypatch.setattr(settings, "VAT_RATE", D("0.1700"))
        r = await test_client.patch(url, headers=_auth(admin_user),
                                    json={"initial_amount": "1000.00", "initial_vat_included": False})
        assert r.status_code == 200, r.text
        assert r.json()["initial_vat"]["vat_rate"] == "0.1700" and r.json()["total_amount"] == "1170.00"
        # Same amount and choice: nothing happens (no new history entry).
        before = len(await _audit_details(test_db, task["id"], "initial_amount_changed"))
        await test_client.patch(url, headers=_auth(admin_user), json={"initial_amount": "1000.00"})
        assert len(await _audit_details(test_db, task["id"], "initial_amount_changed")) == before

    async def test_initial_amount_negative_check_uses_the_amount_to_pay(self, test_client, admin_user, project):
        task = await _create(test_client, admin_user, _single(project.id, [admin_user.id], initial_amount="100.00"))
        await test_client.post(f"{API}/{task['id']}/adjustments", headers=_auth(admin_user),
                               json={"amount": "-100.00", "note": "הנחה"})
        url = f"{API}/{task['id']}/initial-amount"
        # 90 + VAT = 106.20 >= 100: allowed.
        r = await test_client.patch(url, headers=_auth(admin_user),
                                    json={"initial_amount": "90.00", "initial_vat_included": False})
        assert r.status_code == 200 and r.json()["total_amount"] == "6.20"
        # 80 incl. VAT < 100: rejected.
        r = await test_client.patch(url, headers=_auth(admin_user),
                                    json={"initial_amount": "80.00", "initial_vat_included": True})
        assert r.status_code == 422 and _code(r) == "total_negative"


# ── amounts saved before VAT support ─────────────────────────────────────────

async def _make_legacy(db, task_id: int) -> None:
    """Back to the state of a row saved before VAT support (both facts NULL)."""
    await db.execute(text("UPDATE collection_task_details SET initial_vat_included = NULL, initial_vat_rate = NULL "
                          "WHERE task_id = :t"), {"t": task_id})
    await db.execute(text("UPDATE ledger_items SET vat_included = NULL, vat_rate = NULL WHERE task_id = :t"),
                     {"t": task_id})
    await db.commit()


@pytest.mark.asyncio
class TestLegacyAmounts:
    async def test_totals_unchanged_and_no_breakdown(self, test_client, test_db, admin_user, project):
        single = await _create(test_client, admin_user, _single(project.id, [admin_user.id]))
        ledger = await _create(test_client, admin_user, _ledger(project.id, [admin_user.id]))
        await _make_legacy(test_db, single["id"])
        await _make_legacy(test_db, ledger["id"])

        s = (await test_client.get(f"{API}/{single['id']}", headers=_auth(admin_user))).json()
        assert s["total_amount"] == "1000.00"
        assert s["initial_vat"] == {"vat_included": None, "vat_rate": None, "net_amount": None,
                                    "vat_amount": None, "gross_amount": "1000.00"}
        l_ = (await test_client.get(f"{API}/{ledger['id']}", headers=_auth(admin_user))).json()
        assert l_["total_amount"] == "330.50" and l_["total_net_amount"] is None and l_["total_vat_amount"] is None
        assert await _sql_total(test_db, single["id"]) == D("1000.00")
        assert await _sql_total(test_db, ledger["id"]) == D("330.50")

    async def test_subject_edit_keeps_null_amount_edit_needs_a_choice(self, test_client, test_db, admin_user, project):
        task = await _create(test_client, admin_user, _ledger(project.id, [admin_user.id]))
        await _make_legacy(test_db, task["id"])
        item_url = f"{API}/{task['id']}/ledger-items/{task['ledger_items'][0]['id']}"

        r = await test_client.patch(item_url, headers=_auth(admin_user), json={"subject": "ועד בית"})
        assert r.status_code == 200 and r.json()["item"]["vat_included"] is None

        r = await test_client.patch(item_url, headers=_auth(admin_user), json={"amount": "300.00"})
        assert r.status_code == 422 and _code(r) == "vat_choice_required"

        r = await test_client.patch(item_url, headers=_auth(admin_user), json={"amount": "300.00", "vat_included": True})
        assert r.status_code == 200 and r.json()["item"]["vat_rate"] == "0.1800"

    async def test_initial_amount_edit_needs_a_choice(self, test_client, test_db, admin_user, project):
        task = await _create(test_client, admin_user, _single(project.id, [admin_user.id]))
        await _make_legacy(test_db, task["id"])
        url = f"{API}/{task['id']}/initial-amount"
        r = await test_client.patch(url, headers=_auth(admin_user), json={"initial_amount": "900.00"})
        assert r.status_code == 422 and _code(r) == "vat_choice_required"
        r = await test_client.patch(url, headers=_auth(admin_user),
                                    json={"initial_amount": "900.00", "initial_vat_included": False})
        assert r.status_code == 200 and r.json()["total_amount"] == "1062.00"


# ── the statement (PDF) ──────────────────────────────────────────────────────

@pytest.mark.asyncio
class TestStatementVat:
    async def _capture(self, monkeypatch):
        captured = {}

        def fake_render(**kwargs):
            captured.update(kwargs)
            return b"%PDF-fake"

        monkeypatch.setattr(endpoints, "render_statement_pdf", fake_render)
        return captured

    async def test_lines_are_amounts_to_pay_with_the_frozen_rate(self, test_client, admin_user, project, monkeypatch):
        captured = await self._capture(monkeypatch)
        task = await _create(test_client, admin_user, _ledger(project.id, [admin_user.id], items=[
            {"subject": "א", "amount": "1000.00", "vat_included": False},
            {"subject": "ב", "amount": "1000.00", "vat_included": True},
        ]))
        a, b = task["ledger_items"]
        monkeypatch.setattr(settings, "VAT_RATE", D("0.2000"))  # new lines only
        body = {"items": [
            {"subject": "א", "amount": "1000.00", "item_id": a["id"]},
            {"subject": "ב", "amount": "1000.00", "item_id": b["id"]},
            {"subject": "חדש", "amount": "100.00", "vat_included": False},
        ]}
        r = await test_client.post(f"{API}/{task['id']}/statement.pdf", headers=_auth(admin_user), json=body)
        assert r.status_code == 200, r.text
        assert [line.amount for line in captured["lines"]] == [D("1180.00"), D("1000.00"), D("120.00")]
        assert (captured["net_total"], captured["vat_total"], captured["total"]) == \
            (D("1947.46"), D("352.54"), D("2300.00"))

    async def test_an_unknown_line_hides_the_breakdown(self, test_client, test_db, admin_user, project, monkeypatch):
        captured = await self._capture(monkeypatch)
        task = await _create(test_client, admin_user, _ledger(project.id, [admin_user.id]))
        await _make_legacy(test_db, task["id"])
        item = task["ledger_items"][0]
        r = await test_client.post(f"{API}/{task['id']}/statement.pdf", headers=_auth(admin_user), json={"items": [
            {"subject": "ישן", "amount": "250.00", "item_id": item["id"]},
            {"subject": "חדש", "amount": "100.00"},
        ]})
        assert r.status_code == 200
        assert [line.amount for line in captured["lines"]] == [D("250.00"), D("100.00")]
        assert captured["total"] == D("350.00")
        assert captured["net_total"] is None and captured["vat_total"] is None

    async def test_a_foreign_or_archived_item_is_rejected(self, test_client, admin_user, project):
        task = await _create(test_client, admin_user, _ledger(project.id, [admin_user.id]))
        other = await _create(test_client, admin_user, _ledger(project.id, [admin_user.id]))
        url = f"{API}/{task['id']}/statement.pdf"
        r = await test_client.post(url, headers=_auth(admin_user), json={"items": [
            {"subject": "x", "amount": "1.00", "item_id": other["ledger_items"][0]["id"]}]})
        assert r.status_code == 422 and _code(r) == "statement_item_not_found"

    async def test_the_real_pdf_renders_with_a_breakdown(self, test_client, admin_user, project):
        task = await _create(test_client, admin_user, _ledger(project.id, [admin_user.id], items=[
            {"subject": "א", "amount": "1000.00", "vat_included": False}]))
        r = await test_client.post(f"{API}/{task['id']}/statement.pdf", headers=_auth(admin_user), json={"items": [
            {"subject": "א", "amount": "1000.00", "item_id": task["ledger_items"][0]["id"]}]})
        assert r.status_code == 200 and r.content.startswith(b"%PDF")


# ── database rules ───────────────────────────────────────────────────────────

@pytest.mark.asyncio
class TestDatabaseRules:
    async def test_legal_items_can_never_hold_vat(self, test_db, admin_user):
        now = datetime(2026, 11, 24)
        base = dict(task_id=None, legal_proceeding_id=1, item_type="addition", subject="x", amount=D("10.00"),
                    created_by_user_id=admin_user.id, created_at=now, updated_at=now)
        test_db.add(LedgerItem(**base, vat_included=True, vat_rate=D("0.18")))
        with pytest.raises(IntegrityError, match="ck_li_vat"):
            await test_db.flush()
        await test_db.rollback()

    async def test_vat_facts_come_in_pairs(self, test_client, test_db, admin_user, project):
        task = await _create(test_client, admin_user, _ledger(project.id, [admin_user.id]))
        item = (await test_db.execute(select(CollectionLedgerItem).where(
            CollectionLedgerItem.task_id == task["id"]))).scalars().first()
        item.vat_rate = None
        with pytest.raises(IntegrityError, match="ck_li_vat"):
            await test_db.flush()
        await test_db.rollback()

    async def test_a_ledger_task_has_no_initial_vat(self, test_client, test_db, admin_user, project):
        task = await _create(test_client, admin_user, _ledger(project.id, [admin_user.id]))
        details = await test_db.get(CollectionTaskDetails, task["id"])
        details.initial_vat_included, details.initial_vat_rate = True, D("0.18")
        with pytest.raises(IntegrityError, match="ck_ctd_initial_vat"):
            await test_db.flush()
        await test_db.rollback()


# ── single-task adjustments ──────────────────────────────────────────────────

async def _adjust(client, user, task_id, amount, vat_included=None, note="שינוי"):
    body = {"amount": amount, "note": note, **({} if vat_included is None else {"vat_included": vat_included})}
    return await client.post(f"{API}/{task_id}/adjustments", headers=_auth(user), json=body)


@pytest.mark.asyncio
class TestAdjustmentVat:
    async def test_included_and_excluded_additions(self, test_client, test_db, admin_user, project):
        task = await _create(test_client, admin_user, _single(project.id, [admin_user.id]))  # 1000 incl.
        r = await _adjust(test_client, admin_user, task["id"], "100.00", True)
        assert r.status_code == 201 and r.json()["total_amount"] == "1100.00"
        assert r.json()["adjustment"]["vat_included"] is True and r.json()["adjustment"]["gross_amount"] == "100.00"
        r = await _adjust(test_client, admin_user, task["id"], "100.00", False)
        assert r.json()["total_amount"] == "1218.00" and r.json()["adjustment"]["gross_amount"] == "118.00"
        # Omitted = included.
        r = await _adjust(test_client, admin_user, task["id"], "1.00")
        assert r.json()["adjustment"]["vat_included"] is True and r.json()["total_amount"] == "1219.00"
        assert await _sql_total(test_db, task["id"]) == D("1219.00")

    async def test_mixed_signed_adjustments_and_the_rounded_lines_add_up(self, test_client, test_db, admin_user, project):
        task = await _create(test_client, admin_user, _single(project.id, [admin_user.id]))
        for amount, included in [("0.25", False), ("-0.25", False), ("-100.00", False), ("33.33", True), ("1000.25", False)]:
            assert (await _adjust(test_client, admin_user, task["id"], amount, included)).status_code == 201
        detail = (await test_client.get(f"{API}/{task['id']}", headers=_auth(admin_user))).json()
        grosses = [D(a["gross_amount"]) for a in detail["adjustments"]]
        # A reduction mirrors the addition: +0.25 and -0.25 without VAT cancel exactly.
        assert grosses == [D("0.30"), D("-0.30"), D("-118.00"), D("33.33"), D("1180.30")]
        total = D(detail["initial_vat"]["gross_amount"]) + sum(grosses)
        assert D(detail["total_amount"]) == total == await _sql_total(test_db, task["id"]) == D("2095.63")

    async def test_a_new_rate_never_changes_a_saved_adjustment(self, test_client, admin_user, project, monkeypatch):
        task = await _create(test_client, admin_user, _single(project.id, [admin_user.id]))
        await _adjust(test_client, admin_user, task["id"], "100.00", False)  # 118 at 18%
        monkeypatch.setattr(settings, "VAT_RATE", D("0.2000"))
        detail = (await test_client.get(f"{API}/{task['id']}", headers=_auth(admin_user))).json()
        assert detail["total_amount"] == "1118.00" and detail["adjustments"][0]["vat_rate"] == "0.1800"
        r = await _adjust(test_client, admin_user, task["id"], "100.00", False)  # 120 at 20%
        assert r.json()["adjustment"]["vat_rate"] == "0.2000" and r.json()["total_amount"] == "1238.00"

    async def test_editing_the_vat_choice(self, test_client, test_db, admin_user, project, monkeypatch):
        task = await _create(test_client, admin_user, _single(project.id, [admin_user.id]))
        adj = (await _adjust(test_client, admin_user, task["id"], "100.00", True)).json()["adjustment"]
        url = f"{API}/{task['id']}/adjustments/{adj['id']}"
        monkeypatch.setattr(settings, "VAT_RATE", D("0.1700"))
        r = await test_client.patch(url, headers=_auth(admin_user), json={"vat_included": False})
        assert r.status_code == 200, r.text
        assert r.json()["adjustment"]["vat_rate"] == "0.1700" and r.json()["total_amount"] == "1117.00"
        assert (r.json()["adjustment"]["amount"], r.json()["adjustment"]["note"]) == ("100.00", "שינוי")
        logged = await _audit_details(test_db, task["id"], "adjustment_vat_changed")
        assert logged[-1]["before"]["vat_included"] is True and logged[-1]["after"]["vat_included"] is False
        # The same choice again: nothing changes, no new history entry.
        await test_client.patch(url, headers=_auth(admin_user), json={"vat_included": False})
        assert len(await _audit_details(test_db, task["id"], "adjustment_vat_changed")) == 1
        # Only the VAT choice may change.
        r = await test_client.patch(url, headers=_auth(admin_user), json={"vat_included": True, "amount": "5.00"})
        assert r.status_code == 422
        r = await test_client.patch(f"{API}/{task['id']}/adjustments/999999", headers=_auth(admin_user),
                                    json={"vat_included": True})
        assert r.status_code == 404 and _code(r) == "adjustment_not_found"

    async def test_the_total_never_goes_negative(self, test_client, admin_user, project):
        task = await _create(test_client, admin_user, _single(project.id, [admin_user.id], initial_amount="118.00"))
        # A reduction of 100 without VAT is 118: the exact floor.
        r = await _adjust(test_client, admin_user, task["id"], "-100.01", False)
        assert r.status_code == 422 and _code(r) == "total_negative"
        r = await _adjust(test_client, admin_user, task["id"], "-100.00", True)
        assert r.json()["total_amount"] == "18.00"
        # Turning that reduction into "without VAT" makes it -118: allowed (0.00) ...
        adj_id = r.json()["adjustment"]["id"]
        r = await test_client.patch(f"{API}/{task['id']}/adjustments/{adj_id}", headers=_auth(admin_user),
                                    json={"vat_included": False})
        assert r.status_code == 200 and r.json()["total_amount"] == "0.00"
        # ... but one more agora of reduction is not.
        r = await _adjust(test_client, admin_user, task["id"], "-0.01", True)
        assert r.status_code == 422 and _code(r) == "total_negative"

    async def test_editing_a_choice_cannot_make_the_total_negative(self, test_client, admin_user, project):
        task = await _create(test_client, admin_user, _single(project.id, [admin_user.id], initial_amount="110.00"))
        adj = (await _adjust(test_client, admin_user, task["id"], "-100.00", True)).json()["adjustment"]
        # Without VAT the reduction would be -118 > 110: rejected, nothing changes.
        r = await test_client.patch(f"{API}/{task['id']}/adjustments/{adj['id']}", headers=_auth(admin_user),
                                    json={"vat_included": False})
        assert r.status_code == 422 and _code(r) == "total_negative"
        detail = (await test_client.get(f"{API}/{task['id']}", headers=_auth(admin_user))).json()
        assert detail["total_amount"] == "10.00" and detail["adjustments"][0]["vat_included"] is True

    async def test_adjustments_saved_before_vat_support(self, test_client, test_db, admin_user, project):
        task = await _create(test_client, admin_user, _single(project.id, [admin_user.id]))
        adj = (await _adjust(test_client, admin_user, task["id"], "50.00", False)).json()["adjustment"]
        await test_db.execute(text("UPDATE collection_amount_adjustments SET vat_included = NULL, vat_rate = NULL "
                                   "WHERE task_id = :t"), {"t": task["id"]})
        await test_db.commit()
        detail = (await test_client.get(f"{API}/{task['id']}", headers=_auth(admin_user))).json()
        a = detail["adjustments"][0]
        assert (a["vat_included"], a["vat_rate"], a["vat_amount"], a["gross_amount"]) == (None, None, None, "50.00")
        assert detail["total_amount"] == "1050.00" and await _sql_total(test_db, task["id"]) == D("1050.00")
        # A first VAT choice can be made on it.
        r = await test_client.patch(f"{API}/{task['id']}/adjustments/{adj['id']}", headers=_auth(admin_user),
                                    json={"vat_included": False})
        assert r.json()["total_amount"] == "1059.00"

    async def test_wrong_type_and_closed_task(self, test_client, admin_user, project):
        ledger = await _create(test_client, admin_user, _ledger(project.id, [admin_user.id]))
        r = await test_client.patch(f"{API}/{ledger['id']}/adjustments/1", headers=_auth(admin_user),
                                    json={"vat_included": False})
        assert r.status_code == 409 and _code(r) == "wrong_collection_type"
        single = await _create(test_client, admin_user, _single(project.id, [admin_user.id]))
        adj = (await _adjust(test_client, admin_user, single["id"], "10.00", True)).json()["adjustment"]
        await test_client.post(f"{API}/{single['id']}/status", headers=_auth(admin_user), json={"status": "closed"})
        r = await test_client.patch(f"{API}/{single['id']}/adjustments/{adj['id']}", headers=_auth(admin_user),
                                    json={"vat_included": False})
        assert r.status_code == 409

    async def test_adjustment_vat_facts_come_in_pairs(self, test_client, test_db, admin_user, project):
        from backend.models.collection_task import CollectionAmountAdjustment
        task = await _create(test_client, admin_user, _single(project.id, [admin_user.id]))
        await _adjust(test_client, admin_user, task["id"], "10.00", True)
        adj = (await test_db.execute(select(CollectionAmountAdjustment).where(
            CollectionAmountAdjustment.task_id == task["id"]))).scalars().first()
        adj.vat_rate = None
        with pytest.raises(IntegrityError, match="ck_caa_vat"):
            await test_db.flush()
        await test_db.rollback()
