"""Legal proceedings: the shared ledger, required details by role, completing a card."""
from __future__ import annotations

import json
from decimal import Decimal

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker

from backend.models.audit_log import AuditLog
from backend.models.contact import Contact
from backend.models.ledger_item import LedgerItem
from backend.models.legal_proceeding import LegalProceeding
from backend.repositories.collection_task_repository import CollectionTaskRepository
from backend.services.contact_service import ContactService
from backend.services.legal_proceeding_service import LegalProceedingService
from backend.tests.test_collection_task_models import _collection_task
from backend.tests.test_legal_api import (  # noqa: F401  (fixtures)
    API,
    BASE_ITEMS,
    NEW_CONTACT,
    _card,
    _landlord,
    auth,
    colleague,
    lawyer,
    make_user,
    open_proceeding,
    storage,
)

pytestmark = pytest.mark.asyncio

TWO_BASES = [{"subject": "דמי שכירות", "amount": "1000.00"}, {"subject": "ועד בית", "amount": "250.50"}]
FULL = {"email": "a@example.com", "address": "כתובת", "apartment_number": "7"}


async def _proceeding(client, user, **extra) -> dict:
    return (await open_proceeding(client, user, party_role="other", **extra))["proceeding"]


async def _items(client, user, pid) -> dict:
    return (await client.get(f"{API}/proceedings/{pid}", headers=auth(user))).json()


def _url(pid, item=None, suffix=""):
    return f"{API}/proceedings/{pid}/ledger-items" + (f"/{item}" if item else "") + suffix


async def _audit(db, entity, entity_id, action):
    rows = (await db.execute(select(AuditLog.details).where(AuditLog.entity == entity, AuditLog.entity_id == str(entity_id),
                                                            AuditLog.action == action))).scalars().all()
    return [json.loads(r) for r in rows]


# ── base items ───────────────────────────────────────────────────────────────

async def test_every_base_item_is_created_with_the_proceeding(test_client, test_db, lawyer):
    p = await _proceeding(test_client, lawyer, base_items=TWO_BASES)
    assert [(i["item_type"], i["subject"], i["amount"]) for i in p["ledger_items"]] == [
        ("base_amount", "דמי שכירות", "1000.00"), ("base_amount", "ועד בית", "250.50")]
    assert p["total_amount"] == "1250.50"
    created = (await _audit(test_db, "legal_proceeding", p["id"], "proceeding_created"))[0]
    assert created["base_items"] == [{"subject": "דמי שכירות", "amount": "1000.00"}, {"subject": "ועד בית", "amount": "250.50"}]


async def test_no_limit_on_base_items(test_client, lawyer):
    many = [{"subject": f"פריט {i}", "amount": "10"} for i in range(12)]
    p = await _proceeding(test_client, lawyer, base_items=many)
    assert len(p["ledger_items"]) == 12 and p["total_amount"] == "120.00"


@pytest.mark.parametrize("base_items, code", [
    (None, "base_items_required"),
    ([], "base_items_required"),
    ([{"subject": "  ", "amount": "5"}], "ledger_subject_required"),
    ([{"subject": "א", "amount": "0"}], "invalid_amount"),
    ([{"subject": "א", "amount": "1.234"}], "invalid_amount"),
    ([{"subject": "א", "amount": "10000000000"}], "invalid_amount"),
])
async def test_a_proceeding_needs_valid_base_items(test_client, test_db, lawyer, base_items, code):
    body = {"party_role": "other", "title": "t", "contact": {"details": dict(NEW_CONTACT)}}
    if base_items is not None:
        body["base_items"] = base_items
    r = await test_client.post(f"{API}/proceedings", json=body, headers=auth(lawyer))
    assert r.status_code == 422 and r.json()["detail"]["code"] == code, r.text
    assert (await test_db.execute(select(LegalProceeding.id))).first() is None
    assert (await test_db.execute(select(Contact.id))).first() is None


async def test_service_itself_requires_base_items(test_db, lawyer):
    with pytest.raises(HTTPException) as exc:
        await LegalProceedingService(test_db, lawyer).create({"party_role": "other", "title": "t"},
                                                             contact={"details": dict(NEW_CONTACT)})
    assert exc.value.detail["code"] == "base_items_required"


async def test_base_item_can_be_edited_but_not_archived(test_client, test_db, lawyer):
    p = await _proceeding(test_client, lawyer, base_items=TWO_BASES)
    item, h = p["ledger_items"][0]["id"], auth(lawyer)
    r = await test_client.patch(_url(p["id"], item), json={"amount": "900"}, headers=h)
    assert r.status_code == 200 and r.json()["total_amount"] == "1150.50" and r.json()["item"]["item_type"] == "base_amount"
    r = await test_client.post(_url(p["id"], item, "/archive"), headers=h)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "base_item_not_archivable"
    assert (await _items(test_client, lawyer, p["id"]))["total_amount"] == "1150.50"
    logged = await _audit(test_db, "legal_proceeding", p["id"], "ledger_item_updated")
    assert logged == [{"item_id": item, "item_type": "base_amount", "before": {"amount": "1000.00"}, "after": {"amount": "900.00"}}]


async def test_added_items_are_always_additions(test_client, lawyer):
    p = await _proceeding(test_client, lawyer)
    h = auth(lawyer)
    r = await test_client.post(_url(p["id"]), json={"subject": "א", "amount": "5", "item_type": "base_amount"}, headers=h)
    assert r.status_code == 422
    item = p["ledger_items"][0]["id"]
    assert (await test_client.patch(_url(p["id"], item), json={"item_type": "addition"}, headers=h)).status_code == 422


# ── additions ────────────────────────────────────────────────────────────────

async def test_addition_add_edit_archive_and_total(test_client, test_db, lawyer):
    p = await _proceeding(test_client, lawyer)
    pid, h = p["id"], auth(lawyer)
    r = await test_client.post(_url(pid), json={"subject": "הוצאות", "amount": "100"}, headers=h)
    assert r.status_code == 201 and r.json()["total_amount"] == "1350.50"
    item = r.json()["item"]
    assert item["item_type"] == "addition" and item["sort_order"] == 1
    r = await test_client.patch(_url(pid, item["id"]), json={"subject": "הוצאות משפט", "amount": "200"}, headers=h)
    assert r.status_code == 200 and r.json()["total_amount"] == "1450.50"
    r = await test_client.post(_url(pid, item["id"], "/archive"), headers=h)
    assert r.status_code == 200 and r.json()["total_amount"] == "1250.50"
    detail = await _items(test_client, lawyer, pid)
    assert [i["item_type"] for i in detail["ledger_items"]] == ["base_amount"]
    for call in (test_client.patch(_url(pid, item["id"]), json={"amount": "1"}, headers=h),
                 test_client.post(_url(pid, item["id"], "/archive"), headers=h)):
        r = await call
        assert r.status_code == 409 and r.json()["detail"]["code"] == "ledger_item_archived"
    row = await test_db.get(LedgerItem, item["id"])
    assert row.archived_by_user_id == lawyer.id
    for action in ("ledger_item_added", "ledger_item_updated", "ledger_item_archived"):
        assert len(await _audit(test_db, "legal_proceeding", pid, action)) == 1


@pytest.mark.parametrize("body", [{"subject": " ", "amount": "5"}, {"subject": "א", "amount": "-1"}])
async def test_addition_validation(test_client, lawyer, body):
    p = await _proceeding(test_client, lawyer)
    assert (await test_client.post(_url(p["id"]), json=body, headers=auth(lawyer))).status_code == 422


async def test_closed_proceeding_ledger_is_read_only(test_client, lawyer):
    p = await _proceeding(test_client, lawyer)
    pid, h, item = p["id"], auth(lawyer), p["ledger_items"][0]["id"]
    await test_client.post(f"{API}/proceedings/{pid}/close", json={"reason": "r"}, headers=h)
    for call in (test_client.post(_url(pid), json={"subject": "א", "amount": "5"}, headers=h),
                 test_client.patch(_url(pid, item), json={"amount": "5"}, headers=h)):
        r = await call
        assert r.status_code == 409 and r.json()["detail"]["code"] == "proceeding_closed"
    await test_client.post(f"{API}/proceedings/{pid}/reopen", headers=h)
    assert (await test_client.post(_url(pid), json={"subject": "א", "amount": "5"}, headers=h)).status_code == 201


# ── permissions and module separation ────────────────────────────────────────

async def test_ledger_permissions(test_client, test_db, lawyer, colleague):
    p = await _proceeding(test_client, lawyer)
    pid, item = p["id"], p["ledger_items"][0]["id"]
    body = {"subject": "א", "amount": "5"}
    assert (await test_client.post(_url(pid), json=body)).status_code == 401
    reader = await make_user(test_db, "ledger-reader@test.com", "read")
    assert (await test_client.post(_url(pid), json=body, headers=auth(reader))).status_code == 403
    # has the permission, but cannot see this proceeding
    assert (await test_client.post(_url(pid), json=body, headers=auth(colleague))).status_code == 403
    assert (await test_client.patch(_url(pid, item), json=body, headers=auth(colleague))).status_code == 403


async def test_item_of_another_proceeding_is_not_found(test_client, lawyer):
    first, second = await _proceeding(test_client, lawyer), await _proceeding(test_client, lawyer)
    r = await test_client.patch(_url(second["id"], first["ledger_items"][0]["id"]), json={"amount": "1"}, headers=auth(lawyer))
    assert r.status_code == 404 and r.json()["detail"]["code"] == "ledger_item_not_found"


async def test_modules_never_see_each_others_items(test_client, test_db, admin_user, lawyer):
    p = await _proceeding(test_client, lawyer)
    task = await _collection_task(test_db, admin_user)
    collection_item = LedgerItem(task_id=task.id, subject="ועד", amount=Decimal("80"), created_by_user_id=admin_user.id)
    test_db.add(collection_item)
    await test_db.commit()
    r = await test_client.patch(_url(p["id"], collection_item.id), json={"amount": "1"}, headers=auth(lawyer))
    assert r.status_code == 404
    repo = CollectionTaskRepository(test_db)
    assert [i.id for i in await repo.list_ledger_items(task.id, include_archived=True)] == [collection_item.id]
    assert await repo.get_ledger_item(task.id, p["ledger_items"][0]["id"]) is None
    assert (await _items(test_client, lawyer, p["id"]))["total_amount"] == "1250.50"


# ── constraints ──────────────────────────────────────────────────────────────

async def test_ledger_constraints(test_client, test_db, admin_user, lawyer):
    p = await _proceeding(test_client, lawyer)
    pid, task = p["id"], await _collection_task(test_db, admin_user)
    task_id, user_id = task.id, admin_user.id

    async def rejected(**values):
        test_db.add(LedgerItem(subject="x", amount=Decimal("1"), created_by_user_id=user_id, **values))
        with pytest.raises(IntegrityError):
            await test_db.commit()
        await test_db.rollback()

    await rejected()                                                                  # no owner
    await rejected(task_id=task_id, legal_proceeding_id=pid, item_type="addition")    # two owners
    await rejected(task_id=task_id, item_type="addition")                             # collection items have no type
    await rejected(legal_proceeding_id=pid)                                           # a legal item needs one
    await rejected(legal_proceeding_id=pid, item_type="other")
    await rejected(legal_proceeding_id=pid, item_type="base_amount", archived_at=NOW_VALUE, archived_by_user_id=user_id)
    if test_db.get_bind().dialect.name == "postgresql":                               # SQLite does not enforce FKs here
        await rejected(legal_proceeding_id=9999999, item_type="addition")
    test_db.add(LedgerItem(legal_proceeding_id=pid, item_type="addition", subject="x", amount=Decimal("0"), created_by_user_id=user_id))
    with pytest.raises(IntegrityError):
        await test_db.commit()
    await test_db.rollback()
    test_db.add_all([LedgerItem(legal_proceeding_id=pid, item_type="base_amount", subject="x", amount=Decimal("1"),
                                created_by_user_id=user_id) for _ in range(3)])
    await test_db.commit()  # any number of base amounts


# ── totals in lists ──────────────────────────────────────────────────────────

async def test_list_and_summary_totals_count_active_items_once(test_client, test_db, lawyer):
    from backend.models.project import Project
    project = Project(name="סיכום", is_active=True)
    test_db.add(project)
    await test_db.commit()
    p = await _proceeding(test_client, lawyer, base_items=TWO_BASES, project_id=project.id)
    h = auth(lawyer)
    await test_client.post(_url(p["id"]), json={"subject": "א", "amount": "100"}, headers=h)
    archived = (await test_client.post(_url(p["id"]), json={"subject": "ב", "amount": "999"}, headers=h)).json()["item"]["id"]
    await test_client.post(_url(p["id"], archived, "/archive"), headers=h)
    item = (await test_client.get(f"{API}/proceedings", headers=h)).json()["items"][0]
    assert item["total_amount"] == "1350.50" and item["apartment_number"] == "4"
    rows = (await test_client.get(f"{API}/projects/summary", headers=h)).json()
    assert [Decimal(r["open_claim_total"]) for r in rows] == [Decimal("1350.50")]


async def test_list_finds_by_the_contact_apartment(test_client, lawyer):
    await open_proceeding(test_client, lawyer, party_role="other", contact={"details": {**NEW_CONTACT, "apartment_number": "77א"}})
    found = (await test_client.get(f"{API}/proceedings", params={"search": "77א"}, headers=auth(lawyer))).json()
    assert found["total"] == 1 and found["items"][0]["apartment_number"] == "77א"


# ── required details by role ─────────────────────────────────────────────────

@pytest.mark.parametrize("party_role", ["tenant", "landlord", "supplier", "other"])
@pytest.mark.parametrize("field", ["email", "address", "apartment_number"])
async def test_primary_party_needs_every_detail(test_client, lawyer, party_role, field):
    details = {k: v for k, v in NEW_CONTACT.items() if k != field}
    body = {"party_role": party_role, "title": "t", "base_items": BASE_ITEMS, "contact": {"details": details}}
    if party_role == "tenant":
        body["landlord"] = {"contact_id": await _landlord(test_client, lawyer)}
    r = await test_client.post(f"{API}/proceedings", json=body, headers=auth(lawyer))
    assert r.status_code == 422 and r.json()["detail"]["missing"] == [field], r.text


async def test_linked_landlord_needs_only_a_name_and_a_phone(test_client, lawyer):
    landlord = {"kind": "person", "name": "בעל", "phone": "050-8100001"}
    body = {"party_role": "tenant", "title": "t", "base_items": BASE_ITEMS, "contact": {"details": dict(NEW_CONTACT)}, "landlord": {"details": landlord}}
    r = await test_client.post(f"{API}/proceedings", json=body, headers=auth(lawyer))
    assert r.status_code == 201, r.text
    assert r.json()["proceeding"]["linked_landlord"]["email"] is None


async def test_same_card_is_required_differently_by_role(test_client, lawyer):
    bare = await _card(test_client, lawyer, "050-8100002")
    h = auth(lawyer)
    as_landlord = {"party_role": "tenant", "title": "t", "base_items": BASE_ITEMS, "contact": {"details": dict(NEW_CONTACT)}, "landlord": {"contact_id": bare}}
    assert (await test_client.post(f"{API}/proceedings", json=as_landlord, headers=h)).status_code == 201
    as_primary = {"party_role": "landlord", "title": "t", "base_items": BASE_ITEMS, "contact": {"contact_id": bare}}
    r = await test_client.post(f"{API}/proceedings", json=as_primary, headers=h)
    assert r.status_code == 422 and r.json()["detail"]["missing"] == ["email", "address", "apartment_number"]


async def test_open_primary_keeps_the_apartment_number(test_client, admin_user, lawyer):
    cid = (await _proceeding(test_client, admin_user))["contact"]["id"]
    r = await test_client.patch(f"{API}/contacts/{cid}", json={"apartment_number": None}, headers=auth(admin_user))
    assert r.status_code == 422 and r.json()["detail"]["fields"] == ["apartment_number"]


# ── completing an existing card ──────────────────────────────────────────────

def _body(cid, complete, role="other", **extra):
    return {"party_role": role, "title": "t", "base_items": BASE_ITEMS, "contact": {"contact_id": cid, "complete": complete}, **extra}


async def test_opener_completes_missing_details_without_edit_rights(test_client, test_db, lawyer):
    cid = await _card(test_client, lawyer, "050-8200001")
    h = auth(lawyer)
    r = await test_client.post(f"{API}/proceedings", json=_body(cid, {**FULL, "email": "A@Example.com"}), headers=h)
    assert r.status_code == 201, r.text
    contact = r.json()["proceeding"]["contact"]
    assert (contact["id"], contact["email"], contact["address"], contact["apartment_number"]) == (cid, "a@example.com", "כתובת", "7")
    assert len((await test_db.execute(select(Contact.id))).all()) == 1           # no duplicate card
    logged = await _audit(test_db, "contact", cid, "completed_on_proceeding_create")
    assert logged[0]["after"] == {"email": "a@example.com", "address": "כתובת", "apartment_number": "7"}
    assert logged[0]["before"] == {"email": None, "address": None, "apartment_number": None}
    r = await test_client.patch(f"{API}/contacts/{cid}", json={"email": "b@example.com"}, headers=h)
    assert r.status_code == 403                                                  # general editing stays admin-only


async def test_phone_2_can_be_added_and_is_normalized(test_client, lawyer):
    cid = await _card(test_client, lawyer, "050-8200002", **FULL)
    r = await test_client.post(f"{API}/proceedings", json=_body(cid, {"phone_2": "+972 52-820-0002"}), headers=auth(lawyer))
    assert r.status_code == 201 and r.json()["proceeding"]["contact"]["phone_2"] == "0528200002", r.text


@pytest.mark.parametrize("complete, field", [
    ({"email": "other@example.com"}, "email"),
    ({"address": "אחרת"}, "address"),
    ({"apartment_number": "9"}, "apartment_number"),
    ({"phone": "050-8299999"}, "phone"),
])
async def test_existing_values_are_never_overwritten(test_client, test_db, lawyer, complete, field):
    cid = await _card(test_client, lawyer, "050-8200003", **FULL)
    r = await test_client.post(f"{API}/proceedings", json=_body(cid, complete), headers=auth(lawyer))
    assert r.status_code == 422 and r.json()["detail"]["code"] == "contact_field_not_missing"
    assert r.json()["detail"]["fields"] == [field]
    assert (await test_db.execute(select(LegalProceeding.id))).first() is None
    card = (await test_client.get(f"{API}/contacts", params={"search": "כרטיס"}, headers=auth(lawyer))).json()[0]
    assert (card["email"], card["address"], card["apartment_number"], card["phone"]) == ("a@example.com", "כתובת", "7", "0508200003")


async def test_existing_phone_2_is_not_overwritten(test_client, lawyer):
    cid = await _card(test_client, lawyer, "050-8200004", phone_2="052-8200004", **FULL)
    r = await test_client.post(f"{API}/proceedings", json=_body(cid, {"phone_2": "052-8299999"}), headers=auth(lawyer))
    assert r.status_code == 422 and r.json()["detail"]["fields"] == ["phone_2"]


async def test_only_fields_required_for_the_role_can_be_completed(test_client, lawyer):
    bare = await _card(test_client, lawyer, "050-8200005")
    body = {"party_role": "tenant", "title": "t", "base_items": BASE_ITEMS, "contact": {"details": dict(NEW_CONTACT)},
            "landlord": {"contact_id": bare, "complete": {"email": "l@example.com"}}}
    r = await test_client.post(f"{API}/proceedings", json=body, headers=auth(lawyer))
    assert r.status_code == 422 and r.json()["detail"]["code"] == "contact_field_not_missing"
    body["landlord"]["complete"] = {"phone_2": "052-8200005"}
    body["confirm_duplicate_contact"] = True   # the test session keeps the rejected attempt's new card
    assert (await test_client.post(f"{API}/proceedings", json=body, headers=auth(lawyer))).status_code == 201


@pytest.mark.parametrize("complete, status, code", [
    ({"email": "not-an-email"}, 422, None),
    ({**FULL, "phone_2": "12"}, 422, "invalid_phone"),
    ({**FULL, "apartment_number": "x" * 33}, 422, None),
])
async def test_completed_values_are_validated(test_client, lawyer, complete, status, code):
    cid = await _card(test_client, lawyer, "050-8200006")
    r = await test_client.post(f"{API}/proceedings", json=_body(cid, complete), headers=auth(lawyer))
    assert r.status_code == status, r.text
    if code:
        assert r.json()["detail"]["code"] == code


async def test_partial_completion_still_needs_every_required_field(test_client, test_engine, lawyer):
    cid = await _card(test_client, lawyer, "050-8200007")
    r = await test_client.post(f"{API}/proceedings", json=_body(cid, {"email": "a@example.com"}), headers=auth(lawyer))
    assert r.status_code == 422 and r.json()["detail"]["missing"] == ["address", "apartment_number"]
    if test_engine.dialect.name == "postgresql":                                 # SQLite tests share one connection
        async with async_sessionmaker(test_engine, expire_on_commit=False)() as other:
            assert (await other.get(Contact, cid)).email is None                 # nothing was committed


async def test_warning_rolls_the_completion_back_and_retry_applies_it(test_client, lawyer):
    h, landlord = auth(lawyer), await _landlord(test_client, lawyer)
    cid = await _card(test_client, lawyer, "050-8200008", email="a@example.com", address="א", apartment_number="1")
    await open_proceeding(test_client, lawyer, party_role="tenant", contact_id=cid, landlord_contact_id=landlord)
    bare = await _card(test_client, lawyer, "050-8200009")
    other = {"party_role": "tenant", "title": "t", "base_items": BASE_ITEMS, "landlord": {"contact_id": landlord}}
    await test_client.post(f"{API}/proceedings", headers=h, json={**other, "contact": {"contact_id": bare, "complete": FULL}})
    retry = {**other, "contact": {"contact_id": bare, "complete": {"phone_2": "052-8200009"}}}
    r = await test_client.post(f"{API}/proceedings", headers=h, json=retry)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "tenant_has_open_proceeding"
    found = next(c for c in (await test_client.get(f"{API}/contacts", params={"search": "כרטיס"}, headers=h)).json() if c["id"] == bare)
    assert found["phone_2"] is None
    r = await test_client.post(f"{API}/proceedings", headers=h, json={**retry, "confirm_open_proceeding": True})
    assert r.status_code == 201 and r.json()["proceeding"]["contact"]["phone_2"] == "0528200009"


async def test_completed_phone_goes_through_the_duplicate_check(test_client, test_db, lawyer):
    await _card(test_client, lawyer, "050-8300001", name="אחר")
    cid = await _card(test_client, lawyer, "050-8300002", **FULL)
    h, complete = auth(lawyer), {"phone_2": "050-830-0001"}
    r = await test_client.post(f"{API}/proceedings", json=_body(cid, complete), headers=h)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "duplicate_phone"
    r = await test_client.post(f"{API}/proceedings", json=_body(cid, complete, confirm_duplicate_contact=True), headers=h)
    assert r.status_code == 201 and r.json()["has_match"] is True
    logged = await _audit(test_db, "contact", cid, "completed_on_proceeding_create")
    assert logged[0]["duplicate_phone_confirmed"] is True


async def test_complete_only_with_an_existing_contact(test_client, lawyer):
    body = {"party_role": "other", "title": "t", "base_items": BASE_ITEMS, "contact": {"details": dict(NEW_CONTACT), "complete": {"phone_2": "052-1"}}}
    assert (await test_client.post(f"{API}/proceedings", json=body, headers=auth(lawyer))).status_code == 422


async def test_missing_primary_phone_can_be_completed_and_is_normalized(test_db, lawyer):
    """``contacts.phone`` is NOT NULL today, so the case is exercised on an unsaved card."""
    contact = Contact(kind="person", name="ללא טלפון", phone="")
    service = ContactService(test_db, lawyer)
    service.db.flush, service._log = _noop, _noop
    await service.complete_missing(contact, {"phone": "+972 50-840-0001"}, allowed={"phone"})
    assert contact.phone == "0508400001"
    with pytest.raises(HTTPException) as exc:
        await service.complete_missing(contact, {"phone": "050-8400002"}, allowed={"phone"})
    assert exc.value.detail["code"] == "contact_field_not_missing" and contact.phone == "0508400001"


async def _noop(*args, **kwargs):
    return None


NOW_VALUE = __import__("datetime").datetime(2026, 11, 1, 10, 0)
