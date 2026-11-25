"""Business rules for collection (גבייה) tasks.

Every public method runs inside the request's session/transaction (the session
commits once at the end of the request and rolls back on any error) and never
commits itself, so a change, its audit entries and its notifications are
written together or not at all. Changes to amounts or ledger items first take a
row lock on the task's details row, serializing concurrent financial writes.

Rules (see the module spec):
- ``single``: positive, editable initial amount + adjustments (additions > 0,
  reductions < 0) whose amount and note never change. The total (initial +
  adjustments, each as its amount to pay) may be 0 but never negative; every
  change checks it under the same details-row lock.
- ``ledger``: subject/amount items, edited in place or archived — never deleted.
- VAT (services/vat.py): the initial amount and each ledger item carry their own
  "includes VAT?" choice and the VAT_RATE frozen when the amount or the choice is
  set; editing only a subject keeps them. An amount saved before VAT support
  (NULL facts) keeps them NULL until its amount changes, which then requires an
  explicit choice. Each adjustment carries its own choice too; changing it (the
  only edit an adjustment allows) freezes the rate in force then.
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
from backend.repositories.task_repository import TaskRepository
from backend.services.notification_service import create_task_archived_notifications
from backend.schemas.collection_task import (
    AdjustmentCreate,
    AdjustmentVatUpdate,
    InitialAmountUpdate,
    CollectionTaskCreate,
    CollectionTaskUpdate,
    LedgerItemCreate,
    LedgerItemUpdate,
)
from backend.services.audit_service import AuditService
from backend.services.task_access import can_access_task, can_manage_task, is_task_assignee
from backend.services.vat import current_vat_rate, vat_breakdown

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


def _vat_log(vat_included: bool | None, vat_rate: Decimal | None) -> dict:
    """The VAT facts of an amount, as written to the history."""
    return {"vat_included": vat_included, "vat_rate": str(vat_rate) if vat_rate is not None else None}


def _vat_choice_required() -> HTTPException:
    return collection_error(422, "vat_choice_required",
                            "Choose whether the amount includes VAT: it was saved before VAT support")


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

        rate = current_vat_rate()
        single = data.collection_type == CollectionType.SINGLE
        self.db.add(CollectionTaskDetails(
            task_id=task.id,
            collection_type=data.collection_type,
            project_id=data.project_id,
            billing_month=data.billing_month,
            initial_amount=data.initial_amount,
            initial_vat_included=data.initial_vat_included if single else None,
            initial_vat_rate=rate if single else None,
        ))
        for index, item in enumerate(data.items):
            self.db.add(CollectionLedgerItem(
                task_id=task.id,
                subject=item.subject,
                amount=item.amount,
                vat_included=item.vat_included,
                vat_rate=rate,
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
            **({"initial_vat": _vat_log(data.initial_vat_included, rate)} if single else {}),
            "items": [{"subject": i.subject, "amount": _money(i.amount), **_vat_log(i.vat_included, rate)}
                      for i in data.items],
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
        if archived:
            # Conditional, like the regular archive: only the request that actually
            # archives logs it and notifies; a concurrent one is a no-op as before.
            archived_at = await TaskRepository(self.db).archive_if_active(task.id, TaskKind.COLLECTION)
            if archived_at is None:
                return
            await self.db.refresh(task, ["is_archived", "archived_at"])
            await self._log(task.id, CollectionEvent.ARCHIVED)
            await create_task_archived_notifications(self.db, task, self.user, archived_at)
        else:
            task.is_archived = False
            task.archived_at = None
            await self._log(task.id, CollectionEvent.UNARCHIVED)
        await self.db.flush()

    # ── amounts ──────────────────────────────────────────────────────────────

    @staticmethod
    def _ensure_total_not_negative(total: Decimal) -> None:
        if total < 0:
            raise collection_error(422, "total_negative", "The total amount cannot be negative",
                                   total_amount=_money(total))

    async def add_adjustment(self, task_id: int, data: AdjustmentCreate) -> CollectionAmountAdjustment:
        task = await self.load_for_edit(task_id)
        await self._locked_details_for_money(task, CollectionType.SINGLE)
        rate = current_vat_rate()
        if data.amount < 0:
            # Under the details-row lock: concurrent amount changes are serialized.
            gross = vat_breakdown(data.amount, data.vat_included, rate).gross
            self._ensure_total_not_negative(await self.repo.total_for(task.id) + gross)
        adjustment = CollectionAmountAdjustment(
            task_id=task.id, amount=data.amount, note=data.note,
            vat_included=data.vat_included, vat_rate=rate, created_by_user_id=self.user.id,
        )
        self.db.add(adjustment)
        await self.db.flush()
        await self._log(task.id, CollectionEvent.ADJUSTMENT_ADDED, {
            "after": {"amount": _money(data.amount), "note": data.note, **_vat_log(data.vat_included, rate)},
            "adjustment_id": adjustment.id,
        })
        await self.db.refresh(adjustment, ["created_by_user"])
        return adjustment

    async def update_adjustment_vat(self, task_id: int, adjustment_id: int,
                                    data: AdjustmentVatUpdate) -> CollectionAmountAdjustment:
        """Change only the VAT choice of an adjustment (its amount and note never
        change); the rate in force now is frozen with it. An adjustment saved before
        VAT support gets its first choice this way."""
        task = await self.load_for_edit(task_id)
        await self._locked_details_for_money(task, CollectionType.SINGLE)
        adjustment = await self.repo.get_adjustment(task.id, adjustment_id)
        if adjustment is None:
            raise collection_error(404, "adjustment_not_found", "Adjustment not found")
        if adjustment.vat_included == data.vat_included:
            return adjustment
        old_included, old_rate = adjustment.vat_included, adjustment.vat_rate
        new_rate = current_vat_rate()
        old_gross = vat_breakdown(adjustment.amount, old_included, old_rate).gross
        new_gross = vat_breakdown(adjustment.amount, data.vat_included, new_rate).gross
        self._ensure_total_not_negative(await self.repo.total_for(task.id) - old_gross + new_gross)
        adjustment.vat_included = data.vat_included
        adjustment.vat_rate = new_rate
        await self.db.flush()
        await self._log(task.id, CollectionEvent.ADJUSTMENT_VAT_CHANGED, {
            "before": {"amount": _money(adjustment.amount), **_vat_log(old_included, old_rate)},
            "after": {"amount": _money(adjustment.amount), **_vat_log(data.vat_included, new_rate)},
            "adjustment_id": adjustment.id,
        })
        await self.db.refresh(adjustment, ["created_by_user"])
        return adjustment

    async def update_initial_amount(self, task_id: int, data: InitialAmountUpdate) -> None:
        task = await self.load_for_edit(task_id)
        details = await self._locked_details_for_money(task, CollectionType.SINGLE)
        old = details.initial_amount
        old_included, old_rate = details.initial_vat_included, details.initial_vat_rate
        amount_changed = old != data.initial_amount
        new_included = old_included if data.initial_vat_included is None else data.initial_vat_included
        if not amount_changed and new_included == old_included:
            return
        if new_included is None:  # an amount saved before VAT support: explicit choice
            raise _vat_choice_required()
        new_rate = current_vat_rate()
        # Total = initial amount to pay + adjustments (which carry no VAT).
        adjustments_sum = await self.repo.total_for(task.id) - vat_breakdown(old, old_included, old_rate).gross
        self._ensure_total_not_negative(
            vat_breakdown(data.initial_amount, new_included, new_rate).gross + adjustments_sum)
        details.initial_amount = data.initial_amount
        details.initial_vat_included = new_included
        details.initial_vat_rate = new_rate
        await self.db.flush()
        await self._log(task.id, CollectionEvent.INITIAL_AMOUNT_CHANGED, {
            "before": {"initial_amount": _money(old), **_vat_log(old_included, old_rate)},
            "after": {"initial_amount": _money(data.initial_amount), **_vat_log(new_included, new_rate)},
        })

    async def add_ledger_item(self, task_id: int, data: LedgerItemCreate) -> CollectionLedgerItem:
        task = await self.load_for_edit(task_id)
        await self._locked_details_for_money(task, CollectionType.LEDGER)
        sort_order = data.sort_order if data.sort_order is not None else await self.repo.next_sort_order(task.id)
        item = CollectionLedgerItem(
            task_id=task.id, subject=data.subject, amount=data.amount,
            vat_included=data.vat_included, vat_rate=current_vat_rate(),
            sort_order=sort_order, created_by_user_id=self.user.id,
        )
        self.db.add(item)
        await self.db.flush()
        await self._log(task.id, CollectionEvent.LEDGER_ITEM_ADDED, {
            "after": {"subject": item.subject, "amount": _money(item.amount),
                      **_vat_log(item.vat_included, item.vat_rate), "sort_order": sort_order},
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
        before = {"subject": item.subject, "amount": _money(item.amount), "vat_included": item.vat_included,
                  "sort_order": item.sort_order}
        after = {
            "subject": data.subject if "subject" in fields else item.subject,
            "amount": _money(data.amount) if "amount" in fields else before["amount"],
            "vat_included": data.vat_included if "vat_included" in fields else item.vat_included,
            "sort_order": data.sort_order if "sort_order" in fields else item.sort_order,
        }
        changed_before, changed_after = _changed(before, after)
        if not changed_after:
            return item
        if "amount" in changed_after or "vat_included" in changed_after:
            if after["vat_included"] is None:  # an item saved before VAT support: explicit choice
                raise _vat_choice_required()
            # The amount or its VAT choice changed: freeze the rate in force now. The
            # history keeps the amount and VAT facts of both sides (its amount to pay).
            new_rate = current_vat_rate()
            changed_before.update(amount=before["amount"], **_vat_log(item.vat_included, item.vat_rate))
            changed_after.update(amount=after["amount"], **_vat_log(after["vat_included"], new_rate))
            item.vat_included = after["vat_included"]
            item.vat_rate = new_rate
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
            "before": {"subject": item.subject, "amount": _money(item.amount),
                       **_vat_log(item.vat_included, item.vat_rate)}, "item_id": item.id,
        })
        await self.db.refresh(item)
        return item
