"""Repository for user notifications."""
from datetime import datetime
from sqlalchemy import select, func, update, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.models.task import Task, TaskKind
from backend.models.user_notification import UserNotification, NotificationType


def _task_kind_clause(task_kind: str):
    """Keep each module's notifications apart: the general center shows
    notifications with no task or on a regular task; collection notifications
    are shown only by the collection module."""
    in_kind = UserNotification.task_id.in_(select(Task.id).where(Task.task_kind == task_kind))
    if task_kind == TaskKind.GENERAL:
        return or_(UserNotification.task_id.is_(None), in_kind)
    return in_kind


class NotificationRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def create(self, notification: UserNotification) -> UserNotification:
        self.db.add(notification)
        await self.db.flush()
        await self.db.refresh(notification)
        return notification

    async def list_for_user(
        self,
        user_id: int,
        *,
        unread_only: bool = False,
        type_filter: str | None = None,
        limit: int = 100,
        offset: int = 0,
        task_kind: str = TaskKind.GENERAL,
    ) -> list[UserNotification]:
        q = (
            select(UserNotification)
            .options(
                selectinload(UserNotification.from_user),
                selectinload(UserNotification.task),
            )
            .where(UserNotification.user_id == user_id)
            .where(_task_kind_clause(task_kind))
        )
        if unread_only:
            q = q.where(UserNotification.read_at.is_(None))
        if type_filter:
            q = q.where(UserNotification.type == type_filter)
        q = q.order_by(UserNotification.created_at.desc()).limit(limit).offset(offset)
        result = await self.db.execute(q)
        return list(result.unique().scalars().all())

    async def find_unread_for_task(
        self, user_id: int, task_id: int, notification_type: str
    ) -> UserNotification | None:
        """Return the user's unread notification of the given type for a task, if any (for dedup)."""
        result = await self.db.execute(
            select(UserNotification)
            .where(
                UserNotification.user_id == user_id,
                UserNotification.task_id == task_id,
                UserNotification.type == notification_type,
                UserNotification.read_at.is_(None),
            )
            .order_by(UserNotification.created_at.desc())
            .limit(1)
        )
        return result.scalar_one_or_none()

    async def get_by_id(self, notification_id: int, user_id: int) -> UserNotification | None:
        result = await self.db.execute(
            select(UserNotification)
            .options(
                selectinload(UserNotification.from_user),
                selectinload(UserNotification.task),
            )
            .where(
                UserNotification.id == notification_id,
                UserNotification.user_id == user_id,
            )
        )
        return result.unique().scalar_one_or_none()

    async def count_unread(self, user_id: int, task_kind: str = TaskKind.GENERAL) -> int:
        result = await self.db.execute(
            select(func.count(UserNotification.id)).where(
                UserNotification.user_id == user_id,
                UserNotification.read_at.is_(None),
                _task_kind_clause(task_kind),
            )
        )
        return result.scalar() or 0

    async def get_task_ids_with_unread_message(
        self, user_id: int, task_ids: list[int]
    ) -> set[int]:
        """Return the subset of ``task_ids`` that have an unread TASK_MESSAGE notification for the user.

        Runs a single ``SELECT DISTINCT task_id`` filtered to the given user, the
        ``TASK_MESSAGE`` type, unread (``read_at IS NULL``) rows, and the provided
        task ids. Returns an empty set when ``task_ids`` is empty (no query issued).
        """
        if not task_ids:
            return set()
        result = await self.db.execute(
            select(UserNotification.task_id.distinct()).where(
                UserNotification.user_id == user_id,
                UserNotification.type == NotificationType.TASK_MESSAGE,
                UserNotification.read_at.is_(None),
                UserNotification.task_id.in_(task_ids),
            )
        )
        return {task_id for task_id in result.scalars().all() if task_id is not None}

    async def mark_task_messages_read(self, user_id: int, task_id: int) -> None:
        """Mark all of the user's unread TASK_MESSAGE notifications for a task as read.

        Bulk-updates ``read_at`` to the current naive-UTC timestamp (matching the
        convention used by ``mark_read``) for every unread ``TASK_MESSAGE``
        notification belonging to ``(user_id, task_id)``, then flushes.
        """
        await self.db.execute(
            update(UserNotification)
            .where(
                UserNotification.user_id == user_id,
                UserNotification.task_id == task_id,
                UserNotification.type == NotificationType.TASK_MESSAGE,
                UserNotification.read_at.is_(None),
            )
            .values(read_at=datetime.utcnow())
        )
        await self.db.flush()

    async def mark_read(self, notification: UserNotification) -> UserNotification:
        notification.read_at = datetime.utcnow()
        await self.db.flush()
        await self.db.refresh(notification)
        return notification

    async def mark_unread(self, notification: UserNotification) -> UserNotification:
        notification.read_at = None
        await self.db.flush()
        await self.db.refresh(notification)
        return notification
