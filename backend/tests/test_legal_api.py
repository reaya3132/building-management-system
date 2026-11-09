"""Legal proceedings HTTP API (/api/v1/legal): routing, schemas, status codes,
error format and the permission / visibility boundary as seen over HTTP. The
business rules themselves are covered in test_legal_services."""
from __future__ import annotations

import json

import pytest
import pytest_asyncio
from fastapi import UploadFile
from sqlalchemy import event, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.core.security import create_access_token, hash_password
from backend.iam.engine import PermissionsEngine
from backend.models.contact import Contact
from backend.models.audit_log import AuditLog
from backend.models.legal_proceeding import (
    LegalProceeding,
    LegalProceedingAssignee,
    LegalProceedingEntry,
    LegalProceedingStage,
)
from backend.models.project import Project
from backend.models.user import User, UserRole
from backend.services import document_storage
from backend.services.document_storage import StoredFile

pytestmark = pytest.mark.asyncio

API = "/api/v1/legal"
WHEN = "2026-10-01T09:30:00Z"
NEW_CONTACT = {"kind": "person", "name": "ישראל ישראלי", "phone": "050-1234567", "email": "p@example.com", "address": "רחוב 1"}


class FakeStorage:
    def __init__(self):
        self.files: dict[str, bytes] = {}

    async def store(self, file: UploadFile, prefix: str):
        path = f"{prefix}/{len(self.files)}-{file.filename}"
        self.files[path] = await file.read()
        return StoredFile(path, file.filename)

    async def remove(self, path: str):
        self.files.pop(path, None)


@pytest.fixture(autouse=True)
def storage(monkeypatch):
    fake = FakeStorage()
    monkeypatch.setattr(document_storage, "_store_file", fake.store)
    monkeypatch.setattr(document_storage, "_remove_file", fake.remove)
    return fake


def auth(user: User) -> dict:
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def make_user(db, email: str, *actions: str) -> User:
    user = User(email=email, password_hash=hash_password("x"), full_name=email.split("@")[0],
                role=UserRole.MEMBER.value, is_active=True, email_verified=True)
    db.add(user)
    await db.commit()
    engine = PermissionsEngine(db)
    for action in actions:
        await engine.grant_resource_permission(user.id, "legal_proceeding", "*", action)
    await db.commit()
    return user


@pytest_asyncio.fixture
async def lawyer(test_db) -> User:
    return await make_user(test_db, "lawyer@test.com", "read", "write", "update")


@pytest_asyncio.fixture
async def colleague(test_db) -> User:
    return await make_user(test_db, "colleague@test.com", "read", "write", "update")


async def open_proceeding(client, user, **extra) -> dict:
    contact_id, landlord_id = extra.pop("contact_id", None), extra.pop("landlord_contact_id", None)
    body = {"party_role": "landlord", "apartment_number": "4", "title": "חוב ועד בית", "claim_amount": "1250.50",
            "contact": {"contact_id": contact_id} if contact_id else {"details": dict(NEW_CONTACT)},
            "confirm_duplicate_contact": True, **extra}
    if landlord_id:
        body["landlord"] = {"contact_id": landlord_id}
    r = await client.post(f"{API}/proceedings", json=body, headers=auth(user))
    assert r.status_code == 201, r.text
    return r.json()


async def test_requires_authentication(test_client):
    assert (await test_client.get(f"{API}/proceedings")).status_code == 401


async def test_stage_catalogue(test_client, lawyer):
    r = await test_client.get(f"{API}/stages", headers=auth(lawyer))
    assert r.status_code == 200
    stages = r.json()
    assert [s["position"] for s in stages] == [1, 2, 3, 4, 5]
    assert stages[0]["requires_communication"] and stages[1]["components"]


async def test_open_get_list_update_close_reopen(test_client, lawyer):
    created = await open_proceeding(test_client, lawyer)
    p = created["proceeding"]
    assert p["status"] == "open" and p["claim_amount"] == "1250.50" and p["contact"]["name"] == "ישראל ישראלי"
    assert len(p["stages"]) == 5 and p["progress"] == {"resolved": 0, "total": 5, "percent": 0,
                                                       "next_stage_key": p["stages"][0]["key"]}
    assert p["permissions"] == {"can_update": True, "can_assign": True, "can_delete_others": False}
    assert p["opened_at"].endswith("Z") and created["has_match"] is False
    pid, h = p["id"], auth(lawyer)

    assert (await test_client.get(f"{API}/proceedings/{pid}", headers=h)).json()["title"] == "חוב ועד בית"
    page = (await test_client.get(f"{API}/proceedings", params={"status": "open", "search": "ישראלי"},
                                  headers=h)).json()
    assert page["total"] == 1 and page["items"][0]["contact"]["name"] == "ישראל ישראלי"

    r = await test_client.patch(f"{API}/proceedings/{pid}", json={"apartment_number": "7"}, headers=h)
    assert r.status_code == 200 and r.json()["apartment_number"] == "7"
    for field, value in (("contact_id", 9), ("party_role", "other"), ("landlord_contact_id", 9)):
        assert (await test_client.patch(f"{API}/proceedings/{pid}", json={field: value}, headers=h)).status_code == 422
    assert (await test_client.patch(f"{API}/proceedings/{pid}", json={}, headers=h)).status_code == 422

    assert (await test_client.post(f"{API}/proceedings/{pid}/close", json={"reason": ""}, headers=h)).status_code == 422
    r = await test_client.post(f"{API}/proceedings/{pid}/close", json={"reason": "שולם"}, headers=h)
    assert r.status_code == 200 and r.json()["status"] == "closed" and r.json()["close_reason"] == "שולם"
    r = await test_client.patch(f"{API}/proceedings/{pid}", json={"title": "x"}, headers=h)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "proceeding_closed"
    r = await test_client.post(f"{API}/proceedings/{pid}/reopen", headers=h)
    assert r.status_code == 200 and r.json()["status"] == "open" and r.json()["closed_by"] is None

    history = (await test_client.get(f"{API}/proceedings/{pid}/history", headers=h)).json()
    actions = [i["action"] for i in history["items"]]
    assert {"proceeding_created", "proceeding_updated", "proceeding_closed", "proceeding_reopened"} <= set(actions)


async def test_business_errors_carry_a_code(test_client, lawyer):
    r = await test_client.post(f"{API}/proceedings", headers=auth(lawyer),
                               json={"party_role": "landlord", "apartment_number": "4", "title": "t"})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "contact_required"


async def test_permission_and_visibility_boundary(test_client, test_db, lawyer, colleague):
    pid = (await open_proceeding(test_client, lawyer))["proceeding"]["id"]
    nobody = await make_user(test_db, "nobody@test.com")
    assert (await test_client.get(f"{API}/proceedings", headers=auth(nobody))).status_code == 403
    # colleague has read, but is neither the creator nor assigned
    assert (await test_client.get(f"{API}/proceedings/{pid}", headers=auth(colleague))).status_code == 403
    assert (await test_client.get(f"{API}/proceedings", headers=auth(colleague))).json()["total"] == 0
    # assigned -> visible, but cannot assign others
    r = await test_client.post(f"{API}/proceedings/{pid}/assignees", json={"user_id": colleague.id},
                               headers=auth(lawyer))
    assert r.status_code == 201 and [a["user"]["id"] for a in r.json()["assignees"]] == [colleague.id]
    detail = (await test_client.get(f"{API}/proceedings/{pid}", headers=auth(colleague))).json()
    assert detail["assignee_ids"] == [colleague.id] and detail["permissions"]["can_assign"] is False
    assert (await test_client.post(f"{API}/proceedings/{pid}/assignees", json={"user_id": nobody.id},
                                   headers=auth(colleague))).status_code == 403
    r = await test_client.delete(f"{API}/proceedings/{pid}/assignees/{colleague.id}", headers=auth(lawyer))
    assert r.status_code == 200 and r.json()["assignees"] == []


async def test_contacts(test_client, lawyer):
    r = await test_client.post(f"{API}/contacts", json={"kind": "business", "name": " ועד הבית ", "phone": "03-1234561"},
                               headers=auth(lawyer))
    assert r.status_code == 201 and r.json()["contact"]["name"] == "ועד הבית" and r.json()["has_match"] is False
    cid = r.json()["contact"]["id"]
    r = await test_client.post(f"{API}/contacts", json={"kind": "person", "name": "אחר", "phone": "+972 3 1234561"}, headers=auth(lawyer))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "duplicate_phone"
    found = (await test_client.get(f"{API}/contacts", params={"search": "ועד"}, headers=auth(lawyer))).json()
    assert {c["id"] for c in found} >= {cid}
    assert (await test_client.post(f"{API}/contacts", json={"kind": "x", "name": "a", "phone": "1"},
                                   headers=auth(lawyer))).status_code == 422


async def test_stage_actions(test_client, lawyer):
    p = (await open_proceeding(test_client, lawyer))["proceeding"]
    pid, stage, h = p["id"], p["stages"][1]["key"], auth(lawyer)
    missing = (await test_client.get(f"{API}/proceedings/{pid}/stages/{stage}/missing", headers=h)).json()
    assert missing and {"key", "label"} <= set(missing[0])
    r = await test_client.post(f"{API}/proceedings/{pid}/stages/{stage}/complete", headers=h)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "stage_requirements_missing"
    assert r.json()["detail"]["missing"] == missing
    r = await test_client.post(f"{API}/proceedings/{pid}/stages/{stage}/complete", json={"confirm": True}, headers=h)
    assert r.status_code == 200
    by_key = {s["key"]: s for s in r.json()["stages"]}
    assert by_key[stage]["status"] == "completed" and by_key[stage]["resolved_by"]["id"] == lawyer.id
    assert r.json()["progress"]["resolved"] == 1
    r = await test_client.post(f"{API}/proceedings/{pid}/stages/{stage}/reopen", json={"reason": "טעות"}, headers=h)
    assert {s["key"]: s["status"] for s in r.json()["stages"]}[stage] == "pending"
    r = await test_client.post(f"{API}/proceedings/{pid}/stages/{stage}/skip", headers=h)
    assert {s["key"]: s["status"] for s in r.json()["stages"]}[stage] == "skipped"
    assert (await test_client.post(f"{API}/proceedings/{pid}/stages/nope/skip", headers=h)).status_code == 404


async def test_entries_with_files(test_client, lawyer, storage):
    pid, h = (await open_proceeding(test_client, lawyer))["proceeding"]["id"], auth(lawyer)
    r = await test_client.post(f"{API}/proceedings/{pid}/entries", headers=h,
                               data={"entry_type": "communication", "channel": "email", "occurred_at": WHEN},
                               files=[("files", ("letter.pdf", b"%PDF", "application/pdf"))])
    assert r.status_code == 201, r.text
    entry = r.json()
    assert entry["occurred_at"] == "2026-10-01T09:30:00Z" and entry["content"] is None and entry["can_modify"]
    assert [d["file_name"] for d in entry["documents"]] == ["letter.pdf"] and entry["documents"][0]["download_url"]
    assert len(storage.files) == 1
    # a communication without text or file is rejected
    r = await test_client.post(f"{API}/proceedings/{pid}/entries", headers=h,
                               data={"entry_type": "communication", "channel": "email", "occurred_at": WHEN})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "communication_needs_content_or_file"

    for i in range(3):
        await test_client.post(f"{API}/proceedings/{pid}/entries", headers=h,
                               data={"entry_type": "note", "content": f"note {i}"})
    page = (await test_client.get(f"{API}/proceedings/{pid}/entries", params={"limit": 2}, headers=h)).json()
    assert [e["content"] for e in page["items"]] == ["note 2", "note 1"] and page["next_before_id"]
    rest = (await test_client.get(f"{API}/proceedings/{pid}/entries",
                                  params={"limit": 2, "before_id": page["next_before_id"]}, headers=h)).json()
    assert [e["id"] for e in rest["items"]][-1] == entry["id"] and rest["next_before_id"] is None

    r = await test_client.patch(f"{API}/proceedings/{pid}/entries/{entry['id']}", json={"content": "נשלח"}, headers=h)
    assert r.status_code == 200 and r.json()["content"] == "נשלח" and r.json()["updated_by"]["id"] == lawyer.id
    r = await test_client.post(f"{API}/proceedings/{pid}/entries/{entry['id']}/documents", headers=h,
                               files=[("files", ("b.pdf", b"2", "application/pdf"))])
    assert r.status_code == 201 and r.json()[0]["entry_id"] == entry["id"]
    doc_id = r.json()[0]["id"]
    assert (await test_client.delete(f"{API}/proceedings/{pid}/entries/{entry['id']}/documents/{doc_id}",
                                     headers=h)).status_code == 204
    assert (await test_client.delete(f"{API}/proceedings/{pid}/entries/{entry['id']}", headers=h)).status_code == 204
    assert storage.files == {}


async def test_documents(test_client, lawyer, storage):
    p = (await open_proceeding(test_client, lawyer))["proceeding"]
    pid, h = p["id"], auth(lawyer)
    stage = p["stages"][1]
    component = stage["components"][0]["key"]
    r = await test_client.post(f"{API}/proceedings/{pid}/documents", headers=h,
                               data={"stage_key": stage["key"], "component_key": component},
                               files=[("files", ("a.pdf", b"1", "application/pdf")),
                                      ("files", ("b.pdf", b"2", "application/pdf"))])
    assert r.status_code == 201 and [d["component_key"] for d in r.json()] == [component, component]
    r = await test_client.post(f"{API}/proceedings/{pid}/documents", headers=h, data={"stage_key": stage["key"],
                               "component_key": "nope"}, files=[("files", ("c.pdf", b"3", "application/pdf"))])
    assert r.status_code == 422 and r.json()["detail"]["code"] == "invalid_component"
    general = (await test_client.post(f"{API}/proceedings/{pid}/documents", headers=h,
                                      files=[("files", ("g.pdf", b"4", "application/pdf"))])).json()[0]
    assert general["stage_key"] is None and general["uploaded_by"]["id"] == lawyer.id
    listed = (await test_client.get(f"{API}/proceedings/{pid}/documents", headers=h)).json()
    assert len(listed) == 3 and len(storage.files) == 3
    one = (await test_client.get(f"{API}/proceedings/{pid}/documents/{general['id']}", headers=h)).json()
    assert one["download_url"]
    assert (await test_client.delete(f"{API}/proceedings/{pid}/documents/{general['id']}", headers=h)).status_code == 204
    assert (await test_client.get(f"{API}/proceedings/{pid}/documents/{general['id']}", headers=h)).status_code == 404
    assert len(storage.files) == 2


async def test_project_summary(test_client, lawyer):
    await open_proceeding(test_client, lawyer)
    rows = (await test_client.get(f"{API}/projects/summary", headers=auth(lawyer))).json()
    assert rows == [{"project_id": None, "project_name": None, "open_count": 1, "closed_count": 0,
                     "open_claim_total": "1250.50", "contact_count": 1}]


# ── linked_landlord, commit timing, atomicity ────────────────────────────────

async def _landlord(client, user, name="בעל דירה") -> int:
    r = await client.post(f"{API}/contacts", json={"kind": "person", "name": name, "phone": f"050{abs(hash(name)) % 10**7:07d}",
                                                         "email": "l@example.com", "address": "רחוב 2"},
                          headers=auth(user))
    assert r.status_code == 201, r.text
    return r.json()["contact"]["id"]


async def test_linked_landlord_only_in_tenant_proceedings(test_client, lawyer):
    landlord_id = await _landlord(test_client, lawyer)
    h = auth(lawyer)
    tenant = (await open_proceeding(test_client, lawyer, party_role="tenant", landlord_contact_id=landlord_id))["proceeding"]
    assert tenant["linked_landlord"]["id"] == landlord_id and tenant["contact"]["id"] != landlord_id
    got = (await test_client.get(f"{API}/proceedings/{tenant['id']}", headers=h)).json()
    assert got["linked_landlord"]["name"] == "בעל דירה"
    own = (await open_proceeding(test_client, lawyer, party_role="landlord", contact_id=landlord_id))["proceeding"]
    assert own["contact"]["id"] == landlord_id and own["linked_landlord"] is None
    for role in ("supplier", "other"):
        assert (await open_proceeding(test_client, lawyer, party_role=role))["proceeding"]["linked_landlord"] is None
    items = {i["id"]: i for i in (await test_client.get(f"{API}/proceedings", headers=h)).json()["items"]}
    assert items[tenant["id"]]["linked_landlord"] == {"id": landlord_id, "name": "בעל דירה"}
    assert items[own["id"]]["linked_landlord"] is None


async def test_list_query_count_does_not_grow_with_rows(test_client, test_engine, lawyer):
    landlord_id = await _landlord(test_client, lawyer)
    await open_proceeding(test_client, lawyer, party_role="tenant", landlord_contact_id=landlord_id)

    async def count_list() -> int:
        seen = []
        listener = lambda conn, cur, statement, *a: seen.append(statement)
        event.listen(test_engine.sync_engine, "before_cursor_execute", listener)
        try:
            r = await test_client.get(f"{API}/proceedings", headers=auth(lawyer))
        finally:
            event.remove(test_engine.sync_engine, "before_cursor_execute", listener)
        assert r.status_code == 200
        return len(seen), r.json()["total"]

    one, total = await count_list()
    for _ in range(3):
        await open_proceeding(test_client, lawyer, party_role="tenant", landlord_contact_id=landlord_id)
    many, total_many = await count_list()
    assert (total, total_many) == (1, 4) and many == one


async def test_each_write_commits_exactly_once(test_client, test_db, lawyer, colleague, monkeypatch):
    landlord_id = await _landlord(test_client, lawyer)
    pid = (await open_proceeding(test_client, lawyer, party_role="tenant", landlord_contact_id=landlord_id))["proceeding"]["id"]
    h = auth(lawyer)
    original, commits = test_db.commit, []

    async def counting():
        commits.append(1)
        await original()

    monkeypatch.setattr(test_db, "commit", counting)
    P = f"{API}/proceedings"
    calls = [
        lambda: test_client.post(f"{API}/contacts", json={"kind": "person", "name": "n", "phone": "03-1234569"}, headers=h),
        lambda: test_client.post(P, headers=h, json={"party_role": "tenant", "apartment_number": "1", "title": "t",
                                 "landlord": {"contact_id": landlord_id}, "contact": {"details": {**NEW_CONTACT, "name": "m", "phone": "03-1234568"}}}),
        lambda: test_client.patch(f"{P}/{pid}", json={"title": "x"}, headers=h),
        lambda: test_client.post(f"{P}/{pid}/assignees", json={"user_id": colleague.id}, headers=h),
        lambda: test_client.delete(f"{P}/{pid}/assignees/{colleague.id}", headers=h),
        lambda: test_client.post(f"{P}/{pid}/entries", data={"entry_type": "note", "content": "c"}, headers=h),
        lambda: test_client.post(f"{P}/{pid}/entries", data={"entry_type": "communication", "channel": "email", "occurred_at": WHEN}, headers=h,
                                 files=[("files", ("a.pdf", b"1", "application/pdf"))]),
        lambda: test_client.post(f"{P}/{pid}/close", json={"reason": "r"}, headers=h),
        lambda: test_client.post(f"{P}/{pid}/reopen", headers=h),
    ]
    for i, call in enumerate(calls):
        commits.clear()
        r = await call()
        assert r.status_code < 300, (i, r.text)
        assert len(commits) == 1, (i, len(commits))


async def test_failure_midway_rolls_back_the_new_contact_too(test_client, test_engine, lawyer, monkeypatch):
    """Through the real get_db: the contact is flushed, then opening the proceeding fails."""
    from backend.services.legal_proceeding_service import LegalProceedingService

    maker = async_sessionmaker(test_engine, expire_on_commit=False)
    monkeypatch.setattr("backend.db.session.AsyncSessionLocal", maker)
    test_client._transport.app.dependency_overrides.clear()

    async def boom(self, *a, **k):
        raise RuntimeError("audit down")

    monkeypatch.setattr(LegalProceedingService, "_log", boom)
    body = {"party_role": "other", "apartment_number": "4", "title": "t",
            "contact": {"details": {**NEW_CONTACT, "name": "לא יישמר", "phone": "050-7777777"}}}
    r = await test_client.post(f"{API}/proceedings", json=body, headers=auth(lawyer))
    assert r.status_code == 500
    async with maker() as check:
        assert (await check.execute(select(func.count(Contact.id)))).scalar() == 0
        assert (await check.execute(select(func.count(LegalProceeding.id)))).scalar() == 0


# ── a failing commit ─────────────────────────────────────────────────────────

class _CommitFails(AsyncSession):
    rollbacks = 0

    async def commit(self):
        raise RuntimeError("commit failed")

    async def rollback(self):
        type(self).rollbacks += 1
        await super().rollback()


async def _db_state(maker) -> dict:
    async with maker() as db:
        counts = {m.__name__: (await db.execute(select(func.count()).select_from(m))).scalar()
                  for m in (Contact, LegalProceeding, LegalProceedingStage, LegalProceedingEntry,
                            LegalProceedingAssignee, AuditLog)}
        rows = (await db.execute(select(LegalProceeding.id, LegalProceeding.title, LegalProceeding.status)
                                 .order_by(LegalProceeding.id))).all()
    return {**counts, "proceedings": [tuple(r) for r in rows]}


COMMIT_FAILURES = {
    "new_contact_and_proceeding": lambda c, h, pid, other: c.post(f"{API}/proceedings", headers=h, json={
        "party_role": "other", "apartment_number": "4", "title": "t",
        "contact": {"details": {**NEW_CONTACT, "name": "לא יישמר", "phone": "050-7787787"}}}),
    "contact": lambda c, h, pid, other: c.post(f"{API}/contacts", headers=h,
                                               json={"kind": "person", "name": "n", "phone": "03-1234567"}),
    "update": lambda c, h, pid, other: c.patch(f"{API}/proceedings/{pid}", headers=h, json={"title": "changed"}),
    "close": lambda c, h, pid, other: c.post(f"{API}/proceedings/{pid}/close", headers=h, json={"reason": "r"}),
    "assign": lambda c, h, pid, other: c.post(f"{API}/proceedings/{pid}/assignees", headers=h, json={"user_id": other}),
    "note": lambda c, h, pid, other: c.post(f"{API}/proceedings/{pid}/entries", headers=h,
                                            data={"entry_type": "note", "content": "c"}),
}


@pytest.mark.parametrize("operation", COMMIT_FAILURES)
async def test_failed_commit_rolls_back_and_never_reports_success(test_client, test_engine, lawyer, colleague,
                                                                  monkeypatch, operation):
    pid = (await open_proceeding(test_client, lawyer, party_role="other"))["proceeding"]["id"]
    plain = async_sessionmaker(test_engine, expire_on_commit=False)
    before = await _db_state(plain)

    _CommitFails.rollbacks = 0
    monkeypatch.setattr("backend.db.session.AsyncSessionLocal",
                        async_sessionmaker(test_engine, class_=_CommitFails, expire_on_commit=False))
    test_client._transport.app.dependency_overrides.clear()  # the real get_db

    r = await COMMIT_FAILURES[operation](test_client, auth(lawyer), pid, colleague.id)
    assert r.status_code == 500, r.text
    assert _CommitFails.rollbacks >= 1
    assert await _db_state(plain) == before  # nothing partial remains


@pytest.mark.parametrize("email, status, stored", [
    ("not-an-email", 422, None),
    ("a@", 422, None),
    ("  ", 201, None),
    (None, 201, None),
    (" person@example.com ", 201, "person@example.com"),
])
async def test_contact_email_is_optional_but_must_be_valid(test_client, lawyer, email, status, stored):
    r = await test_client.post(f"{API}/contacts", json={"kind": "person", "name": "n", "phone": "03-1234561", "email": email},
                               headers=auth(lawyer))
    assert r.status_code == status, r.text
    if status == 201:
        assert r.json()["contact"]["email"] == stored


async def test_contact_email_may_be_omitted_and_is_validated_everywhere(test_client, lawyer, admin_user):
    h, ah = auth(lawyer), auth(admin_user)
    r = await test_client.post(f"{API}/contacts", json={"kind": "person", "name": "n", "phone": "03-1234562"}, headers=h)
    assert r.status_code == 201 and r.json()["contact"]["email"] is None
    cid = r.json()["contact"]["id"]
    assert (await test_client.patch(f"{API}/contacts/{cid}", json={"email": "bad"}, headers=ah)).status_code == 422
    r = await test_client.patch(f"{API}/contacts/{cid}", json={"email": "ok@example.com"}, headers=ah)
    assert r.status_code == 200 and r.json()["email"] == "ok@example.com"
    r = await test_client.patch(f"{API}/contacts/{cid}", json={"email": None}, headers=ah)
    assert r.status_code == 200 and r.json()["email"] is None
    body = {"party_role": "other", "apartment_number": "4", "title": "t",
            "contact": {"details": {**NEW_CONTACT, "email": "bad"}}}
    assert (await test_client.post(f"{API}/proceedings", json=body, headers=h)).status_code == 422


async def test_users_by_id_is_one_query_and_ignores_none(test_engine, test_db, lawyer, colleague):
    from backend.repositories.user_repository import UserRepository

    repo, seen = UserRepository(test_db), []
    listener = lambda conn, cur, statement, *a: seen.append(statement)
    event.listen(test_engine.sync_engine, "before_cursor_execute", listener)
    try:
        assert await repo.users_by_id([None]) == {}
        assert seen == []
        found = await repo.users_by_id([lawyer.id, colleague.id, None, lawyer.id])
    finally:
        event.remove(test_engine.sync_engine, "before_cursor_execute", listener)
    # User has selectin relationships; the users themselves come from one statement.
    assert set(found) == {lawyer.id, colleague.id} and sum("FROM users" in s and "users.id IN" in s for s in seen) == 1


def test_clean_text():
    from fastapi import HTTPException
    from backend.services.legal_access import clean_text

    assert clean_text(None) is None and clean_text("   ") is None and clean_text("  a ") == "a" and clean_text(5) == "5"
    with pytest.raises(HTTPException) as err:
        clean_text("abcd", limit=3, field_name="f")
    assert err.value.detail["code"] == "value_too_long" and err.value.detail["field"] == "f"


async def test_duplicate_check_is_general_and_needs_write(test_client, test_db, lawyer):
    h = auth(lawyer)
    await test_client.post(f"{API}/contacts", json={"kind": "person", "name": "n", "phone": "050-5550001", "phone_2": "050-5550002"}, headers=h)
    url = f"{API}/contacts/duplicates"
    assert (await test_client.post(url, json={"phone": "+972505550002"}, headers=h)).json() == {"has_match": True}
    assert (await test_client.post(url, json={"phone": "0509999999", "phone_2": "050 555 0001"}, headers=h)).json() == {"has_match": True}
    assert (await test_client.post(url, json={"phone": "0509999999"}, headers=h)).json() == {"has_match": False}
    r = await test_client.post(url, json={"phone": "12"}, headers=h)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "invalid_phone"
    reader = await make_user(test_db, "reader@test.com", "read")
    assert (await test_client.post(url, json={"phone": "0505550001"}, headers=auth(reader))).status_code == 403


# ── selecting an existing contact ────────────────────────────────────────────

async def _card(client, user, phone, **extra) -> int:
    r = await client.post(f"{API}/contacts", json={"kind": "person", "name": "כרטיס", "phone": phone, **extra}, headers=auth(user))
    assert r.status_code == 201, r.text
    return r.json()["contact"]["id"]


def _open_body(contact_id):
    return {"party_role": "other", "apartment_number": "4", "title": "t", "contact": {"contact_id": contact_id}}


def _real_get_db(client, engine, monkeypatch, session_class=AsyncSession):
    monkeypatch.setattr("backend.db.session.AsyncSessionLocal", async_sessionmaker(engine, class_=session_class, expire_on_commit=False))
    client._transport.app.dependency_overrides.clear()
    return async_sessionmaker(engine, expire_on_commit=False)


async def _contact_row(maker, cid) -> tuple:
    async with maker() as db:
        c = await db.get(Contact, cid)
        return (c.kind, c.name, c.email, c.phone, c.phone_2, c.address, c.notes, c.is_active, c.updated_at)


async def test_selecting_an_existing_contact_never_changes_it(test_client, test_engine, test_db, lawyer):
    cid = await _card(test_client, lawyer, "050-6000001", email="keep@example.com", address="כתובת", notes="פנימי")
    maker = async_sessionmaker(test_engine, expire_on_commit=False)
    before = await _contact_row(maker, cid)
    r = await test_client.post(f"{API}/proceedings", headers=auth(lawyer), json=_open_body(cid))
    assert r.status_code == 201, r.text
    assert r.json()["proceeding"]["contact"]["id"] == cid and r.json()["has_match"] is False
    assert await _contact_row(maker, cid) == before
    assert (await test_db.execute(select(func.count(Contact.id)))).scalar() == 1
    updates = select(func.count(AuditLog.id)).where(AuditLog.entity == "contact", AuditLog.action == "updated")
    assert (await test_db.execute(updates)).scalar() == 0


async def test_details_cannot_be_sent_with_an_existing_contact(test_client, lawyer):
    cid = await _card(test_client, lawyer, "050-6000011", email="a@example.com", address="כתובת")
    body = _open_body(cid)
    body["contact"]["details"] = {"address": "אחר", "email": "b@example.com"}
    assert (await test_client.post(f"{API}/proceedings", headers=auth(lawyer), json=body)).status_code == 422
    body = _open_body(cid)
    body["contact"] = {}
    assert (await test_client.post(f"{API}/proceedings", headers=auth(lawyer), json=body)).status_code == 422


async def test_incomplete_card_needs_an_explicit_edit_first(test_client, test_engine, test_db, lawyer, admin_user):
    cid = await _card(test_client, lawyer, "050-6000012", address="כתובת")
    maker = async_sessionmaker(test_engine, expire_on_commit=False)
    before = await _contact_row(maker, cid)
    r = await test_client.post(f"{API}/proceedings", headers=auth(lawyer), json=_open_body(cid))
    assert r.status_code == 422 and r.json()["detail"]["code"] == "contact_details_incomplete"
    assert r.json()["detail"]["missing"] == ["email"] and "מנהל" in r.json()["detail"]["message"]
    assert await _contact_row(maker, cid) == before
    r = await test_client.patch(f"{API}/contacts/{cid}", json={"email": "new@example.com"}, headers=auth(admin_user))
    assert r.status_code == 200 and r.json()["email"] == "new@example.com"
    logged = (await test_db.execute(select(AuditLog.details).where(AuditLog.entity == "contact", AuditLog.action == "updated"))).scalar_one()
    assert json.loads(logged) == {"before": {"email": None}, "after": {"email": "new@example.com"}}
    assert (await test_client.post(f"{API}/proceedings", headers=auth(lawyer), json=_open_body(cid))).status_code == 201


@pytest.mark.parametrize("party_role", ["tenant", "landlord", "supplier", "other"])
@pytest.mark.parametrize("email", [None, "", "  ", "not-an-email"])
async def test_new_party_needs_a_valid_email_in_every_role(test_client, lawyer, party_role, email):
    landlord = await _landlord(test_client, lawyer)
    details = {**NEW_CONTACT, "phone": "050-6000013"}
    if email is None:
        details.pop("email")
    else:
        details["email"] = email
    body = {"party_role": party_role, "apartment_number": "4", "title": "t", "contact": {"details": details}}
    if party_role == "tenant":
        body["landlord"] = {"contact_id": landlord}
    assert (await test_client.post(f"{API}/proceedings", headers=auth(lawyer), json=body)).status_code == 422


@pytest.mark.parametrize("party_role", ["tenant", "landlord", "supplier", "other"])
async def test_existing_party_without_email_is_rejected_in_every_role(test_client, lawyer, party_role):
    landlord = await _landlord(test_client, lawyer)
    cid = await _card(test_client, lawyer, "050-6000014", address="כתובת")
    body = {**_open_body(cid), "party_role": party_role}
    if party_role == "tenant":
        body["landlord"] = {"contact_id": landlord}
    r = await test_client.post(f"{API}/proceedings", headers=auth(lawyer), json=body)
    assert r.status_code == 422 and r.json()["detail"]["missing"] == ["email"]


async def test_email_stays_optional_on_the_contact_itself(test_client, test_engine, lawyer):
    cid = await _card(test_client, lawyer, "050-6000015")
    async with async_sessionmaker(test_engine)() as db:
        assert (await db.get(Contact, cid)).email is None
    assert Contact.__table__.c.email.nullable is True


async def test_contact_search_and_proceeding_expose_no_internal_fields(test_client, lawyer):
    expected = {"id", "name", "phone", "phone_2", "email", "address"}
    cid = await _card(test_client, lawyer, "050-6000016", email="a@example.com", address="כתובת", notes="מידע פנימי")
    h = auth(lawyer)
    found = (await test_client.get(f"{API}/contacts", params={"search": "כרטיס"}, headers=h)).json()
    assert [set(c) for c in found] == [expected]
    created = (await test_client.post(f"{API}/proceedings", headers=h, json=_open_body(cid))).json()
    assert set(created["proceeding"]["contact"]) == expected and "מידע פנימי" not in str(created)
    got = await test_client.get(f"{API}/proceedings/{created['proceeding']['id']}", headers=h)
    assert set(got.json()["contact"]) == expected and "מידע פנימי" not in got.text


@pytest.mark.parametrize("party_role", ["tenant", "landlord", "supplier", "other"])
async def test_required_details_for_every_role(test_client, lawyer, party_role):
    h, landlord = auth(lawyer), await _landlord(test_client, lawyer)
    body = {"party_role": party_role, "apartment_number": "4", "title": "t",
            "contact": {"details": {"kind": "person", "name": "n", "phone": "050-6000021", "email": "a@example.com"}}}
    if party_role == "tenant":
        body["landlord"] = {"contact_id": landlord}
    r = await test_client.post(f"{API}/proceedings", headers=h, json=body)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "contact_details_incomplete"
    assert r.json()["detail"]["party"] == "contact" and r.json()["detail"]["missing"] == ["address"]


async def test_incomplete_landlord_is_rejected(test_client, lawyer):
    bare = await _card(test_client, lawyer, "050-6000031")
    body = {"party_role": "tenant", "apartment_number": "4", "title": "t", "contact": {"details": dict(NEW_CONTACT)},
            "landlord": {"contact_id": bare}}
    r = await test_client.post(f"{API}/proceedings", headers=auth(lawyer), json=body)
    assert r.status_code == 422 and r.json()["detail"]["party"] == "landlord"


async def test_selecting_requires_write_and_an_active_contact(test_client, test_db, lawyer):
    cid = await _card(test_client, lawyer, "050-6000041", email="a@example.com", address="כתובת")
    reader = await make_user(test_db, "reader2@test.com", "read")
    assert (await test_client.post(f"{API}/proceedings", headers=auth(reader), json=_open_body(cid))).status_code == 403
    contact = await test_db.get(Contact, cid)
    contact.is_active = False
    await test_db.commit()
    r = await test_client.post(f"{API}/proceedings", headers=auth(lawyer), json=_open_body(cid))
    assert r.status_code == 422 and r.json()["detail"]["code"] == "contact_inactive"


async def test_selected_contacts_are_locked_together_in_id_order(test_client, test_engine, lawyer):
    first = await _card(test_client, lawyer, "050-6000051", email="a@example.com", address="א")
    second = await _card(test_client, lawyer, "050-6000052", email="b@example.com", address="ב")
    seen = []
    listener = lambda conn, cur, statement, *a: seen.append(statement)
    event.listen(test_engine.sync_engine, "before_cursor_execute", listener)
    try:
        r = await test_client.post(f"{API}/proceedings", headers=auth(lawyer), json={
            "party_role": "tenant", "apartment_number": "4", "title": "t",
            "contact": {"contact_id": second}, "landlord": {"contact_id": first}})
    finally:
        event.remove(test_engine.sync_engine, "before_cursor_execute", listener)
    assert r.status_code == 201, r.text
    locks = [s for s in seen if "FROM contacts" in s and "ORDER BY contacts.id" in s and "IN (" in s]
    assert len(locks) == 1
    if test_engine.dialect.name == "postgresql":
        assert "FOR UPDATE" in locks[0]


async def test_same_contact_may_be_tenant_and_landlord(test_client, lawyer):
    cid = await _card(test_client, lawyer, "050-6000061", email="a@example.com", address="א")
    r = await test_client.post(f"{API}/proceedings", headers=auth(lawyer), json={
        "party_role": "tenant", "apartment_number": "4", "title": "t",
        "contact": {"contact_id": cid}, "landlord": {"contact_id": cid}})
    assert r.status_code == 201 and r.json()["proceeding"]["linked_landlord"]["id"] == cid


@pytest.mark.parametrize("failure", ["business", "commit"])
async def test_failure_leaves_no_proceeding_and_an_unchanged_card(test_client, test_engine, lawyer, monkeypatch, failure):
    from backend.services.legal_proceeding_service import LegalProceedingService

    cid = await _card(test_client, lawyer, "050-6000071", email="a@example.com", address="כתובת")
    maker = _real_get_db(test_client, test_engine, monkeypatch, _CommitFails if failure == "commit" else AsyncSession)
    before = await _contact_row(maker, cid)
    if failure == "business":
        async def boom(self, *a, **k):
            raise RuntimeError("audit down")

        monkeypatch.setattr(LegalProceedingService, "_log", boom)
    r = await test_client.post(f"{API}/proceedings", headers=auth(lawyer), json=_open_body(cid))
    assert r.status_code == 500
    assert await _contact_row(maker, cid) == before
    async with maker() as check:
        assert (await check.execute(select(func.count(LegalProceeding.id)))).scalar() == 0


# ── phones already stored in an older format ─────────────────────────────────

async def test_unnormalized_stored_phone_behaviour(test_client, test_db, admin_user):
    """Only written outside the service (no such path exists today): exact comparison misses it."""
    legacy = Contact(kind="person", name="ישן", phone="050-7000001", email="a@example.com", address="א")
    test_db.add(legacy)
    await test_db.commit()
    h = auth(admin_user)
    url = f"{API}/contacts/duplicates"
    assert (await test_client.post(url, json={"phone": "0507000001"}, headers=h)).json() == {"has_match": False}
    found = (await test_client.get(f"{API}/contacts", params={"search": "0507000001"}, headers=h)).json()
    assert found == []
    assert [c["id"] for c in (await test_client.get(f"{API}/contacts", params={"search": "ישן"}, headers=h)).json()] == [legacy.id]
    # an edit of another field leaves it as is; an edit of the phone normalizes it
    r = await test_client.patch(f"{API}/contacts/{legacy.id}", json={"address": "ב"}, headers=h)
    assert r.status_code == 200 and r.json()["phone"] == "050-7000001"
    r = await test_client.patch(f"{API}/contacts/{legacy.id}", json={"phone": "050-7000001"}, headers=h)
    assert r.status_code == 200 and r.json()["phone"] == "0507000001"
    assert (await test_client.post(url, json={"phone": "+972507000001"}, headers=h)).json() == {"has_match": True}


async def test_card_of_an_open_proceeding_keeps_required_fields(test_client, admin_user, lawyer):
    created = (await open_proceeding(test_client, admin_user, party_role="other"))["proceeding"]
    cid, h = created["contact"]["id"], auth(admin_user)
    for body in ({"phone": ""}, {"name": ""}, {"phone": "12"}):
        assert (await test_client.patch(f"{API}/contacts/{cid}", json=body, headers=h)).status_code == 422
    for body, fields in (({"email": None}, ["email"]), ({"email": "  "}, ["email"]), ({"address": ""}, ["address"]),
                         ({"email": None, "address": None}, ["email", "address"])):
        r = await test_client.patch(f"{API}/contacts/{cid}", json=body, headers=h)
        assert r.status_code == 422 and r.json()["detail"]["code"] == "contact_required_for_open_proceeding", r.text
        assert r.json()["detail"]["fields"] == fields
    r = await test_client.patch(f"{API}/contacts/{cid}", json={"email": "new@example.com", "address": "חדשה", "notes": "n"}, headers=h)
    assert r.status_code == 200 and (r.json()["email"], r.json()["address"], r.json()["notes"]) == ("new@example.com", "חדשה", "n")
    # once closed the fields can be cleared
    await test_client.post(f"{API}/proceedings/{created['id']}/close", json={"reason": "r"}, headers=h)
    assert (await test_client.patch(f"{API}/contacts/{cid}", json={"address": None}, headers=h)).status_code == 200


async def test_linked_landlord_card_keeps_required_fields(test_client, admin_user, lawyer):
    landlord = await _landlord(test_client, lawyer)
    await open_proceeding(test_client, lawyer, party_role="tenant", landlord_contact_id=landlord)
    r = await test_client.patch(f"{API}/contacts/{landlord}", json={"email": None}, headers=auth(admin_user))
    assert r.status_code == 422 and r.json()["detail"]["fields"] == ["email"]


async def _super_admin(db) -> User:
    user = User(email="super@test.com", password_hash=hash_password("x"), full_name="Super", role="SuperAdmin",
                is_active=True, email_verified=True)
    db.add(user)
    await db.commit()
    return user


async def test_only_admin_and_super_admin_edit_a_contact(test_client, test_db, admin_user, lawyer, colleague):
    created = (await open_proceeding(test_client, lawyer, party_role="other"))["proceeding"]
    cid = created["contact"]["id"]
    assert (await test_client.post(f"{API}/proceedings/{created['id']}/assignees", json={"user_id": colleague.id}, headers=auth(lawyer))).status_code == 201
    for user in (lawyer, colleague):  # the creator, an assignee: both hold IAM update
        r = await test_client.patch(f"{API}/contacts/{cid}", json={"notes": "x"}, headers=auth(user))
        assert r.status_code == 403, r.text
    assert (await test_client.patch(f"{API}/contacts/{cid}", json={"notes": "x"})).status_code == 401
    superadmin = await _super_admin(test_db)
    for user, note in ((admin_user, "a"), (superadmin, "b")):
        r = await test_client.patch(f"{API}/contacts/{cid}", json={"notes": note}, headers=auth(user))
        assert r.status_code == 200 and r.json()["notes"] == note
    assert (await test_client.get(f"{API}/proceedings/{created['id']}", headers=auth(superadmin))).status_code == 200
    assert (await test_client.patch(f"{API}/contacts/999999", json={"notes": "x"}, headers=auth(lawyer))).status_code == 403
    logged = (await test_db.execute(select(AuditLog.details).where(AuditLog.entity == "contact", AuditLog.action == "updated").order_by(AuditLog.id))).scalars().all()
    assert [json.loads(x)["after"] for x in logged] == [{"notes": "a"}, {"notes": "b"}]


async def test_no_other_route_edits_an_existing_contact(test_client, test_engine, lawyer):
    cid = await _card(test_client, lawyer, "050-7200001", email="a@example.com", address="א", notes="n")
    maker = async_sessionmaker(test_engine, expire_on_commit=False)
    before = await _contact_row(maker, cid)
    h = auth(lawyer)
    attempts = [
        test_client.post(f"{API}/contacts", json={"id": cid, "kind": "person", "name": "x", "phone": "050-7200002"}, headers=h),
        test_client.post(f"{API}/proceedings", headers=h, json={"party_role": "other", "apartment_number": "4", "title": "t",
                         "contact": {"contact_id": cid, "details": {"email": "b@example.com"}}}),
    ]
    for attempt in attempts:
        assert (await attempt).status_code == 422
    assert await _contact_row(maker, cid) == before


@pytest.mark.parametrize("stored, sent", [
    ({"phone": "050-7300001"}, {"phone": "+972 50 730 0001"}),
    ({"phone": "050-7300002", "phone_2": "052-7300002"}, {"phone": "052-7300002"}),
    ({"phone": "050-7300003"}, {"phone": "059-9999993", "phone_2": "0507300003"}),
    ({"phone": "050-7300004", "phone_2": "052-7300004"}, {"phone": "059-9999994", "phone_2": "972527300004"}),
])
async def test_duplicate_phone_is_blocked_until_confirmed(test_client, test_db, lawyer, stored, sent):
    await _card(test_client, lawyer, **{"phone": stored["phone"], **({"phone_2": stored["phone_2"]} if "phone_2" in stored else {})})
    h, url = auth(lawyer), f"{API}/contacts"
    body = {"kind": "person", "name": "כרטיס", "email": "z@example.com", **sent}
    r = await test_client.post(url, json=body, headers=h)
    assert r.status_code == 409 and set(r.json()["detail"]) == {"code", "message", "has_match"}
    assert r.json()["detail"]["code"] == "duplicate_phone" and r.json()["detail"]["has_match"] is True
    assert (await test_db.execute(select(func.count(Contact.id)))).scalar() == 1
    r = await test_client.post(url, json={**body, "confirm_duplicate": True}, headers=h)
    assert r.status_code == 201 and r.json()["has_match"] is True
    logged = (await test_db.execute(select(AuditLog.details).where(AuditLog.entity == "contact", AuditLog.entity_id == str(r.json()["contact"]["id"])))).scalar_one()
    assert json.loads(logged)["duplicate_phone_confirmed"] is True


async def test_same_name_and_email_are_not_duplicates(test_client, lawyer):
    await _card(test_client, lawyer, "050-7400001", email="same@example.com")
    r = await test_client.post(f"{API}/contacts", headers=auth(lawyer), json={"kind": "person", "name": "כרטיס", "phone": "050-7400002", "email": "same@example.com"})
    assert r.status_code == 201 and r.json()["has_match"] is False


async def test_duplicate_while_opening_a_proceeding_needs_confirmation(test_client, test_engine, lawyer, monkeypatch):
    await _card(test_client, lawyer, "050-7100001")
    maker = _real_get_db(test_client, test_engine, monkeypatch)
    body = {"party_role": "other", "apartment_number": "4", "title": "t",
            "contact": {"details": {**NEW_CONTACT, "phone": "+972 50 710 0001"}}}
    r = await test_client.post(f"{API}/proceedings", headers=auth(lawyer), json=body)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "duplicate_phone"
    async with maker() as check:
        assert (await check.execute(select(func.count(Contact.id)))).scalar() == 1
        assert (await check.execute(select(func.count(LegalProceeding.id)))).scalar() == 0
    r = await test_client.post(f"{API}/proceedings", headers=auth(lawyer), json={**body, "confirm_duplicate_contact": True})
    assert r.status_code == 201 and r.json()["has_match"] is True and set(r.json()) == {"proceeding", "has_match"}


async def test_phone_locks_do_nothing_outside_postgresql(test_db, test_engine):
    from backend.repositories.contact_repository import ContactRepository

    if test_engine.dialect.name != "sqlite":
        pytest.skip("SQLite behaviour")
    seen = []
    listener = lambda conn, cur, statement, *a: seen.append(statement)
    event.listen(test_engine.sync_engine, "before_cursor_execute", listener)
    try:
        await ContactRepository(test_db).lock_phones(["0501234567", "0521234567"])
    finally:
        event.remove(test_engine.sync_engine, "before_cursor_execute", listener)
    assert seen == []


# ── duplicate phones on update ───────────────────────────────────────────────

_OTHER = {"phone": "050-7500001", "phone_2": "052-7500001"}


async def _two_cards(client, user) -> tuple[int, int]:
    other = await _card(client, user, _OTHER["phone"], phone_2=_OTHER["phone_2"])
    edited = await _card(client, user, "050-7500009", phone_2="052-7500009")
    return other, edited


@pytest.mark.parametrize("body", [
    {"phone": "+972 50 750 0001"},                      # phone, against the other card's phone
    {"phone": "052-7500001"},                           # phone, against the other card's phone_2
    {"phone_2": "972507500001"},                        # phone_2, against the other card's phone
    {"phone_2": "(052) 7500001"},                       # phone_2, against the other card's phone_2
    {"phone": "059-7500008", "phone_2": "050-7500001"}, # both, one of them taken
])
async def test_update_to_a_taken_phone_is_blocked_until_confirmed(test_client, test_engine, test_db, lawyer, admin_user, body):
    _, cid = await _two_cards(test_client, lawyer)
    maker, h = async_sessionmaker(test_engine, expire_on_commit=False), auth(admin_user)
    before = await _contact_row(maker, cid)
    r = await test_client.patch(f"{API}/contacts/{cid}", json=body, headers=h)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "duplicate_phone"
    assert set(r.json()["detail"]) == {"code", "message", "has_match"}
    assert await _contact_row(maker, cid) == before
    r = await test_client.patch(f"{API}/contacts/{cid}", json={**body, "confirm_duplicate": True}, headers=h)
    assert r.status_code == 200, r.text
    logged = (await test_db.execute(select(AuditLog.details).where(AuditLog.entity == "contact", AuditLog.entity_id == str(cid),
                                                                   AuditLog.action == "updated"))).scalar_one()
    assert json.loads(logged)["duplicate_phone_confirmed"] is True


@pytest.mark.parametrize("body, phone, phone_2", [
    ({"phone": "059-7500002"}, "0597500002", "0527500009"),
    ({"phone_2": "059-7500003"}, "0507500009", "0597500003"),
    ({"phone": "059-7500004", "phone_2": "058-7500004"}, "0597500004", "0587500004"),
])
async def test_update_to_a_free_phone_is_normalized_and_audited_plainly(test_client, test_db, lawyer, admin_user, body, phone, phone_2):
    _, cid = await _two_cards(test_client, lawyer)
    r = await test_client.patch(f"{API}/contacts/{cid}", json=body, headers=auth(admin_user))
    assert r.status_code == 200 and (r.json()["phone"], r.json()["phone_2"]) == (phone, phone_2)
    logged = (await test_db.execute(select(AuditLog.details).where(AuditLog.entity == "contact", AuditLog.entity_id == str(cid),
                                                                   AuditLog.action == "updated"))).scalar_one()
    assert "duplicate_phone_confirmed" not in json.loads(logged)


@pytest.mark.parametrize("body", [
    {"phone": "050-7500009"},                                 # its own number, another format
    {"phone": "+972507500009", "phone_2": "0527500009"},      # both unchanged
    {"phone": "052-7500009", "phone_2": "050-7500009"},       # swapped
    {"notes": "בלי טלפון"},                                    # no phone at all
])
async def test_a_contact_never_matches_itself(test_client, lawyer, admin_user, body):
    _, cid = await _two_cards(test_client, lawyer)
    r = await test_client.patch(f"{API}/contacts/{cid}", json=body, headers=auth(admin_user))
    assert r.status_code == 200, r.text


async def test_keeping_an_already_confirmed_duplicate_needs_no_new_confirmation(test_client, lawyer, admin_user):
    _, cid = await _two_cards(test_client, lawyer)
    h = auth(admin_user)
    await test_client.patch(f"{API}/contacts/{cid}", json={"phone": "050-7500001", "confirm_duplicate": True}, headers=h)
    r = await test_client.patch(f"{API}/contacts/{cid}", json={"phone": "050-7500001", "notes": "n"}, headers=h)
    assert r.status_code == 200


async def test_update_duplicate_check_keeps_the_admin_only_rule(test_client, lawyer, admin_user):
    _, cid = await _two_cards(test_client, lawyer)
    r = await test_client.patch(f"{API}/contacts/{cid}", json={"phone": "050-7500001", "confirm_duplicate": True}, headers=auth(lawyer))
    assert r.status_code == 403


# ── list filters and the landlord picker ─────────────────────────────────────

async def _project(db, name) -> int:
    project = Project(name=name, is_active=True)
    db.add(project)
    await db.commit()
    return project.id


@pytest_asyncio.fixture
async def listing(test_client, test_db, lawyer):
    """p1: A / landlord1 / open; p2: A / landlord1 / closed; p3: A / landlord2 / open;
    p4: B / landlord1 / open; p5: A, the landlord himself as primary contact, open."""
    a, b = await _project(test_db, "פרויקט א"), await _project(test_db, "פרויקט ב")
    l1, l2 = await _landlord(test_client, lawyer, "בעל א"), await _landlord(test_client, lawyer, "בעל ב")

    async def tenant(project, landlord):
        return (await open_proceeding(test_client, lawyer, party_role="tenant", landlord_contact_id=landlord, project_id=project))["proceeding"]["id"]

    p1, p2, p3, p4 = await tenant(a, l1), await tenant(a, l1), await tenant(a, l2), await tenant(b, l1)
    p5 = (await open_proceeding(test_client, lawyer, party_role="landlord", contact_id=l1, project_id=a))["proceeding"]["id"]
    await test_client.post(f"{API}/proceedings/{p2}/close", json={"reason": "r"}, headers=auth(lawyer))
    return dict(a=a, b=b, l1=l1, l2=l2, p1=p1, p2=p2, p3=p3, p4=p4, p5=p5)


async def _ids(client, user, **params) -> tuple[list[int], int]:
    r = await client.get(f"{API}/proceedings", params=params, headers=auth(user))
    assert r.status_code == 200, r.text
    return sorted(i["id"] for i in r.json()["items"]), r.json()["total"]


async def test_each_filter_alone_and_combined(test_client, lawyer, listing):
    x = listing
    cases = [
        ({"project_id": x["a"]}, [x["p1"], x["p2"], x["p3"], x["p5"]]),
        ({"project_id": x["b"]}, [x["p4"]]),
        ({"landlord_contact_id": x["l1"]}, [x["p1"], x["p2"], x["p4"]]),   # not p5: he is its primary contact
        ({"landlord_contact_id": x["l2"]}, [x["p3"]]),
        ({"status": "open"}, [x["p1"], x["p3"], x["p4"], x["p5"]]),
        ({"status": "closed"}, [x["p2"]]),
        ({"project_id": x["a"], "landlord_contact_id": x["l1"]}, [x["p1"], x["p2"]]),
        ({"project_id": x["a"], "status": "open"}, [x["p1"], x["p3"], x["p5"]]),
        ({"landlord_contact_id": x["l1"], "status": "open"}, [x["p1"], x["p4"]]),
        ({"project_id": x["a"], "landlord_contact_id": x["l1"], "status": "open"}, [x["p1"]]),
        ({"project_id": x["b"], "landlord_contact_id": x["l2"], "status": "open"}, []),
    ]
    for params, expected in cases:
        assert await _ids(test_client, lawyer, **params) == (sorted(expected), len(expected)), params
    assert (await test_client.get(f"{API}/proceedings", params={"status": "pending"}, headers=auth(lawyer))).status_code == 422


async def test_filters_respect_visibility(test_client, admin_user, lawyer, colleague, listing):
    x = listing
    assert await _ids(test_client, colleague, landlord_contact_id=x["l1"]) == ([], 0)
    assert await _ids(test_client, admin_user, landlord_contact_id=x["l1"]) == (sorted([x["p1"], x["p2"], x["p4"]]), 3)
    await test_client.post(f"{API}/proceedings/{x['p1']}/assignees", json={"user_id": colleague.id}, headers=auth(lawyer))
    assert await _ids(test_client, colleague, project_id=x["a"], landlord_contact_id=x["l1"], status="open") == ([x["p1"]], 1)


async def test_filtered_pagination_has_a_right_total_and_no_repeats(test_client, lawyer, listing):
    x, seen = listing, []
    for page in (1, 2):
        r = (await test_client.get(f"{API}/proceedings", params={"landlord_contact_id": x["l1"], "page": page, "page_size": 2}, headers=auth(lawyer))).json()
        assert r["total"] == 3 and r["page"] == page and r["page_size"] == 2
        seen += [i["id"] for i in r["items"]]
    assert sorted(seen) == sorted([x["p1"], x["p2"], x["p4"]])


async def test_assignees_do_not_multiply_filtered_rows(test_client, lawyer, colleague, test_db, listing):
    x = listing
    other = await make_user(test_db, "third@test.com", "read")
    for user_id in (colleague.id, other.id):
        await test_client.post(f"{API}/proceedings/{x['p3']}/assignees", json={"user_id": user_id}, headers=auth(lawyer))
    assert await _ids(test_client, lawyer, landlord_contact_id=x["l2"]) == ([x["p3"]], 1)
    landlords = (await test_client.get(f"{API}/landlords", headers=auth(colleague))).json()
    assert landlords == [{"id": x["l2"], "name": "בעל ב"}]


async def test_landlord_picker_lists_visible_landlords_once(test_client, test_db, admin_user, lawyer, colleague, listing):
    x, url = listing, f"{API}/landlords"
    expected = [{"id": x["l1"], "name": "בעל א"}, {"id": x["l2"], "name": "בעל ב"}]
    assert (await test_client.get(url, headers=auth(lawyer))).json() == expected
    assert (await test_client.get(url, headers=auth(admin_user))).json() == expected
    assert (await test_client.get(url, headers=auth(colleague))).json() == []
    nobody = await make_user(test_db, "nobody2@test.com")
    assert (await test_client.get(url, headers=auth(nobody))).status_code == 403
    assert (await test_client.get(url)).status_code == 401


async def test_primary_landlord_alone_is_not_in_the_picker(test_client, lawyer):
    own = await _landlord(test_client, lawyer, "בעל ראשי")
    await open_proceeding(test_client, lawyer, party_role="landlord", contact_id=own)
    assert (await test_client.get(f"{API}/landlords", headers=auth(lawyer))).json() == []


async def test_landlord_picker_query_count_does_not_grow(test_client, test_engine, lawyer):
    landlord = await _landlord(test_client, lawyer, "בעל")

    async def count() -> tuple[int, int]:
        seen = []
        listener = lambda conn, cur, statement, *a: seen.append(statement)
        event.listen(test_engine.sync_engine, "before_cursor_execute", listener)
        try:
            r = await test_client.get(f"{API}/landlords", headers=auth(lawyer))
        finally:
            event.remove(test_engine.sync_engine, "before_cursor_execute", listener)
        return len(seen), len(r.json())

    await open_proceeding(test_client, lawyer, party_role="tenant", landlord_contact_id=landlord)
    first, rows = await count()
    for i in range(3):
        other = await _landlord(test_client, lawyer, f"בעל {i}")
        await open_proceeding(test_client, lawyer, party_role="tenant", landlord_contact_id=other)
    assert rows == 1 and (await count()) == (first, 4)


# ── open-proceeding warning ──────────────────────────────────────────────────

async def test_open_proceeding_warning_is_general_and_tenant_only(test_client, test_db, lawyer, colleague):
    landlord = await _landlord(test_client, lawyer)
    tenant = await _card(test_client, lawyer, "050-6000091", email="a@example.com", address="א")
    first = await open_proceeding(test_client, lawyer, party_role="tenant", contact_id=tenant, landlord_contact_id=landlord, title="סודי")
    url = f"{API}/contacts/{tenant}/open-proceedings"
    assert (await test_client.get(url, headers=auth(colleague))).json() == {"has_open": True}
    body = {"party_role": "tenant", "apartment_number": "9", "title": "t", "contact": {"contact_id": tenant}, "landlord": {"contact_id": landlord}}
    r = await test_client.post(f"{API}/proceedings", headers=auth(colleague), json=body)
    assert r.status_code == 409
    assert r.json()["detail"] == {"code": "tenant_has_open_proceeding", "message": "לאיש קשר זה כבר קיים הליך משפטי פתוח. האם להמשיך?"}
    assert "סודי" not in r.text and str(first["proceeding"]["opened_at"]) not in r.text
    r = await test_client.post(f"{API}/proceedings", headers=auth(colleague), json={**body, "confirm_open_proceeding": True})
    assert r.status_code == 201 and "open_proceedings" not in r.json()
    pid = r.json()["proceeding"]["id"]
    details = (await test_db.execute(select(AuditLog.details).where(AuditLog.entity == "legal_proceeding", AuditLog.entity_id == str(pid),
                                                                    AuditLog.action == "proceeding_created"))).scalar_one()
    parsed = json.loads(details)
    assert parsed["had_open_proceeding"] is True and "open_proceedings_of_contact" not in parsed
    # the same person as another role is not warned, and a landlord is not "a tenant with an open proceeding"
    assert (await test_client.get(f"{API}/contacts/{landlord}/open-proceedings", headers=auth(lawyer))).json() == {"has_open": False}
    other = {"party_role": "other", "apartment_number": "9", "title": "t", "contact": {"contact_id": tenant}}
    r = await test_client.post(f"{API}/proceedings", headers=auth(lawyer), json=other)
    assert r.status_code == 201


async def test_closed_tenant_proceeding_does_not_warn(test_client, lawyer):
    landlord = await _landlord(test_client, lawyer)
    tenant = await _card(test_client, lawyer, "050-6000101", email="a@example.com", address="א")
    first = await open_proceeding(test_client, lawyer, party_role="tenant", contact_id=tenant, landlord_contact_id=landlord)
    await test_client.post(f"{API}/proceedings/{first['proceeding']['id']}/close", json={"reason": "שולם"}, headers=auth(lawyer))
    assert (await test_client.get(f"{API}/contacts/{tenant}/open-proceedings", headers=auth(lawyer))).json() == {"has_open": False}
    second = await open_proceeding(test_client, lawyer, party_role="tenant", contact_id=tenant, landlord_contact_id=landlord)
    assert second["proceeding"]["id"] != first["proceeding"]["id"]
