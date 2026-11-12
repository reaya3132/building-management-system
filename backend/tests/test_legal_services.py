"""Legal proceedings — service layer (stage 3): access, proceedings, stages,
entries, documents, assignees, project view, storage consistency, cleanup script.

Storage is replaced by an in-memory fake so failures can be injected; everything
else (IAM, audit, documents table) is the real code on the SQLite test database.
"""
from __future__ import annotations

import io
import json
from datetime import datetime
from decimal import Decimal

import pytest
import pytest_asyncio
from fastapi import HTTPException, UploadFile
from sqlalchemy import func, select

from backend.configurations.legal.stages import STAGE1_KEY, STAGE_KEYS
from backend.core.security import hash_password
from backend.iam.engine import PermissionsEngine
from backend.models.audit_log import AuditLog
from backend.models.document import Document
from backend.models.legal_proceeding import (
    LegalProceeding, LegalProceedingAssignee, LegalProceedingEntry, LegalProceedingStage,
)
from backend.models.project import Project
from backend.models.user import User, UserRole
from backend.repositories.legal_proceeding_repository import ProceedingFilters
from backend.scripts import legal_storage_cleanup
from backend.services import document_storage
from backend.services.audit_service import AuditService
from backend.services.document_storage import StoredFile
from backend.services.contact_service import ContactService
from backend.services.legal_assignee_service import LegalAssigneeService
from backend.services.legal_document_service import LegalDocumentService
from backend.services.legal_entry_service import LegalEntryService
from backend.services.contact_service import normalize_phone
from backend.services.legal_proceeding_service import LegalProceedingService
from backend.services.legal_stage_service import LegalStageService

pytestmark = pytest.mark.asyncio
WHEN = datetime(2026, 10, 20, 9, 30)


# ── fakes & helpers ───────────────────────────────────────────────────────────

class FakeStorage:
    def __init__(self):
        self.files: dict[str, bytes] = {}
        self.fail_store_after: int | None = None
        self.fail_remove = False
        self._n = 0

    async def store(self, file: UploadFile, prefix: str):
        if self.fail_store_after is not None and len(self.files) >= self.fail_store_after:
            raise HTTPException(status_code=400, detail="bad file")
        self._n += 1
        path = f"{prefix}/{self._n}-{file.filename}"
        self.files[path] = await file.read()
        return StoredFile(path, file.filename)

    async def remove(self, path: str):
        if self.fail_remove:
            raise RuntimeError("s3 down")
        self.files.pop(path, None)


@pytest.fixture(autouse=True)
def storage(monkeypatch):
    fake = FakeStorage()
    monkeypatch.setattr(document_storage, "_store_file", fake.store)
    monkeypatch.setattr(document_storage, "_remove_file", fake.remove)
    return fake


def upload(name="proof.pdf", data=b"%PDF") -> UploadFile:
    return UploadFile(filename=name, file=io.BytesIO(data))


async def grant(db, user, *actions):
    engine = PermissionsEngine(db)
    for action in actions:
        await engine.grant_resource_permission(user.id, "legal_proceeding", "*", action)
    await db.commit()


async def make_user(db, email, role=UserRole.MEMBER.value, **kw) -> User:
    kw.setdefault("is_active", True)
    user = User(email=email, password_hash=hash_password("x"), full_name=email.split("@")[0], role=role,
                email_verified=True, **kw)
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


async def actions(db, proceeding_id) -> list[str]:
    rows = await db.execute(select(AuditLog.action).where(AuditLog.entity == "legal_proceeding",
                                                          AuditLog.entity_id == str(proceeding_id)).order_by(AuditLog.id))
    return list(rows.scalars())


async def last_details(db, proceeding_id, action) -> dict:
    row = (await db.execute(select(AuditLog.details).where(
        AuditLog.entity == "legal_proceeding", AuditLog.entity_id == str(proceeding_id), AuditLog.action == action
    ).order_by(AuditLog.id.desc()).limit(1))).scalar_one()
    return json.loads(row)


def code_of(exc: pytest.ExceptionInfo) -> str | None:
    detail = exc.value.detail
    return detail.get("code") if isinstance(detail, dict) else None


@pytest_asyncio.fixture
async def team(test_db, admin_user):
    """lawyer: full module permissions; helper: read+update; outsider: read+update+delete, unrelated."""
    lawyer = await make_user(test_db, "lawyer@x.io")
    helper = await make_user(test_db, "helper@x.io")
    outsider = await make_user(test_db, "outsider@x.io")
    await grant(test_db, lawyer, "read", "write", "update")
    await grant(test_db, helper, "read", "update")
    await grant(test_db, outsider, "read", "write", "update", "delete")
    return {"db": test_db, "admin": admin_user, "lawyer": lawyer, "helper": helper, "outsider": outsider}


async def open_proceeding(db, user, *, contact_id=None, project_id=None, amount="100", **values):
    payload = {"party_role": "other", "title": "חוב ועד בית", "base_items": [{"subject": "בסיס", "amount": amount}], **values}
    if project_id is not None:
        payload["project_id"] = project_id
    contact = {"contact_id": contact_id} if contact_id else {"details": {
        "kind": "person", "name": "דייר א", "phone": "050-1111111", "email": "p@example.com", "address": "רחוב 1", "apartment_number": "4"}}
    result = await LegalProceedingService(db, user).create(payload, contact=contact, confirm_duplicate_contact=True)
    await db.commit()
    return result


# ── IAM & visibility ──────────────────────────────────────────────────────────

async def test_iam_is_required(team, member_user):
    db = team["db"]
    with pytest.raises(HTTPException) as exc:
        await open_proceeding(db, member_user)
    assert exc.value.status_code == 403 and exc.value.detail == "Permission denied: write on legal_proceeding"
    with pytest.raises(HTTPException) as exc:
        await LegalProceedingService(db, member_user).list(ProceedingFilters())
    assert exc.value.status_code == 403


async def test_visibility_follows_creator_assignee_admin(team):
    db, lawyer, helper, outsider, admin = team["db"], team["lawyer"], team["helper"], team["outsider"], team["admin"]
    created = await open_proceeding(db, lawyer)
    pid = created.proceeding.id

    # outsider has every IAM action but is neither creator nor assignee
    for call in (lambda s: s.get(pid), lambda s: s.history(pid)):
        with pytest.raises(HTTPException) as exc:
            await call(LegalProceedingService(db, outsider))
        assert exc.value.status_code == 403
    for call in (
        lambda: LegalStageService(db, outsider).complete(pid, STAGE1_KEY, confirm=True),
        lambda: LegalEntryService(db, outsider).create(pid, entry_type="note", content="x"),
        lambda: LegalEntryService(db, outsider).list(pid),
        lambda: LegalDocumentService(db, outsider).list_for_proceeding(pid),
        lambda: LegalDocumentService(db, outsider).upload_to_proceeding(pid, [upload()]),
        lambda: LegalAssigneeService(db, outsider).team(pid),
        lambda: LegalProceedingService(db, outsider).close(pid, "x"),
        lambda: ContactService(db, outsider).get(created.contact.id),
    ):
        with pytest.raises(HTTPException) as exc:
            await call()
        assert exc.value.status_code == 403
    items, total = await LegalProceedingService(db, outsider).list(ProceedingFilters())
    assert (items, total) == ([], 0)
    assert await LegalProceedingService(db, outsider).project_summary() == []

    # admin sees everything; assignment makes it visible to the helper
    assert (await LegalProceedingService(db, admin).list(ProceedingFilters()))[1] == 1
    await LegalAssigneeService(db, lawyer).assign(pid, helper.id)
    await db.commit()
    assert (await LegalProceedingService(db, helper).get(pid)).id == pid
    items, _ = await LegalProceedingService(db, helper).list(ProceedingFilters())
    assert [i.row.proceeding.id for i in items] == [pid] and items[0].assignee_ids == [helper.id]
    assert (await ContactService(db, helper).get(created.contact.id)).id == created.contact.id


async def test_missing_proceeding_is_not_revealed_without_iam(team, member_user):
    with pytest.raises(HTTPException) as exc:
        await LegalProceedingService(team["db"], member_user).get(999)
    assert exc.value.status_code == 403  # IAM first, then existence
    with pytest.raises(HTTPException) as exc:
        await LegalProceedingService(team["db"], team["lawyer"]).get(999)
    assert exc.value.status_code == 404


# ── assignees ─────────────────────────────────────────────────────────────────

async def test_assignment_rules(team, test_db):
    db, lawyer, helper, admin, outsider = team["db"], team["lawyer"], team["helper"], team["admin"], team["outsider"]
    pid = (await open_proceeding(db, lawyer)).proceeding.id
    t = await LegalAssigneeService(db, lawyer).assign(pid, helper.id)
    await db.commit()
    assert t.owner.id == lawyer.id and [a.user.id for a in t.assignees] == [helper.id]
    assert t.assignees[0].assigned_by.id == lawyer.id

    with pytest.raises(HTTPException) as exc:  # an assignee cannot assign others
        await LegalAssigneeService(db, helper).assign(pid, outsider.id)
    assert exc.value.status_code == 403
    with pytest.raises(HTTPException) as exc:
        await LegalAssigneeService(db, lawyer).assign(pid, lawyer.id)
    assert code_of(exc) == "creator_is_owner"
    with pytest.raises(HTTPException) as exc:
        await LegalAssigneeService(db, lawyer).assign(pid, helper.id)
    assert code_of(exc) == "already_assigned"
    # Archiving a user deactivates it (user_archive_service): the shared rule is "exists and active".
    archived = await make_user(test_db, "gone@x.io", is_active=False, archived_at=WHEN)
    with pytest.raises(HTTPException) as exc:
        await LegalAssigneeService(db, lawyer).assign(pid, archived.id)
    assert code_of(exc) == "user_not_assignable"
    with pytest.raises(HTTPException) as exc:
        await LegalAssigneeService(db, lawyer).assign(pid, 99999)
    assert code_of(exc) == "user_not_assignable" and exc.value.detail["user_id"] == 99999

    await LegalAssigneeService(db, admin).assign(pid, outsider.id)  # admin may assign
    await LegalAssigneeService(db, lawyer).unassign(pid, helper.id)
    await db.commit()
    with pytest.raises(HTTPException):
        await LegalProceedingService(db, helper).get(pid)  # no longer visible
    assert (await actions(db, pid)).count("assignee_added") == 2
    assert "assignee_removed" in await actions(db, pid)


async def assigned_ids(db, proceeding_id) -> list[int]:
    rows = (await db.execute(select(LegalProceedingAssignee.user_id)
                             .where(LegalProceedingAssignee.proceeding_id == proceeding_id))).scalars().all()
    return sorted(rows)


async def rollback(db, *users) -> None:
    """What a request does on an error; the acting users' rows are reloaded (they expire)."""
    await db.rollback()
    for user in users:
        await db.refresh(user)


async def test_create_without_assignees_needs_only_write(team, test_db):
    writer = await make_user(test_db, "writer@x.io")
    await grant(test_db, writer, "read", "write")
    pid = (await open_proceeding(team["db"], writer)).proceeding.id
    assert await assigned_ids(team["db"], pid) == []
    pid2 = (await open_proceeding(team["db"], writer, assignee_ids=[])).proceeding.id  # [] = none
    assert await assigned_ids(team["db"], pid2) == []
    assert "assignee_added" not in await actions(team["db"], pid)


async def test_create_with_assignees_in_one_transaction(team):
    db, lawyer, helper, outsider = team["db"], team["lawyer"], team["helper"], team["outsider"]
    pid = (await open_proceeding(db, lawyer, assignee_ids=[helper.id, outsider.id, helper.id])).proceeding.id
    assert await assigned_ids(db, pid) == sorted([helper.id, outsider.id])
    assert (await actions(db, pid)).count("assignee_added") == 2           # one audit entry per user
    assert (await LegalProceedingService(db, helper).get(pid)).id == pid  # assignment grants visibility


@pytest.mark.parametrize("bad", ["inactive", "creator", "no_update"])
async def test_rejected_assignment_on_create_creates_nothing(team, test_db, bad):
    db, lawyer, helper = team["db"], team["lawyer"], team["helper"]
    creator, ids = lawyer, [helper.id]
    if bad == "inactive":
        ids = [helper.id, (await make_user(test_db, "off@x.io", is_active=False)).id]
    elif bad == "creator":
        ids = [lawyer.id]
    else:  # write without update: may open a proceeding, may not assign
        creator = await make_user(test_db, "writer2@x.io")
        await grant(test_db, creator, "read", "write")
    before = await db.scalar(select(func.count()).select_from(LegalProceeding))
    with pytest.raises(HTTPException) as exc:
        await open_proceeding(db, creator, assignee_ids=ids)
    await db.rollback()  # what the request does on any error
    if bad == "no_update":
        assert exc.value.status_code == 403
    else:
        assert code_of(exc) == {"inactive": "user_not_assignable", "creator": "creator_is_owner"}[bad]
    assert await db.scalar(select(func.count()).select_from(LegalProceeding)) == before
    assert await db.scalar(select(func.count()).select_from(LegalProceedingAssignee)) == 0


async def test_update_replaces_the_full_set(team):
    db, lawyer, helper, outsider, admin = team["db"], team["lawyer"], team["helper"], team["outsider"], team["admin"]
    pid = (await open_proceeding(db, lawyer, assignee_ids=[helper.id])).proceeding.id
    service = LegalProceedingService(db, lawyer)

    await service.update(pid, {"title": "שם חדש"})                       # not sent: untouched
    await db.commit()
    assert await assigned_ids(db, pid) == [helper.id]

    await service.update(pid, {"assignee_ids": [outsider.id]})           # full set: replaced
    await db.commit()
    assert await assigned_ids(db, pid) == [outsider.id]
    log = await actions(db, pid)
    assert log.count("assignee_added") == 2 and log.count("assignee_removed") == 1

    await service.update(pid, {"assignee_ids": []})                      # []: everyone removed
    await db.commit()
    assert await assigned_ids(db, pid) == []

    await LegalProceedingService(db, admin).update(pid, {"assignee_ids": [helper.id, admin.id]})  # admin may
    await db.commit()
    assert await assigned_ids(db, pid) == sorted([helper.id, admin.id])

    with pytest.raises(HTTPException) as exc:
        await service.update(pid, {"assignee_ids": [lawyer.id]})
    assert code_of(exc) == "creator_is_owner"
    await db.rollback()


async def test_update_assignees_keeps_the_assigning_rules(team):
    db, lawyer, helper, outsider = team["db"], team["lawyer"], team["helper"], team["outsider"]
    helper_id, outsider_id = helper.id, outsider.id  # rows expire on rollback
    pid = (await open_proceeding(db, lawyer, assignee_ids=[helper_id])).proceeding.id
    # an assignee with update may edit, may re-send the same set (ignored), may not change it
    await LegalProceedingService(db, helper).update(pid, {"title": "עדכון", "assignee_ids": [helper_id]})
    await db.commit()
    with pytest.raises(HTTPException) as exc:
        await LegalProceedingService(db, helper).update(pid, {"assignee_ids": [helper_id, outsider_id]})
    assert exc.value.status_code == 403
    await rollback(db, lawyer, helper)
    assert await assigned_ids(db, pid) == [helper_id]
    assert (await LegalProceedingService(db, lawyer).get(pid)).title == "עדכון"

    # a rejected set rolls back the other fields of the same request
    with pytest.raises(HTTPException):
        await LegalProceedingService(db, lawyer).update(pid, {"title": "לא נשמר", "assignee_ids": [99999]})
    await rollback(db, lawyer, helper)
    assert (await LegalProceedingService(db, lawyer).get(pid)).title == "עדכון"

    # closed: no assignment changes
    await LegalProceedingService(db, lawyer).close(pid, "שולם")
    await db.commit()
    with pytest.raises(HTTPException) as exc:
        await LegalProceedingService(db, lawyer).update(pid, {"assignee_ids": []})
    assert code_of(exc) == "proceeding_closed"
    await db.rollback()
    assert await assigned_ids(db, pid) == [helper_id]


# ── open / edit / close / reopen ──────────────────────────────────────────────

async def test_create_builds_stages_and_never_blocks_other_roles(team):
    db, lawyer, admin = team["db"], team["lawyer"], team["admin"]
    first = await open_proceeding(db, admin, amount="1250.50")
    assert await LegalProceedingService(db, admin).ledger_total(first.proceeding.id) == Decimal("1250.50")
    stages = (await db.execute(select(LegalProceedingStage.stage_key, LegalProceedingStage.status)
                                .where(LegalProceedingStage.proceeding_id == first.proceeding.id))).all()
    assert sorted(stages) == sorted((k, "pending") for k in STAGE_KEYS)

    # Only a tenant's proceeding is subject to the open-proceeding warning.
    second = await open_proceeding(db, lawyer, contact_id=first.contact.id, amount=300)
    assert second.proceeding.id != first.proceeding.id
    assert await actions(db, second.proceeding.id) == ["proceeding_created"]


async def test_landlord_rules_and_immutable_parties(team):
    db, lawyer = team["db"], team["lawyer"]
    landlord = (await open_proceeding(db, lawyer, party_role="landlord")).contact
    svc = LegalProceedingService(db, lawyer)
    new = {"contact": {"details": {"kind": "person", "name": "דייר ב", "phone": "050-2222222", "email": "p@example.com", "address": "רחוב 1", "apartment_number": "4"}}}
    base = {"party_role": "tenant", "title": "t", "base_items": [{"subject": "בסיס", "amount": "10"}]}
    for values, kwargs, code in (
        (base, {}, "landlord_required"),
        ({**base, "party_role": "supplier"}, {"landlord": {"contact_id": landlord.id}}, "landlord_not_allowed"),
        ({**base, "base_items": []}, {"landlord": {"contact_id": landlord.id}}, "base_items_required"),
        (base, {"landlord": {"contact_id": 9999}}, "contact_not_found"),
    ):
        with pytest.raises(HTTPException) as exc:
            await svc.create(values, **new, **kwargs)
        assert exc.value.detail["code"] == code
    created = await svc.create(base, **new, landlord={"contact_id": landlord.id}, confirm_duplicate_contact=True)
    await db.commit()
    assert created.proceeding.landlord_id == landlord.id
    for field, value in (("party_role", "other"), ("landlord_contact_id", landlord.id), ("contact_id", landlord.id)):
        with pytest.raises(HTTPException) as exc:
            await svc.update(created.proceeding.id, {field: value})
        assert exc.value.detail["code"] == "contact_immutable"


async def test_duplicate_phone_blocks_a_new_contact_until_confirmed(team):
    db, lawyer = team["db"], team["lawyer"]
    await open_proceeding(db, lawyer)
    svc = LegalProceedingService(db, lawyer)
    values = {"party_role": "landlord", "title": "t", "base_items": [{"subject": "בסיס", "amount": "10"}]}
    details = {"kind": "person", "name": "Someone", "phone": "+972 50-111-1111", "email": "p@example.com", "address": "רחוב 1", "apartment_number": "4"}
    with pytest.raises(HTTPException) as exc:
        await svc.create(values, contact={"details": details})
    assert exc.value.status_code == 409 and exc.value.detail["code"] == "duplicate_phone"
    assert set(exc.value.detail) == {"code", "message", "has_match"}
    same_phone = await svc.create(values, contact={"details": details}, confirm_duplicate_contact=True)
    assert same_phone.has_match is True
    same_name = await svc.create(values, contact={"details": {**details, "name": "דייר א", "phone": "050-9999999"}})
    assert same_name.has_match is False  # names are not compared


@pytest.mark.parametrize("raw, expected", [
    ("050-1234567", "0501234567"), ("050 123 4567", "0501234567"), ("(050)1234567", "0501234567"),
    ("+972501234567", "0501234567"), ("+972-50-1234567", "0501234567"), ("00972501234567", "0501234567"),
    ("972501234567", "0501234567"), ("+972 050 1234567", "0501234567"), ("03-1234567", "031234567"),
    ("+1 (212) 555-0123", "12125550123"), ("001 212 555 0123", "12125550123"),
])
def test_normalize_phone(raw, expected):
    assert normalize_phone(raw) == expected


@pytest.mark.parametrize("raw", ["12345", "abc", "050-12345x7", "05+01234567", "1" * 16, "*2000"])
def test_normalize_phone_rejects(raw):
    with pytest.raises(HTTPException) as exc:
        normalize_phone(raw)
    assert exc.value.status_code == 422 and exc.value.detail["code"] == "invalid_phone"


async def test_phones_are_stored_normalized_and_every_combination_matches(team):
    db, lawyer = team["db"], team["lawyer"]
    contacts = ContactService(db, lawyer)
    made = (await contacts.create({"kind": "person", "name": "א", "phone": "050-1000001", "phone_2": "+972 52 1000002"})).contact
    await db.commit()
    assert (made.phone, made.phone_2) == ("0501000001", "0521000002")
    for phone, phone_2 in (("0501000001", None), ("0521000002", None), ("0599999999", "050 100 0001"),
                           ("0599999999", "+972521000002")):
        assert await contacts.has_duplicate(phone, phone_2) is True, (phone, phone_2)
    assert await contacts.has_duplicate("0599999999", "0588888888") is False
    assert await contacts.has_duplicate("0501000001", exclude_id=made.id) is False
    assert [c.id for c in await contacts.search("050-100")] == [made.id]
    assert [c.id for c in await contacts.search("+972 52")] == [made.id]
    admin_contacts = ContactService(db, team["admin"])  # editing needs visibility; Admin sees all
    updated = await admin_contacts.update(made.id, {"phone_2": "(054) 1000003"})
    assert updated.phone_2 == "0541000003"
    with pytest.raises(HTTPException) as exc:
        await admin_contacts.update(made.id, {"phone": "12"})
    assert exc.value.detail["code"] == "invalid_phone"
    made.is_active = False
    await db.flush()
    assert await contacts.has_duplicate("0501000001") is False  # inactive contacts are not matched


@pytest.mark.parametrize("values, code", [
    ({"amount": 0}, "invalid_amount"),
    ({"amount": "-5"}, "invalid_amount"),
    ({"amount": "1.234"}, "invalid_amount"),
    ({"party_role": "judge"}, "invalid_party_role"),
    ({"title": "  "}, "title_required"),
    ({"project_id": 9999}, "project_not_found"),
])
async def test_create_validation(team, values, code):
    with pytest.raises(HTTPException) as exc:
        await open_proceeding(team["db"], team["lawyer"], **values)
    assert exc.value.status_code == 422 and code_of(exc) == code


async def test_update_close_reopen(team):
    db, lawyer = team["db"], team["lawyer"]
    pid = (await open_proceeding(db, lawyer)).proceeding.id
    svc = LegalProceedingService(db, lawyer)
    await svc.update(pid, {"title": "נושא חדש", "claim_details": "פירוט"})
    with pytest.raises(HTTPException) as exc:
        await svc.update(pid, {"contact_id": 5})
    assert code_of(exc) == "contact_immutable"
    with pytest.raises(HTTPException) as exc:
        await svc.close(pid, "   ")
    assert code_of(exc) == "close_reason_required"
    closed = await svc.close(pid, "שולם במלואו")
    await db.commit()
    assert (closed.status, closed.close_reason, closed.closed_by) == ("closed", "שולם במלואו", lawyer.id)
    with pytest.raises(HTTPException) as exc:  # closed proceedings are read-only
        await svc.update(pid, {"title": "x"})
    assert code_of(exc) == "proceeding_closed"
    with pytest.raises(HTTPException) as exc:
        await LegalEntryService(db, lawyer).create(pid, entry_type="note", content="x")
    assert code_of(exc) == "proceeding_closed"
    reopened = await svc.reopen(pid, "נמצא חוב נוסף")
    await db.commit()
    assert (reopened.status, reopened.closed_at, reopened.closed_by, reopened.close_reason) == ("open", None, None, None)
    assert await actions(db, pid) == ["proceeding_created", "proceeding_updated", "proceeding_closed",
                                      "proceeding_reopened"]
    upd = await last_details(db, pid, "proceeding_updated")
    assert upd["after"] == {"title": "נושא חדש", "claim_details": "פירוט"}
    reo = await last_details(db, pid, "proceeding_reopened")
    assert reo["previous_close"]["close_reason"] == "שולם במלואו"
    logs, total = await svc.history(pid)
    assert total == 4 and logs[0][0].action == "proceeding_reopened"


# ── stages ────────────────────────────────────────────────────────────────────

async def test_tenants_committee_approval_is_an_ordinary_stage(team, storage):
    """Stage 2: one component; several documents, notes and completion through the existing mechanism."""
    db, lawyer = team["db"], team["lawyer"]
    key = "tenants_committee_approval"
    pid = (await open_proceeding(db, lawyer)).proceeding.id
    svc = LegalStageService(db, lawyer)
    with pytest.raises(HTTPException) as exc:
        await svc.complete(pid, key)
    assert code_of(exc) == "stage_requirements_missing"
    assert exc.value.detail["missing"] == [{"key": "committee_approval", "label": "אישור נציגות דיירים"}]

    docs = await LegalDocumentService(db, lawyer).upload_to_proceeding(
        pid, [upload("approval.pdf"), upload("minutes.pdf")], stage_key=key, component_key="committee_approval")
    await LegalEntryService(db, lawyer).create(pid, entry_type="note", stage_key=key, content="הנציגות אישרה")
    await LegalEntryService(db, lawyer).create(pid, entry_type="note", stage_key=key,
                                               context_key="committee_approval", content="נחתם בישיבה")
    await db.commit()
    assert len(docs) == 2 and len(storage.files) == 2
    assert await svc.missing(pid, key) == []
    assert len(await LegalEntryService(db, lawyer).list(pid, stage_key=key)) == 2

    done = await svc.complete(pid, key)  # documented: no warning
    await db.commit()
    assert done.status == "completed"
    items, _ = await LegalProceedingService(db, lawyer).list(ProceedingFilters())
    assert len(items) == 1
    progress = items[0].progress
    assert (progress.resolved, progress.total, progress.next_stage_key) == (1, 6, STAGE1_KEY)


async def test_stage_completion_warning_is_not_blocking(team):
    db, lawyer = team["db"], team["lawyer"]
    pid = (await open_proceeding(db, lawyer)).proceeding.id
    svc = LegalStageService(db, lawyer)
    with pytest.raises(HTTPException) as exc:
        await svc.complete(pid, "first_door_notice")
    assert exc.value.status_code == 409 and code_of(exc) == "stage_requirements_missing"
    assert [m["key"] for m in exc.value.detail["missing"]] == [
        "door_placement", "letter_file", "email_proof", "whatsapp_proof"]

    # a note on a component does NOT document it; a document does
    await LegalEntryService(db, lawyer).create(pid, entry_type="note", stage_key="first_door_notice",
                                               context_key="letter_file", content="נשלח")
    await LegalDocumentService(db, lawyer).upload_to_proceeding(pid, [upload()], stage_key="first_door_notice",
                                                                component_key="door_placement")
    missing = await svc.missing(pid, "first_door_notice")
    assert [m["key"] for m in missing] == ["letter_file", "email_proof", "whatsapp_proof"]
    stage = (await db.execute(select(LegalProceedingStage).where(
        LegalProceedingStage.proceeding_id == pid, LegalProceedingStage.stage_key == "first_door_notice"))).scalar_one()
    assert stage.status == "pending"  # documents / notes never change the status

    done = await svc.complete(pid, "first_door_notice", confirm=True)
    await db.commit()
    assert (done.status, done.resolved_by) == ("completed", lawyer.id) and done.resolved_at
    details = await last_details(db, pid, "stage_status_changed")
    assert details["forced"] is True and [m["key"] for m in details["missing"]] == ["letter_file", "email_proof",
                                                                                    "whatsapp_proof"]
    with pytest.raises(HTTPException) as exc:
        await svc.complete(pid, "first_door_notice", confirm=True)
    assert code_of(exc) == "stage_not_pending"


async def test_stage1_documented_by_communication_with_file(team):
    db, lawyer = team["db"], team["lawyer"]
    pid = (await open_proceeding(db, lawyer)).proceeding.id
    svc, entries = LegalStageService(db, lawyer), LegalEntryService(db, lawyer)
    assert [m["key"] for m in await svc.missing(pid, STAGE1_KEY)] == ["communication_with_file"]
    await entries.create(pid, entry_type="communication", channel="email", occurred_at=WHEN, content="מייל ללא קובץ")
    assert [m["key"] for m in await svc.missing(pid, STAGE1_KEY)] == ["communication_with_file"]
    await entries.create(pid, entry_type="communication", channel="whatsapp", occurred_at=WHEN, files=[upload("w.png")])
    assert await svc.missing(pid, STAGE1_KEY) == []
    done = await svc.complete(pid, STAGE1_KEY)  # nothing missing: no confirmation needed
    assert done.status == "completed"
    assert (await last_details(db, pid, "stage_status_changed"))["forced"] is False


async def test_skip_reopen_and_progress(team):
    db, lawyer = team["db"], team["lawyer"]
    pid = (await open_proceeding(db, lawyer)).proceeding.id
    svc = LegalStageService(db, lawyer)
    await svc.skip(pid, STAGE1_KEY, reason="לא רלוונטי")
    await svc.complete(pid, "first_door_notice", confirm=True)
    await db.commit()
    items, _ = await LegalProceedingService(db, lawyer).list(ProceedingFilters())
    progress = items[0].progress
    assert (progress.resolved, progress.total, progress.percent, progress.next_stage_key) == (
        2, 6, 33, "tenants_committee_approval")

    reopened = await svc.reopen(pid, STAGE1_KEY, reason="נדרש תיעוד")
    await db.commit()
    assert (reopened.status, reopened.resolved_at, reopened.resolved_by) == ("pending", None, None)
    details = await last_details(db, pid, "stage_status_changed")
    assert (details["from"], details["to"], details["reason"]) == ("skipped", "pending", "נדרש תיעוד")
    with pytest.raises(HTTPException) as exc:
        await svc.reopen(pid, STAGE1_KEY)
    assert code_of(exc) == "stage_not_resolved"
    with pytest.raises(HTTPException) as exc:
        await svc.complete(pid, "no_such_stage")
    assert exc.value.status_code == 404
    assert (await actions(db, pid)).count("stage_status_changed") == 3


# ── entries ───────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("kwargs, code", [
    ({"entry_type": "note"}, "content_required"),
    ({"entry_type": "note", "content": "x", "stage_key": "nope"}, "invalid_stage"),
    ({"entry_type": "note", "content": "x", "stage_key": "first_door_notice", "context_key": "lawyer_letter"},
     "invalid_component"),
    ({"entry_type": "note", "content": "x", "context_key": "letter_file"}, "invalid_component"),
    ({"entry_type": "note", "content": "x", "channel": "sms"}, "invalid_channel"),
    ({"entry_type": "communication", "occurred_at": WHEN, "content": "x"}, "channel_required"),
    ({"entry_type": "communication", "channel": "email", "content": "x"}, "occurred_at_required"),
    ({"entry_type": "communication", "channel": "email", "occurred_at": WHEN}, "communication_needs_content_or_file"),
    ({"entry_type": "communication", "channel": "email", "occurred_at": WHEN, "content": "x",
      "stage_key": "lawyer_warning"}, "communication_stage_only"),
    ({"entry_type": "memo", "content": "x"}, "invalid_entry_type"),
])
async def test_entry_validation(team, kwargs, code):
    db, lawyer = team["db"], team["lawyer"]
    pid = (await open_proceeding(db, lawyer)).proceeding.id
    with pytest.raises(HTTPException) as exc:
        await LegalEntryService(db, lawyer).create(pid, **kwargs)
    assert exc.value.status_code == 422 and code_of(exc) == code


async def test_entries_notes_and_communications(team, storage):
    db, lawyer = team["db"], team["lawyer"]
    pid = (await open_proceeding(db, lawyer)).proceeding.id
    svc = LegalEntryService(db, lawyer)
    general = await svc.create(pid, entry_type="note", content="  הערה כללית ", channel="whatsapp")
    assert (general.entry.content, general.entry.stage_key, general.entry.occurred_at) == ("הערה כללית", None, None)
    await svc.create(pid, entry_type="note", stage_key="lawyer_warning", context_key="lawyer_letter", content="נשלח")
    comm = await svc.create(pid, entry_type="communication", channel="email", occurred_at=WHEN,
                            files=[upload("a.pdf"), upload("b.pdf")])
    await db.commit()
    assert comm.entry.stage_key == STAGE1_KEY and comm.entry.content is None
    assert [d.document.file_name for d in comm.documents] == ["a.pdf", "b.pdf"]
    assert all(d.uploaded_by.id == lawyer.id for d in comm.documents)
    assert len(storage.files) == 2

    assert [v.entry.id for v in await svc.list(pid, general_only=True)] == [general.entry.id]
    assert [v.entry.context_key for v in await svc.list(pid, stage_key="lawyer_warning")] == ["lawyer_letter"]
    listed = await svc.list(pid, entry_type="communication")
    assert len(listed) == 1 and len(listed[0].documents) == 2 and listed[0].can_modify

    # last-file rule of a communication without text
    docs = LegalDocumentService(db, lawyer)
    await docs.delete_entry_document(pid, comm.entry.id, comm.documents[0].document.id)
    with pytest.raises(HTTPException) as exc:
        await docs.delete_entry_document(pid, comm.entry.id, comm.documents[1].document.id)
    assert code_of(exc) == "last_file_of_communication"
    with pytest.raises(HTTPException) as exc:  # cannot clear the text of a communication with no files
        text_only = await svc.create(pid, entry_type="communication", channel="other", occurred_at=WHEN, content="שיחה")
        await svc.update(pid, text_only.entry.id, content="  ")
    assert code_of(exc) == "communication_needs_content_or_file"


async def test_other_users_content_needs_delete_permission(team):
    db, lawyer, helper, admin = team["db"], team["lawyer"], team["helper"], team["admin"]
    pid = (await open_proceeding(db, lawyer)).proceeding.id
    await LegalAssigneeService(db, lawyer).assign(pid, helper.id)
    note = await LegalEntryService(db, lawyer).create(pid, entry_type="note", content="של עו״ד")
    doc = (await LegalDocumentService(db, lawyer).upload_to_proceeding(pid, [upload()]))[0]
    await db.commit()

    helper_entries = LegalEntryService(db, helper)  # read + update, no delete
    assert (await helper_entries.list(pid))[0].can_modify is False
    for call in (lambda: helper_entries.update(pid, note.entry.id, content="שונה"),
                 lambda: helper_entries.delete(pid, note.entry.id),
                 lambda: LegalDocumentService(db, helper).delete_proceeding_document(pid, doc.id)):
        with pytest.raises(HTTPException) as exc:
            await call()
        assert exc.value.status_code == 403
    own = await helper_entries.create(pid, entry_type="note", content="שלי")
    await helper_entries.update(pid, own.entry.id, content="שלי - עודכן")  # own content: allowed

    await LegalEntryService(db, admin).update(pid, note.entry.id, content="תוקן")  # admin has delete
    details = await last_details(db, pid, "entry_updated")
    assert details["before"] == {"content": "של עו״ד"} and details["after"] == {"content": "תוקן"}


async def test_delete_entry_snapshots_then_removes_files(team, storage):
    db, lawyer = team["db"], team["lawyer"]
    pid = (await open_proceeding(db, lawyer)).proceeding.id
    comm = await LegalEntryService(db, lawyer).create(pid, entry_type="communication", channel="email",
                                                      occurred_at=WHEN, content="נשלח", files=[upload("x.pdf")])
    path = comm.documents[0].document.file_path
    await LegalEntryService(db, lawyer).delete(pid, comm.entry.id)
    assert path not in storage.files
    assert (await db.execute(select(func.count(LegalProceedingEntry.id)))).scalar() == 0
    assert (await db.execute(select(func.count(Document.id)).where(Document.file_path == path))).scalar() == 0
    snap = await last_details(db, pid, "entry_deleted")
    assert snap["entry"]["content"] == "נשלח" and snap["entry"]["stage_key"] == STAGE1_KEY
    assert snap["entry"]["channel"] == "email" and snap["entry"]["occurred_at"] == WHEN.isoformat()
    assert [d["file_path"] for d in snap["documents"]] == [path]


async def test_storage_failure_on_delete_is_recorded_and_cleaned_later(team, storage):
    db, lawyer = team["db"], team["lawyer"]
    pid = (await open_proceeding(db, lawyer)).proceeding.id
    docs = LegalDocumentService(db, lawyer)
    doc = (await docs.upload_to_proceeding(pid, [upload("keep.pdf")]))[0]
    other = (await docs.upload_to_proceeding(pid, [upload("other.pdf")]))[0]
    storage.fail_remove = True
    await docs.delete_proceeding_document(pid, doc.id)
    assert (await db.execute(select(func.count(Document.id)).where(Document.id == doc.id))).scalar() == 0  # row gone
    assert doc.file_path in storage.files  # file left behind ...
    failed = await last_details(db, pid, "document_storage_delete_failed")
    assert failed == {"document_id": doc.id, "file_path": doc.file_path}  # ... and recorded

    report = await legal_storage_cleanup.run(db, apply=False)  # dry run
    assert report["pending"] == [doc.file_path] and doc.file_path in storage.files
    report = await legal_storage_cleanup.run(db, apply=True)  # storage still down
    assert report["failed"] and doc.file_path in storage.files
    storage.fail_remove = False
    report = await legal_storage_cleanup.run(db, apply=True)
    assert report["removed"] == [doc.file_path] and doc.file_path not in storage.files
    assert (await legal_storage_cleanup.run(db, apply=False))["pending"] == []  # never processed twice
    assert other.file_path in storage.files  # a referenced file is never touched


async def test_cleanup_only_touches_legal_files(team, storage):
    db, lawyer = team["db"], team["lawyer"]
    pid = (await open_proceeding(db, lawyer)).proceeding.id
    foreign = {"projects/1/x.pdf": b"x", f"legal/{pid + 1}/y.pdf": b"y"}  # another module / proceeding
    storage.files.update(foreign)
    audit = AuditService(db)
    for path in foreign:
        await audit.log_action(lawyer.id, "document_storage_delete_failed", "legal_proceeding", str(pid),
                               {"document_id": 0, "file_path": path})
    await db.commit()
    report = await legal_storage_cleanup.run(db, apply=True)
    assert report["pending"] == [] and report["removed"] == []
    assert report["skipped"] == sorted(foreign)
    assert all(p in storage.files for p in foreign)


async def test_upload_failures_leave_no_rows_and_no_files(team, storage, monkeypatch):
    db, lawyer = team["db"], team["lawyer"]
    pid = (await open_proceeding(db, lawyer)).proceeding.id
    docs = LegalDocumentService(db, lawyer)
    # second file rejected -> the first stored one is removed
    storage.fail_store_after = 1
    with pytest.raises(HTTPException):
        await docs.upload_to_proceeding(pid, [upload("1.pdf"), upload("2.exe")])
    assert storage.files == {}
    storage.fail_store_after = None
    # the commit fails -> rollback + stored files removed
    original_commit = db.commit
    calls = {"n": 0}

    async def failing_commit():
        calls["n"] += 1
        raise RuntimeError("db down")

    monkeypatch.setattr(db, "commit", failing_commit)
    with pytest.raises(RuntimeError):
        await LegalEntryService(db, lawyer).create(pid, entry_type="communication", channel="email",
                                                   occurred_at=WHEN, files=[upload("c.pdf")])
    monkeypatch.setattr(db, "commit", original_commit)
    assert calls["n"] == 1 and storage.files == {}
    assert (await db.execute(select(func.count(Document.id)))).scalar() == 0
    assert (await db.execute(select(func.count(LegalProceedingEntry.id)))).scalar() == 0


async def test_document_isolation_between_proceedings(team, test_db):
    db, lawyer = team["db"], team["lawyer"]
    a = (await open_proceeding(db, lawyer)).proceeding.id
    b = (await open_proceeding(db, lawyer)).proceeding.id
    docs = LegalDocumentService(db, lawyer)
    doc_a = (await docs.upload_to_proceeding(a, [upload()]))[0]
    entry_a = await LegalEntryService(db, lawyer).create(a, entry_type="note", content="n", files=[upload()])
    foreign = Document(entity_type="project", entity_id=b, file_path="p", source_table="", source_id=0)
    test_db.add(foreign)
    await test_db.commit()
    for call in (
        lambda: docs.get_view(b, doc_a.id),
        lambda: docs.delete_proceeding_document(b, doc_a.id),
        lambda: docs.get_view(a, foreign.id),
        lambda: docs.delete_proceeding_document(a, foreign.id),
        lambda: docs.delete_entry_document(b, entry_a.entry.id, entry_a.documents[0].document.id),
        lambda: docs.upload_to_entry(b, entry_a.entry.id, [upload()]),
        lambda: LegalEntryService(db, lawyer).delete(b, entry_a.entry.id),
    ):
        with pytest.raises(HTTPException) as exc:
            await call()
        assert exc.value.status_code == 404
    listed = await docs.list_for_proceeding(a)
    assert {v.document.id for v in listed} == {doc_a.id, entry_a.documents[0].document.id}
    assert next(v for v in listed if v.entry_id).entry_id == entry_a.entry.id
    assert (await docs.list_for_proceeding(b)) == []


async def test_component_upload_validation(team):
    db, lawyer = team["db"], team["lawyer"]
    pid = (await open_proceeding(db, lawyer)).proceeding.id
    docs = LegalDocumentService(db, lawyer)
    for stage, component in (("first_door_notice", "lawyer_letter"), (STAGE1_KEY, "email_proof"), (None, "x")):
        with pytest.raises(HTTPException) as exc:
            await docs.upload_to_proceeding(pid, [upload()], stage_key=stage, component_key=component)
        assert code_of(exc) == "invalid_component"
    views = await docs.views(pid, await docs.upload_to_proceeding(pid, [upload()], stage_key="supervisor_claim",
                                                                  component_key="supervisor_decision"))
    assert (views[0].document.context_key, views[0].stage_key, views[0].component_key) == (
        "supervisor_claim.supervisor_decision", "supervisor_claim", "supervisor_decision")


# ── project view ──────────────────────────────────────────────────────────────

async def test_project_summary_and_filters(team, test_db):
    db, lawyer, admin = team["db"], team["lawyer"], team["admin"]
    parent = Project(name="פרויקט אב", is_active=True, is_parent_project=True)
    test_db.add(parent)
    await test_db.flush()
    child = Project(name="בניין 1", is_active=True, relation_project=parent.id)
    other = Project(name="אחר", is_active=True)
    test_db.add_all([child, other])
    await test_db.commit()

    p1 = await open_proceeding(db, lawyer, project_id=child.id, amount=100)
    await open_proceeding(db, lawyer, project_id=child.id, amount="50.50")
    closed = await open_proceeding(db, lawyer, project_id=parent.id, amount=900)
    await LegalProceedingService(db, lawyer).close(closed.proceeding.id, "הסתיים")
    await open_proceeding(db, admin, project_id=other.id)  # not visible to the lawyer
    await db.commit()

    rows = {r.project_id: r for r in await LegalProceedingService(db, lawyer).project_summary()}
    assert set(rows) == {child.id, parent.id}
    assert (rows[child.id].open_count, rows[child.id].closed_count, rows[child.id].open_claim_total) == (
        2, 0, Decimal("150.50"))
    rolled = await LegalProceedingService(db, lawyer).project_summary(rollup_to_parent=True)
    assert [(r.project_id, r.open_count, r.closed_count, r.contact_count) for r in rolled] == [(parent.id, 2, 1, 3)]
    assert len(await LegalProceedingService(db, admin).project_summary()) == 3

    svc = LegalProceedingService(db, lawyer)
    assert (await svc.list(ProceedingFilters(project_id=parent.id)))[1] == 1
    assert (await svc.list(ProceedingFilters(project_id=parent.id, include_subprojects=True)))[1] == 3
    assert (await svc.list(ProceedingFilters(status="open")))[1] == 2
    assert (await svc.list(ProceedingFilters(contact_id=p1.contact.id)))[1] == 1
    assert (await svc.list(ProceedingFilters(search="דייר")))[1] == 3


# ── contacts ──────────────────────────────────────────────────────────────────

async def test_contacts(team):
    db, lawyer, helper = team["db"], team["lawyer"], team["helper"]
    created = await open_proceeding(db, lawyer)
    contacts = ContactService(db, lawyer)
    assert [c.id for c in await contacts.search("050")] == [created.contact.id]
    assert [c.id for c in await contacts.search("דייר")] == [created.contact.id]
    assert await contacts.search("%") == [] and await contacts.search("_") == []  # wildcards are literal
    assert (await LegalProceedingService(db, lawyer).list(ProceedingFilters(search="%")))[1] == 0
    with pytest.raises(HTTPException) as exc:  # search needs write (used while opening)
        await ContactService(db, helper).search("x")
    assert exc.value.status_code == 403
    updated = await ContactService(db, team["admin"]).update(created.contact.id, {"email": " A@B.co ", "phone_2": ""})
    await db.commit()
    assert (updated.email, updated.phone_2) == ("a@b.co", None)
    row = (await db.execute(select(AuditLog.details).where(AuditLog.entity == "contact",
                                                           AuditLog.action == "updated"))).scalar_one()
    assert json.loads(row) == {"before": {"email": "p@example.com"}, "after": {"email": "a@b.co"}}
    with pytest.raises(HTTPException) as exc:
        await ContactService(db, team["admin"]).update(created.contact.id, {"kind": "alien"})
    assert code_of(exc) == "invalid_contact_kind"
