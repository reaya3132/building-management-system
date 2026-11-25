"""Collection (גבייה) task models.

A collection task is a regular ``tasks`` row with ``task_kind='collection'`` —
title, description, status, assignees, chat and files stay on the shared task
tables. Only the collection-specific data lives here:

- ``CollectionTaskDetails``  1:1 with the task: type, project, billing month and,
  for ``single``, the (positive, editable) initial amount with its VAT facts.
- ``CollectionAmountAdjustment``  additions (> 0) and reductions (< 0), ``single``
  only, each with its own VAT choice. The service keeps the task total >= 0.
- ``CollectionLedgerItem``  subject + amount lines (``ledger`` only), archived
  instead of deleted.

The total (the amount to pay) is never stored: ``single`` = the initial amount to
pay + SUM(adjustments), ``ledger`` = SUM(each active item's amount to pay), where
"to pay" adds VAT to an amount entered without it (services/vat.py), adjustments
included. Every FK to ``tasks`` is RESTRICT so a
task holding financial data can never be hard-deleted; change history lives in
``audit_logs`` (entity='collection_task').
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Numeric,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.db.base import Base
from backend.models.ledger_item import LedgerItem

# ILS, two decimal places, up to 9,999,999,999.99.
MONEY = Numeric(12, 2)
# A VAT rate as a fraction, e.g. 0.1800.
VAT_RATE = Numeric(5, 4)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class CollectionType:
    """שני סוגי גבייה: חד״פ (single) או כרטסת (ledger)."""
    SINGLE = "single"
    LEDGER = "ledger"


# History of collection tasks lives in the shared ``audit_logs`` table
# (``AuditService.log_action``) under this entity, ``entity_id`` = task id.
COLLECTION_AUDIT_ENTITY = "collection_task"


class CollectionEvent:
    """``audit_logs.action`` values for collection tasks."""
    CREATED = "created"
    UPDATED = "updated"
    PROJECT_CHANGED = "project_changed"
    MONTH_CHANGED = "month_changed"
    ASSIGNEES_CHANGED = "assignees_changed"
    STATUS_CHANGED = "status_changed"
    REOPENED = "reopened"
    ARCHIVED = "archived"
    UNARCHIVED = "unarchived"
    ADJUSTMENT_ADDED = "adjustment_added"
    ADJUSTMENT_VAT_CHANGED = "adjustment_vat_changed"
    INITIAL_AMOUNT_CHANGED = "initial_amount_changed"
    LEDGER_ITEM_ADDED = "ledger_item_added"
    LEDGER_ITEM_UPDATED = "ledger_item_updated"
    LEDGER_ITEM_ARCHIVED = "ledger_item_archived"
    MESSAGE_ADDED = "message_added"
    MESSAGE_EDITED = "message_edited"
    MESSAGE_DELETED = "message_deleted"
    ATTACHMENT_ADDED = "attachment_added"
    ATTACHMENT_DELETED = "attachment_deleted"


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
        # VAT of the initial amount (single only): both set or both NULL (an amount
        # saved before VAT support); a ledger task has none.
        CheckConstraint(
            "(initial_vat_included IS NULL AND initial_vat_rate IS NULL)"
            f" OR (collection_type = '{CollectionType.SINGLE}'"
            " AND initial_vat_included IS NOT NULL AND initial_vat_rate IS NOT NULL)",
            name="ck_ctd_initial_vat",
        ),
        CheckConstraint(
            "initial_vat_rate IS NULL OR (initial_vat_rate >= 0 AND initial_vat_rate < 1)",
            name="ck_ctd_initial_vat_rate",
        ),
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
    # Does initial_amount include VAT, and the rate in force when it was set
    # (frozen; see services/vat.py). NULL/NULL = saved before VAT support.
    # Adjustments never carry VAT.
    initial_vat_included: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    initial_vat_rate: Mapped[Decimal | None] = mapped_column(VAT_RATE, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=_utcnow, onupdate=_utcnow
    )

    task: Mapped["Task"] = relationship("Task", foreign_keys=[task_id])
    project: Mapped["Project"] = relationship("Project", foreign_keys=[project_id])


class CollectionAmountAdjustment(Base):
    """An addition (> 0) or reduction (< 0) to a ``single`` collection task.
    Its amount and note are never changed; only its VAT choice may be. The service
    rejects any change that would make the total negative."""
    __tablename__ = "collection_amount_adjustments"
    __table_args__ = (
        CheckConstraint("amount <> 0", name="ck_caa_amount_nonzero"),
        # VAT: both set or both NULL (an adjustment saved before VAT support).
        CheckConstraint(
            "(vat_included IS NULL AND vat_rate IS NULL) OR (vat_included IS NOT NULL AND vat_rate IS NOT NULL)",
            name="ck_caa_vat",
        ),
        CheckConstraint("vat_rate IS NULL OR (vat_rate >= 0 AND vat_rate < 1)", name="ck_caa_vat_rate"),
        Index("ix_caa_task_id", "task_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(
        ForeignKey("tasks.id", ondelete="RESTRICT"), nullable=False
    )
    amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    # Does ``amount`` include VAT, and the rate in force when that was set (frozen;
    # see services/vat.py). NULL/NULL = saved before VAT support. Mirrored in
    # backend/migrations/collection_adjustments_vat.sql.
    vat_included: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    vat_rate: Mapped[Decimal | None] = mapped_column(VAT_RATE, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by_user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_utcnow)

    created_by_user: Mapped["User"] = relationship("User", foreign_keys=[created_by_user_id])


# The shared table; the name stays for the collection code.
CollectionLedgerItem = LedgerItem
