"""Project documentation boards (תיעוד הפרויקט).

One table holds every board; ``board`` scopes a note to one board of one
project ('general' = project documentation, 'fund' = fund documentation).
Notes belong to the project, not to the fund: a fund can be deleted and
recreated, and its documentation stays with the project.

Parent projects have no boards. Deleting a note removes the row; a full
snapshot is written to ``audit_logs`` (entity='project_note') first, as for
other content records (transactions, chat messages).
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.db.base import Base

PROJECT_NOTE_AUDIT_ENTITY = "project_note"


class NoteBoard:
    GENERAL = "general"
    FUND = "fund"
    ALL = (GENERAL, FUND)


class NoteEvent:
    """``audit_logs.action`` values for project notes."""
    CREATED = "created"
    UPDATED = "updated"
    DELETED = "deleted"


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class ProjectNote(Base):
    __tablename__ = "project_notes"
    __table_args__ = (
        CheckConstraint("board IN ('general', 'fund')", name="ck_project_notes_board"),
        # One board of one project, newest first: ids rise with creation time, so
        # (project_id, board, id) serves the list and its keyset pagination.
        Index("ix_project_notes_project_board_id", "project_id", "board", "id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"), nullable=False)
    board: Mapped[str] = mapped_column(String(16), nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_now)
    updated_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    # Set only when the note is edited.
    updated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    created_by_user: Mapped["User"] = relationship("User", foreign_keys=[created_by_user_id], lazy="noload")
    updated_by_user: Mapped["User | None"] = relationship("User", foreign_keys=[updated_by_user_id], lazy="noload")
