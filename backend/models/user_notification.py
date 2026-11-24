"""User notification model – messages, instructions, and task reminders per user."""
from __future__ import annotations
from datetime import datetime, timezone
from sqlalchemy import Index, String, Text, DateTime, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.db.base import Base


class NotificationType:
    """Notification type: הוראה, משימה חדשה, תזכורת, כללי."""
    INSTRUCTION = "instruction"
    TASK_ASSIGNMENT = "task_assignment"
    TASK_REMINDER = "task_reminder"
    GENERAL = "general"
    TASK_MESSAGE = "task_message"  # הודעת צ'אט חדשה במשימה
    # משימה (כללית או גבייה) אורכבה ידנית. The task's kind, title, the archiving
    # user and the time are kept in title / body / created_at, so the notification
    # stays complete after the task or that user is deleted.
    TASK_ARCHIVED = "task_archived"
    # תאריך של משימה כללית שונה (כולל תזמון מה-Backlog והחזרה אליו). Like
    # TASK_ARCHIVED, title / body keep the dates, the task title and the actor's
    # name as text.
    TASK_DATE_CHANGED = "task_date_changed"


class UserNotification(Base):
    __tablename__ = "user_notifications"
    __table_args__ = (
        Index("ix_user_notifications_user_read", "user_id", "read_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    from_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    task_id: Mapped[int | None] = mapped_column(
        ForeignKey("tasks.id", ondelete="SET NULL"), nullable=True, index=True
    )
    type: Mapped[str] = mapped_column(
        String(32), default=NotificationType.GENERAL, nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    read_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))

    user: Mapped["User"] = relationship(
        "User", back_populates="notifications", foreign_keys=[user_id]
    )
    # Not loaded with the notification: a notification shows only the sender's name
    # and the task's title, and loading the whole User / Task here pulled each
    # task's assignees, participants, labels and apartment into every notification
    # list. NotificationRepository loads just those two columns (display_options);
    # an implicit load raises.
    from_user: Mapped["User | None"] = relationship(
        "User", foreign_keys=[from_user_id], lazy="raise_on_sql"
    )
    task: Mapped["Task | None"] = relationship(
        "Task", foreign_keys=[task_id], lazy="raise_on_sql"
    )


# Notification center: a user's notifications newest first (keyset paging on
# created_at, id), and the same for unread ones only. Defined after the class so
# the columns can carry DESC and the partial condition. On existing databases they
# are built by migrations/add_user_notifications_indexes_concurrently.sql.
Index(
    "ix_user_notifications_user_created",
    UserNotification.user_id, UserNotification.created_at.desc(), UserNotification.id.desc(),
)
Index(
    "ix_user_notifications_user_unread",
    UserNotification.user_id, UserNotification.created_at.desc(), UserNotification.id.desc(),
    postgresql_where=UserNotification.read_at.is_(None),
    sqlite_where=UserNotification.read_at.is_(None),
)
