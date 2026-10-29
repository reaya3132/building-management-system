"""Collection module: the month navigator counts and the ledger PDF statement."""
from __future__ import annotations

from decimal import Decimal

import pytest

from backend.api.v1.endpoints import collection_tasks as endpoints
from backend.services.collection_statement_pdf import render_statement_pdf, StatementLine
from backend.services.pdf_hebrew import register_hebrew_font, rtl
from backend.tests.test_collection_tasks_api import (  # noqa: F401  (fixtures)
    API,
    _audit_actions,
    _auth,
    _code,
    _create,
    _grant,
    _ledger,
    _single,
    other_member,
    project,
)


def _months(response) -> dict[str, int]:
    assert response.status_code == 200, response.text
    return {m["month"][:7]: m["count"] for m in response.json()["months"]}


@pytest.mark.asyncio
class TestMonthCounts:
    async def test_counts_not_closed_per_month_for_twelve_months(self, test_client, admin_user, project):
        a = await _create(test_client, admin_user, _single(project.id, [admin_user.id]))
        await _create(test_client, admin_user, _ledger(project.id, [admin_user.id]))
        closed = await _create(test_client, admin_user, _single(project.id, [admin_user.id]))
        await test_client.post(f"{API}/{closed['id']}/status", headers=_auth(admin_user), json={"status": "closed"})
        await test_client.post(f"{API}/{a['id']}/status", headers=_auth(admin_user), json={"status": "in_progress"})
        await _create(test_client, admin_user, _single(project.id, [admin_user.id], billing_month="2026-03"))
        await _create(test_client, admin_user, _single(project.id, [admin_user.id], billing_month="2027-01"))

        counts = _months(await test_client.get(f"{API}/month-counts", params={"year": 2026}, headers=_auth(admin_user)))
        assert len(counts) == 12
        assert counts["2026-10"] == 2   # open + in progress; the closed one is not counted
        assert counts["2026-03"] == 1
        assert counts["2026-01"] == 0   # 2027-01 belongs to another year

    async def test_independent_of_page_filters(self, test_client, admin_user, project):
        await _create(test_client, admin_user, _single(project.id, [admin_user.id]))
        await _create(test_client, admin_user, _ledger(project.id, [admin_user.id]))
        filtered = await test_client.get(
            f"{API}/month-counts",
            params={"year": 2026, "collection_type": "single", "project_id": 999999, "status": "closed", "search": "zzz"},
            headers=_auth(admin_user),
        )
        assert _months(filtered)["2026-10"] == 2

    async def test_archived_left_out_like_the_default_list(self, test_client, admin_user, project):
        task = await _create(test_client, admin_user, _single(project.id, [admin_user.id]))
        await test_client.post(f"{API}/{task['id']}/archive", headers=_auth(admin_user))
        counts = _months(await test_client.get(f"{API}/month-counts", params={"year": 2026}, headers=_auth(admin_user)))
        assert counts["2026-10"] == 0
        await test_client.post(f"{API}/{task['id']}/unarchive", headers=_auth(admin_user))
        counts = _months(await test_client.get(f"{API}/month-counts", params={"year": 2026}, headers=_auth(admin_user)))
        assert counts["2026-10"] == 1

    async def test_visibility_and_read_permission(self, test_client, test_db, admin_user, member_user, project):
        await _create(test_client, admin_user, _single(project.id, [member_user.id]))
        await _create(test_client, admin_user, _single(project.id, [admin_user.id]))
        url = f"{API}/month-counts"
        assert (await test_client.get(url, params={"year": 2026}, headers=_auth(member_user))).status_code == 403
        await _grant(test_db, member_user, "read")
        assert _months(await test_client.get(url, params={"year": 2026}, headers=_auth(member_user)))["2026-10"] == 1


@pytest.mark.asyncio
class TestStatement:
    async def test_ledger_pdf_reflects_the_sent_lines_and_total(self, test_client, admin_user, project, monkeypatch):
        captured = {}

        def fake_render(**kwargs):
            captured.update(kwargs)
            return b"%PDF-fake"

        monkeypatch.setattr(endpoints, "render_statement_pdf", fake_render)
        task = await _create(test_client, admin_user, _ledger(project.id, [admin_user.id]))
        body = {"items": [{"subject": "ועד בית (מעודכן)", "amount": "300.00"}, {"subject": "שורה למסמך", "amount": "19.99"}]}
        response = await test_client.post(f"{API}/{task['id']}/statement.pdf", headers=_auth(admin_user), json=body)

        assert response.status_code == 200, response.text
        assert response.headers["content-type"] == "application/pdf"
        assert response.content == b"%PDF-fake"
        assert [(line.subject, line.amount) for line in captured["lines"]] == [
            ("ועד בית (מעודכן)", Decimal("300.00")), ("שורה למסמך", Decimal("19.99")),
        ]
        assert captured["total"] == Decimal("319.99")
        assert captured["project"] == project.name
        assert captured["billing_month"].isoformat() == "2026-10-01"

    async def test_export_does_not_change_the_ledger(self, test_client, test_db, admin_user, project):
        task = await _create(test_client, admin_user, _ledger(project.id, [admin_user.id]))
        before = (await test_client.get(f"{API}/{task['id']}", headers=_auth(admin_user))).json()
        history_before = await _audit_actions(test_db, task["id"])

        response = await test_client.post(
            f"{API}/{task['id']}/statement.pdf", headers=_auth(admin_user),
            json={"items": [{"subject": "רק במסמך", "amount": "1.00"}]},
        )
        assert response.status_code == 200
        assert response.content.startswith(b"%PDF")

        after = (await test_client.get(f"{API}/{task['id']}", headers=_auth(admin_user))).json()
        assert after["total_amount"] == before["total_amount"] == "330.50"
        assert [(i["subject"], i["amount"]) for i in after["ledger_items"]] == \
            [(i["subject"], i["amount"]) for i in before["ledger_items"]]
        assert await _audit_actions(test_db, task["id"]) == history_before

    async def test_single_rejected_with_existing_code(self, test_client, admin_user, project):
        task = await _create(test_client, admin_user, _single(project.id, [admin_user.id]))
        response = await test_client.post(f"{API}/{task['id']}/statement.pdf", headers=_auth(admin_user), json={"items": []})
        assert response.status_code == 409
        assert _code(response) == "wrong_collection_type"

    async def test_access_rules(self, test_client, test_db, admin_user, member_user, other_member, project):
        task = await _create(test_client, admin_user, _ledger(project.id, [member_user.id]))
        url = f"{API}/{task['id']}/statement.pdf"
        assert (await test_client.post(url, headers=_auth(member_user), json={"items": []})).status_code == 403
        await _grant(test_db, member_user, "read")
        await _grant(test_db, other_member, "read")
        assert (await test_client.post(url, headers=_auth(member_user), json={"items": []})).status_code == 200
        assert (await test_client.post(url, headers=_auth(other_member), json={"items": []})).status_code == 403

    @pytest.mark.parametrize("item", [
        {"subject": "x", "amount": "0"},
        {"subject": "x", "amount": "1.001"},
        {"subject": " ", "amount": "5"},
        {"subject": "x", "amount": "5", "id": 1},
    ])
    async def test_invalid_lines_rejected(self, test_client, admin_user, project, item):
        task = await _create(test_client, admin_user, _ledger(project.id, [admin_user.id]))
        response = await test_client.post(f"{API}/{task['id']}/statement.pdf", headers=_auth(admin_user), json={"items": [item]})
        assert response.status_code == 422


class TestPdfHebrew:
    def test_rtl_reorders_hebrew_and_keeps_numbers(self):
        assert rtl("שלום") == "םולש"
        assert rtl("סה\"כ 100") .endswith("כ\"הס")
        assert rtl(None) == ""

    def test_renders_a_pdf_with_a_hebrew_font(self):
        assert register_hebrew_font() in ("HebrewShared", "Helvetica")
        from datetime import date
        content = render_statement_pdf(billing_month=date(2026, 10, 1), project="בניין א › כניסה 1",
                                       lines=[StatementLine("ועד בית", Decimal("250.00"))], total=Decimal("250.00"))
        assert content.startswith(b"%PDF")


class _FakeFace:
    def __init__(self, chars: str):
        self.charToGlyph = {ord(c): i for i, c in enumerate(chars)}


class _FakeFont:
    def __init__(self, name, path):
        self.fontName = name
        self.path = path
        # "hebrew-only" mimics NotoSansHebrew: Hebrew and ₪, but no digits / punctuation.
        hebrew = "אבגדהוזחטיכלמנסעפצקרשתךםןףץ₪ "
        self.face = _FakeFace(hebrew if "hebrew-only" in path else hebrew + "0123456789.,:;-–\"'()/%›#ABCabc")


class TestHebrewFontSelection:
    """Regression: the Docker image's NotoSansHebrew has no digits or
    punctuation, so amounts, years and quotes vanished from the statement."""

    def test_font_covers_requires_digits_and_punctuation(self):
        from backend.services.pdf_hebrew import font_covers
        assert font_covers(_FakeFont("x", "/fonts/full.ttf"))
        assert not font_covers(_FakeFont("x", "/fonts/hebrew-only.ttf"))

    def test_skips_a_hebrew_only_font_for_a_complete_one(self, monkeypatch):
        import os
        from reportlab.pdfbase import pdfmetrics, ttfonts
        from backend.services import pdf_hebrew

        registered = []
        monkeypatch.setattr(pdf_hebrew, "_FONT_CANDIDATES", ["/fonts/hebrew-only.ttf", "/fonts/full.ttf"])
        monkeypatch.setattr(os.path, "exists", lambda p: p.startswith("/fonts/"))
        monkeypatch.setattr(ttfonts, "TTFont", _FakeFont)
        monkeypatch.setattr(pdfmetrics, "registerFont", registered.append)
        pdf_hebrew.register_hebrew_font.cache_clear()
        try:
            assert pdf_hebrew.register_hebrew_font() == pdf_hebrew.HEBREW_FONT_NAME
            assert [f.path for f in registered] == ["/fonts/full.ttf"]
        finally:
            pdf_hebrew.register_hebrew_font.cache_clear()

    def test_the_chosen_font_draws_every_character_of_a_statement(self):
        from reportlab.pdfbase import pdfmetrics
        from backend.services.collection_statement_pdf import format_ils, format_month
        from backend.services.pdf_hebrew import font_covers

        name = register_hebrew_font()
        if name == "Helvetica":
            pytest.skip("no Hebrew font installed in this environment")
        from datetime import date
        text = " ".join([
            format_month(date(2026, 10, 1)), "בניין א › כניסה 1", 'סה"כ', "ועד בית (מעודכן) - 3 חודשים",
            format_ils(Decimal("1234.56")), format_ils(Decimal("20.00")),
        ])
        assert font_covers(pdfmetrics.getFont(name), text)

    def test_rtl_keeps_numbers_and_full_subject(self):
        shown = rtl("כרטסת 12 (מעודכן)")
        assert "12" in shown                       # digits stay in reading order
        assert sorted(shown) == sorted("כרטסת 12 (מעודכן)")  # nothing dropped
        from backend.services.collection_statement_pdf import format_ils
        assert format_ils(Decimal("1234.56")) == "₪1,234.56"  # amounts are not passed through bidi
