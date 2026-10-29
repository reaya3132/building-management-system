"""Task repository for Task Management Calendar."""
from __future__ import annotations
from datetime import datetime, date, timezone
from zoneinfo import ZoneInfo
from sqlalchemy import select, or_, and_, exists, update, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.models.task import Task, TaskKind, TaskParticipant, TaskStatus, task_assignees

# Task ``start_time`` values are stored as naive Israel local wall-clock (see the
# serializer note in ``backend/schemas/task.py``), so "has the task come due?"
# must be judged against Israel-local now — not UTC — to stay correct across the
# 2–3h offset (and DST).
ISRAEL_TZ = ZoneInfo("Asia/Jerusalem")


class TaskRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    @staticmethod
    def _general_only():
        """Restrict to regular tasks. Every query here serves the regular task
        screens, so collection (גבייה) tasks must never leak into them."""
        return Task.task_kind == TaskKind.GENERAL

    @staticmethod
    def _visible_to_user_clause(user_id: int):
        """Tasks in a user's calendar: they are an assignee (primary OR co-owner)
        OR they are an invited participant."""
        return or_(
            Task.assigned_to_user_id == user_id,
            exists()
            .where(task_assignees.c.task_id == Task.id)
            .where(task_assignees.c.user_id == user_id),
            exists().where(TaskParticipant.task_id == Task.id).where(TaskParticipant.user_id == user_id),
        )

    async def create(self, task: Task) -> Task:
        self.db.add(task)
        await self.db.flush()
        await self.db.refresh(task)
        return task

    async def list(
        self,
        assigned_to_user_id: int | None = None,
        for_user_id: int | None = None,
        start: datetime | None = None,
        end: datetime | None = None,
        include_archived: bool = False,
    ) -> list[Task]:
        q = (
            select(Task)
            .options(
                selectinload(Task.assigned_user),
                selectinload(Task.assignees),
                selectinload(Task.attachments),
                selectinload(Task.labels),
                selectinload(Task.participants).selectinload(TaskParticipant.user),
            )
            .where(self._general_only())
            .order_by(Task.start_time)
        )
        if not include_archived:
            q = q.where(Task.is_archived == False)
        if for_user_id is not None:
            # Show tasks where user is owner OR invited participant (like Outlook)
            q = q.where(self._visible_to_user_clause(for_user_id))
        elif assigned_to_user_id is not None:
            # Admin filtering by a user: owner OR invited participant, so a task the
            # user merely attends (assigned to someone else) still shows in their calendar.
            q = q.where(self._visible_to_user_clause(assigned_to_user_id))
        if start is not None and end is not None:
            q = q.where(
                or_(
                    and_(Task.start_time.is_(None), Task.end_time.is_(None)),
                    and_(Task.end_time >= start, Task.start_time <= end),
                    # Recurring series that started on/before the range end and
                    # haven't ended yet may project occurrences INTO this range,
                    # even though their stored (first) occurrence is in the past.
                    # The frontend expands the actual occurrences per range.
                    and_(
                        Task.recurrence_rule != "",
                        Task.start_time <= end,
                        or_(
                            Task.recurrence_end_date.is_(None),
                            Task.recurrence_end_date >= start.date(),
                        ),
                    ),
                )
            )
        elif start is not None:
            q = q.where(
                or_(
                    Task.start_time.is_(None),
                    Task.end_time >= start,
                    Task.recurrence_rule != "",
                )
            )
        elif end is not None:
            q = q.where(or_(Task.start_time.is_(None), Task.start_time <= end))
        result = await self.db.execute(q)
        return list(result.unique().scalars().all())

    async def list_by_apartment(self, apartment_id: int) -> list[Task]:
        """Non-archived tasks linked to a reception-desk apartment, newest first."""
        result = await self.db.execute(
            select(Task)
            .options(selectinload(Task.assigned_user))
            .where(Task.apartment_id == apartment_id)
            .where(Task.is_archived == False)  # noqa: E712
            .where(self._general_only())
            .order_by(Task.start_time.is_(None), Task.start_time)
        )
        return list(result.unique().scalars().all())

    async def list_archived_by_apartment(self, apartment_id: int) -> list[Task]:
        """Archived tasks linked to a reception-desk apartment, newest-archived first."""
        result = await self.db.execute(
            select(Task)
            .options(selectinload(Task.assigned_user))
            .where(Task.apartment_id == apartment_id)
            .where(Task.is_archived == True)  # noqa: E712
            .where(self._general_only())
            .order_by(Task.archived_at.desc())
        )
        return list(result.unique().scalars().all())

    async def count_open_by_apartment_ids(self, apartment_ids: list[int]) -> dict[int, int]:
        """Count "due" open tasks per apartment — the signal behind the reception
        grid's per-apartment task indicator.

        A task counts only when it is non-archived, non-completed AND its time has
        actually arrived: it either has no scheduled start (``start_time IS NULL``
        — immediate work with no future date to wait for) or its ``start_time`` is
        now-or-earlier. Future-dated tasks (e.g. a recurring task scheduled ahead)
        are deliberately excluded so the grid flags an apartment only once the work
        is genuinely pending, instead of lighting up every apartment the moment a
        future task is planned.

        Returns a ``{apartment_id: open_task_count}`` mapping in a single grouped
        query. Apartments with no due open tasks are simply absent from the mapping.
        """
        if not apartment_ids:
            return {}
        now_israel = datetime.now(ISRAEL_TZ).replace(tzinfo=None)
        result = await self.db.execute(
            select(Task.apartment_id, func.count(Task.id))
            .where(Task.apartment_id.in_(apartment_ids))
            .where(Task.is_archived == False)  # noqa: E712
            .where(self._general_only())
            .where(Task.status != TaskStatus.COMPLETED)
            .where(or_(Task.start_time.is_(None), Task.start_time <= now_israel))
            .group_by(Task.apartment_id)
        )
        return {apartment_id: count for apartment_id, count in result.all()}

    async def get(self, task_id: int, kind: str = TaskKind.GENERAL) -> Task | None:
        result = await self.db.execute(
            select(Task)
            .options(
                selectinload(Task.assigned_user),
                selectinload(Task.assignees),
                selectinload(Task.attachments),
                selectinload(Task.labels),
                selectinload(Task.participants).selectinload(TaskParticipant.user),
            )
            .where(Task.id == task_id)
            .where(Task.task_kind == kind)
        )
        return result.unique().scalar_one_or_none()

    async def update(self, task: Task) -> Task:
        await self.db.flush()
        await self.db.refresh(task)
        return task

    async def delete(self, task: Task) -> None:
        await self.db.delete(task)
        await self.db.flush()

    async def list_archived(
        self,
        date_from: datetime | None = None,
        date_to: datetime | None = None,
        assigned_to_user_id: int | None = None,
        for_user_id: int | None = None,
    ) -> list[Task]:
        q = (
            select(Task)
            .options(
                selectinload(Task.assigned_user),
                selectinload(Task.assignees),
                selectinload(Task.attachments),
                selectinload(Task.labels),
                selectinload(Task.participants).selectinload(TaskParticipant.user),
            )
            .where(Task.is_archived == True)
            .where(self._general_only())
            .order_by(Task.archived_at.desc())
        )
        if for_user_id is not None:
            q = q.where(self._visible_to_user_clause(for_user_id))
        elif assigned_to_user_id is not None:
            q = q.where(self._visible_to_user_clause(assigned_to_user_id))
        if date_from is not None:
            q = q.where(Task.archived_at >= date_from)
        if date_to is not None:
            q = q.where(Task.archived_at <= date_to)
        result = await self.db.execute(q)
        return list(result.unique().scalars().all())

    async def list_super_tasks(self) -> list[Task]:
        """Return non-archived, non-completed super tasks, oldest first."""
        q = (
            select(Task)
            .options(
                selectinload(Task.assigned_user),
                selectinload(Task.assignees),
                selectinload(Task.attachments),
                selectinload(Task.labels),
                selectinload(Task.participants).selectinload(TaskParticipant.user),
            )
            .where(Task.is_super_task == True)   # noqa: E712
            .where(self._general_only())
            .where(Task.is_archived == False)     # noqa: E712
            .where(Task.status != TaskStatus.COMPLETED)
            .order_by(Task.created_at.asc())
        )
        result = await self.db.execute(q)
        return list(result.unique().scalars().all())

    async def list_backlog(
        self,
        assigned_to_user_id: int | None = None,
        for_user_id: int | None = None,
    ) -> list[Task]:
        """Return backlog tasks: no-date pending tasks OR explicitly-flagged tasks.

        A task belongs in the backlog when it has no date (``start_time IS NULL``)
        and its status is ``pending`` (not yet started), OR it was explicitly
        flagged ``is_backlog == True``. Archived and completed tasks are always
        excluded. Member sees own/invited; Admin can filter by user.
        """
        q = (
            select(Task)
            .options(
                selectinload(Task.assigned_user),
                selectinload(Task.assignees),
                selectinload(Task.attachments),
                selectinload(Task.labels),
                selectinload(Task.participants).selectinload(TaskParticipant.user),
            )
            .where(
                or_(
                    Task.is_backlog == True,  # noqa: E712
                    and_(
                        Task.start_time.is_(None),
                        Task.status == TaskStatus.PENDING,
                    ),
                )
            )
            .where(Task.is_archived == False)  # noqa: E712
            .where(Task.status != TaskStatus.COMPLETED)
            .where(self._general_only())
            .order_by(Task.created_at.asc())
        )
        if for_user_id is not None:
            q = q.where(self._visible_to_user_clause(for_user_id))
        elif assigned_to_user_id is not None:
            q = q.where(self._visible_to_user_clause(assigned_to_user_id))
        result = await self.db.execute(q)
        return list(result.unique().scalars().all())

    async def archive_completed_tasks(self) -> int:
        today_midnight = datetime.combine(date.today(), datetime.min.time())
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        stmt = (
            update(Task)
            .where(
                Task.status == TaskStatus.COMPLETED,
                Task.completed_at.isnot(None),
                Task.completed_at < today_midnight,
                Task.is_archived == False,
                self._general_only(),
            )
            .values(is_archived=True, archived_at=now)
            .execution_options(synchronize_session=False)
        )
        result = await self.db.execute(stmt)
        await self.db.flush()
        return result.rowcount
