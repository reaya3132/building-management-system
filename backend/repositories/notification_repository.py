"""Repository for user notifications."""
from datetime import datetime
from sqlalchemy import (
    DateTime, String, Text, exists, insert, literal, select, func, true, tuple_, update, or_,
)
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased, joinedload, load_only, raiseload

from backend.models.task import Task, TaskKind
from backend.models.user import User
from backend.models.user_notification import UserNotification, NotificationType


def display_options():
    """What a notification shows besides its own columns: the sender's name and the
    task's title — joined in the same query, nothing else (no task assignees,
    participants or labels, no user preferences)."""
    return (
        joinedload(UserNotification.from_user).options(load_only(User.full_name), raiseload("*")),
        joinedload(UserNotification.task).options(
            load_only(Task.title, Task.task_kind, Task.is_archived), raiseload("*")),
    )


# The notification center's views.
VIEW_UNREAD, VIEW_READ, VIEW_ALL = "unread", "read", "all"


def _task_kind_clause(task_kind: str | None):
    """Keep each module's notifications apart: the general center shows
    notifications with no task or on a regular task; collection notifications
    are shown only by the collection module. ``None``: every module (the
    notification center)."""
    if task_kind is None:
        return true()
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
        view: str | None = None,
        type_filter: str | None = None,
        limit: int = 100,
        offset: int = 0,
        before: tuple[datetime, int] | None = None,
        task_kind: str | None = TaskKind.GENERAL,
    ) -> list[UserNotification]:
        """Newest first, ``created_at DESC, id DESC`` (the order of the stage-1
        indexes). ``view`` (unread / read / all) overrides ``unread_only``.
        ``before``: keyset paging — only rows strictly after that (created_at, id)."""
        view = view or (VIEW_UNREAD if unread_only else VIEW_ALL)
        q = (
            select(UserNotification)
            .options(*display_options())
            .where(UserNotification.user_id == user_id)
            .where(_task_kind_clause(task_kind))
        )
        if view == VIEW_UNREAD:
            q = q.where(UserNotification.read_at.is_(None))
        elif view == VIEW_READ:
            q = q.where(UserNotification.read_at.is_not(None))
        if type_filter:
            q = q.where(UserNotification.type == type_filter)
        if before is not None:
            q = q.where(tuple_(UserNotification.created_at, UserNotification.id) < tuple_(*before))
        q = (
            q.order_by(UserNotification.created_at.desc(), UserNotification.id.desc())
            .limit(limit)
            .offset(offset)
        )
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

    async def create_archived(
        self,
        recipient_ids: set[int],
        *,
        task_id: int,
        from_user_id: int,
        title: str,
        body: str,
        archived_at: datetime,
    ) -> None:
        """One task_archived notification per recipient, in a single INSERT ... SELECT.

        created_at is the task's archived_at as stored. NOT EXISTS skips a recipient
        who already has a task_archived notification for this archiving (same task,
        created at or after archived_at) — a second guard; the conditional archive
        UPDATE is what lets only one request get here. Users that no longer exist
        are skipped by the select from users.
        """
        if not recipient_ids:
            return
        existing = aliased(UserNotification)
        rows = (
            select(
                User.id,
                literal(from_user_id),
                literal(task_id),
                literal(NotificationType.TASK_ARCHIVED, String),
                literal(title, String),
                literal(body, Text),
                literal(archived_at, DateTime),
            )
            .where(
                User.id.in_(recipient_ids),
                ~exists().where(
                    existing.user_id == User.id,
                    existing.task_id == task_id,
                    existing.type == NotificationType.TASK_ARCHIVED,
                    existing.created_at >= archived_at,
                ),
            )
        )
        await self.db.execute(
            insert(UserNotification).from_select(
                ["user_id", "from_user_id", "task_id", "type", "title", "body", "created_at"], rows
            )
        )

    async def get_by_id(self, notification_id: int, user_id: int) -> UserNotification | None:
        result = await self.db.execute(
            select(UserNotification)
            .options(*display_options())
            .where(
                UserNotification.id == notification_id,
                UserNotification.user_id == user_id,
            )
        )
        return result.unique().scalar_one_or_none()

    async def count_unread(
        self, user_id: int, task_kind: str | None = TaskKind.GENERAL, *, cap: int | None = None
    ) -> int:
        """Unread notifications. ``cap``: count at most that many (a bounded scan of
        the partial unread index; the caller shows e.g. "999+")."""
        where = (
            UserNotification.user_id == user_id,
            UserNotification.read_at.is_(None),
            _task_kind_clause(task_kind),
        )
        if cap is None:
            result = await self.db.execute(select(func.count(UserNotification.id)).where(*where))
        else:
            capped = select(UserNotification.id).where(*where).limit(cap).subquery()
            result = await self.db.execute(select(func.count()).select_from(capped))
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

    # Only read_at is refreshed: a full refresh expires the sender / task already
    # loaded for display, which then cannot (and need not) be loaded again.
    async def mark_read(self, notification: UserNotification) -> UserNotification:
        notification.read_at = datetime.utcnow()
        await self.db.flush()
        await self.db.refresh(notification, ["read_at"])
        return notification

    async def mark_unread(self, notification: UserNotification) -> UserNotification:
        notification.read_at = None
        await self.db.flush()
        await self.db.refresh(notification, ["read_at"])
        return notification
