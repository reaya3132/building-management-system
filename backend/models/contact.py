"""Contacts (אנשי קשר): general contact card of a person or a business.

Holds contact details only; nothing domain-specific (legal, tenancy, supplier)
lives here. A contact is never hard-deleted — ``is_active`` hides it. Change
history goes to ``audit_logs`` (entity='contact').

Constraints are mirrored 1:1 in backend/migrations/add_legal_proceedings.sql.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Index, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column

from backend.db.base import Base

CONTACT_AUDIT_ENTITY = "contact"


class ContactKind:
    PERSON = "person"
    BUSINESS = "business"
    ALL = (PERSON, BUSINESS)


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Contact(Base):
    __tablename__ = "contacts"
    __table_args__ = (
        CheckConstraint("kind IN ('person', 'business')", name="ck_contacts_kind"),
        CheckConstraint("trim(name) <> ''", name="ck_contacts_name"),
        CheckConstraint("trim(phone) <> ''", name="ck_contacts_phone"),
        Index("ix_contacts_name", "name"),
        Index("ix_contacts_phone", "phone"),
        Index("ix_contacts_phone_2", "phone_2"),
        Index("ix_contacts_email", "email"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    phone: Mapped[str] = mapped_column(String(50), nullable=False)
    phone_2: Mapped[str | None] = mapped_column(String(50), nullable=True)
    address: Mapped[str | None] = mapped_column(String(500), nullable=True)
    apartment_number: Mapped[str | None] = mapped_column(String(32), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default=text("true"))
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_now)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
