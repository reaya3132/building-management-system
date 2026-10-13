from __future__ import annotations
import uuid as _uuid_module
from datetime import datetime, timezone
from enum import Enum
from typing import TYPE_CHECKING
from sqlalchemy import ForeignKey, String, Boolean, DateTime
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.db.base import Base

if TYPE_CHECKING:
    from backend.models.user_notification import UserNotification


class UserRole(str, Enum):
    ADMIN = "Admin"
    MEMBER = "Member"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)    
    full_name: Mapped[str] = mapped_column(String(255))
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)  # Nullable for OAuth users
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    role: Mapped[str] = mapped_column(String(50), default=UserRole.MEMBER.value, index=True)                                                                    
    group_id: Mapped[int | None] = mapped_column(nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))
    requires_password_change: Mapped[bool] = mapped_column(Boolean, default=False)
    # OAuth fields
    oauth_provider: Mapped[str | None] = mapped_column(String(50), nullable=True, index=True)  # 'google', 'facebook', etc.
    oauth_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)  # Provider's user ID
    email_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    last_login: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    avatar_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
    # Set when the user is moved to the archive (null = not archived)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    # CEMS-specific fields (null = no CEMS access)
    cems_role: Mapped[str | None] = mapped_column(String(50), nullable=True, index=True)
    cems_warehouse_id: Mapped[_uuid_module.UUID | None] = mapped_column(
        ForeignKey("cems_warehouses.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    preferences: Mapped["UserPreference"] = relationship(
        "UserPreference", back_populates="user", uselist=False, lazy="selectin",
        cascade="all, delete-orphan"
    )

    projects: Mapped[list["Project"]] = relationship(back_populates="manager")
    tasks: Mapped[list["Task"]] = relationship(
        "Task", back_populates="assigned_user",
        foreign_keys="Task.assigned_to_user_id", lazy="selectin"
    )
    # Reverse of Task.assignees (full co-owner assignee set). `secondary` is the
    # string table name to avoid an import cycle with the task module.
    assigned_tasks: Mapped[list["Task"]] = relationship(
        "Task", secondary="task_assignees", back_populates="assignees", lazy="selectin"
    )
    task_participations: Mapped[list["TaskParticipant"]] = relationship(
        "TaskParticipant", back_populates="user", lazy="selectin"
    )
    task_messages: Mapped[list["TaskMessage"]] = relationship(
        "TaskMessage", back_populates="user", lazy="selectin"
    )
    notifications: Mapped[list["UserNotification"]] = relationship(
        "UserNotification", back_populates="user", foreign_keys="UserNotification.user_id",
        lazy="selectin"
    )