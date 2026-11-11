"""Legal proceedings (הליכים משפטיים) — /api/v1/legal.

Thin HTTP layer: every route only authenticates, parses the request, calls one
service and maps the result to a schema. Permissions (IAM ``legal_proceeding``
read / write / update / delete), visibility (Admin, creator, assignees) and every
business rule live in the services; documents go through LegalDocumentService,
which stores files with the shared DocumentStorageService.

Transactions: services only flush, so one operation can span several of them. Each
write route commits once, last (``_saved``), so success is never returned before the
data is stored; a failure before that is rolled back by ``get_db``. Document uploads /
deletes and entries with files commit inside their service, where storage compensation
needs it, and do not go through ``_saved``.
"""
from __future__ import annotations

import json
from datetime import datetime

from fastapi import APIRouter, Depends, File, Form, Query, Response, UploadFile

from backend.configurations.legal.stages import STAGES, stage_position
from backend.core.deps import DBSessionDep, get_current_user
from backend.models.contact import Contact
from backend.repositories.legal_proceeding_repository import ProceedingFilters
from backend.schemas.legal import (
    AssignBody,
    AssigneeOut,
    ChannelLiteral,
    CloseBody,
    CompleteStageBody,
    ContactCreate,
    ContactCreated,
    ContactOut,
    ContactSummary,
    ContactUpdate,
    DocumentOut,
    DuplicateCheck,
    DuplicateResult,
    EntryOut,
    EntryPage,
    EntryTypeLiteral,
    EntryUpdate,
    HistoryEntry,
    HistoryPage,
    LedgerItemCreate,
    LedgerItemOut,
    LedgerItemResult,
    LedgerItemUpdate,
    MissingItem,
    OpenProceedingStatus,
    ProceedingCreate,
    ProceedingCreated,
    ProceedingDetailOut,
    ProceedingListItem,
    ProceedingPage,
    ProceedingPermissions,
    ProceedingUpdate,
    Progress,
    ProjectOptionOut,
    ProjectSummaryOut,
    ReasonBody,
    Ref,
    StageComponentOut,
    StageDefinitionOut,
    StageOut,
    TeamOut,
    UserRef,
)
from backend.services.contact_service import ContactService
from backend.services.legal_assignee_service import LegalAssigneeService, Team
from backend.services.legal_document_service import DocumentView, LegalDocumentService
from backend.services.legal_entry_service import EntryView, LegalEntryService
from backend.services.legal_proceeding_service import LegalProceedingService, ProceedingDetail
from backend.services.legal_stage_service import LegalStageService

router = APIRouter()
current_user = Depends(get_current_user)


async def _saved(db, response):
    """The commit of a write route, after the whole operation and its response are built."""
    await db.commit()
    return response


# ── mapping ──────────────────────────────────────────────────────────────────

def _user(u) -> UserRef | None:
    return UserRef(id=u.id, full_name=u.full_name, avatar_url=u.avatar_url) if u else None


def _contact(c: Contact) -> ContactOut:
    return ContactOut.model_validate(c, from_attributes=True)


def _summary(c: Contact) -> ContactSummary:
    return ContactSummary.model_validate(c, from_attributes=True)


def _progress(p) -> Progress:
    return Progress(resolved=p.resolved, total=p.total, percent=p.percent, next_stage_key=p.next_stage_key)


def _stage_definition(d) -> dict:
    return dict(key=d.key, label=d.label, description=d.description, position=stage_position(d.key),
                requires_communication=d.requires_communication,
                components=[StageComponentOut(key=c.key, label=c.label) for c in d.components])


def _detail(d: ProceedingDetail) -> ProceedingDetailOut:
    p = d.proceeding
    return ProceedingDetailOut(
        id=p.id, title=p.title, status=p.status, party_role=p.party_role,
        claim_details=p.claim_details, total_amount=d.total_amount,
        ledger_items=[LedgerItemOut.model_validate(i, from_attributes=True) for i in d.ledger_items],
        contact=_summary(d.contact),
        linked_landlord=_summary(d.linked_landlord) if d.linked_landlord else None,
        project=Ref(id=p.project_id, name=d.project_name) if p.project_id else None,
        created_by=_user(d.users.get(p.created_by)), opened_at=p.opened_at, closed_at=p.closed_at,
        closed_by=_user(d.users.get(p.closed_by)), close_reason=p.close_reason, updated_at=p.updated_at,
        progress=_progress(d.progress),
        stages=[StageOut(**_stage_definition(defn), status=s.status, resolved_at=s.resolved_at,
                         resolved_by=_user(d.users.get(s.resolved_by))) for defn, s in d.stages],
        assignee_ids=d.assignee_ids,
        permissions=ProceedingPermissions(can_update=d.can_update, can_assign=d.can_assign,
                                          can_delete_others=d.can_delete_others),
    )


def _document(v: DocumentView) -> DocumentOut:
    return DocumentOut(id=v.document.id, file_name=v.document.file_name, download_url=v.download_url, preview_url=v.preview_url,
                       uploaded_by=_user(v.uploaded_by), uploaded_at=v.uploaded_at,
                       stage_key=v.stage_key, component_key=v.component_key, entry_id=v.entry_id)


def _entry(v: EntryView) -> EntryOut:
    e = v.entry
    return EntryOut(id=e.id, entry_type=e.entry_type, stage_key=e.stage_key, context_key=e.context_key,
                    content=e.content, channel=e.channel, occurred_at=e.occurred_at,
                    created_by=_user(v.created_by), created_at=e.created_at,
                    updated_by=_user(v.updated_by), updated_at=e.updated_at, can_modify=v.can_modify,
                    documents=[_document(d) for d in v.documents])


def _team(t: Team) -> TeamOut:
    return TeamOut(owner=_user(t.owner), assignees=[
        AssigneeOut(user=_user(a.user), assigned_by=_user(a.assigned_by), assigned_at=a.assigned_at)
        for a in t.assignees])


def _history(rows, total: int, page: int, page_size: int) -> HistoryPage:
    return HistoryPage(items=[
        HistoryEntry(id=log.id, action=log.action, user_id=log.user_id, user_name=name,
                     details=json.loads(log.details) if log.details else None, created_at=log.created_at)
        for log, name in rows], total=total, page=page, page_size=page_size)


# ── configuration ────────────────────────────────────────────────────────────

@router.get("/stages", response_model=list[StageDefinitionOut])
async def stage_catalogue(user=current_user):
    """The fixed stages and their documentation components (labels for the UI)."""
    return [StageDefinitionOut(**_stage_definition(d)) for d in STAGES]


# ── contacts ─────────────────────────────────────────────────────────────────

@router.get("/contacts", response_model=list[ContactSummary])
async def search_contacts(db: DBSessionDep, user=current_user,
                          search: str | None = Query(None, max_length=255), limit: int = Query(20, ge=1, le=50)):
    return [_summary(c) for c in await ContactService(db, user).search(search, limit=limit)]


@router.post("/contacts", response_model=ContactCreated, status_code=201)
async def create_contact(data: ContactCreate, db: DBSessionDep, user=current_user):
    result = await ContactService(db, user).create(data.model_dump(exclude={"confirm_duplicate"}),
                                                   confirm_duplicate=data.confirm_duplicate)
    return await _saved(db, ContactCreated(contact=_contact(result.contact), has_match=result.has_match))


@router.post("/contacts/duplicates", response_model=DuplicateResult)
async def check_contact_duplicates(data: DuplicateCheck, db: DBSessionDep, user=current_user):
    """Before creating a contact. A general answer only; POST keeps phones out of URLs and logs."""
    return DuplicateResult(has_match=await ContactService(db, user).has_duplicate(
        data.phone, data.phone_2, exclude_id=data.exclude_id))


@router.get("/contacts/{contact_id}", response_model=ContactOut)
async def get_contact(contact_id: int, db: DBSessionDep, user=current_user):
    return _contact(await ContactService(db, user).get(contact_id))


@router.patch("/contacts/{contact_id}", response_model=ContactOut)
async def update_contact(contact_id: int, data: ContactUpdate, db: DBSessionDep, user=current_user):
    return await _saved(db, _contact(await ContactService(db, user).update(
        contact_id, data.model_dump(exclude_unset=True, exclude={"confirm_duplicate"}), confirm_duplicate=data.confirm_duplicate)))


@router.get("/contacts/{contact_id}/open-proceedings", response_model=OpenProceedingStatus)
async def open_proceedings_of_contact(contact_id: int, db: DBSessionDep, user=current_user):
    """The general warning shown while opening a proceeding for a tenant."""
    return OpenProceedingStatus(has_open=await LegalProceedingService(db, user).has_open_proceeding(contact_id))


# ── proceedings ──────────────────────────────────────────────────────────────

@router.get("/project-options", response_model=list[ProjectOptionOut])
async def project_options(db: DBSessionDep, user=current_user):
    """Active projects for the picker shown while opening a proceeding."""
    return [ProjectOptionOut(id=i, name=name, parent_name=parent)
            for i, name, parent in await LegalProceedingService(db, user).project_options()]


@router.get("/landlords", response_model=list[Ref])
async def linked_landlords(db: DBSessionDep, user=current_user):
    """Landlords linked to the tenants' proceedings the user can see (for the list filter)."""
    return [Ref(id=i, name=name) for i, name in await LegalProceedingService(db, user).linked_landlords()]


@router.get("/proceedings", response_model=ProceedingPage)
async def list_proceedings(
    db: DBSessionDep, user=current_user,
    status: str | None = Query(None, pattern="^(open|closed)$"),
    project_id: int | None = Query(None, ge=1),
    include_subprojects: bool = False,
    contact_id: int | None = Query(None, ge=1),
    landlord_contact_id: int | None = Query(None, ge=1, description="Only tenants' proceedings linked to this landlord"),
    assigned_user_id: int | None = Query(None, ge=1),
    search: str | None = Query(None, max_length=255),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    filters = ProceedingFilters(status=status, project_id=project_id, include_subprojects=include_subprojects,
                                contact_id=contact_id, landlord_contact_id=landlord_contact_id, search=search,
                                assigned_user_id=assigned_user_id)
    items, total = await LegalProceedingService(db, user).list(filters, page=page, page_size=page_size)
    return ProceedingPage(items=[
        ProceedingListItem(
            id=i.row.proceeding.id, title=i.row.proceeding.title, status=i.row.proceeding.status,
            party_role=i.row.proceeding.party_role, apartment_number=i.row.apartment_number,
            total_amount=i.row.total_amount,
            contact=Ref(id=i.row.proceeding.contact_id, name=i.row.contact_name),
            linked_landlord=Ref(id=i.row.proceeding.landlord_id, name=i.row.linked_landlord_name)
            if i.row.proceeding.landlord_id else None,
            project=Ref(id=i.row.proceeding.project_id, name=i.row.project_name) if i.row.proceeding.project_id else None,
            created_by=Ref(id=i.row.proceeding.created_by, name=i.row.created_by_name),
            opened_at=i.row.proceeding.opened_at, closed_at=i.row.proceeding.closed_at,
            progress=_progress(i.progress), assignee_ids=i.assignee_ids)
        for i in items], total=total, page=page, page_size=page_size)


@router.post("/proceedings", response_model=ProceedingCreated, status_code=201)
async def create_proceeding(data: ProceedingCreate, db: DBSessionDep, user=current_user):
    values = data.model_dump(exclude={"contact", "landlord", "confirm_open_proceeding", "confirm_duplicate_contact"}, exclude_unset=True)
    service = LegalProceedingService(db, user)
    result = await service.create(values, contact=data.contact.model_dump(exclude_unset=True) if data.contact else None,
                                  landlord=data.landlord.model_dump(exclude_unset=True) if data.landlord else None,
                                  confirm_open_proceeding=data.confirm_open_proceeding,
                                  confirm_duplicate_contact=data.confirm_duplicate_contact)
    return await _saved(db, ProceedingCreated(proceeding=_detail(await service.detail_of(result.proceeding)),
                                              has_match=result.has_match))


@router.get("/proceedings/{proceeding_id}", response_model=ProceedingDetailOut)
async def get_proceeding(proceeding_id: int, db: DBSessionDep, user=current_user):
    return _detail(await LegalProceedingService(db, user).detail(proceeding_id))


@router.patch("/proceedings/{proceeding_id}", response_model=ProceedingDetailOut)
async def update_proceeding(proceeding_id: int, data: ProceedingUpdate, db: DBSessionDep, user=current_user):
    service = LegalProceedingService(db, user)
    return await _saved(db, _detail(await service.detail_of(await service.update(proceeding_id, data.model_dump(exclude_unset=True)))))


@router.post("/proceedings/{proceeding_id}/close", response_model=ProceedingDetailOut)
async def close_proceeding(proceeding_id: int, data: CloseBody, db: DBSessionDep, user=current_user):
    service = LegalProceedingService(db, user)
    return await _saved(db, _detail(await service.detail_of(await service.close(proceeding_id, data.reason))))


@router.post("/proceedings/{proceeding_id}/reopen", response_model=ProceedingDetailOut)
async def reopen_proceeding(proceeding_id: int, db: DBSessionDep, user=current_user,
                            data: ReasonBody | None = None):
    service = LegalProceedingService(db, user)
    return await _saved(db, _detail(await service.detail_of(await service.reopen(proceeding_id, data.reason if data else None))))


async def _ledger_result(db, service: LegalProceedingService, proceeding_id: int, item) -> LedgerItemResult:
    result = LedgerItemResult(item=LedgerItemOut.model_validate(item, from_attributes=True),
                              total_amount=await service.ledger_total(proceeding_id))
    return await _saved(db, result)


@router.post("/proceedings/{proceeding_id}/ledger-items", response_model=LedgerItemResult, status_code=201)
async def add_ledger_item(proceeding_id: int, data: LedgerItemCreate, db: DBSessionDep, user=current_user):
    service = LegalProceedingService(db, user)
    return await _ledger_result(db, service, proceeding_id, await service.add_ledger_item(proceeding_id, data.model_dump()))


@router.patch("/proceedings/{proceeding_id}/ledger-items/{item_id}", response_model=LedgerItemResult)
async def update_ledger_item(proceeding_id: int, item_id: int, data: LedgerItemUpdate, db: DBSessionDep, user=current_user):
    service = LegalProceedingService(db, user)
    item = await service.update_ledger_item(proceeding_id, item_id, data.model_dump(exclude_unset=True))
    return await _ledger_result(db, service, proceeding_id, item)


@router.post("/proceedings/{proceeding_id}/ledger-items/{item_id}/archive", response_model=LedgerItemResult)
async def archive_ledger_item(proceeding_id: int, item_id: int, db: DBSessionDep, user=current_user):
    service = LegalProceedingService(db, user)
    return await _ledger_result(db, service, proceeding_id, await service.archive_ledger_item(proceeding_id, item_id))


@router.get("/proceedings/{proceeding_id}/history", response_model=HistoryPage)
async def proceeding_history(proceeding_id: int, db: DBSessionDep, user=current_user,
                             page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=200)):
    rows, total = await LegalProceedingService(db, user).history(proceeding_id, page=page, page_size=page_size)
    return _history(rows, total, page, page_size)


@router.get("/projects/summary", response_model=list[ProjectSummaryOut])
async def project_summary(db: DBSessionDep, user=current_user, rollup_to_parent: bool = False,
                          project_id: int | None = Query(None, ge=1)):
    rows = await LegalProceedingService(db, user).project_summary(rollup_to_parent=rollup_to_parent,
                                                                  project_id=project_id)
    return [ProjectSummaryOut.model_validate(r, from_attributes=True) for r in rows]


# ── stages ───────────────────────────────────────────────────────────────────

@router.get("/proceedings/{proceeding_id}/stages/{stage_key}/missing", response_model=list[MissingItem])
async def stage_missing_documentation(proceeding_id: int, stage_key: str, db: DBSessionDep, user=current_user):
    return await LegalStageService(db, user).missing(proceeding_id, stage_key)


@router.post("/proceedings/{proceeding_id}/stages/{stage_key}/complete", response_model=ProceedingDetailOut)
async def complete_stage(proceeding_id: int, stage_key: str, db: DBSessionDep, user=current_user,
                         data: CompleteStageBody | None = None):
    """409 ``stage_requirements_missing`` (with ``missing``) unless ``confirm`` is true."""
    await LegalStageService(db, user).complete(proceeding_id, stage_key, confirm=bool(data and data.confirm))
    return await _saved(db, _detail(await LegalProceedingService(db, user).detail(proceeding_id)))


@router.post("/proceedings/{proceeding_id}/stages/{stage_key}/skip", response_model=ProceedingDetailOut)
async def skip_stage(proceeding_id: int, stage_key: str, db: DBSessionDep, user=current_user,
                     data: ReasonBody | None = None):
    await LegalStageService(db, user).skip(proceeding_id, stage_key, reason=data.reason if data else None)
    return await _saved(db, _detail(await LegalProceedingService(db, user).detail(proceeding_id)))


@router.post("/proceedings/{proceeding_id}/stages/{stage_key}/reopen", response_model=ProceedingDetailOut)
async def reopen_stage(proceeding_id: int, stage_key: str, db: DBSessionDep, user=current_user,
                       data: ReasonBody | None = None):
    await LegalStageService(db, user).reopen(proceeding_id, stage_key, reason=data.reason if data else None)
    return await _saved(db, _detail(await LegalProceedingService(db, user).detail(proceeding_id)))


# ── entries ──────────────────────────────────────────────────────────────────

@router.get("/proceedings/{proceeding_id}/entries", response_model=EntryPage)
async def list_entries(
    proceeding_id: int, db: DBSessionDep, user=current_user,
    stage_key: str | None = Query(None, max_length=50),
    general_only: bool = False,
    context_key: str | None = Query(None, max_length=50),
    entry_type: EntryTypeLiteral | None = None,
    before_id: int | None = Query(None, ge=1, description="Cursor: id of the last entry already shown"),
    limit: int = Query(50, ge=1, le=100),
):
    # one extra row tells whether an older page exists
    views = await LegalEntryService(db, user).list(proceeding_id, stage_key=stage_key, general_only=general_only,
                                                   context_key=context_key, entry_type=entry_type,
                                                   before_id=before_id, limit=limit + 1)
    page = views[:limit]
    return EntryPage(items=[_entry(v) for v in page],
                     next_before_id=page[-1].entry.id if len(views) > limit else None)


@router.post("/proceedings/{proceeding_id}/entries", response_model=EntryOut, status_code=201)
async def create_entry(
    proceeding_id: int, db: DBSessionDep, user=current_user,
    entry_type: EntryTypeLiteral = Form(...),
    stage_key: str | None = Form(None, max_length=50),
    context_key: str | None = Form(None, max_length=50),
    content: str | None = Form(None),
    channel: ChannelLiteral | None = Form(None),
    occurred_at: datetime | None = Form(None),
    files: list[UploadFile] | None = File(None),
):
    """Multipart, so a communication is created together with its files."""
    return _entry(await LegalEntryService(db, user).create(
        proceeding_id, entry_type=entry_type, stage_key=stage_key or None, context_key=context_key or None,
        content=content, channel=channel, occurred_at=occurred_at, files=files or []))


@router.patch("/proceedings/{proceeding_id}/entries/{entry_id}", response_model=EntryOut)
async def update_entry(proceeding_id: int, entry_id: int, data: EntryUpdate, db: DBSessionDep, user=current_user):
    return await _saved(db, _entry(await LegalEntryService(db, user).update(
        proceeding_id, entry_id, **{k: getattr(data, k) for k in data.model_fields_set})))


@router.delete("/proceedings/{proceeding_id}/entries/{entry_id}", status_code=204)
async def delete_entry(proceeding_id: int, entry_id: int, db: DBSessionDep, user=current_user):
    await LegalEntryService(db, user).delete(proceeding_id, entry_id)
    return Response(status_code=204)


@router.post("/proceedings/{proceeding_id}/entries/{entry_id}/documents", response_model=list[DocumentOut],
             status_code=201)
async def upload_entry_documents(proceeding_id: int, entry_id: int, db: DBSessionDep, user=current_user,
                                 files: list[UploadFile] = File(...)):
    service = LegalDocumentService(db, user)
    docs = await service.upload_to_entry(proceeding_id, entry_id, files)
    return [_document(v) for v in await service.views(proceeding_id, docs)]


@router.delete("/proceedings/{proceeding_id}/entries/{entry_id}/documents/{document_id}", status_code=204)
async def delete_entry_document(proceeding_id: int, entry_id: int, document_id: int, db: DBSessionDep,
                                user=current_user):
    await LegalDocumentService(db, user).delete_entry_document(proceeding_id, entry_id, document_id)
    return Response(status_code=204)


# ── documents (general / stage component) ────────────────────────────────────

@router.get("/proceedings/{proceeding_id}/documents", response_model=list[DocumentOut])
async def list_documents(proceeding_id: int, db: DBSessionDep, user=current_user):
    """Every document of the proceeding: general, stage components and entry attachments."""
    return [_document(v) for v in await LegalDocumentService(db, user).list_for_proceeding(proceeding_id)]


@router.post("/proceedings/{proceeding_id}/documents", response_model=list[DocumentOut], status_code=201)
async def upload_documents(proceeding_id: int, db: DBSessionDep, user=current_user,
                           files: list[UploadFile] = File(...),
                           stage_key: str | None = Form(None, max_length=50),
                           component_key: str | None = Form(None, max_length=50)):
    """A general document (no stage), or a stage component document (both keys)."""
    service = LegalDocumentService(db, user)
    docs = await service.upload_to_proceeding(proceeding_id, files, stage_key=stage_key or None,
                                              component_key=component_key or None)
    return [_document(v) for v in await service.views(proceeding_id, docs)]


@router.get("/proceedings/{proceeding_id}/documents/{document_id}", response_model=DocumentOut)
async def get_document(proceeding_id: int, document_id: int, db: DBSessionDep, user=current_user):
    """Fresh signed download URL of one document."""
    return _document(await LegalDocumentService(db, user).get_view(proceeding_id, document_id))


@router.delete("/proceedings/{proceeding_id}/documents/{document_id}", status_code=204)
async def delete_document(proceeding_id: int, document_id: int, db: DBSessionDep, user=current_user):
    await LegalDocumentService(db, user).delete_proceeding_document(proceeding_id, document_id)
    return Response(status_code=204)


# ── team ─────────────────────────────────────────────────────────────────────

@router.get("/proceedings/{proceeding_id}/team", response_model=TeamOut)
async def get_team(proceeding_id: int, db: DBSessionDep, user=current_user):
    return _team(await LegalAssigneeService(db, user).team(proceeding_id))


@router.post("/proceedings/{proceeding_id}/assignees", response_model=TeamOut, status_code=201)
async def assign_user(proceeding_id: int, data: AssignBody, db: DBSessionDep, user=current_user):
    return await _saved(db, _team(await LegalAssigneeService(db, user).assign(proceeding_id, data.user_id)))


@router.delete("/proceedings/{proceeding_id}/assignees/{user_id}", response_model=TeamOut)
async def unassign_user(proceeding_id: int, user_id: int, db: DBSessionDep, user=current_user):
    return await _saved(db, _team(await LegalAssigneeService(db, user).unassign(proceeding_id, user_id)))
