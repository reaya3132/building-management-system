"""Collection (גבייה) task models.

A collection task is a regular ``tasks`` row with ``task_kind='collection'`` —
title, description, status, assignees, chat and files stay on the shared task
tables. Only the collection-specific data lives here:

- ``CollectionTaskDetails``  1:1 with the task: type, project, billing month and,
  for ``single``, the immutable initial amount.
- ``CollectionAmountAdjustment``  append-only positive additions (``single`` only).
- ``CollectionLedgerItem``  subject + amount lines (``ledger`` only), archived
  instead of deleted.

The total is never stored: ``single`` = initial_amount + SUM(adjustments),
``ledger`` = SUM(active ledger items). Every FK to ``tasks`` is RESTRICT so a
task holding financial data can never be hard-deleted; change history lives in
``audit_logs`` (entity='collection_task').
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.db.base import Base

# ILS, two decimal places, up to 9,999,999,999.99.
MONEY = Numeric(12, 2)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class CollectionType:
    """שני סוגי גבייה: חד״פ (single) או כרטסת (ledger)."""
    SINGLE = "single"
    LEDGER = "ledger"


class CollectionTaskDetails(Base):
    __tablename__ = "collection_task_details"
    __table_args__ = (
        CheckConstraint(
            f"collection_type IN ('{CollectionType.SINGLE}', '{CollectionType.LEDGER}')",
            name="ck_ctd_type",
        ),
        CheckConstraint(
            f"(collection_type = '{CollectionType.SINGLE}' AND initial_amount IS NOT NULL AND initial_amount > 0)"
            f" OR (collection_type = '{CollectionType.LEDGER}' AND initial_amount IS NULL)",
            name="ck_ctd_initial_amount",
        ),
        # PostgreSQL only (SQLite has no EXTRACT); the service normalizes the month too.
        CheckConstraint(
            "EXTRACT(DAY FROM billing_month) = 1", name="ck_ctd_month_first_day"
        ).ddl_if(dialect="postgresql"),
        Index("ix_ctd_billing_month_project_id", "billing_month", "project_id"),
        Index("ix_ctd_billing_month", "billing_month"),
        Index("ix_ctd_project_id", "project_id"),
    )

    task_id: Mapped[int] = mapped_column(
        ForeignKey("tasks.id", ondelete="RESTRICT"), primary_key=True
    )
    collection_type: Mapped[str] = mapped_column(String(16), nullable=False)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="RESTRICT"), nullable=False
    )
    # Always the first day of the billing month; independent of created/updated_at.
    billing_month: Mapped[date] = mapped_column(Date, nullable=False)
    initial_amount: Mapped[Decimal | None] = mapped_column(MONEY, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=_utcnow, onupdate=_utcnow
    )

    task: Mapped["Task"] = relationship("Task", foreign_keys=[task_id])
    project: Mapped["Project"] = relationship("Project", foreign_keys=[project_id])


class CollectionAmountAdjustment(Base):
    """A positive addition to a ``single`` collection task. Append-only."""
    __tablename__ = "collection_amount_adjustments"
    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_caa_amount_positive"),
        Index("ix_caa_task_id", "task_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(
        ForeignKey("tasks.id", ondelete="RESTRICT"), nullable=False
    )
    amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by_user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_utcnow)

    created_by_user: Mapped["User"] = relationship("User", foreign_keys=[created_by_user_id])


class CollectionLedgerItem(Base):
    """A subject + amount line of a ``ledger`` collection task.

    Items are archived (``archived_at``) rather than deleted, so the financial
    history is never lost; only active items count towards the total.
    """
    __tablename__ = "collection_ledger_items"
    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_cli_amount_positive"),
        Index("ix_cli_task_id", "task_id"),
        Index(
            "ix_cli_task_id_active",
            "task_id",
            postgresql_where=text("archived_at IS NULL"),
            sqlite_where=text("archived_at IS NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(
        ForeignKey("tasks.id", ondelete="RESTRICT"), nullable=False
    )
    subject: Mapped[str] = mapped_column(String(255), nullable=False)
    amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    created_by_user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    updated_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=_utcnow, onupdate=_utcnow
    )
    archived_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    archived_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=True
    )
