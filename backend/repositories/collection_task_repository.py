"""Queries for collection (גבייה) tasks.

All filtering happens in SQL. The task total is a SQL expression built from the
source rows (initial amount + adjustments, or active ledger items) through
correlated subqueries, so a list page costs a fixed number of queries no matter
how many rows it holds, and the total is never stored or computed twice.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

from sqlalchemy import Select, and_, case, distinct, exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased, noload, selectinload

from backend.models.audit_log import AuditLog
from backend.models.collection_task import (
    COLLECTION_AUDIT_ENTITY,
    CollectionAmountAdjustment,
    CollectionLedgerItem,
    CollectionTaskDetails,
    CollectionType,
)
from backend.models.project import Project
from backend.models.task import Task, TaskKind, TaskMessage, TaskMessageRead
from backend.models.user import User
from backend.repositories.task_repository import TaskRepository

ZERO = Decimal("0.00")


def _parent_project():
    """Alias for a project's parent (built lazily: aliasing at import time would
    configure the mappers before every model module is loaded)."""
    return aliased(Project, name="parent_project")


def total_amount_expr():
    """The task total, from the source rows only."""
    adjustments = (
        select(func.coalesce(func.sum(CollectionAmountAdjustment.amount), 0))
        .where(CollectionAmountAdjustment.task_id == CollectionTaskDetails.task_id)
        .correlate(CollectionTaskDetails)
        .scalar_subquery()
    )
    items = (
        select(func.coalesce(func.sum(CollectionLedgerItem.amount), 0))
        .where(
            CollectionLedgerItem.task_id == CollectionTaskDetails.task_id,
            CollectionLedgerItem.archived_at.is_(None),
        )
        .correlate(CollectionTaskDetails)
        .scalar_subquery()
    )
    return case(
        (CollectionTaskDetails.collection_type == CollectionType.SINGLE,
         CollectionTaskDetails.initial_amount + adjustments),
        else_=items,
    )


@dataclass
class CollectionFilters:
    month: date | None = None
    statuses: list[str] = field(default_factory=list)  # stored task statuses
    project_id: int | None = None
    collection_type: str | None = None
    assignee_id: int | None = None
    archived: str = "false"  # "false" | "true" | "all"
    search: str | None = None


def _money(value) -> Decimal:
    return Decimal(value if value is not None else 0).quantize(Decimal("0.01"))


class CollectionTaskRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    # ── single task ──────────────────────────────────────────────────────────

    async def get_task(self, task_id: int) -> Task | None:
        """The collection task with what access checks and output need — the
        regular screens' relationships (labels, participants, …) are skipped."""
        result = await self.db.execute(
            select(Task)
            .options(
                selectinload(Task.assignees),
                selectinload(Task.attachments),
                noload(Task.participants),
                noload(Task.labels),
                noload(Task.apartment),
                noload(Task.created_by_user),
                noload(Task.assigned_user),
            )
            .where(Task.id == task_id, Task.task_kind == TaskKind.COLLECTION)
        )
        return result.unique().scalar_one_or_none()

    async def get_details(self, task_id: int, *, for_update: bool = False) -> CollectionTaskDetails | None:
        """``for_update`` row-locks the details row: every amount / item change
        takes this lock first, serializing concurrent financial writes per task."""
        q = select(CollectionTaskDetails).where(CollectionTaskDetails.task_id == task_id)
        if for_update:
            q = q.with_for_update()
        return (await self.db.execute(q)).scalar_one_or_none()

    async def get_project_brief(self, project_id: int) -> tuple[Project, str | None] | None:
        ParentProject = _parent_project()
        row = (await self.db.execute(
            select(Project, ParentProject.name)
            .outerjoin(ParentProject, ParentProject.id == Project.relation_project)
            .where(Project.id == project_id)
        )).first()
        return (row[0], row[1]) if row else None

    async def get_active_project(self, project_id: int) -> Project | None:
        return (await self.db.execute(
            select(Project).where(Project.id == project_id, Project.is_active == True)  # noqa: E712
        )).scalar_one_or_none()

    async def total_for(self, task_id: int) -> Decimal:
        value = (await self.db.execute(
            select(total_amount_expr()).where(CollectionTaskDetails.task_id == task_id)
        )).scalar_one_or_none()
        return _money(value)

    async def list_adjustments(self, task_id: int) -> list[CollectionAmountAdjustment]:
        result = await self.db.execute(
            select(CollectionAmountAdjustment)
            .options(selectinload(CollectionAmountAdjustment.created_by_user))
            .where(CollectionAmountAdjustment.task_id == task_id)
            .order_by(CollectionAmountAdjustment.created_at, CollectionAmountAdjustment.id)
        )
        return list(result.scalars().all())

    async def list_ledger_items(self, task_id: int, *, include_archived: bool = False) -> list[CollectionLedgerItem]:
        q = select(CollectionLedgerItem).where(CollectionLedgerItem.task_id == task_id)
        if not include_archived:
            q = q.where(CollectionLedgerItem.archived_at.is_(None))
        q = q.order_by(CollectionLedgerItem.sort_order, CollectionLedgerItem.id)
        return list((await self.db.execute(q)).scalars().all())

    async def get_ledger_item(self, task_id: int, item_id: int) -> CollectionLedgerItem | None:
        return (await self.db.execute(
            select(CollectionLedgerItem).where(
                CollectionLedgerItem.id == item_id, CollectionLedgerItem.task_id == task_id
            )
        )).scalar_one_or_none()

    async def next_sort_order(self, task_id: int) -> int:
        value = (await self.db.execute(
            select(func.max(CollectionLedgerItem.sort_order)).where(CollectionLedgerItem.task_id == task_id)
        )).scalar_one_or_none()
        return 0 if value is None else value + 1

    # ── lists ────────────────────────────────────────────────────────────────

    def _filtered(self, columns, filters: CollectionFilters, user) -> Select:
        q = (
            select(*columns)
            .select_from(Task)
            .join(CollectionTaskDetails, CollectionTaskDetails.task_id == Task.id)
            .where(Task.task_kind == TaskKind.COLLECTION)
        )
        # Same visibility as the regular task lists: Admin sees all; anyone else
        # sees tasks they are assigned to (or invited to).
        if user.role != "Admin":
            q = q.where(TaskRepository._visible_to_user_clause(user.id))
        if filters.month is not None:
            q = q.where(CollectionTaskDetails.billing_month == filters.month)
        if filters.archived == "false":
            q = q.where(Task.is_archived == False)  # noqa: E712
        elif filters.archived == "true":
            q = q.where(Task.is_archived == True)  # noqa: E712
        if filters.statuses:
            q = q.where(Task.status.in_(filters.statuses))
        if filters.project_id is not None:
            q = q.where(CollectionTaskDetails.project_id == filters.project_id)
        if filters.collection_type:
            q = q.where(CollectionTaskDetails.collection_type == filters.collection_type)
        if filters.assignee_id is not None:
            q = q.where(TaskRepository._visible_to_user_clause(filters.assignee_id))
        if filters.search:
            q = q.where(Task.title.ilike(f"%{filters.search.strip()}%"))
        return q

    async def list_page(
        self, filters: CollectionFilters, user, *, page: int, page_size: int
    ) -> tuple[list[tuple[Task, CollectionTaskDetails, Project, str | None, Decimal]], int]:
        ParentProject = _parent_project()
        total_expr = total_amount_expr().label("total_amount")
        q = (
            self._filtered(
                [Task, CollectionTaskDetails, Project, ParentProject.name, total_expr], filters, user
            )
            .join(Project, Project.id == CollectionTaskDetails.project_id)
            .outerjoin(ParentProject, ParentProject.id == Project.relation_project)
            .options(
                selectinload(Task.assignees),
                noload(Task.participants),
                noload(Task.labels),
                noload(Task.apartment),
                noload(Task.created_by_user),
                noload(Task.assigned_user),
            )
            .order_by(CollectionTaskDetails.billing_month.desc(), Task.id.desc())
            .limit(page_size)
            .offset((page - 1) * page_size)
        )
        rows = [
            (task, details, project, parent_name, _money(total))
            for task, details, project, parent_name, total in (await self.db.execute(q)).unique().all()
        ]
        count = (await self.db.execute(
            self._filtered([func.count(Task.id)], filters, user)
        )).scalar_one()
        return rows, count

    async def summary(self, filters: CollectionFilters, user) -> list[tuple[str, int, Decimal]]:
        """``(stored status, count, total amount)`` per status, in one grouped query."""
        totals = self._filtered(
            [Task.status.label("status"), total_amount_expr().label("total_amount")], filters, user
        ).subquery()
        result = await self.db.execute(
            select(totals.c.status, func.count(), func.coalesce(func.sum(totals.c.total_amount), 0))
            .group_by(totals.c.status)
        )
        return [(status, count, _money(total)) for status, count, total in result.all()]

    async def month_counts(self, year: int, statuses: list[str], user) -> dict[date, int]:
        """Tasks per billing month of ``year`` in the given stored statuses, in
        one grouped query. Ignores the page's filters on purpose; keeps the list
        visibility rule and the list's default of leaving archived tasks out."""
        q = (
            self._filtered([CollectionTaskDetails.billing_month, func.count(Task.id)],
                           CollectionFilters(statuses=statuses), user)
            .where(CollectionTaskDetails.billing_month >= date(year, 1, 1),
                   CollectionTaskDetails.billing_month < date(year + 1, 1, 1))
            .group_by(CollectionTaskDetails.billing_month)
        )
        return {month: count for month, count in (await self.db.execute(q)).all()}

    async def unread_summary(self, user_id: int) -> tuple[int, int]:
        """Unread chat messages on non-archived collection tasks the user is
        tied to — the same recipient rule as the regular /tasks/unread-summary
        (Admins included: viewing rights alone do not count)."""
        read = TaskMessageRead
        result = await self.db.execute(
            select(func.count(TaskMessage.id), func.count(distinct(TaskMessage.task_id)))
            .select_from(TaskMessage)
            .join(Task, Task.id == TaskMessage.task_id)
            .outerjoin(read, and_(read.task_id == TaskMessage.task_id, read.user_id == user_id))
            .where(
                Task.task_kind == TaskKind.COLLECTION,
                Task.is_archived == False,  # noqa: E712
                TaskMessage.user_id != user_id,
                or_(read.last_read_at.is_(None), TaskMessage.created_at > read.last_read_at),
                TaskRepository._visible_to_user_clause(user_id),
            )
        )
        total, tasks = result.one()
        return total or 0, tasks or 0

    async def project_options(self) -> list[Project]:
        """Active projects, plus inactive parents that still have an active
        sub-project (shown only to group them; not selectable)."""
        child = aliased(Project)
        has_active_child = exists().where(child.relation_project == Project.id, child.is_active == True)  # noqa: E712
        result = await self.db.execute(
            select(Project)
            .where(or_(Project.is_active == True, has_active_child))  # noqa: E712
            .order_by(Project.name)
        )
        return list(result.scalars().all())

    async def history(self, task_id: int, *, page: int, page_size: int) -> tuple[list[tuple[AuditLog, str | None]], int]:
        where = and_(AuditLog.entity == COLLECTION_AUDIT_ENTITY, AuditLog.entity_id == str(task_id))
        rows = (await self.db.execute(
            select(AuditLog, User.full_name)
            .outerjoin(User, User.id == AuditLog.user_id)
            .where(where)
            .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
            .limit(page_size)
            .offset((page - 1) * page_size)
        )).all()
        total = (await self.db.execute(select(func.count(AuditLog.id)).where(where))).scalar_one()
        return [(log, name) for log, name in rows], total
