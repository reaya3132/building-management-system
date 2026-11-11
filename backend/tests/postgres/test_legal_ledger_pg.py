"""The legal ledger and card completion (test_legal_ledger) on the migrated PostgreSQL
schema, plus real concurrent transactions. TEST_POSTGRES_URL only."""
from __future__ import annotations

import asyncio
from decimal import Decimal

import pytest_asyncio
from fastapi import HTTPException
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker

from backend.models.contact import Contact
from backend.models.ledger_item import LedgerItem
from backend.models.user import User, UserRole
from backend.services.legal_proceeding_service import LegalProceedingService
from backend.tests.test_legal_ledger import *  # noqa: F401,F403

BASE = [{"subject": "בסיס", "amount": "10"}]
ROUNDS = 5


@pytest_asyncio.fixture
async def ctx(test_db, test_engine):
    user = User(email="ledger-locks@example.com", full_name="L", password_hash="x", role=UserRole.ADMIN.value,
                is_active=True, email_verified=True, requires_password_change=False)
    test_db.add(user)
    await test_db.commit()
    return user, async_sessionmaker(test_engine, expire_on_commit=False)


async def _run(maker, action):
    """One request: its own transaction, committed at the end."""
    async with maker() as db:
        try:
            result = await action(db)
            await db.commit()
            return result
        except HTTPException as exc:
            await db.rollback()
            return exc


def _details(phone):
    return {"kind": "person", "name": "c", "phone": phone, "email": "c@example.com", "address": "א", "apartment_number": "1"}


async def _open(maker, user, phone, **values):
    return (await _run(maker, lambda db: LegalProceedingService(db, user).create(
        {"party_role": "other", "title": "t", "base_items": BASE, **values}, contact={"details": _details(phone)}))).proceeding.id


async def _wait_for_row_lock(maker, timeout=10.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    sql = text("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() "
               "AND wait_event_type = 'Lock' AND wait_event IN ('transactionid', 'tuple')")
    while asyncio.get_running_loop().time() < deadline:
        async with maker() as db:
            if (await db.execute(sql)).scalar():
                return
        await asyncio.sleep(0.02)
    raise AssertionError("no transaction was blocked on a row lock")


async def test_parallel_additions_are_all_kept_in_order(ctx):
    user, maker = ctx
    pid = await _open(maker, user, "050-9100001")
    results = await asyncio.gather(*[
        _run(maker, lambda db, i=i: LegalProceedingService(db, user).add_ledger_item(pid, {"subject": f"פריט {i}", "amount": "5"}))
        for i in range(8)])
    assert not [r for r in results if isinstance(r, Exception)]
    async with maker() as db:
        orders = list((await db.execute(select(LedgerItem.sort_order).where(LedgerItem.legal_proceeding_id == pid))).scalars())
        total = await LegalProceedingService(db, user).ledger_total(pid)
    assert sorted(orders) == list(range(9)) and total == Decimal("50.00")


async def test_parallel_openings_each_get_all_their_base_items(ctx):
    user, maker = ctx
    bases = [{"subject": f"פריט {i}", "amount": "1"} for i in range(4)]
    ids = await asyncio.gather(*[_open(maker, user, f"050-92000{i:02d}", base_items=bases) for i in range(6)])
    async with maker() as db:
        rows = (await db.execute(select(LedgerItem.legal_proceeding_id, func.count()).where(
            LedgerItem.legal_proceeding_id.in_(ids), LedgerItem.item_type == "base_amount"
        ).group_by(LedgerItem.legal_proceeding_id))).all()
    assert sorted(n for _, n in rows) == [4] * 6


async def test_addition_waits_for_a_closing_transaction_then_fails(ctx):
    user, maker = ctx
    pid = await _open(maker, user, "050-9300001")
    async with maker() as closing:
        await LegalProceedingService(closing, user).close(pid, "סיום")
        waiter = asyncio.create_task(_run(maker, lambda db: LegalProceedingService(db, user).add_ledger_item(pid, {"subject": "א", "amount": "5"})))
        await _wait_for_row_lock(maker)
        assert not waiter.done()
        await closing.commit()
    result = await waiter
    assert isinstance(result, HTTPException) and result.detail["code"] == "proceeding_closed"
    async with maker() as db:
        assert await LegalProceedingService(db, user).ledger_total(pid) == Decimal("10.00")


async def test_parallel_completion_of_one_card_never_overwrites(ctx):
    user, maker = ctx
    for round_no in range(ROUNDS):
        async with maker() as db:
            card = Contact(kind="person", name="c", phone=f"050-94000{round_no:02d}")
            db.add(card)
            await db.commit()

        async def attempt(email):
            return await _run(maker, lambda db: LegalProceedingService(db, user).create(
                {"party_role": "other", "title": "t", "base_items": BASE},
                contact={"contact_id": card.id, "complete": {"email": email, "address": "א", "apartment_number": "1"}}))

        results = await asyncio.gather(attempt("first@example.com"), attempt("second@example.com"))
        winners = [r for r in results if not isinstance(r, Exception)]
        losers = [r for r in results if isinstance(r, HTTPException)]
        assert len(winners) == 1 and len(losers) == 1 and losers[0].detail["code"] == "contact_field_not_missing"
        async with maker() as db:
            stored = await db.get(Contact, card.id)
        assert stored.email == winners[0].contact.email


async def test_completing_a_phone_serializes_with_a_new_card(ctx):
    """Both directions take the phone's advisory lock: only one can skip the duplicate check."""
    user, maker = ctx
    for round_no in range(ROUNDS):
        phone = f"052-95000{round_no:02d}"
        async with maker() as db:
            card = Contact(kind="person", name="c", phone=f"050-95000{round_no:02d}", email="a@example.com", address="א", apartment_number="1")
            db.add(card)
            await db.commit()

        completing = _run(maker, lambda db: LegalProceedingService(db, user).create(
            {"party_role": "other", "title": "t", "base_items": BASE},
            contact={"contact_id": card.id, "complete": {"phone_2": phone}}))
        creating = _run(maker, lambda db: LegalProceedingService(db, user).create(
            {"party_role": "other", "title": "t", "base_items": BASE}, contact={"details": _details(phone)}))
        results = await asyncio.gather(completing, creating)
        conflicts = [r for r in results if isinstance(r, HTTPException) and r.status_code == 409]
        assert len(conflicts) == 1 and conflicts[0].detail["code"] == "duplicate_phone", results
