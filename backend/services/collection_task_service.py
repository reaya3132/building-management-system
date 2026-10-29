"""Business rules for collection (גבייה) tasks.

Every public method runs inside the request's session/transaction (the session
commits once at the end of the request and rolls back on any error) and never
commits itself, so a change, its audit entries and its notifications are
written together or not at all. Changes to amounts or ledger items first take a
row lock on the task's details row, serializing concurrent financial writes.

Rules (see the module spec):
- ``single``: immutable initial amount + positive, append-only adjustments.
- ``ledger``: subject/amount items, edited in place or archived — never deleted.
- Closed tasks lock amounts and items; archived tasks accept only unarchive.

Access follows the regular tasks exactly (``services/task_access``): Admin or an
assignee views and edits; archiving also allows the creator; unarchiving and
reassigning are Admin-only. Access errors use the regular tasks' messages.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from backend.iam.engine import PermissionsEngine
from backend.iam.enums import Action, ResourceType
from backend.models.collection_task import (
    COLLECTION_AUDIT_ENTITY,
    CollectionAmountAdjustment,
    CollectionEvent,
    CollectionLedgerItem,
    CollectionTaskDetails,
    CollectionType,
)
from backend.models.task import EventType, Task, TaskKind, TaskStatus
from backend.models.user import User
from backend.models.user_notification import NotificationType, UserNotification
from backend.repositories.collection_task_repository import CollectionTaskRepository
from backend.repositories.notification_repository import NotificationRepository
from backend.schemas.collection_task import (
    AdjustmentCreate,
    CollectionTaskCreate,
    CollectionTaskUpdate,
    LedgerItemCreate,
    LedgerItemUpdate,
)
from backend.services.audit_service import AuditService
from backend.services.task_access import can_access_task, can_manage_task, is_task_assignee

# Displayed collection status <-> stored task status (regular-task meaning untouched).
STATUS_TO_STORED = {
    "open": TaskStatus.PENDING,
    "in_progress": TaskStatus.IN_PROGRESS,
    "closed": TaskStatus.COMPLETED,
}
STORED_TO_STATUS = {stored: shown for shown, stored in STATUS_TO_STORED.items()}


def collection_error(status_code: int, code: str, message: str, **extra) -> HTTPException:
    """Business-rule errors carry a stable ``code`` the client can translate.
    (Access errors use the regular tasks' plain messages instead.)"""
    return HTTPException(status_code=status_code, detail={"code": code, "message": message, **extra})


def _money(amount) -> str:
    """Amounts are logged as fixed two-decimal strings ("20.00")."""
    return f"{amount:.2f}"


def _changed(before: dict, after: dict) -> tuple[dict, dict]:
    """Only the keys whose value changed, as (before, after)."""
    keys = [k for k in after if before.get(k) != after.get(k)]
    return {k: before.get(k) for k in keys}, {k: after[k] for k in keys}


def display_status(stored: str | None) -> str:
    return STORED_TO_STATUS.get(stored or TaskStatus.PENDING, "open")


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _assignee_ids(task: Task) -> list[int]:
    """Primary assignee first, then the rest of the set in id order."""
    others = sorted(a.id for a in (task.assignees or []) if a.id != task.assigned_to_user_id)
    return [task.assigned_to_user_id, *others]


class CollectionTaskService:
    def __init__(self, db: AsyncSession, user):
        self.db = db
        self.user = user
        self.repo = CollectionTaskRepository(db)
        self.audit = AuditService(db)

    async def _log(self, task_id: int, event: str, details: dict | None = None) -> None:
        """Write a history entry in the request's transaction (shared audit_logs)."""
        await self.audit.log_action(self.user.id, event, COLLECTION_AUDIT_ENTITY, str(task_id), details)

    # ── loading & access (same rules and messages as the regular tasks) ─────

    async def get_task(self, task_id: int) -> Task:
        """Every per-task action starts here: the existing ``collection_task:read``
        permission is required (checked before the lookup, so a missing task is
        not revealed), then each caller applies the assignment rule."""
        if not await PermissionsEngine(self.db).has_permission(
            self.user.id, Action.READ.value, ResourceType.COLLECTION_TASK.value
        ):
            raise HTTPException(status_code=403, detail="Permission denied: read on collection_task")
        task = await self.repo.get_task(task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="Task not found")
        return task

    async def load_for_view(self, task_id: int) -> Task:
        task = await self.get_task(task_id)
        if not can_access_task(task, self.user):
            raise HTTPException(status_code=403, detail="Access denied")
        return task

    async def load_for_edit(self, task_id: int) -> Task:
        task = await self.get_task(task_id)
        if not (self.user.role == "Admin" or is_task_assignee(task, self.user.id)):
            raise HTTPException(status_code=403, detail="Access denied. Only an assignee or admin can edit.")
        return task

    async def load_for_manage(self, task_id: int) -> Task:
        """Admin, any assignee or the creator — like adding files to a regular task."""
        task = await self.get_task(task_id)
        if not can_manage_task(task, self.user):
            raise HTTPException(status_code=403, detail="Access denied.")
        return task

    # ── guards ───────────────────────────────────────────────────────────────

    @staticmethod
    def _ensure_not_archived(task: Task) -> None:
        if task.is_archived:
            raise collection_error(409, "task_archived", "The task is archived; unarchive it first")

    @staticmethod
    def _ensure_not_closed(task: Task) -> None:
        if task.status == TaskStatus.COMPLETED:
            raise collection_error(409, "task_closed", "Amounts and items are locked while the task is closed")

    @staticmethod
    def _ensure_type(details: CollectionTaskDetails, expected: str) -> None:
        if details.collection_type != expected:
            raise collection_error(
                409, "wrong_collection_type",
                f"This action is available only for '{expected}' collection tasks",
            )

    async def _locked_details_for_money(self, task: Task, expected_type: str) -> CollectionTaskDetails:
        self._ensure_not_archived(task)
        details = await self.repo.get_details(task.id, for_update=True)
        self._ensure_type(details, expected_type)
        self._ensure_not_closed(task)
        return details

    async def _require_active_project(self, project_id: int) -> None:
        if await self.repo.get_active_project(project_id) is None:
            raise collection_error(422, "project_not_active", "The project does not exist or is not active",
                                   project_id=project_id)

    async def _notify_assigned(self, task: Task, user_ids: list[int]) -> None:
        repo = NotificationRepository(self.db)
        for uid in dict.fromkeys(user_ids):
            if uid == self.user.id:
                continue
            await repo.create(UserNotification(
                user_id=uid,
                from_user_id=self.user.id,
                task_id=task.id,
                type=NotificationType.TASK_ASSIGNMENT,
                title=f"משימת גבייה חדשה: {task.title}",
                body=task.description or None,
            ))

    # ── create / edit ────────────────────────────────────────────────────────

    async def create(self, data: CollectionTaskCreate, assignees: list[User]) -> int:
        """``assignees`` are the active users of ``data.assignee_ids`` (primary
        first), resolved by the caller exactly as for a regular task. The
        ``collection_task:write`` permission is enforced at the endpoint."""
        await self._require_active_project(data.project_id)

        task = Task(
            title=data.title,
            description=data.description,
            task_kind=TaskKind.COLLECTION,
            status=TaskStatus.PENDING,
            event_type=EventType.TASK,
            assigned_to_user_id=assignees[0].id,
            created_by_user_id=self.user.id,
            requires_closure_approval=False,
            is_super_task=False,
            is_backlog=False,
        )
        task.assignees = assignees
        self.db.add(task)
        await self.db.flush()

        self.db.add(CollectionTaskDetails(
            task_id=task.id,
            collection_type=data.collection_type,
            project_id=data.project_id,
            billing_month=data.billing_month,
            initial_amount=data.initial_amount,
        ))
        for index, item in enumerate(data.items):
            self.db.add(CollectionLedgerItem(
                task_id=task.id,
                subject=item.subject,
                amount=item.amount,
                sort_order=item.sort_order if item.sort_order is not None else index,
                created_by_user_id=self.user.id,
            ))
        await self.db.flush()

        await self._log(task.id, CollectionEvent.CREATED, {"after": {
            "title": data.title,
            "description": data.description,
            "collection_type": data.collection_type,
            "project_id": data.project_id,
            "billing_month": data.billing_month.isoformat(),
            "assignee_ids": [u.id for u in assignees],
            "initial_amount": _money(data.initial_amount) if data.initial_amount is not None else None,
            "items": [{"subject": i.subject, "amount": _money(i.amount)} for i in data.items],
        }})
        await self._notify_assigned(task, [u.id for u in assignees])
        return task.id

    async def update(self, task_id: int, data: CollectionTaskUpdate,
                     new_assignees: list[User] | None = None) -> None:
        """``new_assignees`` are the resolved users of ``data.assignee_ids``."""
        task = await self.load_for_edit(task_id)
        self._ensure_not_archived(task)
        fields = data.model_fields_set
        if "assignee_ids" in fields and self.user.role != "Admin":
            # Same as a regular task: a non-admin may re-send the current set
            # (ignored) but may not change who the task is assigned to.
            if set(data.assignee_ids) != set(_assignee_ids(task)):
                raise HTTPException(status_code=403, detail="רק מנהל יכול לשנות את המשתמשים המוקצים למשימה")
            fields = fields - {"assignee_ids"}

        before = {"title": task.title, "description": task.description}
        after = {
            "title": data.title if "title" in fields else task.title,
            "description": data.description if "description" in fields else task.description,
        }
        changed_before, changed_after = _changed(before, after)
        if changed_after:
            task.title, task.description = after["title"], after["description"]
            await self._log(task.id, CollectionEvent.UPDATED, {"before": changed_before, "after": changed_after})

        if "project_id" in fields:
            details = await self.repo.get_details(task.id)
            if data.project_id != details.project_id:
                await self._require_active_project(data.project_id)
                old_project = details.project_id
                details.project_id = data.project_id
                await self._log(task.id, CollectionEvent.PROJECT_CHANGED, {
                    "before": {"project_id": old_project}, "after": {"project_id": data.project_id},
                })

        if "assignee_ids" in fields:
            old_ids = _assignee_ids(task)
            new_users = new_assignees
            new_ids = [u.id for u in new_users]
            if set(new_ids) != set(old_ids) or new_ids[0] != old_ids[0]:
                task.assignees = new_users
                task.assigned_to_user_id = new_ids[0]
                await self._log(task.id, CollectionEvent.ASSIGNEES_CHANGED, {
                    "before": {"assignee_ids": old_ids}, "after": {"assignee_ids": new_ids},
                })
                await self._notify_assigned(task, [uid for uid in new_ids if uid not in old_ids])
        await self.db.flush()

    async def move_month(self, task_id: int, billing_month: date, reason: str | None) -> None:
        task = await self.load_for_edit(task_id)
        self._ensure_not_archived(task)
        details = await self.repo.get_details(task.id)
        if details.billing_month == billing_month:
            return
        old_month = details.billing_month
        details.billing_month = billing_month
        await self._log(task.id, CollectionEvent.MONTH_CHANGED, {
            "before": {"billing_month": old_month.isoformat()},
            "after": {"billing_month": billing_month.isoformat()},
            "reason": reason,
        })
        await self.db.flush()

    # ── status / archive ─────────────────────────────────────────────────────

    async def set_status(self, task_id: int, status: str) -> None:
        task = await self.load_for_edit(task_id)
        target = STATUS_TO_STORED[status]
        if task.is_archived:
            if task.status == TaskStatus.COMPLETED and target != TaskStatus.COMPLETED:
                raise collection_error(409, "unarchive_first", "Unarchive the task before reopening it")
            raise collection_error(409, "task_archived", "The task is archived; unarchive it first")
        if task.status == target:
            return
        reopening = task.status == TaskStatus.COMPLETED
        old = display_status(task.status)
        task.status = target
        task.completed_at = _now() if target == TaskStatus.COMPLETED else None
        await self._log(task.id, CollectionEvent.REOPENED if reopening else CollectionEvent.STATUS_CHANGED,
                        {"before": {"status": old}, "after": {"status": status}})
        await self.db.flush()

    async def set_archived(self, task_id: int, archived: bool) -> None:
        """Archive: Admin, an assignee or the creator (regular ``archive``).
        Unarchive: Admin only (regular ``restore``; the endpoint also requires
        ``collection_task:update``)."""
        if archived:
            task = await self.get_task(task_id)
            if not can_manage_task(task, self.user):
                raise HTTPException(status_code=403, detail="אין לך הרשאה לארכב משימה זו")
        else:
            if self.user.role != "Admin":
                raise HTTPException(status_code=403, detail="Only admins can restore archived tasks")
            task = await self.get_task(task_id)
        if task.is_archived == archived:
            return
        task.is_archived = archived
        task.archived_at = _now() if archived else None
        await self._log(task.id, CollectionEvent.ARCHIVED if archived else CollectionEvent.UNARCHIVED)
        await self.db.flush()

    # ── amounts ──────────────────────────────────────────────────────────────

    async def add_adjustment(self, task_id: int, data: AdjustmentCreate) -> CollectionAmountAdjustment:
        task = await self.load_for_edit(task_id)
        await self._locked_details_for_money(task, CollectionType.SINGLE)
        adjustment = CollectionAmountAdjustment(
            task_id=task.id, amount=data.amount, note=data.note, created_by_user_id=self.user.id,
        )
        self.db.add(adjustment)
        await self.db.flush()
        await self._log(task.id, CollectionEvent.ADJUSTMENT_ADDED, {
            "after": {"amount": _money(data.amount), "note": data.note}, "adjustment_id": adjustment.id,
        })
        await self.db.refresh(adjustment, ["created_by_user"])
        return adjustment

    async def add_ledger_item(self, task_id: int, data: LedgerItemCreate) -> CollectionLedgerItem:
        task = await self.load_for_edit(task_id)
        await self._locked_details_for_money(task, CollectionType.LEDGER)
        sort_order = data.sort_order if data.sort_order is not None else await self.repo.next_sort_order(task.id)
        item = CollectionLedgerItem(
            task_id=task.id, subject=data.subject, amount=data.amount,
            sort_order=sort_order, created_by_user_id=self.user.id,
        )
        self.db.add(item)
        await self.db.flush()
        await self._log(task.id, CollectionEvent.LEDGER_ITEM_ADDED, {
            "after": {"subject": item.subject, "amount": _money(item.amount), "sort_order": sort_order},
            "item_id": item.id,
        })
        return item

    async def _active_item(self, task: Task, item_id: int) -> CollectionLedgerItem:
        item = await self.repo.get_ledger_item(task.id, item_id)
        if item is None:
            raise collection_error(404, "item_not_found", "Ledger item not found")
        if item.archived_at is not None:
            raise collection_error(409, "item_archived", "The ledger item is archived")
        return item

    async def update_ledger_item(self, task_id: int, item_id: int, data: LedgerItemUpdate) -> CollectionLedgerItem:
        task = await self.load_for_edit(task_id)
        await self._locked_details_for_money(task, CollectionType.LEDGER)
        item = await self._active_item(task, item_id)
        fields = data.model_fields_set
        before = {"subject": item.subject, "amount": _money(item.amount), "sort_order": item.sort_order}
        after = {
            "subject": data.subject if "subject" in fields else item.subject,
            "amount": _money(data.amount) if "amount" in fields else before["amount"],
            "sort_order": data.sort_order if "sort_order" in fields else item.sort_order,
        }
        changed_before, changed_after = _changed(before, after)
        if not changed_after:
            return item
        if "subject" in changed_after:
            item.subject = data.subject
        if "amount" in changed_after:
            item.amount = data.amount
        if "sort_order" in changed_after:
            item.sort_order = data.sort_order
        item.updated_by_user_id = self.user.id
        await self.db.flush()
        await self._log(task.id, CollectionEvent.LEDGER_ITEM_UPDATED, {
            "before": changed_before, "after": changed_after, "item_id": item.id,
        })
        await self.db.refresh(item)
        return item

    async def archive_ledger_item(self, task_id: int, item_id: int) -> CollectionLedgerItem:
        task = await self.load_for_edit(task_id)
        await self._locked_details_for_money(task, CollectionType.LEDGER)
        item = await self._active_item(task, item_id)
        item.archived_at = _now()
        item.archived_by_user_id = self.user.id
        await self.db.flush()
        await self._log(task.id, CollectionEvent.LEDGER_ITEM_ARCHIVED, {
            "before": {"subject": item.subject, "amount": _money(item.amount)}, "item_id": item.id,
        })
        await self.db.refresh(item)
        return item
