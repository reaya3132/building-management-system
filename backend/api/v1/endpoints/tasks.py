"""Task API endpoints for Task Management Calendar."""
import asyncio
import io
import logging
from datetime import datetime, timezone, timedelta
import os
import uuid
from sqlalchemy import select, update, func, or_, exists, distinct
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload
from fastapi import APIRouter, Depends, HTTPException, Query, Body, File, UploadFile, Form

from backend.core.config import settings
from backend.core.deps import DBSessionDep, get_current_user
from backend.iam.decorators import require_permission
from backend.iam.engine import PermissionsEngine
from backend.iam.enums import Action, ResourceType
from backend.services.s3_service import S3Service
from backend.services.file_url_resolver import resolve_stored_file_url
from backend.repositories.task_repository import ISRAEL_TZ, TaskRepository
from backend.repositories.task_label_repository import TaskLabelRepository
from backend.repositories.task_checklist_repository import TaskChecklistRepository
from backend.repositories.user_repository import UserRepository
from backend.repositories.notification_repository import NotificationRepository
from backend.schemas.task import (
    TaskCreate,
    TaskOut,
    TaskUpdate,
    RECURRENCE_RULE_VALUES,
    TASK_STATUS_VALUES,
    TaskParticipantOut,
    TaskAssigneeOut,
    TaskAttachmentOut,
    TaskMessageOut,
    TaskMessageAttachmentOut,
    TaskMessageUpdate,
    TaskUnreadSummaryOut,
    ArchivedTasksFilter,
    TaskChecklistItemCreate,
    TaskChecklistItemUpdate,
    TaskChecklistItemOut,
    TaskChecklistSummary,
)
from backend.schemas.task_label import TaskLabelOut, TaskLabelCreate, TaskLabelUpdate
from backend.models.user import User
from backend.models.task import (
    Task,
    TaskLabel,
    TaskParticipant,
    TaskAttachment,
    TaskMessage,
    TaskMessageAttachment,
    TaskMessageRead,
    task_assignees,
    TaskChecklistItem,
    TaskKind,
    TaskStatus,
    EventType,
    ParticipantResponse,
    generate_unique_tag,
)
from backend.services.outlook_sync_service import (
    create_outlook_event,
    update_outlook_event,
    delete_outlook_event,
)
from backend.services.task_access import (
    can_access_task as _can_access_task,
    can_manage_task as _can_manage_task,
    is_task_assignee as _is_task_assignee,
)
from backend.models.collection_task import COLLECTION_AUDIT_ENTITY, CollectionEvent
from backend.services.audit_service import AuditService
from backend.services.notification_service import (
    _build_message_preview,
    create_task_assignment_notifications,
    create_task_message_notifications,
    create_task_reminder,
    create_closure_approval_notification,
)

router = APIRouter()
logger = logging.getLogger(__name__)

EMPLOYEE_COLORS = [
    "#3B82F6", "#10B981", "#F59E0B", "#EF4444",
    "#8B5CF6", "#EC4899", "#06B6D4", "#84CC16",
]


def _user_color(user) -> str | None:
    """Resolve a display color for a user.

    Prefers the user's own ``calendar_color`` when set, otherwise picks a
    stable color from the ``EMPLOYEE_COLORS`` palette by user id. Returns
    ``None`` for a missing user. Single source of truth for the per-user color
    used by both task and checklist-item serialization (DRY).
    """
    if not user:
        return None
    explicit_color = getattr(user, "calendar_color", None)
    if explicit_color:
        return explicit_color
    idx = ((getattr(user, "id", None) or 1) - 1) % len(EMPLOYEE_COLORS)
    return EMPLOYEE_COLORS[idx]


def _get_uploads_dir() -> str:
    from backend.core.config import settings
    if os.path.isabs(settings.FILE_UPLOAD_DIR):
        return settings.FILE_UPLOAD_DIR
    current_dir = os.path.dirname(os.path.abspath(__file__))
    backend_dir = os.path.dirname(os.path.dirname(os.path.dirname(current_dir)))
    return os.path.abspath(os.path.join(backend_dir, settings.FILE_UPLOAD_DIR))


async def _delete_stored_file(stored_path: str | None) -> None:
    """Delete a stored attachment file from S3 or local disk.

    No-ops on an empty/None path. When the path is an http(s) URL and an S3
    bucket is configured, deletes the S3 object (in a worker thread, since boto3
    is synchronous). Otherwise removes the local file under the uploads dir.
    Failures are swallowed (logged) so a missing file never blocks the DB delete.
    """
    if not stored_path:
        return
    is_s3_object = stored_path.startswith("http://") or stored_path.startswith("https://")
    if is_s3_object and settings.AWS_S3_BUCKET:
        try:
            await asyncio.to_thread(S3Service().delete_file, stored_path)
        except Exception:
            logger.warning("Failed to delete S3 attachment %s", stored_path, exc_info=True)
        return
    full_path = os.path.join(_get_uploads_dir(), stored_path)
    if os.path.isfile(full_path):
        try:
            os.remove(full_path)
        except OSError:
            pass


# Allowed extensions for task attachments (images + video + audio recordings +
# common docs). Shared by task attachments and task-message (chat) attachments so
# both enforce the same policy. Audio types support voice recordings;
# MediaRecorder typically outputs `.webm` (or `.m4a` on Safari/iOS).
ALLOWED_ATTACHMENT_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg",
    ".mp4", ".mov", ".m4v", ".avi", ".mkv", ".ogv", ".3gp",
    ".webm", ".ogg", ".oga", ".mp3", ".m4a", ".wav", ".aac",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".txt", ".csv", ".zip",
}
MAX_ATTACHMENT_SIZE_MB = 25


async def _save_upload_to_s3(
    content: bytes, file: UploadFile, subdir: str
) -> tuple[str, str]:
    """Persist already-read upload bytes to S3 under ``subdir``.

    Reuses ``content`` (read by the caller) rather than re-reading the file.
    boto3 is synchronous, so the upload runs in a worker thread to avoid
    blocking the event loop. Returns ``(full_s3_url, original_file_name)``.
    """
    file_obj = io.BytesIO(content)
    stored = await asyncio.to_thread(
        S3Service().upload_file,
        prefix=subdir,
        file_obj=file_obj,
        filename=file.filename or "file",
        content_type=getattr(file, "content_type", None),
    )
    return stored, file.filename or stored


def _save_upload_to_disk(
    content: bytes, file: UploadFile, subdir: str
) -> tuple[str, str]:
    """Persist already-read upload bytes to local disk under ``uploads/<subdir>``.

    Returns ``(relative_path, original_file_name)``. Used as the dev/test
    fallback whenever no S3 bucket is configured.
    """
    target_dir = os.path.join(_get_uploads_dir(), subdir)
    os.makedirs(target_dir, exist_ok=True)
    safe_name = (file.filename or "file").strip() or "file"
    for char in ['/', '\\', '\0', '..']:
        safe_name = safe_name.replace(char, "_")
    stored_name = f"{uuid.uuid4().hex[:12]}_{safe_name}"
    with open(os.path.join(target_dir, stored_name), "wb") as out_file:
        out_file.write(content)
    return f"{subdir}/{stored_name}", file.filename or stored_name


async def _save_upload_file(file: UploadFile, subdir: str) -> tuple[str, str]:
    """Validate an uploaded file and persist it via the configured backend.

    Returns ``(stored_path, original_file_name)`` where ``stored_path`` is a
    full S3 URL when ``AWS_S3_BUCKET`` is configured, otherwise a relative
    local path. Raises HTTPException(400) for an unsupported extension or
    oversized file. Shared by task attachments and task-message attachments so
    both enforce identical limits (DRY).
    """
    ext = (os.path.splitext(file.filename or "")[1] or "").lower()
    if ext not in ALLOWED_ATTACHMENT_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"סוג קובץ לא נתמך. מותרים: {', '.join(sorted(ALLOWED_ATTACHMENT_EXTENSIONS))}",
        )
    content = await file.read()
    if len(content) > MAX_ATTACHMENT_SIZE_MB * 1024 * 1024:
        raise HTTPException(
            status_code=400,
            detail=f"גודל קובץ מקסימלי: {MAX_ATTACHMENT_SIZE_MB} MB",
        )
    if settings.AWS_S3_BUCKET:
        return await _save_upload_to_s3(content, file, subdir)
    return _save_upload_to_disk(content, file, subdir)


def _message_to_out(msg: TaskMessage, author, read_by_all: bool = False) -> TaskMessageOut:
    """Build a TaskMessageOut (with attachments) from a TaskMessage."""
    attachments = []
    for att in getattr(msg, "attachments", None) or []:
        file_url = resolve_stored_file_url(getattr(att, "file_path", None))
        attachments.append(
            TaskMessageAttachmentOut(id=att.id, file_name=att.file_name or "", file_url=file_url)
        )
    return TaskMessageOut(
        id=msg.id,
        task_id=msg.task_id,
        user_id=msg.user_id,
        full_name=getattr(author, "full_name", "") or "",
        avatar_url=getattr(author, "avatar_url", None),
        message=msg.message,
        created_at=msg.created_at,
        edited_at=getattr(msg, "edited_at", None),
        read_by_all=read_by_all,
        attachments=attachments,
    )


VALID_WEEKDAYS = {"0", "1", "2", "3", "4", "5", "6"}
VALID_MONTHLY_MODES = ("day_of_month", "day_of_week")


def _normalize_recurrence(
    rule: str | None,
    interval: int | None,
    weekdays: str | None,
    monthly_mode: str | None,
    count: int | None,
) -> dict:
    """Sanitize Outlook-style recurrence inputs into safe DB values.

    Returns the cleaned ``recurrence_*`` fields. A non-recurring task ('' rule)
    resets every refinement so stale settings can't linger. Weekday/monthly-mode
    refinements only apply to their relevant frequency.
    """
    clean_rule = (rule or "").strip().lower()
    if clean_rule not in ("daily", "weekly", "monthly", "yearly"):
        return {
            "recurrence_rule": "",
            "recurrence_interval": 1,
            "recurrence_weekdays": None,
            "recurrence_monthly_mode": None,
            "recurrence_count": None,
        }
    clean_interval = interval if isinstance(interval, int) and interval >= 1 else 1
    clean_weekdays = None
    if clean_rule == "weekly" and weekdays:
        days = [d.strip() for d in str(weekdays).split(",") if d.strip() in VALID_WEEKDAYS]
        # de-duplicate while preserving ascending order
        clean_weekdays = ",".join(sorted(set(days), key=int)) or None
    clean_monthly_mode = None
    if clean_rule == "monthly":
        clean_monthly_mode = monthly_mode if monthly_mode in VALID_MONTHLY_MODES else "day_of_month"
    clean_count = count if isinstance(count, int) and count >= 1 else None
    return {
        "recurrence_rule": clean_rule,
        "recurrence_interval": clean_interval,
        "recurrence_weekdays": clean_weekdays,
        "recurrence_monthly_mode": clean_monthly_mode,
        "recurrence_count": clean_count,
    }


def _ordered_unique_assignee_ids(primary_id: int | None, extra_ids: list[int] | None) -> list[int]:
    """Ordered-unique union of the primary id and any extra ids (primary first).

    Preserves first-seen order and drops duplicates so the primary assignee is
    always index 0 of the effective assignee set.
    """
    ordered: list[int] = []
    for candidate_id in [primary_id, *(extra_ids or [])]:
        if candidate_id and candidate_id not in ordered:
            ordered.append(candidate_id)
    return ordered


async def _load_active_assignees(user_repo: UserRepository, assignee_ids: list[int]) -> list[User]:
    """Load User rows for every id, requiring each to exist and be active.

    Raises HTTPException(404) with a Hebrew detail if any id is missing or
    inactive. Returns the users in the same order as ``assignee_ids`` so the
    primary (first) stays first.
    """
    loaded: list[User] = []
    for assignee_id in assignee_ids:
        candidate = await user_repo.get_by_id(assignee_id)
        if not candidate or not candidate.is_active:
            raise HTTPException(status_code=404, detail="User not found")
        loaded.append(candidate)
    return loaded


def _to_naive_utc(dt: datetime | None) -> datetime | None:
    """Convert timezone-aware datetime to naive UTC for DB comparison."""
    if dt is None:
        return None
    if dt.tzinfo:
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def _to_naive_israel_local(dt: datetime | None) -> datetime | None:
    """Normalize a scheduling value to naive Israel local wall-clock.

    ``start_time``/``end_time`` are stored as naive Israel wall-clock (see the
    serializer note in ``backend/schemas/task.py``) and read back that way by the
    frontend and by ``count_open_by_apartment_ids``. The frontend already sends
    naive wall-clock, but an API client may send a tz-aware value; convert those
    to Israel local (NOT UTC) so every stored ``start_time`` uses one convention
    and the "has the task come due?" comparison stays correct across the offset.
    """
    if dt is None:
        return None
    if dt.tzinfo:
        return dt.astimezone(ISRAEL_TZ).replace(tzinfo=None)
    return dt


def _task_assignees_out(task: Task) -> list[TaskAssigneeOut]:
    """Build the full assignee set for a task.

    Falls back to the primary ``assigned_user`` for legacy rows created before
    the assignee backfill (empty ``task.assignees``) so the response is never
    empty for a task that has a primary assignee.
    """
    assignee_users = list(getattr(task, "assignees", None) or [])
    if not assignee_users and task.assigned_user:
        assignee_users = [task.assigned_user]
    # The `task_assignees` join has no inherent order, so pin the primary
    # (`assigned_to_user_id`) first — the frontend and the update endpoint both
    # treat `assigned_to_user_ids[0]` as the primary. sort() is stable, so the
    # remaining co-assignees keep their existing relative order.
    primary_id = task.assigned_to_user_id
    assignee_users.sort(key=lambda member: 0 if getattr(member, "id", None) == primary_id else 1)
    return [
        TaskAssigneeOut(
            user_id=assignee.id,
            full_name=assignee.full_name or "",
            avatar_url=getattr(assignee, "avatar_url", None),
            color=_user_color(assignee),
        )
        for assignee in assignee_users
    ]


def _task_to_out(task: Task, unread_count: int = 0) -> dict:
    color = _user_color(task.assigned_user)
    if color is None:
        idx = ((task.assigned_to_user_id or 1) - 1) % len(EMPLOYEE_COLORS)
        color = EMPLOYEE_COLORS[idx]
    assignees_out = _task_assignees_out(task)
    labels = getattr(task, "labels", None) or []
    participants_data = []
    for p in getattr(task, "participants", None) or []:
        usr = getattr(p, "user", None)
        participants_data.append(
            TaskParticipantOut(
                user_id=p.user_id,
                full_name=usr.full_name if usr else "",
                response_status=getattr(p, "response_status",
                                        ParticipantResponse.PENDING) or ParticipantResponse.PENDING,
                avatar_url=getattr(usr, "avatar_url", None) if usr else None,
            )
        )
    recurrence_rule = getattr(task, "recurrence_rule", None) or ""
    recurrence_end_date = getattr(task, "recurrence_end_date", None)
    attachments_raw = getattr(task, "attachments", None) or []
    attachments_data = []
    for att in attachments_raw:
        file_url = resolve_stored_file_url(getattr(att, "file_path", None))
        attachments_data.append(
            TaskAttachmentOut(
                id=att.id,
                file_name=getattr(att, "file_name", "") or "",
                file_url=file_url,
            )
        )
    return {
        "id": task.id,
        "title": task.title,
        "start_time": task.start_time,
        "end_time": task.end_time,
        "description": task.description,
        "status": getattr(task, "status", "pending") or "pending",
        "event_type": getattr(task, "event_type", EventType.TASK) or EventType.TASK,
        "assigned_to_user_id": task.assigned_to_user_id,
        "apartment_id": getattr(task, "apartment_id", None),
        "building_id": getattr(task, "building_id", None),
        "has_unread_messages": unread_count > 0,
        "unread_messages_count": unread_count,
        "unique_tag": task.unique_tag,
        "recurrence_rule": recurrence_rule if recurrence_rule in RECURRENCE_RULE_VALUES else "",
        "recurrence_end_date": recurrence_end_date,
        "recurrence_interval": getattr(task, "recurrence_interval", 1) or 1,
        "recurrence_weekdays": getattr(task, "recurrence_weekdays", None),
        "recurrence_monthly_mode": getattr(task, "recurrence_monthly_mode", None),
        "recurrence_count": getattr(task, "recurrence_count", None),
        "created_at": task.created_at,
        "updated_at": task.updated_at,
        "assignee_acknowledged_at": getattr(task, "assignee_acknowledged_at", None),
        "assignee_viewed_at": getattr(task, "assignee_viewed_at", None),
        "is_archived": getattr(task, "is_archived", False),
        "archived_at": getattr(task, "archived_at", None),
        "completed_at": getattr(task, "completed_at", None),
        "requires_closure_approval": getattr(task, "requires_closure_approval", False),
        "is_super_task": getattr(task, "is_super_task", False),
        "is_backlog": getattr(task, "is_backlog", False),
        "task_kind": getattr(task, "task_kind", TaskKind.GENERAL) or TaskKind.GENERAL,
        "assigned_user_name": task.assigned_user.full_name if task.assigned_user else None,
        "assigned_user_color": color,
        "assigned_user_avatar": getattr(task.assigned_user, "avatar_url", None) if task.assigned_user else None,
        "assigned_to_user_ids": [a.user_id for a in assignees_out],
        "assignees": assignees_out,
        "labels": [TaskLabelOut.model_validate(l) for l in labels],
        "participants": participants_data,
        "attachments": attachments_data,
    }


async def _tasks_to_out_with_unread(db, user_id: int, tasks: list[Task]) -> list[dict]:
    """Serialize task cards with each task's unread chat-message count for ``user_id``.

    Resolves the "how many unread replies for me" signal in a single query via
    ``_unread_message_counts`` (based on the read-receipt ``last_read_at``) and
    applies it per task. Shared by every list endpoint that renders cards (DRY).
    """
    counts = await _unread_message_counts(db, user_id, [task.id for task in tasks])
    return [_task_to_out(task, counts.get(task.id, 0)) for task in tasks]


@router.get("/", response_model=list[TaskOut])
async def list_tasks(
        db: DBSessionDep,
        user=Depends(get_current_user),
        assigned_to_user_id: int | None = Query(None, description="Filter by assigned user ID"),
        start: datetime | None = Query(None, description="Start of date range (ISO)"),
        end: datetime | None = Query(None, description="End of date range (ISO)"),
        include_archived: bool = Query(False, description="Include archived tasks"),
):
    """Fetch tasks. Admin sees all; Member sees tasks they own or are invited to."""
    repo = TaskRepository(db)
    start_naive = _to_naive_utc(start)
    end_naive = _to_naive_utc(end)
    if user.role != "Admin":
        tasks = await repo.list(for_user_id=user.id, start=start_naive, end=end_naive, include_archived=include_archived)
    else:
        tasks = await repo.list(assigned_to_user_id=assigned_to_user_id, start=start_naive, end=end_naive, include_archived=include_archived)
    return await _tasks_to_out_with_unread(db, user.id, tasks)


@router.get("/labels", response_model=list[TaskLabelOut])
async def list_task_labels(db: DBSessionDep, user=Depends(get_current_user)):
    """List all task labels (for calendar)."""
    repo = TaskLabelRepository(db)
    labels = await repo.list_all()
    return [TaskLabelOut.model_validate(l) for l in labels]


@router.post("/labels", response_model=TaskLabelOut)
async def create_task_label(
        data: TaskLabelCreate, db: DBSessionDep, user=Depends(require_permission("write", "task", project_id_param=None))
):
    """Create a new task label."""
    color = (data.color or "#3B82F6").strip()
    if color and not color.startswith("#"):
        color = "#" + color
    label = TaskLabel(name=data.name.strip(), color=color or "#3B82F6")
    repo = TaskLabelRepository(db)
    created = await repo.create(label)
    return TaskLabelOut.model_validate(created)


@router.put("/labels/{label_id}", response_model=TaskLabelOut)
async def update_task_label(
        label_id: int,
        data: TaskLabelUpdate,
        db: DBSessionDep,
        user=Depends(require_permission("update", "task", project_id_param=None)),
):
    """Update a task label."""
    repo = TaskLabelRepository(db)
    label = await repo.get_by_id(label_id)
    if not label:
        raise HTTPException(status_code=404, detail="Label not found")
    if data.name is not None:
        label.name = data.name.strip()
    if data.color is not None:
        color = data.color.strip()
        if color and not color.startswith("#"):
            color = "#" + color
        label.color = color or label.color
    updated = await repo.update(label)
    return TaskLabelOut.model_validate(updated)


@router.get("/labels/{label_id}/usage")
async def get_task_label_usage(
        label_id: int, db: DBSessionDep, user=Depends(get_current_user)
):
    """Return how many tasks use this label (for delete confirmation)."""
    repo = TaskLabelRepository(db)
    label = await repo.get_by_id(label_id)
    if not label:
        raise HTTPException(status_code=404, detail="Label not found")
    task_count = await repo.count_tasks_for_label(label_id)
    return {"task_count": task_count}


@router.delete("/labels/{label_id}", status_code=204)
async def delete_task_label(
        label_id: int, db: DBSessionDep, user=Depends(require_permission("delete", "task", project_id_param=None))
):
    """Delete a task label (removes it from all tasks)."""
    repo = TaskLabelRepository(db)
    label = await repo.get_by_id(label_id)
    if not label:
        raise HTTPException(status_code=404, detail="Label not found")
    await repo.delete(label)
    return None


@router.get("/archived", response_model=list[TaskOut])
async def list_archived_tasks(
        db: DBSessionDep,
        user=Depends(get_current_user),
        date_from: datetime | None = Query(None, description="Start of date range (ISO)"),
        date_to: datetime | None = Query(None, description="End of date range (ISO)"),
        preset: str | None = Query(None, description="Preset: last_week, last_month, last_3_months"),
        assigned_to_user_id: int | None = Query(None, description="Filter by assigned user ID (admin only)"),
):
    """List archived tasks with date filters. Admin sees all; Member sees own."""
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    if preset and not date_from:
        if preset == "last_week":
            date_from = now - timedelta(days=7)
        elif preset == "last_month":
            date_from = now - timedelta(days=30)
        elif preset == "last_3_months":
            date_from = now - timedelta(days=90)
    if date_from and not date_to:
        date_to = now
    date_from_naive = _to_naive_utc(date_from)
    date_to_naive = _to_naive_utc(date_to)
    repo = TaskRepository(db)
    if user.role != "Admin":
        tasks = await repo.list_archived(
            date_from=date_from_naive, date_to=date_to_naive, for_user_id=user.id
        )
    else:
        tasks = await repo.list_archived(
            date_from=date_from_naive, date_to=date_to_naive, assigned_to_user_id=assigned_to_user_id
        )
    return await _tasks_to_out_with_unread(db, user.id, tasks)


@router.get("/super", response_model=list[TaskOut])
async def list_super_tasks(db: DBSessionDep, user=Depends(get_current_user)):
    """Return all active super tasks (not completed, not archived). Admin only.

    This is the dedicated, system-wide Super Tasks list, which is admin-managed
    and admin-only. Non-admins get an empty list (rather than a 403) so the
    polling Super Tasks panel simply renders nothing for them. Note this only
    hides the aggregated list/panel: a super task assigned to a member is still
    visible to that member through the normal task list/board/calendar, like any
    other task assigned to them.
    """
    if user.role != "Admin":
        return []
    repo = TaskRepository(db)
    tasks = await repo.list_super_tasks()
    return await _tasks_to_out_with_unread(db, user.id, tasks)


@router.get("/backlog", response_model=list[TaskOut])
async def list_backlog_tasks(
        db: DBSessionDep,
        user=Depends(get_current_user),
        assigned_to_user_id: int | None = Query(None, description="Filter by assigned user ID (admin only)"),
):
    """Return active backlog tasks (unscheduled). Admin sees all; Member sees own/invited."""
    repo = TaskRepository(db)
    if user.role != "Admin":
        tasks = await repo.list_backlog(for_user_id=user.id)
    else:
        tasks = await repo.list_backlog(assigned_to_user_id=assigned_to_user_id)
    return await _tasks_to_out_with_unread(db, user.id, tasks)


@router.post("/{task_id}/archive", response_model=TaskOut)
async def archive_task(
        task_id: int,
        db: DBSessionDep,
        user=Depends(get_current_user),
):
    """Archive a single task (removes it from the active calendar; can be restored).

    Allowed for Admin, the assignee, or the task creator (via ``_can_manage_task``).
    We intentionally do NOT gate this on the ``update`` task permission: the Member
    global role is write-only on tasks by design, so a Member who created a task for
    someone else would otherwise be unable to archive it.
    """
    repo = TaskRepository(db)
    task = await repo.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if task.is_archived:
        raise HTTPException(status_code=400, detail="המשימה כבר נמצאת בארכיון")
    if not _can_manage_task(task, user):
        raise HTTPException(status_code=403, detail="אין לך הרשאה לארכב משימה זו")
    task.is_archived = True
    task.archived_at = datetime.now(timezone.utc).replace(tzinfo=None)
    await repo.update(task)
    updated = await repo.get(task.id)
    return _task_to_out(updated)


@router.post("/{task_id}/restore", response_model=TaskOut)
async def restore_task(
        task_id: int,
        db: DBSessionDep,
        user=Depends(require_permission("update", "task", resource_id_param="task_id", project_id_param=None)),
):
    """Restore an archived task back to active. Admin only."""
    if user.role != "Admin":
        raise HTTPException(status_code=403, detail="Only admins can restore archived tasks")
    repo = TaskRepository(db)
    task = await repo.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if not task.is_archived:
        raise HTTPException(status_code=400, detail="Task is not archived")
    task.is_archived = False
    task.archived_at = None
    await repo.update(task)
    updated = await repo.get(task.id)
    return _task_to_out(updated)


# Message previews in a collection task's history keep their original length.
COLLECTION_PREVIEW_LENGTH = 80


async def _log_collection_chat(db, task: Task, user_id: int, event: str, details: dict) -> None:
    """Record chat/file events in a COLLECTION task's history; a no-op for
    regular tasks, whose behavior (no audit entries) is unchanged."""
    if task.task_kind == TaskKind.COLLECTION:
        await AuditService(db).log_action(user_id, event, COLLECTION_AUDIT_ENTITY, str(task.id), details)


async def _get_chat_task(db, task_id: int, user) -> Task:
    """Load a task for the shared chat endpoints — regular or collection.

    Both kinds follow the same rule (``_can_access_task``): Admin, any assignee,
    or a participant; anyone else gets 403, a missing task 404. A collection
    task also requires the existing ``collection_task:read`` permission;
    regular tasks are unchanged.
    """
    repo = TaskRepository(db)
    task = await repo.get(task_id) or await repo.get(task_id, kind=TaskKind.COLLECTION)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if task.task_kind == TaskKind.COLLECTION and not await PermissionsEngine(db).has_permission(
        user.id, Action.READ.value, ResourceType.COLLECTION_TASK.value
    ):
        raise HTTPException(status_code=403, detail="Permission denied: read on collection_task")
    if not _can_access_task(task, user):
        raise HTTPException(status_code=403, detail="Access denied")
    return task


def _can_delete_message(message, user) -> bool:
    """True if user may delete this chat message: Admin or the message's author."""
    return user.role == "Admin" or message.user_id == user.id


def _task_recipient_ids(task: Task) -> set[int]:
    """All chat recipients of a task: every assignee plus every participant.

    Used for WhatsApp-style read receipts — a message is "read by all" when each
    of these users (except the author) has read the chat up to that message.
    """
    recipient_ids: set[int] = set()
    if getattr(task, "assigned_to_user_id", None) is not None:
        recipient_ids.add(task.assigned_to_user_id)
    for assignee in getattr(task, "assignees", None) or []:
        assignee_id = getattr(assignee, "id", None)
        if assignee_id is not None:
            recipient_ids.add(assignee_id)
    for participant in getattr(task, "participants", None) or []:
        participant_id = getattr(participant, "user_id", None)
        if participant_id is not None:
            recipient_ids.add(participant_id)
    return recipient_ids


async def _mark_task_chat_read(db, task_id: int, user_id: int) -> None:
    """Upsert the user's ``last_read_at`` for a task's chat to now.

    Records that ``user_id`` has read the task chat up to this moment, which is
    what other members' messages check against to flip to the read (✓✓) state.

    Update-first, then insert: the insert is guarded by a SAVEPOINT so that a
    concurrent first read of the same (task, user) — two tabs/devices racing
    before any row exists — hits the unique constraint on the loser, rolls back
    only the savepoint (not the whole request), and falls back to an update
    instead of surfacing an IntegrityError as a 500.
    """
    now = datetime.now(timezone.utc).replace(tzinfo=None)

    async def _touch() -> int:
        result = await db.execute(
            update(TaskMessageRead)
            .where(
                TaskMessageRead.task_id == task_id,
                TaskMessageRead.user_id == user_id,
            )
            .values(last_read_at=now)
        )
        return result.rowcount or 0

    if await _touch() > 0:
        return
    try:
        async with db.begin_nested():
            db.add(TaskMessageRead(task_id=task_id, user_id=user_id, last_read_at=now))
            await db.flush()
    except IntegrityError:
        # A concurrent request inserted the row first; just update it.
        await _touch()


async def _unread_message_counts(
    db, user_id: int, task_ids: list[int]
) -> dict[int, int]:
    """Return ``{task_id: unread_count}`` for the given tasks and user.

    A message counts as unread when it was authored by someone else and was
    created after this user's ``last_read_at`` for the task (or the user has
    never opened the chat). Single grouped query; empty input short-circuits.
    """
    if not task_ids:
        return {}
    read = TaskMessageRead
    result = await db.execute(
        select(TaskMessage.task_id, func.count(TaskMessage.id))
        .outerjoin(
            read,
            (read.task_id == TaskMessage.task_id) & (read.user_id == user_id),
        )
        .where(
            TaskMessage.task_id.in_(task_ids),
            TaskMessage.user_id != user_id,
            or_(read.last_read_at.is_(None), TaskMessage.created_at > read.last_read_at),
        )
        .group_by(TaskMessage.task_id)
    )
    return {task_id: count for task_id, count in result.all()}


async def _recipient_last_read_map(db, task_id: int) -> dict[int, datetime]:
    """Return ``{user_id: last_read_at}`` for everyone who has read a task's chat."""
    result = await db.execute(
        select(TaskMessageRead.user_id, TaskMessageRead.last_read_at).where(
            TaskMessageRead.task_id == task_id
        )
    )
    return {user_id: last_read_at for user_id, last_read_at in result.all()}


def _is_message_read_by_all(
    msg: TaskMessage, recipient_ids: set[int], last_read_map: dict[int, datetime]
) -> bool:
    """True if every recipient other than the author has read up to this message."""
    others = recipient_ids - {msg.user_id}
    if not others:
        return False
    return all(
        others_last_read is not None and others_last_read >= msg.created_at
        for others_last_read in (last_read_map.get(other_id) for other_id in others)
    )



@router.get("/{task_id}/messages", response_model=list[TaskMessageOut])
async def list_task_messages(
        task_id: int,
        db: DBSessionDep,
        user=Depends(get_current_user),
):
    """List chat messages for a task. Only assignee, participants, or Admin can see."""
    task = await _get_chat_task(db, task_id, user)
    result = await db.execute(
        select(TaskMessage)
        .options(selectinload(TaskMessage.user), selectinload(TaskMessage.attachments))
        .where(TaskMessage.task_id == task_id)
        .order_by(TaskMessage.created_at)
    )
    messages_sorted = list(result.scalars().unique().all())
    # Opening the chat marks it read for this user (drives others' ✓✓); then
    # compute, per message, whether every other recipient has read up to it.
    await _mark_task_chat_read(db, task_id, user.id)
    recipient_ids = _task_recipient_ids(task)
    last_read_map = await _recipient_last_read_map(db, task_id)
    return [
        _message_to_out(
            m,
            getattr(m, "user", None),
            read_by_all=_is_message_read_by_all(m, recipient_ids, last_read_map),
        )
        for m in messages_sorted
    ]


@router.post("/{task_id}/messages", response_model=TaskMessageOut)
async def create_task_message(
        task_id: int,
        db: DBSessionDep,
        user=Depends(get_current_user),
        message: str = Form(""),
        files: list[UploadFile] = File(default=[]),
):
    """Add a chat message (optionally with file attachments) to a task.

    Sent as multipart/form-data: a ``message`` text field plus zero or more
    ``files``. A message must contain text and/or at least one file. Only the
    assignee, participants, or Admin can post.
    """
    task = await _get_chat_task(db, task_id, user)
    msg_text = (message or "").strip()
    valid_files = [f for f in (files or []) if f and f.filename]
    if not msg_text and not valid_files:
        raise HTTPException(status_code=400, detail="יש לכתוב הודעה או לצרף קובץ")
    msg = TaskMessage(task_id=task_id, user_id=user.id, message=msg_text)
    db.add(msg)
    await db.flush()
    for upload in valid_files:
        relative_path, original_name = await _save_upload_file(upload, "task_message_attachments")
        db.add(TaskMessageAttachment(message_id=msg.id, file_path=relative_path, file_name=original_name))
    await db.flush()
    await db.refresh(msg)
    await _log_collection_chat(db, task, user.id, CollectionEvent.MESSAGE_ADDED, {
        "message_id": msg.id, "preview": _build_message_preview(msg_text, COLLECTION_PREVIEW_LENGTH), "attachments": len(valid_files),
    })
    if msg_text:
        notify_text = msg_text
    elif len(valid_files) == 1:
        notify_text = "צירף קובץ"
    else:
        notify_text = f"צירף {len(valid_files)} קבצים"
    try:
        await create_task_message_notifications(db, task, user.id, notify_text)
    except Exception:
        logger.warning(f"Failed to create message notifications for task {task_id}", exc_info=True)
    return _message_to_out(msg, getattr(msg, "user", None) or user)


async def _load_message_with_attachments(db, message_id: int) -> TaskMessage | None:
    """Load a chat message with its attachments eagerly, or None if absent."""
    result = await db.execute(
        select(TaskMessage)
        .options(selectinload(TaskMessage.attachments))
        .where(TaskMessage.id == message_id)
    )
    return result.scalar_one_or_none()


@router.patch("/{task_id}/messages/{message_id}", response_model=TaskMessageOut)
async def edit_task_message(
        task_id: int,
        message_id: int,
        payload: TaskMessageUpdate,
        db: DBSessionDep,
        user=Depends(get_current_user),
):
    """Edit the text of a chat message (WhatsApp-style). Author only.

    Only the message's original author may edit it (Admins included only when the
    Admin is the author). The new text must be non-empty. ``edited_at`` is stamped
    so the UI can show a "נערך" label. Attachments are untouched.
    """
    task = await _get_chat_task(db, task_id, user)
    msg = await _load_message_with_attachments(db, message_id)
    if not msg or msg.task_id != task_id:
        raise HTTPException(status_code=404, detail="Message not found")
    if msg.user_id != user.id:
        raise HTTPException(status_code=403, detail="רק כותב ההודעה יכול לערוך אותה")
    new_text = (payload.message or "").strip()
    if not new_text:
        raise HTTPException(status_code=400, detail="לא ניתן לשמור הודעה ריקה")
    old_preview = _build_message_preview(msg.message or "", COLLECTION_PREVIEW_LENGTH)
    msg.message = new_text
    msg.edited_at = datetime.now(timezone.utc).replace(tzinfo=None)
    await db.flush()
    await _log_collection_chat(db, task, user.id, CollectionEvent.MESSAGE_EDITED, {
        "message_id": msg.id, "before": {"preview": old_preview},
        "after": {"preview": _build_message_preview(new_text, COLLECTION_PREVIEW_LENGTH)},
    })
    recipient_ids = _task_recipient_ids(task)
    last_read_map = await _recipient_last_read_map(db, task_id)
    read_by_all = _is_message_read_by_all(msg, recipient_ids, last_read_map)
    return _message_to_out(msg, user, read_by_all=read_by_all)


@router.delete("/{task_id}/messages/{message_id}", status_code=204)
async def delete_task_message(
        task_id: int,
        message_id: int,
        db: DBSessionDep,
        user=Depends(get_current_user),
):
    """Delete a whole chat message (text + all its attachments) from a task.

    The author or an Admin may delete. Cascade removes the attachment rows; the
    stored files (S3 or local) are deleted first.
    """
    task = await _get_chat_task(db, task_id, user)
    msg = await _load_message_with_attachments(db, message_id)
    if not msg or msg.task_id != task_id:
        raise HTTPException(status_code=404, detail="Message not found")
    if not _can_delete_message(msg, user):
        raise HTTPException(status_code=403, detail="Access denied")
    for att in list(msg.attachments or []):
        await _delete_stored_file(att.file_path)
    await _log_collection_chat(db, task, user.id, CollectionEvent.MESSAGE_DELETED, {
        "message_id": msg.id, "preview": _build_message_preview(msg.message or "", COLLECTION_PREVIEW_LENGTH),
        "attachments": len(msg.attachments or []),
    })
    await db.delete(msg)
    await db.flush()
    return None


@router.delete("/{task_id}/messages/{message_id}/attachments/{attachment_id}", status_code=204)
async def delete_task_message_attachment(
        task_id: int,
        message_id: int,
        attachment_id: int,
        db: DBSessionDep,
        user=Depends(get_current_user),
):
    """Delete a single attachment (voice recording or document) within a chat message.

    The author or an Admin may delete. If removing it leaves the message with no
    attachments and no text, the now-empty message is deleted too.
    """
    task = await _get_chat_task(db, task_id, user)
    msg = await _load_message_with_attachments(db, message_id)
    if not msg or msg.task_id != task_id:
        raise HTTPException(status_code=404, detail="Message not found")
    if not _can_delete_message(msg, user):
        raise HTTPException(status_code=403, detail="Access denied")
    att = next((a for a in (msg.attachments or []) if a.id == attachment_id), None)
    if not att:
        raise HTTPException(status_code=404, detail="Attachment not found")
    await _delete_stored_file(att.file_path)
    await _log_collection_chat(db, task, user.id, CollectionEvent.ATTACHMENT_DELETED, {
        "message_id": msg.id, "attachment_id": att.id, "file_name": att.file_name,
    })
    remaining = [a for a in (msg.attachments or []) if a.id != attachment_id]
    if not remaining and not (msg.message or "").strip():
        # The message would be left empty (no text, no attachments): delete the
        # whole message and let the cascade remove the attachment row, rather
        # than deleting the attachment first (which would make the cascade try
        # to re-delete an already-removed row).
        await db.delete(msg)
    else:
        await db.delete(att)
    await db.flush()
    return None


@router.get("/unread-summary", response_model=TaskUnreadSummaryOut)
async def get_unread_summary(
        db: DBSessionDep,
        user=Depends(get_current_user),
):
    """Total unread chat messages across all tasks the current user is tied to.

    Feeds the global nav badge. Counts messages authored by someone else, created
    after the user's ``last_read_at`` (or never read), on non-archived tasks where
    the user is the assignee, a co-assignee, or a participant. One aggregate query.
    """
    read = TaskMessageRead
    recipient_condition = or_(
        Task.assigned_to_user_id == user.id,
        exists().where(
            (task_assignees.c.task_id == Task.id) & (task_assignees.c.user_id == user.id)
        ),
        exists().where(
            (TaskParticipant.task_id == Task.id) & (TaskParticipant.user_id == user.id)
        ),
    )
    result = await db.execute(
        select(func.count(TaskMessage.id), func.count(distinct(TaskMessage.task_id)))
        .select_from(TaskMessage)
        .join(Task, Task.id == TaskMessage.task_id)
        .outerjoin(read, (read.task_id == TaskMessage.task_id) & (read.user_id == user.id))
        .where(
            TaskMessage.user_id != user.id,
            Task.task_kind == TaskKind.GENERAL,
            Task.is_archived.is_(False),
            or_(read.last_read_at.is_(None), TaskMessage.created_at > read.last_read_at),
            recipient_condition,
        )
    )
    total_unread, task_count = result.one()
    return TaskUnreadSummaryOut(total_unread=total_unread or 0, task_count=task_count or 0)


@router.get("/{task_id}", response_model=TaskOut)
async def get_task(
        task_id: int,
        db: DBSessionDep,
        user=Depends(get_current_user),
):
    """Get a single task by ID. Member can only get own or invited tasks."""
    repo = TaskRepository(db)
    task = await repo.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if not _can_access_task(task, user):
        raise HTTPException(status_code=403, detail="Access denied")
    # Auto-mark as viewed when assignee opens the task for the first time
    if task.assigned_to_user_id == user.id and task.assignee_viewed_at is None:
        task.assignee_viewed_at = datetime.now(timezone.utc).replace(tzinfo=None)
        await db.flush()
    # Opening the task reads its chat: clear this user's unread reply notifications
    # and advance their read-receipt so the unread-message count resets to zero.
    await NotificationRepository(db).mark_task_messages_read(user.id, task_id)
    await _mark_task_chat_read(db, task_id, user.id)
    out = _task_to_out(task)
    checklist_repo = TaskChecklistRepository(db)
    summary = await checklist_repo.get_summary(task_id)
    total = summary["total"]
    completed = summary["completed"]
    pct = round(completed / total * 100, 1) if total else 0.0
    out["checklist_summary"] = TaskChecklistSummary(total=total, completed=completed, progress_pct=pct)
    return out


@router.post("/", response_model=TaskOut)
async def create_task(
        data: TaskCreate, db: DBSessionDep, user=Depends(require_permission("write", "task", project_id_param=None))
):
    """Create a new task and generate the unique tag."""
    if not data.start_time and not data.end_time:
        pass  # no-date task is valid
    elif not data.start_time or not data.end_time:
        raise HTTPException(status_code=400, detail="Both start_time and end_time required for dated tasks")
    user_repo = UserRepository(db)
    assignee_ids = _ordered_unique_assignee_ids(
        data.assigned_to_user_id, getattr(data, "assigned_to_user_ids", None)
    )
    if not assignee_ids:
        raise HTTPException(status_code=400, detail="At least one assignee is required")
    assignee_users = await _load_active_assignees(user_repo, assignee_ids)
    primary_assignee_id = assignee_ids[0]
    start_val = _to_naive_israel_local(data.start_time) if data.start_time else data.start_time
    end_val = _to_naive_israel_local(data.end_time) if data.end_time else data.end_time
    event_type = (data.event_type if data.event_type in (EventType.MEETING, EventType.TASK) else EventType.TASK)
    recurrence = _normalize_recurrence(
        getattr(data, "recurrence_rule", None),
        getattr(data, "recurrence_interval", None),
        getattr(data, "recurrence_weekdays", None),
        getattr(data, "recurrence_monthly_mode", None),
        getattr(data, "recurrence_count", None),
    )
    # end-after-N (count) and end-by-date are mutually exclusive; count wins if both sent.
    recurrence_end_date = None if recurrence["recurrence_count"] else getattr(data, "recurrence_end_date", None)
    initial_status = data.status if data.status in TASK_STATUS_VALUES else TaskStatus.PENDING
    # Super tasks are admin-only (mirrors the update endpoint): a non-admin can
    # never create one, even by sending is_super_task=true directly.
    is_super_task = bool(getattr(data, "is_super_task", False)) and user.role == "Admin"
    task = Task(
        title=data.title,
        # The regular task API only ever creates regular tasks; the kind is never
        # taken from the client.
        task_kind=TaskKind.GENERAL,
        start_time=start_val,
        end_time=end_val,
        description=data.description,
        status=initial_status,
        event_type=event_type,
        assigned_to_user_id=primary_assignee_id,
        created_by_user_id=user.id,
        recurrence_rule=recurrence["recurrence_rule"],
        recurrence_end_date=recurrence_end_date,
        recurrence_interval=recurrence["recurrence_interval"],
        recurrence_weekdays=recurrence["recurrence_weekdays"],
        recurrence_monthly_mode=recurrence["recurrence_monthly_mode"],
        recurrence_count=recurrence["recurrence_count"],
        requires_closure_approval=getattr(data, "requires_closure_approval", False),
        is_super_task=is_super_task,
        is_backlog=getattr(data, "is_backlog", False),
        apartment_id=getattr(data, "apartment_id", None),
        building_id=getattr(data, "building_id", None),
    )
    if initial_status == TaskStatus.COMPLETED:
        task.completed_at = datetime.now(timezone.utc).replace(tzinfo=None)
    task.unique_tag = generate_unique_tag()
    task.assignees = assignee_users
    label_ids = getattr(data, "label_ids", None) or []
    if label_ids:
        label_repo = TaskLabelRepository(db)
        task.labels = await label_repo.get_by_ids(label_ids)
    repo = TaskRepository(db)
    created = await repo.create(task)
    # Participants are Outlook-style invitees, distinct from true assignees:
    # never invite anyone who is already an assignee (primary or additional).
    assignee_id_set = set(assignee_ids)
    participant_ids = getattr(data, "participant_ids", None) or []
    for uid in participant_ids:
        if uid not in assignee_id_set:
            db.add(TaskParticipant(task_id=created.id, user_id=uid, response_status=ParticipantResponse.PENDING))
    await db.flush()
    try:
        outlook_id = await create_outlook_event(db, created)
        if outlook_id:
            created.outlook_event_id = outlook_id
            await repo.update(created)
    except Exception:
        logger.warning(f"Failed to create Outlook event for task {created.id}", exc_info=True)
    # Assigning `task.assignees` on the new object leaves its `participants`
    # collection in a stale "loaded-empty" state; expire it so the re-fetch's
    # selectinload reflects the participants just written.
    db.expire(created, ["participants"])
    created = await repo.get(created.id)
    try:
        await create_task_assignment_notifications(db, created, user.id)
    except Exception:
        logger.warning(f"Failed to create notifications for task {created.id}", exc_info=True)
    return _task_to_out(created)


@router.put("/{task_id}", response_model=TaskOut)
async def update_task(
        task_id: int,
        data: TaskUpdate,
        db: DBSessionDep,
        user=Depends(get_current_user),
):
    """Update task time/date (used by drag & drop), status, or other fields.

    Editable by an Admin or any assignee of the task (the primary assignee or a
    co-assignee). We intentionally do NOT gate this on the ``update`` task
    permission: the Member global role is write-only on tasks by design, so an
    assignee who is a Member would otherwise be unable to edit a task assigned to
    them. This mirrors ``archive_task``'s access model. Participants (Outlook-style
    invitees) are not assignees and must use ``respond`` to accept/decline.
    Reassignment and the super-task flag remain admin-only (enforced below).
    """
    repo = TaskRepository(db)
    task = await repo.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if not (user.role == "Admin" or _is_task_assignee(task, user.id)):
        raise HTTPException(status_code=403,
                            detail="Access denied. Only an assignee or admin can edit. Use respond to accept/decline.")
    update_data = data.model_dump(exclude_unset=True)
    # Only admins can toggle super task flag
    if "is_super_task" in update_data and user.role != "Admin":
        update_data.pop("is_super_task", None)
    # Scheduling a backlog task (giving it a real start_time) removes it from the backlog
    if update_data.get("start_time") is not None and "is_backlog" not in update_data:
        update_data["is_backlog"] = False
    if "status" in update_data and update_data["status"] not in TASK_STATUS_VALUES:
        update_data.pop("status", None)
    # Intercept: non-admin trying to complete a task that requires closure approval
    if (
        update_data.get("status") == TaskStatus.COMPLETED
        and getattr(task, "requires_closure_approval", False)
        and user.role != "Admin"
    ):
        update_data["status"] = TaskStatus.PENDING_CLOSURE
        try:
            await create_closure_approval_notification(db, task, user.id)
        except Exception:
            logger.warning(f"Failed to create closure approval notification for task {task.id}", exc_info=True)
    if "event_type" in update_data and update_data["event_type"] not in (EventType.MEETING, EventType.TASK):
        update_data.pop("event_type", None)
    recurrence_keys = {
        "recurrence_rule", "recurrence_interval", "recurrence_weekdays",
        "recurrence_monthly_mode", "recurrence_count",
    }
    if recurrence_keys & update_data.keys():
        # Recompute the whole recurrence block from the incoming values, falling
        # back to the task's current values for any field not sent in this update.
        def _pick(field):
            return update_data[field] if field in update_data else getattr(task, field, None)
        recurrence = _normalize_recurrence(
            _pick("recurrence_rule"),
            _pick("recurrence_interval"),
            _pick("recurrence_weekdays"),
            _pick("recurrence_monthly_mode"),
            _pick("recurrence_count"),
        )
        update_data.update(recurrence)
        # count and end-date are mutually exclusive; a chosen count clears the date.
        if recurrence["recurrence_count"]:
            update_data["recurrence_end_date"] = None
    # Reassignment (scalar and/or full set) is admin-only. When
    # `assigned_to_user_ids` is sent it REPLACES the whole assignee set (its
    # first element becomes the primary; the old primary is dropped unless it is
    # listed). A scalar `assigned_to_user_id` sent alone replaces the set with
    # that single user (legacy single-assignee semantics). When both are sent,
    # the scalar is pinned first as the primary.
    new_assignee_users: list[User] | None = None
    scalar_reassign = "assigned_to_user_id" in update_data and update_data["assigned_to_user_id"]
    set_reassign = "assigned_to_user_ids" in update_data and update_data["assigned_to_user_ids"] is not None
    if scalar_reassign or set_reassign:
        if user.role != "Admin":
            # A non-admin assignee may edit the task but may NOT change who it is
            # assigned to. The edit form always re-sends the current assignees, so
            # a genuine reassignment (a set that differs from the current one) is
            # rejected, while an unchanged set is accepted and simply ignored.
            requested_ids = set(_ordered_unique_assignee_ids(
                update_data["assigned_to_user_id"] if scalar_reassign else None,
                update_data.get("assigned_to_user_ids"),
            ))
            current_ids = {task.assigned_to_user_id} | {
                getattr(a, "id", None) for a in (getattr(task, "assignees", None) or [])
            }
            current_ids.discard(None)
            if requested_ids and requested_ids != current_ids:
                raise HTTPException(status_code=403, detail="רק מנהל יכול לשנות את המשתמשים המוקצים למשימה")
            update_data.pop("assigned_to_user_id", None)  # Only Admin can reassign
            update_data.pop("assigned_to_user_ids", None)
        else:
            user_repo = UserRepository(db)
            # An explicit scalar pins the primary; otherwise the sent set is
            # authoritative and its first element becomes the primary.
            primary_candidate = update_data["assigned_to_user_id"] if scalar_reassign else None
            new_assignee_ids = _ordered_unique_assignee_ids(
                primary_candidate, update_data.get("assigned_to_user_ids"),
            )
            if not new_assignee_ids:
                raise HTTPException(status_code=400, detail="At least one assignee is required")
            new_assignee_users = await _load_active_assignees(user_repo, new_assignee_ids)
            update_data["assigned_to_user_id"] = new_assignee_ids[0]
    # `assigned_to_user_ids` is not a Task column; never setattr it directly.
    update_data.pop("assigned_to_user_ids", None)
    if "status" in update_data and update_data["status"] == TaskStatus.COMPLETED and task.completed_at is None:
        task.completed_at = datetime.now(timezone.utc).replace(tzinfo=None)
    label_ids = update_data.pop("label_ids", None)
    participant_ids = update_data.pop("participant_ids", None)
    for k, v in update_data.items():
        if k in ("start_time", "end_time") and v is not None:
            v = _to_naive_israel_local(v) or v
        setattr(task, k, v)
    if new_assignee_users is not None:
        task.assignees = new_assignee_users
    if label_ids is not None:
        label_repo = TaskLabelRepository(db)
        task.labels = await label_repo.get_by_ids(label_ids)
    if participant_ids is not None:
        # Never keep anyone who is now a true assignee (primary or additional).
        assignee_id_set = {task.assigned_to_user_id} | {
            getattr(a, "id", None) for a in (getattr(task, "assignees", None) or [])
        }
        new_set = set(participant_ids) - assignee_id_set
        existing_by_user = {p.user_id: p for p in (getattr(task, "participants", None) or [])}
        for p in list(task.participants):
            if p.user_id not in new_set:
                task.participants.remove(p)
        for uid in new_set:
            if uid not in existing_by_user:
                task.participants.append(
                    TaskParticipant(task_id=task.id, user_id=uid, response_status=ParticipantResponse.PENDING)
                )
    # Persist to DB (e.g. drag & drop new date/time)
    await repo.update(task)
    try:
        if task.outlook_event_id:
            await update_outlook_event(db, task)
        else:
            outlook_id = await create_outlook_event(db, task)
            if outlook_id:
                task.outlook_event_id = outlook_id
                await repo.update(task)
    except Exception:
        logger.warning(f"Failed to sync Outlook event for task {task.id}", exc_info=True)
    # Re-fetch with eager loading so _task_to_out can access all relationships
    # (refresh() doesn't reload selectinload relations → MissingGreenlet in async)
    updated = await repo.get(task.id)
    return _task_to_out(updated)


@router.post("/{task_id}/acknowledge", response_model=TaskOut)
async def acknowledge_task(
        task_id: int,
        db: DBSessionDep,
        user=Depends(get_current_user),
):
    """לקוח/משתמש מוקצה מאשר קבלת המשימה. רק המשתמש המוקצה יכול לאשר."""
    repo = TaskRepository(db)
    task = await repo.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if task.assigned_to_user_id != user.id:
        raise HTTPException(
            status_code=403,
            detail="רק המשתמש המוקצה למשימה יכול לאשר קבלתה",
        )
    task.assignee_acknowledged_at = datetime.now(timezone.utc).replace(tzinfo=None)
    await db.flush()
    updated = await repo.get(task_id)
    return _task_to_out(updated)


@router.post("/{task_id}/remind")
async def remind_task(
        task_id: int,
        db: DBSessionDep,
        user=Depends(get_current_user),
):
    """Send a reminder for this task to the assignee. Notification appears in הודעות. Only for users who can see the task (Admin, assignee, or participant)."""
    repo = TaskRepository(db)
    task = await repo.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if user.role != "Admin":
        if task.assigned_to_user_id != user.id:
            participants = getattr(task, "participants", None) or []
            if not any(getattr(p, "user_id", None) == user.id for p in participants):
                raise HTTPException(status_code=403, detail="Access denied")
    if not task.assigned_to_user_id:
        raise HTTPException(status_code=400, detail="למשימה אין משתמש מוקצה")
    await create_task_reminder(db, task, user.id)
    return {"message": "תזכורת נשלחה לעובד בהודעות"}


@router.post("/{task_id}/respond", response_model=TaskOut)
async def respond_to_invitation(
        task_id: int,
        db: DBSessionDep,
        response: str = Body(..., embed=True),
        user=Depends(get_current_user),
):
    """Accept or decline an event invitation (like Outlook). Only invitees can respond."""
    if response not in ("accepted", "declined"):
        raise HTTPException(status_code=400, detail="response must be 'accepted' or 'declined'")
    repo = TaskRepository(db)
    task = await repo.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    participants = getattr(task, "participants", None) or []
    my_part = next((p for p in participants if getattr(p, "user_id", None) == user.id), None)
    if not my_part:
        raise HTTPException(status_code=403, detail="You are not invited to this event.")
    my_part.response_status = response
    await db.flush()
    await db.refresh(my_part)
    updated = await repo.get(task_id)
    return _task_to_out(updated)


@router.delete("/{task_id}", status_code=204)
async def delete_task(
        task_id: int,
        db: DBSessionDep,
        user=Depends(get_current_user),
):
    """Delete a task or meeting.

    Deletable by an Admin or any assignee (primary or co-assignee), mirroring
    the ``update_task``/``archive_task`` access model. We intentionally do NOT
    gate this on the ``delete`` task permission: the Member global role is
    write-only on tasks by design, so an assignee who is a Member would otherwise
    be unable to delete a task assigned to them.
    """
    repo = TaskRepository(db)
    task = await repo.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if not (user.role == "Admin" or _is_task_assignee(task, user.id)):
        raise HTTPException(status_code=403, detail="Access denied. Only an assignee or admin can delete this task.")
    outlook_id = task.outlook_event_id
    user_id = task.assigned_to_user_id
    await repo.delete(task)
    try:
        if outlook_id:
            await delete_outlook_event(db, user_id, outlook_id)
    except Exception:
        logger.warning(f"Failed to delete Outlook event {outlook_id} for task {task_id}", exc_info=True)
    return None


@router.post("/{task_id}/attachments", response_model=TaskAttachmentOut)
async def upload_task_attachment(
        task_id: int,
        db: DBSessionDep,
        user=Depends(require_permission("write", "task", resource_id_param="task_id", project_id_param=None)),
        file: UploadFile = File(...),
):
    """Upload a file or image attachment to a task. Only task creator, assignee, or Admin can add attachments."""
    repo = TaskRepository(db)
    task = await repo.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if not _can_manage_task(task, user):
        raise HTTPException(status_code=403, detail="Access denied.")
    relative_path, original_name = await _save_upload_file(file, "task_attachments")
    attachment = TaskAttachment(
        task_id=task_id,
        file_path=relative_path,
        file_name=original_name,
    )
    db.add(attachment)
    await db.flush()
    await db.refresh(attachment)
    return TaskAttachmentOut(
        id=attachment.id,
        file_name=attachment.file_name,
        file_url=resolve_stored_file_url(relative_path),
    )


def _checklist_item_to_out(item: TaskChecklistItem) -> TaskChecklistItemOut:
    """Build a TaskChecklistItemOut from a TaskChecklistItem with loaded user relationships."""
    assigned_user = getattr(item, "assigned_user", None)
    handled_by_user = getattr(item, "handled_by_user", None)

    # Per-user color via the shared helper (same palette logic as _task_to_out).
    assigned_user_color = _user_color(assigned_user)
    handled_by_user_color = _user_color(handled_by_user)

    return TaskChecklistItemOut(
        id=item.id,
        task_id=item.task_id,
        text=item.text,
        is_completed=item.is_completed,
        sort_order=item.sort_order,
        created_at=item.created_at,
        assigned_to_user_id=item.assigned_to_user_id,
        assigned_user_name=assigned_user.full_name if assigned_user else None,
        assigned_user_avatar=getattr(assigned_user, "avatar_url", None) if assigned_user else None,
        assigned_user_color=assigned_user_color,
        handled_by_user_id=item.handled_by_user_id,
        handled_by_user_name=handled_by_user.full_name if handled_by_user else None,
        handled_by_user_avatar=getattr(handled_by_user, "avatar_url", None) if handled_by_user else None,
        handled_by_user_color=handled_by_user_color,
        handled_at=item.handled_at,
    )


@router.get("/{task_id}/checklist", response_model=list[TaskChecklistItemOut])
async def list_checklist_items(
        task_id: int,
        db: DBSessionDep,
        user=Depends(get_current_user),
):
    """List checklist items for a task, ordered by sort_order."""
    repo = TaskRepository(db)
    task = await repo.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if not _can_access_task(task, user):
        raise HTTPException(status_code=403, detail="Access denied")
    checklist_repo = TaskChecklistRepository(db)
    items = await checklist_repo.list_for_task(task_id)
    return [_checklist_item_to_out(item) for item in items]


@router.post("/{task_id}/checklist", response_model=TaskChecklistItemOut, status_code=201)
async def create_checklist_item(
        task_id: int,
        body: TaskChecklistItemCreate,
        db: DBSessionDep,
        user=Depends(get_current_user),
):
    """Add a checklist item to a task."""
    repo = TaskRepository(db)
    task = await repo.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if not _can_access_task(task, user):
        raise HTTPException(status_code=403, detail="Access denied")
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="הפריט לא יכול להיות ריק")
    checklist_repo = TaskChecklistRepository(db)
    sort_order = await checklist_repo.get_next_sort_order(task_id)
    item = TaskChecklistItem(task_id=task_id, text=text, sort_order=sort_order)
    created = await checklist_repo.create(item)
    return _checklist_item_to_out(created)


@router.patch("/{task_id}/checklist/{item_id}", response_model=TaskChecklistItemOut)
async def update_checklist_item(
        task_id: int,
        item_id: int,
        body: TaskChecklistItemUpdate,
        db: DBSessionDep,
        user=Depends(get_current_user),
):
    """Toggle is_completed, update text, or assign a user to a checklist item."""
    repo = TaskRepository(db)
    task = await repo.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if not _can_access_task(task, user):
        raise HTTPException(status_code=403, detail="Access denied")
    checklist_repo = TaskChecklistRepository(db)
    item = await checklist_repo.get_by_id(item_id)
    if not item or item.task_id != task_id:
        raise HTTPException(status_code=404, detail="Checklist item not found")
    if body.is_completed is not None:
        item.is_completed = body.is_completed
        if body.is_completed:
            item.handled_by_user_id = user.id
            item.handled_at = datetime.now(timezone.utc).replace(tzinfo=None)
        else:
            item.handled_by_user_id = None
            item.handled_at = None
    if body.text is not None:
        text = body.text.strip()
        if not text:
            raise HTTPException(status_code=400, detail="הפריט לא יכול להיות ריק")
        item.text = text
    if body.clear_assignment:
        item.assigned_to_user_id = None
    elif body.assigned_to_user_id is not None:
        user_repo = UserRepository(db)
        target_user = await user_repo.get_by_id(body.assigned_to_user_id)
        if not target_user:
            raise HTTPException(status_code=404, detail="User not found")
        item.assigned_to_user_id = body.assigned_to_user_id
    updated = await checklist_repo.update(item)
    # Re-fetch to ensure relationships are loaded after update
    refreshed = await checklist_repo.get_by_id(updated.id)
    return _checklist_item_to_out(refreshed)


@router.delete("/{task_id}/checklist/{item_id}", status_code=204)
async def delete_checklist_item(
        task_id: int,
        item_id: int,
        db: DBSessionDep,
        user=Depends(get_current_user),
):
    """Delete a checklist item from a task."""
    repo = TaskRepository(db)
    task = await repo.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if not _can_access_task(task, user):
        raise HTTPException(status_code=403, detail="Access denied")
    checklist_repo = TaskChecklistRepository(db)
    item = await checklist_repo.get_by_id(item_id)
    if not item or item.task_id != task_id:
        raise HTTPException(status_code=404, detail="Checklist item not found")
    await checklist_repo.delete(item)
    return None


@router.delete("/{task_id}/attachments/{attachment_id}", status_code=204)
async def delete_task_attachment(
        task_id: int,
        attachment_id: int,
        db: DBSessionDep,
        user=Depends(require_permission("update", "task", resource_id_param="task_id", project_id_param=None)),
):
    """Remove an attachment from a task. Only task owner or Admin."""
    repo = TaskRepository(db)
    task = await repo.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if user.role != "Admin" and task.assigned_to_user_id != user.id:
        raise HTTPException(status_code=403, detail="Access denied.")
    att = next((a for a in (task.attachments or []) if a.id == attachment_id), None)
    if not att:
        raise HTTPException(status_code=404, detail="Attachment not found")
    await _delete_stored_file(att.file_path)
    await db.delete(att)
    await db.flush()
    return None
