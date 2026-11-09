"""Legal proceedings (הליכים משפטיים).

- ``LegalProceeding``          one independent proceeding: a primary contact
                               (``contact_id``, typed by ``party_role``), the landlord
                               linked to a tenant's proceeding, the apartment number,
                               an optional project, claim details and amount.
- ``LegalProceedingStage``     one row per fixed stage (configurations/legal/stages.py);
                               status changes only by an explicit complete / skip /
                               reopen action.
- ``LegalProceedingEntry``     notes and stage-1 communication records.
- ``LegalProceedingAssignee``  operational assignment of employees. The creator is
                               the primary owner (``created_by``) and is not listed here.

Documents reuse the shared ``documents`` table (entity_type 'legal_proceeding' with
``context_key`` = "<stage>.<component>" or NULL, and 'legal_proceeding_entry' for
files attached to an entry). History lives in ``audit_logs``
(entity='legal_proceeding', entity_id = proceeding id).

Proceedings are never hard-deleted (closed instead): every FK into
``legal_proceedings`` and to ``users`` is RESTRICT. All constraints are mirrored 1:1
in backend/migrations/add_legal_proceedings.sql.
"""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import (
    CheckConstraint,
    and_,
    case,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.ext.hybrid import hybrid_property
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.configurations.legal.stages import STAGE1_KEY
from backend.db.base import Base

LEGAL_PROCEEDING_AUDIT_ENTITY = "legal_proceeding"
# documents.entity_type values owned by this module.
LEGAL_PROCEEDING_DOCUMENT_ENTITY = "legal_proceeding"
LEGAL_ENTRY_DOCUMENT_ENTITY = "legal_proceeding_entry"


class ProceedingStatus:
    OPEN = "open"
    CLOSED = "closed"


class PartyRole:
    """What the primary contact (``contact_id``) is in the proceeding."""
    TENANT = "tenant"
    LANDLORD = "landlord"
    SUPPLIER = "supplier"
    OTHER = "other"
    ALL = (TENANT, LANDLORD, SUPPLIER, OTHER)


class StageStatus:
    PENDING = "pending"
    COMPLETED = "completed"
    SKIPPED = "skipped"
    RESOLVED = (COMPLETED, SKIPPED)  # both count as done for progress


class EntryType:
    NOTE = "note"
    COMMUNICATION = "communication"
    ALL = (NOTE, COMMUNICATION)


class CommunicationChannel:
    EMAIL = "email"
    WHATSAPP = "whatsapp"
    OTHER = "other"
    ALL = (EMAIL, WHATSAPP, OTHER)


class LegalEvent:
    """``audit_logs.action`` values (entity='legal_proceeding')."""
    CREATED = "proceeding_created"
    UPDATED = "proceeding_updated"
    CLOSED = "proceeding_closed"
    REOPENED = "proceeding_reopened"
    STAGE_STATUS_CHANGED = "stage_status_changed"
    ENTRY_CREATED = "entry_created"
    ENTRY_UPDATED = "entry_updated"
    ENTRY_DELETED = "entry_deleted"
    DOCUMENT_UPLOADED = "document_uploaded"
    DOCUMENT_DELETED = "document_deleted"
    DOCUMENT_STORAGE_DELETE_FAILED = "document_storage_delete_failed"
    ASSIGNEE_ADDED = "assignee_added"
    ASSIGNEE_REMOVED = "assignee_removed"


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class LegalProceeding(Base):
    __tablename__ = "legal_proceedings"
    __table_args__ = (
        CheckConstraint("party_role IN ('tenant', 'landlord', 'supplier', 'other')", name="ck_lp_party_role"),
        CheckConstraint(
            "(party_role = 'tenant' AND landlord_contact_id IS NOT NULL)"
            " OR (party_role <> 'tenant' AND landlord_contact_id IS NULL)",
            name="ck_lp_landlord",
        ),
        CheckConstraint("trim(apartment_number) <> ''", name="ck_lp_apartment_number"),
        CheckConstraint("trim(title) <> ''", name="ck_lp_title"),
        CheckConstraint("claim_amount IS NULL OR claim_amount > 0", name="ck_lp_amount"),
        CheckConstraint("status IN ('open', 'closed')", name="ck_lp_status"),
        CheckConstraint(
            "(status = 'open' AND closed_at IS NULL AND closed_by IS NULL AND close_reason IS NULL)"
            " OR (status = 'closed' AND closed_at IS NOT NULL AND closed_by IS NOT NULL"
            " AND close_reason IS NOT NULL AND trim(close_reason) <> '')",
            name="ck_lp_closed",
        ),
        Index("ix_lp_project_status", "project_id", "status"),
        Index("ix_lp_contact_status", "contact_id", "status"),
        # Serves linked_to_landlord(): only a tenant's proceeding has a linked landlord.
        Index("ix_lp_landlord_status", "landlord_contact_id", "status",
              postgresql_where=text("party_role = 'tenant'"), sqlite_where=text("party_role = 'tenant'")),
        Index("ix_lp_created_by_status", "created_by", "status"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    contact_id: Mapped[int] = mapped_column(ForeignKey("contacts.id", ondelete="RESTRICT"), nullable=False)
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"), nullable=True)
    party_role: Mapped[str] = mapped_column(String(20), nullable=False)
    # The landlord of this tenant; only when party_role = 'tenant' (ck_lp_landlord).
    landlord_contact_id: Mapped[int | None] = mapped_column(ForeignKey("contacts.id", ondelete="RESTRICT"), nullable=True)
    apartment_number: Mapped[str] = mapped_column(String(32), nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    claim_details: Mapped[str | None] = mapped_column(Text, nullable=True)
    claim_amount: Mapped[Decimal | None] = mapped_column(Numeric(14, 2), nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default=ProceedingStatus.OPEN)
    opened_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_now)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    closed_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=True)
    close_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Primary owner of the proceeding; never changes.
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_now)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    contact: Mapped["Contact"] = relationship("Contact", foreign_keys=[contact_id], lazy="noload")
    project: Mapped["Project | None"] = relationship("Project", lazy="noload")
    created_by_user: Mapped["User"] = relationship("User", foreign_keys=[created_by], lazy="noload")
    stages: Mapped[list["LegalProceedingStage"]] = relationship(
        "LegalProceedingStage", back_populates="proceeding", lazy="noload", passive_deletes="all"
    )
    assignees: Mapped[list["LegalProceedingAssignee"]] = relationship(
        "LegalProceedingAssignee", back_populates="proceeding", lazy="noload", passive_deletes="all"
    )

    @hybrid_property
    def landlord_id(self) -> int | None:
        """The landlord linked to a tenant's proceeding; None for every other type
        (when party_role = 'landlord' the landlord is the primary contact)."""
        return self.landlord_contact_id if self.party_role == PartyRole.TENANT else None

    @landlord_id.inplace.expression
    @classmethod
    def _landlord_id_expression(cls):
        return case((cls.party_role == PartyRole.TENANT, cls.landlord_contact_id), else_=None)

    @classmethod
    def linked_to_landlord(cls, contact_id: int):
        """The one condition for filtering by linked landlord. Use this in WHERE, not
        ``landlord_id == x``: the partial index needs the explicit party_role term."""
        return and_(cls.party_role == PartyRole.TENANT, cls.landlord_contact_id == contact_id)


class LegalProceedingStage(Base):
    __tablename__ = "legal_proceeding_stages"
    __table_args__ = (
        UniqueConstraint("proceeding_id", "stage_key", name="uq_lps_proceeding_stage"),
        CheckConstraint("status IN ('pending', 'completed', 'skipped')", name="ck_lps_status"),
        CheckConstraint(
            "(status = 'pending' AND resolved_at IS NULL AND resolved_by IS NULL)"
            " OR (status IN ('completed', 'skipped') AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL)",
            name="ck_lps_resolved",
        ),
        Index("ix_lps_proceeding_status", "proceeding_id", "status"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    proceeding_id: Mapped[int] = mapped_column(
        ForeignKey("legal_proceedings.id", ondelete="RESTRICT"), nullable=False
    )
    stage_key: Mapped[str] = mapped_column(String(50), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default=StageStatus.PENDING)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    resolved_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=True)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    proceeding: Mapped["LegalProceeding"] = relationship("LegalProceeding", back_populates="stages", lazy="noload")


class LegalProceedingEntry(Base):
    __tablename__ = "legal_proceeding_entries"
    __table_args__ = (
        # The entry's stage must be a stage of the same proceeding (MATCH SIMPLE:
        # not checked when stage_key is NULL, i.e. a general entry).
        ForeignKeyConstraint(
            ["proceeding_id", "stage_key"],
            ["legal_proceeding_stages.proceeding_id", "legal_proceeding_stages.stage_key"],
            name="fk_lpe_stage",
            ondelete="RESTRICT",
        ),
        CheckConstraint("entry_type IN ('note', 'communication')", name="ck_lpe_type"),
        CheckConstraint(
            "channel IS NULL OR channel IN ('email', 'whatsapp', 'other')", name="ck_lpe_channel"
        ),
        CheckConstraint("context_key IS NULL OR stage_key IS NOT NULL", name="ck_lpe_context_needs_stage"),
        CheckConstraint("content IS NULL OR trim(content) <> ''", name="ck_lpe_content_not_blank"),
        CheckConstraint("entry_type <> 'note' OR content IS NOT NULL", name="ck_lpe_note"),
        # ``stage_key IS NOT NULL`` is required: ``NULL = 'x'`` is NULL, which a
        # CHECK treats as satisfied.
        CheckConstraint(
            "entry_type <> 'communication' OR (stage_key IS NOT NULL AND stage_key = '" + STAGE1_KEY + "'"
            " AND context_key IS NULL"
            " AND channel IS NOT NULL AND occurred_at IS NOT NULL)",
            name="ck_lpe_communication",
        ),
        Index("ix_lpe_proceeding_stage_context_id", "proceeding_id", "stage_key", "context_key", "id"),
        Index("ix_lpe_proceeding_type_occurred", "proceeding_id", "entry_type", "occurred_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    proceeding_id: Mapped[int] = mapped_column(
        ForeignKey("legal_proceedings.id", ondelete="RESTRICT"), nullable=False
    )
    entry_type: Mapped[str] = mapped_column(String(20), nullable=False)
    stage_key: Mapped[str | None] = mapped_column(String(50), nullable=True)
    # Component of the stage (configurations/legal/stages.py), when the entry is about one.
    context_key: Mapped[str | None] = mapped_column(String(50), nullable=True)
    content: Mapped[str | None] = mapped_column(Text, nullable=True)
    channel: Mapped[str | None] = mapped_column(String(20), nullable=True)
    # When it happened in reality; never derived from created_at.
    occurred_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_now)
    updated_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=True)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    created_by_user: Mapped["User"] = relationship("User", foreign_keys=[created_by_user_id], lazy="noload")
    updated_by_user: Mapped["User | None"] = relationship("User", foreign_keys=[updated_by_user_id], lazy="noload")


class LegalProceedingAssignee(Base):
    __tablename__ = "legal_proceeding_assignees"
    __table_args__ = (Index("ix_lpa_user_id", "user_id"),)

    proceeding_id: Mapped[int] = mapped_column(
        ForeignKey("legal_proceedings.id", ondelete="RESTRICT"), primary_key=True
    )
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), primary_key=True)
    assigned_by: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    assigned_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=_now)

    proceeding: Mapped["LegalProceeding"] = relationship("LegalProceeding", back_populates="assignees", lazy="noload")
    user: Mapped["User"] = relationship("User", foreign_keys=[user_id], lazy="noload")
