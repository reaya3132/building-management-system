"""Duplicate-phone check under real concurrent PostgreSQL transactions (TEST_POSTGRES_URL).

Each request runs in its own session on its own connection. Where order matters, the
test first waits until PostgreSQL itself reports the second transaction as blocked on
an advisory lock, so concurrency is observed rather than simulated.
"""
from __future__ import annotations

import asyncio

import pytest
import pytest_asyncio
from fastapi import HTTPException
from sqlalchemy import event, func, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker

from backend.models.contact import Contact
from backend.models.user import User, UserRole
from backend.services.contact_service import ContactService
from backend.services.legal_proceeding_service import LegalProceedingService

pytestmark = pytest.mark.asyncio

ROUNDS = 8


@pytest_asyncio.fixture
async def ctx(test_db, test_engine):
    user = User(email="locks@example.com", full_name="L", password_hash="x", role=UserRole.ADMIN.value,
                is_active=True, email_verified=True, requires_password_change=False)
    test_db.add(user)
    await test_db.commit()
    return user, test_engine, async_sessionmaker(test_engine, expire_on_commit=False)


def card(phone, phone_2=None, name="c"):
    return {"kind": "person", "name": name, "phone": phone, "phone_2": phone_2,
            "email": "c@example.com", "address": "רחוב", "apartment_number": "4"}


async def create(maker, user, values, **kw):
    """One request: its own transaction, committed at the end."""
    async with maker() as db:
        try:
            result = await ContactService(db, user).create(values, **kw)
            await db.commit()
            return result
        except HTTPException as exc:
            await db.rollback()
            return exc


async def count(maker) -> int:
    async with maker() as db:
        return (await db.execute(select(func.count(Contact.id)))).scalar()


async def wait_until_blocked(maker, timeout=10.0) -> None:
    """Until another backend of this database is waiting on an advisory lock."""
    deadline = asyncio.get_running_loop().time() + timeout
    sql = text("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() "
               "AND wait_event_type = 'Lock' AND wait_event = 'advisory'")
    while asyncio.get_running_loop().time() < deadline:
        async with maker() as db:
            if (await db.execute(sql)).scalar():
                return
        await asyncio.sleep(0.02)
    raise AssertionError("no transaction was blocked on the advisory lock")


def outcomes(results):
    created = [r for r in results if not isinstance(r, Exception)]
    blocked = [r for r in results if isinstance(r, HTTPException) and r.status_code == 409]
    return created, blocked


async def test_second_transaction_waits_and_is_blocked(ctx):
    user, _, maker = ctx
    values = card("050-1000001")
    async with maker() as first:
        created = await ContactService(first, user).create(values)
        waiter = asyncio.create_task(create(maker, user, values))
        await wait_until_blocked(maker)
        assert not waiter.done()  # it really waits for the first transaction
        await first.commit()
    second = await asyncio.wait_for(waiter, 10)
    assert created.has_match is False
    assert isinstance(second, HTTPException) and second.status_code == 409
    assert second.detail["code"] == "duplicate_phone" and set(second.detail) == {"code", "message", "has_match"}
    assert await count(maker) == 1


async def test_rolled_back_transaction_does_not_block_the_waiter(ctx):
    user, _, maker = ctx
    values = card("050-1000002")
    async with maker() as first:
        await ContactService(first, user).create(values)
        waiter = asyncio.create_task(create(maker, user, values))
        await wait_until_blocked(maker)
        await first.rollback()
    second = await asyncio.wait_for(waiter, 10)
    assert second.has_match is False and await count(maker) == 1


async def test_same_phone_concurrently_creates_exactly_one(ctx):
    user, _, maker = ctx
    for i in range(ROUNDS):
        before = await count(maker)
        values = card(f"050-20000{i:02d}")
        results = await asyncio.wait_for(asyncio.gather(*(create(maker, user, values) for _ in range(4))), 30)
        created, blocked = outcomes(results)
        assert (len(created), len(blocked)) == (1, 3), results
        assert await count(maker) == before + 1


async def test_two_phones_in_opposite_order_do_not_deadlock(ctx):
    user, _, maker = ctx
    for i in range(ROUNDS):
        a, b = f"050-30000{i:02d}", f"052-30000{i:02d}"
        results = await asyncio.wait_for(asyncio.gather(create(maker, user, card(a, b)), create(maker, user, card(b, a))), 30)
        created, blocked = outcomes(results)  # a deadlock would surface as DBAPIError instead
        assert (len(created), len(blocked)) == (1, 1), results


async def test_new_contact_and_landlord_in_opposite_order_do_not_deadlock(ctx):
    user, _, maker = ctx

    async def open_case(contact_phone, landlord_phone):
        values = {"party_role": "tenant", "title": "t", "base_items": [{"subject": "בסיס", "amount": "10"}]}
        async with maker() as db:
            try:
                result = await LegalProceedingService(db, user).create(
                    values, contact={"details": card(contact_phone)}, landlord={"details": card(landlord_phone)})
                await db.commit()
                return result
            except HTTPException as exc:
                await db.rollback()
                return exc

    for i in range(ROUNDS):
        a, b = f"050-40000{i:02d}", f"052-40000{i:02d}"
        results = await asyncio.wait_for(asyncio.gather(open_case(a, b), open_case(b, a)), 30)
        created, blocked = outcomes(results)
        assert (len(created), len(blocked)) == (1, 1), results


async def test_locks_are_taken_in_sorted_order(ctx):
    user, engine, maker = ctx
    taken = []

    def listener(conn, cur, statement, params, *a):
        if "pg_advisory_xact_lock" in statement:
            taken.append(params[1] if isinstance(params, (tuple, list)) else params["phone"])

    event.listen(engine.sync_engine, "before_cursor_execute", listener)
    try:
        await create(maker, user, card("052-5000001", "050-5000001"))
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", listener)
    assert taken == ["0505000001", "0525000001"]


async def test_each_new_phone_conflicting_with_the_other_field_is_found(ctx):
    user, _, maker = ctx
    assert not isinstance(await create(maker, user, card("050-6000001", "052-6000001")), Exception)
    crossed = await create(maker, user, card("+972 52 600 0001", "00972506000001"))
    assert isinstance(crossed, HTTPException) and crossed.status_code == 409
    partly = await create(maker, user, card("059-6000009", "050 600 0001"))
    assert isinstance(partly, HTTPException) and partly.status_code == 409
    assert await count(maker) == 1


async def test_confirmed_creation_still_checks_under_the_lock(ctx):
    user, _, maker = ctx
    values = card("050-7000001")
    async with maker() as first:
        created = await ContactService(first, user).create(values)
        waiter = asyncio.create_task(create(maker, user, values, confirm_duplicate=True))
        await wait_until_blocked(maker)  # a confirmed request waits for the lock too
        await first.commit()
    second = await asyncio.wait_for(waiter, 10)
    assert created.has_match is False and second.has_match is True
    assert await count(maker) == 2


# ── updates ──────────────────────────────────────────────────────────────────

async def update(maker, user, contact_id, values, **kw):
    async with maker() as db:
        try:
            result = await ContactService(db, user).update(contact_id, values, **kw)
            await db.commit()
            return result
        except HTTPException as exc:
            await db.rollback()
            return exc


async def new_card(maker, user, phone, phone_2=None) -> int:
    result = await create(maker, user, card(phone, phone_2))
    assert not isinstance(result, Exception), result
    return result.contact.id


async def phones_of(maker, contact_id) -> tuple:
    async with maker() as db:
        row = await db.get(Contact, contact_id)
        return row.phone, row.phone_2


async def test_update_waits_for_a_concurrent_create_of_the_same_phone(ctx):
    user, _, maker = ctx
    cid = await new_card(maker, user, "050-8000001")
    async with maker() as first:
        await ContactService(first, user).create(card("050-8000002"))
        waiter = asyncio.create_task(update(maker, user, cid, {"phone": "050-8000002"}))
        await wait_until_blocked(maker)
        await first.commit()
    second = await asyncio.wait_for(waiter, 10)
    assert isinstance(second, HTTPException) and second.status_code == 409
    assert await phones_of(maker, cid) == ("0508000001", None)


async def test_create_waits_for_a_concurrent_update_to_the_same_phone(ctx):
    user, _, maker = ctx
    cid = await new_card(maker, user, "050-8000003")
    async with maker() as first:
        await ContactService(first, user).update(cid, {"phone_2": "052-8000003"})
        waiter = asyncio.create_task(create(maker, user, card("052-8000003")))
        await wait_until_blocked(maker)
        await first.commit()
    second = await asyncio.wait_for(waiter, 10)
    assert isinstance(second, HTTPException) and second.status_code == 409 and await count(maker) == 1


async def test_two_updates_to_the_same_phone(ctx):
    user, _, maker = ctx
    a, b = await new_card(maker, user, "050-8000004"), await new_card(maker, user, "050-8000005")
    async with maker() as first:
        await ContactService(first, user).update(a, {"phone": "059-8000006"})
        waiter = asyncio.create_task(update(maker, user, b, {"phone": "059-8000006"}))
        await wait_until_blocked(maker)
        await first.commit()
    second = await asyncio.wait_for(waiter, 10)
    assert isinstance(second, HTTPException) and second.status_code == 409
    assert await phones_of(maker, b) == ("0508000005", None)


async def test_concurrent_updates_with_phones_in_opposite_order_do_not_deadlock(ctx):
    user, _, maker = ctx
    for i in range(ROUNDS):
        a = await new_card(maker, user, f"050-81000{i:02d}")
        b = await new_card(maker, user, f"050-82000{i:02d}")
        x, y = f"059-83000{i:02d}", f"058-83000{i:02d}"
        results = await asyncio.wait_for(asyncio.gather(update(maker, user, a, {"phone": x, "phone_2": y}),
                                                        update(maker, user, b, {"phone": y, "phone_2": x})), 30)
        updated, blocked = outcomes(results)
        assert (len(updated), len(blocked)) == (1, 1), results


async def test_update_and_opening_a_proceeding_do_not_deadlock(ctx):
    """Opening takes phone locks, then card locks: an update has to follow the same order."""
    user, _, maker = ctx

    async def open_with(existing_id, new_phone):
        values = {"party_role": "tenant", "title": "t", "base_items": [{"subject": "בסיס", "amount": "10"}]}
        async with maker() as db:
            try:
                result = await LegalProceedingService(db, user).create(
                    values, contact={"details": card(new_phone)}, landlord={"contact_id": existing_id})
                await db.commit()
                return result
            except HTTPException as exc:
                await db.rollback()
                return exc

    for i in range(ROUNDS):
        existing = await new_card(maker, user, f"050-84000{i:02d}")
        phone = f"059-85000{i:02d}"
        results = await asyncio.wait_for(asyncio.gather(open_with(existing, phone),
                                                        update(maker, user, existing, {"phone": phone})), 30)
        created, blocked = outcomes(results)  # a deadlock would surface as DBAPIError
        assert (len(created), len(blocked)) == (1, 1), results


async def test_confirmed_update_waits_for_the_lock_too(ctx):
    user, _, maker = ctx
    cid = await new_card(maker, user, "050-8000007")
    async with maker() as first:
        await ContactService(first, user).create(card("059-8000008"))
        waiter = asyncio.create_task(update(maker, user, cid, {"phone": "059-8000008"}, confirm_duplicate=True))
        await wait_until_blocked(maker)
        await first.commit()
    assert not isinstance(await asyncio.wait_for(waiter, 10), Exception)
    assert await phones_of(maker, cid) == ("0598000008", None)
