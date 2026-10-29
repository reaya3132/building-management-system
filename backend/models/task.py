"""Task model for Task Management Calendar with unique tagging logic."""
from __future__ import annotations
from datetime import date, datetime, timezone
import uuid
from sqlalchemy import String, DateTime, Date, Text, ForeignKey, Table, Column, Integer, UniqueConstraint, Boolean, CheckConstraint, Index
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.db.base import Base

# Many-to-many: tasks <-> task_labels (labels for calendar tasks)
task_task_labels = Table(
    "task_task_labels",
    Base.metadata,
    Column("task_id", Integer, ForeignKey("tasks.id", ondelete="CASCADE"), primary_key=True),
    Column("task_label_id", Integer, ForeignKey("task_labels.id", ondelete="CASCADE"), primary_key=True),
)

# Many-to-many: tasks <-> users (full co-owner assignee set). The scalar
# `Task.assigned_to_user_id` remains the *primary* assignee (always the first of
# the set); this join layers the complete assignee set on top so several users
# can co-own a single task.
task_assignees = Table(
    "task_assignees",
    Base.metadata,
    Column("task_id", Integer, ForeignKey("tasks.id", ondelete="CASCADE"), primary_key=True),
    Column("user_id", Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
)


def generate_unique_tag() -> str:
    """Generate a unique tag: timestamp (YYYYMMDDHHMMSS) + short UUID (8 chars)."""
    ts = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    short_uuid = uuid.uuid4().hex[:8]
    return f"{ts}-{short_uuid}"


class TaskStatus:
    """Task status: מחכה לטיפול, בטיפול, טופלה."""
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    PENDING_CLOSURE = "pending_closure"


class EventType:
    """Event type: פגישה (with hours) vs משימה (all-day or no date)."""
    MEETING = "meeting"
    TASK = "task"


class TaskKind:
    """Which module owns a task row. Regular task screens only ever see GENERAL;
    COLLECTION tasks (גבייה) are served exclusively by the collection module."""
    GENERAL = "general"
    COLLECTION = "collection"


class ParticipantResponse:
    """Invitation response: ממתין, מקבל, דוחה (like Outlook)."""
    PENDING = "pending"
    ACCEPTED = "accepted"
    DECLINED = "declined"


class TaskLabel(Base):
    """Label/tag for tasks in the calendar (e.g. דחוף, לקוח)."""
    __tablename__ = "task_labels"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    color: Mapped[str] = mapped_column(String(7), default="#3B82F6", nullable=False)  # hex

    tasks: Mapped[list["Task"]] = relationship(
        "Task", secondary=task_task_labels, back_populates="labels"
    )


class Task(Base):
    __tablename__ = "tasks"
    __table_args__ = (
        CheckConstraint(
            f"task_kind IN ('{TaskKind.GENERAL}', '{TaskKind.COLLECTION}')",
            name="ck_tasks_task_kind",
        ),
        # On PostgreSQL this index is built by the CONCURRENTLY migration script
        # (it cannot run inside init_db's transaction); declared here for SQLite tests.
        Index("ix_tasks_task_kind", "task_kind").ddl_if(dialect="sqlite"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    title: Mapped[str] = mapped_column(String(255), index=True)
    task_kind: Mapped[str] = mapped_column(
        String(32), default=TaskKind.GENERAL, server_default=TaskKind.GENERAL, nullable=False
    )
    start_time: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    end_time: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    description: Mapped[str | None] = mapped_column(Text, default=None)
    status: Mapped[str] = mapped_column(
        String(32), default=TaskStatus.PENDING, index=True, nullable=False
    )
    event_type: Mapped[str] = mapped_column(
        String(32), default=EventType.TASK, index=True, nullable=False
    )
    assigned_to_user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id"), nullable=False, index=True
    )
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id"), nullable=True, index=True
    )
    unique_tag: Mapped[str] = mapped_column(
        String(64), unique=True, index=True, default=generate_unique_tag
    )
    outlook_event_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    # Recurrence: rule = "" | daily | weekly | monthly | yearly. The fields below
    # refine it Outlook-style (interval, specific weekdays, monthly-by-weekday,
    # and an optional occurrence count). See `getTaskOccurrences` on the frontend.
    recurrence_rule: Mapped[str] = mapped_column(String(32), default="", nullable=False, index=True)
    recurrence_end_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    # "every N" units (1 = every day/week/month/year). >= 1.
    recurrence_interval: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    # Weekly only: comma-separated weekday numbers (0=Sunday .. 6=Saturday), e.g. "0,2,4".
    recurrence_weekdays: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # Monthly only: "day_of_month" (default) or "day_of_week" (e.g. first Monday).
    recurrence_monthly_mode: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # Optional end-after-N-occurrences (mutually exclusive with recurrence_end_date).
    recurrence_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None), onupdate=lambda: datetime.now(timezone.utc).replace(tzinfo=None)
    )
    assignee_acknowledged_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True, index=True
    )
    assignee_viewed_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True, index=True
    )
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, index=True)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    requires_closure_approval: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_super_task: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, index=True)
    is_backlog: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, index=True)
    # Building Reception Desk linkage: a task can optionally target a specific
    # apartment (and/or building) handled by the reception desk.
    apartment_id: Mapped[int | None] = mapped_column(
        ForeignKey("apartments.id"), nullable=True, index=True
    )
    building_id: Mapped[int | None] = mapped_column(
        ForeignKey("buildings.id"), nullable=True, index=True
    )

    assigned_user: Mapped["User"] = relationship(
        "User", back_populates="tasks", foreign_keys=[assigned_to_user_id], lazy="selectin"
    )
    # Full co-owner assignee set (primary + additional). The primary assignee is
    # also present here; `assigned_to_user_id` stays authoritative for the first.
    assignees: Mapped[list["User"]] = relationship(
        "User", secondary=task_assignees, back_populates="assigned_tasks", lazy="selectin"
    )
    created_by_user: Mapped["User | None"] = relationship(
        "User", foreign_keys=[created_by_user_id], lazy="selectin"
    )
    attachments: Mapped[list["TaskAttachment"]] = relationship(
        "TaskAttachment", back_populates="task", cascade="all, delete-orphan"
    )
    labels: Mapped[list["TaskLabel"]] = relationship(
        "TaskLabel", secondary=task_task_labels, back_populates="tasks", lazy="selectin"
    )
    participants: Mapped[list["TaskParticipant"]] = relationship(
        "TaskParticipant", back_populates="task", cascade="all, delete-orphan", lazy="selectin"
    )
    messages: Mapped[list["TaskMessage"]] = relationship(
        "TaskMessage", back_populates="task", cascade="all, delete-orphan", lazy="noload"
    )
    checklist_items: Mapped[list["TaskChecklistItem"]] = relationship(
        "TaskChecklistItem", back_populates="task", cascade="all, delete-orphan"
    )
    apartment: Mapped["Apartment | None"] = relationship(
        "Apartment", foreign_keys=[apartment_id], lazy="selectin"
    )


class TaskParticipant(Base):
    """Invitee to a task/meeting – can accept or decline (like Outlook)."""
    __tablename__ = "task_participants"
    __table_args__ = (UniqueConstraint("task_id", "user_id", name="uq_task_participants_task_user"),)

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    task_id: Mapped[int] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    response_status: Mapped[str] = mapped_column(
        String(32), default=ParticipantResponse.PENDING, nullable=False, index=True
    )

    task: Mapped["Task"] = relationship("Task", back_populates="participants")
    user: Mapped["User"] = relationship("User", back_populates="task_participations", lazy="selectin")


class TaskMessage(Base):
    """Chat message on a task – visible to assignee and all participants."""
    __tablename__ = "task_messages"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    task_id: Mapped[int] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    message: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))
    # Set the first time the author edits the message text (WhatsApp-style "נערך").
    edited_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    task: Mapped["Task"] = relationship("Task", back_populates="messages")
    user: Mapped["User"] = relationship("User", back_populates="task_messages", lazy="selectin")
    attachments: Mapped[list["TaskMessageAttachment"]] = relationship(
        "TaskMessageAttachment",
        back_populates="message",
        cascade="all, delete-orphan",
        lazy="selectin",
    )


class TaskMessageAttachment(Base):
    """File/image attached to a single task chat message."""
    __tablename__ = "task_message_attachments"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    message_id: Mapped[int] = mapped_column(
        ForeignKey("task_messages.id", ondelete="CASCADE"), nullable=False, index=True
    )
    file_path: Mapped[str] = mapped_column(String(512))
    file_name: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))

    message: Mapped["TaskMessage"] = relationship("TaskMessage", back_populates="attachments")


class TaskMessageRead(Base):
    """WhatsApp-style read receipt: how far a user has read a task's chat.

    One row per (task, user) holding ``last_read_at`` — the moment the user last
    opened the task chat. A message is "read by all" when every OTHER recipient
    (assignees + participants) has a ``last_read_at`` at or after its
    ``created_at``, which drives the blue double-check on the author's messages.
    """
    __tablename__ = "task_message_reads"
    __table_args__ = (
        UniqueConstraint("task_id", "user_id", name="uq_task_message_reads_task_user"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    task_id: Mapped[int] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    last_read_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None)
    )


class TaskAttachment(Base):
    """File attachment for a task - each attachment gets its own unique tag."""
    __tablename__ = "task_attachments"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    task_id: Mapped[int] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False, index=True
    )
    file_path: Mapped[str] = mapped_column(String(512))
    file_name: Mapped[str] = mapped_column(String(255))
    unique_tag: Mapped[str] = mapped_column(
        String(64), unique=True, index=True, default=generate_unique_tag
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))

    task: Mapped["Task"] = relationship("Task", back_populates="attachments")


class TaskChecklistItem(Base):
    """Individual checklist item for a task."""
    __tablename__ = "task_checklist_items"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    task_id: Mapped[int] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False, index=True
    )
    text: Mapped[str] = mapped_column(Text, nullable=False)
    is_completed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None)
    )
    assigned_to_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    handled_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    handled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    task: Mapped["Task"] = relationship("Task", back_populates="checklist_items")
    assigned_user: Mapped["User | None"] = relationship(
        "User", foreign_keys=[assigned_to_user_id], lazy="selectin"
    )
    handled_by_user: Mapped["User | None"] = relationship(
        "User", foreign_keys=[handled_by_user_id], lazy="selectin"
    )
