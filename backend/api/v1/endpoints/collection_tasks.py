"""Collection (גבייה) tasks API — mounted at /api/v1/collection-tasks.

Thin layer: parsing, calling ``CollectionTaskService`` and mapping to schemas.
Access follows the regular tasks exactly: the same IAM decorator where the
regular endpoints use one (create, restore, files) and the shared
``services/task_access`` rules everywhere else. Chat messages reuse the shared ``/tasks/{id}/messages``
endpoints (which apply the collection access rules for collection tasks);
task-level files are served here so they follow collection permissions.

Static paths are declared before ``/{task_id}`` so they are never parsed as ids.
"""
from __future__ import annotations

import json
from typing import Literal

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pydantic import TypeAdapter, ValidationError

from backend.api.v1.endpoints.tasks import (
    _delete_stored_file,
    _load_active_assignees,
    _mark_task_chat_read,
    _save_upload_file,
    _unread_message_counts,
)
from backend.core.deps import DBSessionDep, get_current_user
from backend.iam.decorators import require_permission
from backend.iam.enums import ResourceType
from backend.models.collection_task import (
    COLLECTION_AUDIT_ENTITY,
    CollectionAmountAdjustment,
    CollectionEvent,
    CollectionLedgerItem,
)
from backend.models.project import Project
from backend.models.task import Task, TaskAttachment, TaskKind
from backend.repositories.collection_task_repository import CollectionFilters, CollectionTaskRepository
from backend.repositories.notification_repository import NotificationRepository
from backend.repositories.user_repository import UserRepository
from backend.schemas.collection_task import (
    AdjustmentCreate,
    AdjustmentOut,
    AdjustmentResult,
    AuditEntryOut,
    AuditPage,
    BillingMonth,
    CollectionStatusLiteral,
    CollectionSummary,
    CollectionTaskCreate,
    CollectionTaskDetail,
    CollectionTaskListItem,
    CollectionTaskPage,
    CollectionTaskUpdate,
    CollectionUnreadSummary,
    LedgerItemCreate,
    LedgerItemOut,
    LedgerItemResult,
    LedgerItemUpdate,
    MoveMonthIn,
    ProjectBrief,
    ProjectOption,
    StatusIn,
    StatusSummary,
    UserBrief,
)
from backend.schemas.notification import NotificationOut
from backend.schemas.task import TaskAttachmentOut
from backend.services.audit_service import AuditService
from backend.services.collection_task_service import (
    collection_error,
    STATUS_TO_STORED,
    CollectionTaskService,
    _assignee_ids,
    display_status,
)
from backend.services.file_url_resolver import resolve_stored_file_url
from backend.api.v1.endpoints.notifications import _to_out as _notification_to_out

router = APIRouter()

COLLECTION = ResourceType.COLLECTION_TASK.value


async def _resolve_assignees(db, assignee_ids: list[int]):
    """Active users for the ids (primary first) — the regular tasks' loader."""
    return await _load_active_assignees(UserRepository(db), list(dict.fromkeys(assignee_ids)))

_month_adapter = TypeAdapter(BillingMonth)


# ── mapping ──────────────────────────────────────────────────────────────────

def _user_brief(user) -> UserBrief:
    return UserBrief(id=user.id, full_name=user.full_name, avatar_url=getattr(user, "avatar_url", None))


def _assignees_out(task: Task) -> list[UserBrief]:
    by_id = {u.id: u for u in (task.assignees or [])}
    return [_user_brief(by_id[uid]) for uid in _assignee_ids(task) if uid in by_id]


def _project_brief(project: Project, parent_name: str | None) -> ProjectBrief:
    return ProjectBrief(id=project.id, name=project.name,
                        relation_project=project.relation_project, parent_name=parent_name)


def _list_item(task, details, project, parent_name, total, unread: int) -> CollectionTaskListItem:
    return CollectionTaskListItem(
        id=task.id,
        title=task.title,
        status=display_status(task.status),
        collection_type=details.collection_type,
        billing_month=details.billing_month,
        project=_project_brief(project, parent_name),
        assignees=_assignees_out(task),
        total_amount=total,
        is_archived=task.is_archived,
        unread_messages_count=unread,
        created_at=task.created_at,
        updated_at=task.updated_at,
    )


def _adjustment_out(adj: CollectionAmountAdjustment) -> AdjustmentOut:
    author = adj.created_by_user
    return AdjustmentOut(id=adj.id, amount=adj.amount, note=adj.note,
                         created_by=_user_brief(author) if author else None, created_at=adj.created_at)


def _item_out(item: CollectionLedgerItem) -> LedgerItemOut:
    return LedgerItemOut.model_validate(item, from_attributes=True)


async def _detail(db, user, task_id: int) -> CollectionTaskDetail:
    repo = CollectionTaskRepository(db)
    task = await repo.get_task(task_id)
    details = await repo.get_details(task_id)
    project, parent_name = await repo.get_project_brief(details.project_id)
    unread = (await _unread_message_counts(db, user.id, [task_id])).get(task_id, 0)
    base = _list_item(task, details, project, parent_name, await repo.total_for(task_id), unread)
    return CollectionTaskDetail(
        **base.model_dump(),
        description=task.description,
        initial_amount=details.initial_amount,
        adjustments=[_adjustment_out(a) for a in await repo.list_adjustments(task_id)],
        ledger_items=[_item_out(i) for i in await repo.list_ledger_items(task_id)],
        attachments=[
            TaskAttachmentOut(id=a.id, file_name=a.file_name or "", file_url=resolve_stored_file_url(a.file_path))
            for a in (task.attachments or [])
        ],
        created_by_user_id=task.created_by_user_id,
        completed_at=task.completed_at,
        archived_at=task.archived_at,
    )


def _parse_month(value: str | None):
    if value is None:
        return None
    try:
        return _month_adapter.validate_python(value)
    except ValidationError:
        raise HTTPException(status_code=422, detail={"code": "invalid_month", "message": "month must be YYYY-MM"})


def _filters(
    user,
    month: str | None,
    status: list[CollectionStatusLiteral] | None,
    project_id: int | None,
    collection_type: str | None,
    assignee_id: int | None,
    archived: str,
    search: str | None,
) -> CollectionFilters:
    return CollectionFilters(
        month=_parse_month(month),
        statuses=[STATUS_TO_STORED[s] for s in (status or [])],
        project_id=project_id,
        collection_type=collection_type,
        # As in the regular lists, filtering by another user is an Admin tool.
        assignee_id=assignee_id if user.role == "Admin" else None,
        archived=archived,
        search=search or None,
    )


# ── module-level endpoints (declared before /{task_id}) ──────────────────────

@router.get("/", response_model=CollectionTaskPage)
async def list_collection_tasks(
    db: DBSessionDep,
    user=Depends(require_permission("read", COLLECTION, project_id_param=None)),
    month: str = Query(..., description="Billing month, YYYY-MM"),
    status: list[CollectionStatusLiteral] | None = Query(None),
    project_id: int | None = Query(None),
    collection_type: Literal["single", "ledger"] | None = Query(None),
    assignee_id: int | None = Query(None, description="Admin only"),
    archived: Literal["false", "true", "all"] = Query("false"),
    search: str | None = Query(None, max_length=255),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    filters = _filters(user, month, status, project_id, collection_type, assignee_id, archived, search)
    rows, total = await CollectionTaskRepository(db).list_page(filters, user, page=page, page_size=page_size)
    unread = await _unread_message_counts(db, user.id, [row[0].id for row in rows])
    return CollectionTaskPage(
        items=[_list_item(*row, unread.get(row[0].id, 0)) for row in rows],
        total=total, page=page, page_size=page_size,
    )


@router.get("/summary", response_model=CollectionSummary)
async def collection_summary(
    db: DBSessionDep,
    user=Depends(require_permission("read", COLLECTION, project_id_param=None)),
    month: str = Query(...),
    status: list[CollectionStatusLiteral] | None = Query(None),
    project_id: int | None = Query(None),
    collection_type: Literal["single", "ledger"] | None = Query(None),
    assignee_id: int | None = Query(None),
    archived: Literal["false", "true", "all"] = Query("false"),
    search: str | None = Query(None, max_length=255),
):
    filters = _filters(user, month, status, project_id, collection_type, assignee_id, archived, search)
    by_status = {s: StatusSummary() for s in STATUS_TO_STORED}
    for stored, count, total in await CollectionTaskRepository(db).summary(filters, user):
        bucket = by_status[display_status(stored)]
        bucket.count += count
        bucket.total_amount += total
    return CollectionSummary(
        by_status=by_status,
        count=sum(b.count for b in by_status.values()),
        total_amount=sum((b.total_amount for b in by_status.values()), StatusSummary().total_amount),
    )


@router.get("/unread-summary", response_model=CollectionUnreadSummary)
async def collection_unread_summary(db: DBSessionDep, user=Depends(require_permission("read", COLLECTION, project_id_param=None))):
    """Unread chat messages on collection tasks the user is assigned to.
    Separate from the regular /tasks/unread-summary counter."""
    total, tasks = await CollectionTaskRepository(db).unread_summary(user.id)
    return CollectionUnreadSummary(total_unread=total, task_count=tasks)


@router.get("/notifications", response_model=list[NotificationOut])
async def collection_notifications(
    db: DBSessionDep,
    user=Depends(require_permission("read", COLLECTION, project_id_param=None)),
    unread_only: bool = Query(False),
    limit: int = Query(100, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """The user's notifications about collection tasks (kept out of the general center)."""
    items = await NotificationRepository(db).list_for_user(
        user.id, unread_only=unread_only, limit=limit, offset=offset, task_kind=TaskKind.COLLECTION
    )
    return [_notification_to_out(n) for n in items]


@router.get("/notifications/unread-count")
async def collection_notifications_unread_count(db: DBSessionDep, user=Depends(require_permission("read", COLLECTION, project_id_param=None))):
    return {"count": await NotificationRepository(db).count_unread(user.id, task_kind=TaskKind.COLLECTION)}


@router.get("/project-options", response_model=list[ProjectOption])
async def collection_project_options(db: DBSessionDep, user=Depends(require_permission("read", COLLECTION, project_id_param=None))):
    """Projects for the picker: parents and sub-projects (via relation_project).
    Inactive parents appear only to group active sub-projects (is_active=false)."""
    return [
        ProjectOption(id=p.id, name=p.name, relation_project=p.relation_project,
                      is_parent_project=bool(p.is_parent_project), is_active=bool(p.is_active))
        for p in await CollectionTaskRepository(db).project_options()
    ]


@router.post("/", response_model=CollectionTaskDetail, status_code=201)
async def create_collection_task(
    data: CollectionTaskCreate,
    db: DBSessionDep,
    user=Depends(require_permission("write", COLLECTION, project_id_param=None)),
):
    assignees = await _resolve_assignees(db, data.assignee_ids)
    task_id = await CollectionTaskService(db, user).create(data, assignees)
    return await _detail(db, user, task_id)


# ── per-task endpoints ───────────────────────────────────────────────────────

@router.get("/{task_id}", response_model=CollectionTaskDetail)
async def get_collection_task(task_id: int, db: DBSessionDep, user=Depends(get_current_user)):
    """Full details. Opening the task reads its chat (clears this user's unread)."""
    await CollectionTaskService(db, user).load_for_view(task_id)
    await NotificationRepository(db).mark_task_messages_read(user.id, task_id)
    await _mark_task_chat_read(db, task_id, user.id)
    return await _detail(db, user, task_id)


@router.get("/{task_id}/history", response_model=AuditPage)
async def get_collection_task_history(
    task_id: int,
    db: DBSessionDep,
    user=Depends(get_current_user),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    await CollectionTaskService(db, user).load_for_view(task_id)
    rows, total = await CollectionTaskRepository(db).history(task_id, page=page, page_size=page_size)
    return AuditPage(
        items=[
            AuditEntryOut(id=log.id, action=log.action, user_id=log.user_id, user_name=name,
                          details=json.loads(log.details) if log.details else None, created_at=log.created_at)
            for log, name in rows
        ],
        total=total, page=page, page_size=page_size,
    )


@router.get("/{task_id}/ledger-items", response_model=list[LedgerItemOut])
async def list_collection_ledger_items(
    task_id: int, db: DBSessionDep, user=Depends(get_current_user),
    include_archived: bool = Query(False),
):
    await CollectionTaskService(db, user).load_for_view(task_id)
    items = await CollectionTaskRepository(db).list_ledger_items(task_id, include_archived=include_archived)
    return [_item_out(i) for i in items]


@router.patch("/{task_id}", response_model=CollectionTaskDetail)
async def update_collection_task(task_id: int, data: CollectionTaskUpdate, db: DBSessionDep,
                                 user=Depends(get_current_user)):
    new_assignees = None
    if data.assignee_ids is not None and user.role == "Admin":
        new_assignees = await _resolve_assignees(db, data.assignee_ids)
    await CollectionTaskService(db, user).update(task_id, data, new_assignees)
    return await _detail(db, user, task_id)


@router.post("/{task_id}/move-month", response_model=CollectionTaskDetail)
async def move_collection_task_month(task_id: int, data: MoveMonthIn, db: DBSessionDep,
                                     user=Depends(get_current_user)):
    await CollectionTaskService(db, user).move_month(task_id, data.billing_month, data.reason)
    return await _detail(db, user, task_id)


@router.post("/{task_id}/status", response_model=CollectionTaskDetail)
async def set_collection_task_status(task_id: int, data: StatusIn, db: DBSessionDep,
                                     user=Depends(get_current_user)):
    await CollectionTaskService(db, user).set_status(task_id, data.status)
    return await _detail(db, user, task_id)


@router.post("/{task_id}/archive", response_model=CollectionTaskDetail)
async def archive_collection_task(task_id: int, db: DBSessionDep, user=Depends(get_current_user)):
    await CollectionTaskService(db, user).set_archived(task_id, True)
    return await _detail(db, user, task_id)


@router.post("/{task_id}/unarchive", response_model=CollectionTaskDetail)
async def unarchive_collection_task(
    task_id: int,
    db: DBSessionDep,
    user=Depends(require_permission("update", COLLECTION, resource_id_param="task_id", project_id_param=None)),
):
    await CollectionTaskService(db, user).set_archived(task_id, False)
    return await _detail(db, user, task_id)


@router.post("/{task_id}/adjustments", response_model=AdjustmentResult, status_code=201)
async def add_collection_adjustment(task_id: int, data: AdjustmentCreate, db: DBSessionDep,
                                    user=Depends(get_current_user)):
    adjustment = await CollectionTaskService(db, user).add_adjustment(task_id, data)
    total = await CollectionTaskRepository(db).total_for(task_id)
    return AdjustmentResult(adjustment=_adjustment_out(adjustment), total_amount=total)


@router.post("/{task_id}/ledger-items", response_model=LedgerItemResult, status_code=201)
async def add_collection_ledger_item(task_id: int, data: LedgerItemCreate, db: DBSessionDep,
                                     user=Depends(get_current_user)):
    item = await CollectionTaskService(db, user).add_ledger_item(task_id, data)
    total = await CollectionTaskRepository(db).total_for(task_id)
    return LedgerItemResult(item=_item_out(item), total_amount=total)


@router.patch("/{task_id}/ledger-items/{item_id}", response_model=LedgerItemResult)
async def update_collection_ledger_item(task_id: int, item_id: int, data: LedgerItemUpdate,
                                        db: DBSessionDep, user=Depends(get_current_user)):
    item = await CollectionTaskService(db, user).update_ledger_item(task_id, item_id, data)
    total = await CollectionTaskRepository(db).total_for(task_id)
    return LedgerItemResult(item=_item_out(item), total_amount=total)


@router.post("/{task_id}/ledger-items/{item_id}/archive", response_model=LedgerItemResult)
async def archive_collection_ledger_item(task_id: int, item_id: int, db: DBSessionDep,
                                         user=Depends(get_current_user)):
    item = await CollectionTaskService(db, user).archive_ledger_item(task_id, item_id)
    total = await CollectionTaskRepository(db).total_for(task_id)
    return LedgerItemResult(item=_item_out(item), total_amount=total)


@router.post("/{task_id}/attachments", response_model=TaskAttachmentOut, status_code=201)
async def upload_collection_attachment(
    task_id: int,
    db: DBSessionDep,
    user=Depends(require_permission("write", COLLECTION, resource_id_param="task_id", project_id_param=None)),
    file: UploadFile = File(...),
):
    task = await CollectionTaskService(db, user).load_for_manage(task_id)
    stored_path, original_name = await _save_upload_file(file, "task_attachments")
    attachment = TaskAttachment(file_path=stored_path, file_name=original_name)
    task.attachments.append(attachment)
    await db.flush()
    await AuditService(db).log_action(user.id, CollectionEvent.ATTACHMENT_ADDED, COLLECTION_AUDIT_ENTITY,
                                      str(task.id), {"attachment_id": attachment.id, "file_name": original_name})
    return TaskAttachmentOut(id=attachment.id, file_name=original_name,
                             file_url=resolve_stored_file_url(stored_path))


@router.delete("/{task_id}/attachments/{attachment_id}", status_code=204)
async def delete_collection_attachment(
    task_id: int,
    attachment_id: int,
    db: DBSessionDep,
    user=Depends(require_permission("update", COLLECTION, resource_id_param="task_id", project_id_param=None)),
):
    """Same rule as a regular task's file: Admin or the primary assignee.
    Files are not financial records; the removal is recorded in the history."""
    task = await CollectionTaskService(db, user).get_task(task_id)
    if user.role != "Admin" and task.assigned_to_user_id != user.id:
        raise HTTPException(status_code=403, detail="Access denied.")
    attachment = next((a for a in (task.attachments or []) if a.id == attachment_id), None)
    if attachment is None:
        raise HTTPException(status_code=404, detail="Attachment not found")
    await _delete_stored_file(attachment.file_path)
    await AuditService(db).log_action(user.id, CollectionEvent.ATTACHMENT_DELETED, COLLECTION_AUDIT_ENTITY,
                                      str(task.id), {"attachment_id": attachment.id,
                                                     "file_name": attachment.file_name})
    task.attachments.remove(attachment)  # delete-orphan cascade removes the row
    await db.flush()
    return None
