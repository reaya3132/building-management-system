"""Ledger items (כרטסת): subject + amount lines of a collection task or a legal proceeding.

One table for the data only. Each module keeps its own permissions, locking, audit and
business rules in its own service; every query filters by that module's owner column, so
an item of one module is never reachable from the other. ``ck_li_one_owner`` guarantees
exactly one owner. Items are archived instead of deleted, and only active items count
towards a total, which is never stored.

``item_type`` belongs to legal proceedings (NULL on a collection item). A proceeding may
hold any number of ``base_amount`` items; they can be edited but never archived.

Constraints are mirrored 1:1 in backend/migrations/upgrade_ledger_items_and_legal_fields.sql.
"""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, Numeric, String, text
from sqlalchemy.orm import Mapped, mapped_column

from backend.db.base import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class LedgerItemType:
    """``item_type`` of a legal proceeding's item."""
    BASE_AMOUNT = "base_amount"
    ADDITION = "addition"


class LedgerItem(Base):
    __tablename__ = "ledger_items"
    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_cli_amount_positive"),
        CheckConstraint(
            "(task_id IS NOT NULL AND legal_proceeding_id IS NULL)"
            " OR (task_id IS NULL AND legal_proceeding_id IS NOT NULL)",
            name="ck_li_one_owner",
        ),
        CheckConstraint(
            "(task_id IS NOT NULL AND item_type IS NULL)"
            " OR (legal_proceeding_id IS NOT NULL AND item_type IS NOT NULL AND item_type IN ('base_amount', 'addition'))",
            name="ck_li_item_type",
        ),
        CheckConstraint(
            "item_type IS NULL OR item_type <> 'base_amount' OR archived_at IS NULL",
            name="ck_li_base_not_archived",
        ),
        Index("ix_cli_task_id", "task_id"),
        Index(
            "ix_cli_task_id_active",
            "task_id",
            postgresql_where=text("archived_at IS NULL"),
            sqlite_where=text("archived_at IS NULL"),
        ),
        Index("ix_li_legal_proceeding_id", "legal_proceeding_id"),
        Index(
            "ix_li_legal_proceeding_active",
            "legal_proceeding_id",
            postgresql_where=text("archived_at IS NULL"),
            sqlite_where=text("archived_at IS NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int | None] = mapped_column(ForeignKey("tasks.id", ondelete="RESTRICT"), nullable=True)
    legal_proceeding_id: Mapped[int | None] = mapped_column(
        ForeignKey("legal_proceedings.id", ondelete="RESTRICT"), nullable=True
    )
    item_type: Mapped[str | None] = mapped_column(String(20), nullable=True)
    subject: Mapped[str] = mapped_column(String(255), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    created_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    updated_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_utcnow, onupdate=_utcnow)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    archived_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=True)
