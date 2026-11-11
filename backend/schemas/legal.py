"""Schemas of the legal proceedings module (/api/v1/legal).

Request models only check shape (types, lengths, known fields); every business
rule (allowed values, required combinations, permissions) is enforced by the
services, which answer ``{"detail": {"code", "message", ...}}`` on a rule error.
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, EmailStr, Field, field_serializer, model_validator

from backend.schemas.task import to_utc_z

PartyRoleLiteral = Literal["tenant", "landlord", "supplier", "other"]
ContactKindLiteral = Literal["person", "business"]
StageStatusLiteral = Literal["pending", "completed", "skipped"]
EntryTypeLiteral = Literal["note", "communication"]
ChannelLiteral = Literal["email", "whatsapp", "other"]


def _blank_to_none(value: Any) -> Any:
    return (value.strip() or None) if isinstance(value, str) else value


# Optional; blank means "no email" (as before); anything else must be a valid address.
ContactEmail = Annotated[EmailStr | None, BeforeValidator(_blank_to_none)]


class _Out(BaseModel):
    """Datetimes as UTC ISO-8601 with 'Z' (same as the other modules)."""

    @field_serializer("*", when_used="json-unless-none")
    def _dates(self, value):
        return to_utc_z(value) if isinstance(value, datetime) else value


class _In(BaseModel):
    model_config = ConfigDict(extra="forbid")


class UserRef(_Out):
    id: int
    full_name: str
    avatar_url: str | None = None


# ── contacts ─────────────────────────────────────────────────────────────────

class ContactCreate(_In):
    confirm_duplicate: bool = False     # create although a phone is already on another contact
    kind: ContactKindLiteral
    name: str = Field(max_length=255)
    email: ContactEmail = None
    phone: str = Field(max_length=50)
    phone_2: str | None = Field(None, max_length=50)
    address: str | None = Field(None, max_length=500)
    apartment_number: str | None = Field(None, max_length=32)
    notes: str | None = None


class ContactUpdate(_In):
    confirm_duplicate: bool = False     # save although a new phone is already on another contact
    kind: ContactKindLiteral | None = None
    name: str | None = Field(None, max_length=255)
    email: ContactEmail = None
    phone: str | None = Field(None, max_length=50)
    phone_2: str | None = Field(None, max_length=50)
    address: str | None = Field(None, max_length=500)
    apartment_number: str | None = Field(None, max_length=32)
    notes: str | None = None
    is_active: bool | None = None

    @model_validator(mode="after")
    def _not_empty(self):
        if not self.model_fields_set:
            raise ValueError("at least one field must be provided")
        return self


class DuplicateCheck(_In):
    phone: str = Field(max_length=50)
    phone_2: str | None = Field(None, max_length=50)
    exclude_id: int | None = None


class DuplicateResult(_Out):
    has_match: bool


class ContactSummary(_Out):
    """A contact as seen when selecting it or on a proceeding: no internal fields."""
    id: int
    name: str
    phone: str
    phone_2: str | None = None
    email: str | None = None
    address: str | None = None
    apartment_number: str | None = None


class ContactOut(_Out):
    id: int
    kind: ContactKindLiteral
    name: str
    email: str | None = None
    phone: str | None = None
    phone_2: str | None = None
    address: str | None = None
    apartment_number: str | None = None
    notes: str | None = None
    is_active: bool
    created_at: datetime
    updated_at: datetime | None = None


class ContactCreated(_Out):
    contact: ContactOut
    has_match: bool             # general warning: a phone is already on another contact


# ── proceedings ──────────────────────────────────────────────────────────────

class Progress(_Out):
    resolved: int
    total: int
    percent: int
    next_stage_key: str | None = None


class Ref(_Out):
    id: int
    name: str | None = None


class ProjectOptionOut(_Out):
    id: int
    name: str
    parent_name: str | None = None


class ProceedingListItem(_Out):
    id: int
    title: str
    status: Literal["open", "closed"]
    party_role: PartyRoleLiteral
    apartment_number: str | None = None    # of the primary contact
    total_amount: Decimal
    contact: Ref
    linked_landlord: Ref | None = None   # only in a tenant's proceeding
    project: Ref | None = None
    created_by: Ref
    opened_at: datetime
    closed_at: datetime | None = None
    progress: Progress
    assignee_ids: list[int]


class ProceedingPage(_Out):
    items: list[ProceedingListItem]
    total: int
    page: int
    page_size: int


class ContactDetails(_In):
    """A new card created while opening a proceeding (required fields depend on the role)."""
    kind: ContactKindLiteral | None = None
    name: str | None = Field(None, max_length=255)
    email: ContactEmail = None
    phone: str | None = Field(None, max_length=50)
    phone_2: str | None = Field(None, max_length=50)
    address: str | None = Field(None, max_length=500)
    apartment_number: str | None = Field(None, max_length=32)
    notes: str | None = None


class ContactCompletion(_In):
    """Values for fields that are empty on an existing card. Never overwrites."""
    phone: str | None = Field(None, max_length=50)
    phone_2: str | None = Field(None, max_length=50)
    email: ContactEmail = None
    address: str | None = Field(None, max_length=500)
    apartment_number: str | None = Field(None, max_length=32)


class PartySelection(_In):
    """Exactly one of: an existing contact (optionally completing its empty fields),
    or the details of a new one."""
    contact_id: int | None = None
    complete: ContactCompletion | None = None
    details: ContactDetails | None = None

    @model_validator(mode="after")
    def _exactly_one(self):
        if (self.contact_id is None) == (self.details is None):
            raise ValueError("provide either contact_id or details")
        if self.complete is not None and self.contact_id is None:
            raise ValueError("complete applies only to an existing contact")
        return self


class OpenProceedingStatus(_Out):
    has_open: bool


class LedgerItemCreate(_In):
    subject: str = Field(max_length=255)
    amount: Decimal


class LedgerItemUpdate(_In):
    subject: str | None = Field(None, max_length=255)
    amount: Decimal | None = None

    @model_validator(mode="after")
    def _not_empty(self):
        if not self.model_fields_set:
            raise ValueError("at least one field must be provided")
        return self


class LedgerItemOut(_Out):
    id: int
    item_type: Literal["base_amount", "addition"]
    subject: str
    amount: Decimal
    sort_order: int


class LedgerItemResult(_Out):
    item: LedgerItemOut
    total_amount: Decimal


class ProceedingCreate(_In):
    contact: PartySelection | None = None
    landlord: PartySelection | None = None   # required only when party_role is 'tenant'
    confirm_open_proceeding: bool = False    # continue although the tenant has an open proceeding
    confirm_duplicate_contact: bool = False  # create a new contact although its phone is already known
    party_role: PartyRoleLiteral
    title: str = Field(max_length=255)
    base_items: list[LedgerItemCreate] | None = None     # at least one (enforced by the service)
    claim_details: str | None = None
    project_id: int | None = None


class ProceedingUpdate(_In):
    """The parties (contact_id, party_role, landlord_contact_id) are rejected here."""
    title: str | None = Field(None, max_length=255)
    claim_details: str | None = None
    project_id: int | None = None

    @model_validator(mode="after")
    def _not_empty(self):
        if not self.model_fields_set:
            raise ValueError("at least one field must be provided")
        return self


class StageComponentOut(_Out):
    key: str
    label: str


class StageOut(_Out):
    key: str
    label: str
    description: str | None = None
    position: int
    requires_communication: bool
    components: list[StageComponentOut]
    status: StageStatusLiteral
    resolved_at: datetime | None = None
    resolved_by: UserRef | None = None


class ProceedingPermissions(_Out):
    can_update: bool          # edit, stages, entries, documents, close / reopen
    can_assign: bool          # creator or Admin (+ update)
    can_delete_others: bool   # edit / delete other users' entries and documents


class ProceedingDetailOut(_Out):
    id: int
    title: str
    status: Literal["open", "closed"]
    party_role: PartyRoleLiteral
    claim_details: str | None = None
    total_amount: Decimal
    ledger_items: list[LedgerItemOut]
    contact: ContactSummary  # the primary contact, whatever party_role is
    linked_landlord: ContactSummary | None = None   # only in a tenant's proceeding
    project: Ref | None = None
    created_by: UserRef | None = None
    opened_at: datetime
    closed_at: datetime | None = None
    closed_by: UserRef | None = None
    close_reason: str | None = None
    updated_at: datetime | None = None
    progress: Progress
    stages: list[StageOut]
    assignee_ids: list[int]
    permissions: ProceedingPermissions


class ProceedingCreated(_Out):
    proceeding: ProceedingDetailOut
    has_match: bool


class CloseBody(_In):
    reason: str = Field(min_length=1)


class ReasonBody(_In):
    reason: str | None = None


class CompleteStageBody(_In):
    confirm: bool = False     # complete even though documentation is missing


class MissingItem(_Out):
    key: str
    label: str


class ProjectSummaryOut(_Out):
    project_id: int | None = None
    project_name: str | None = None
    open_count: int
    closed_count: int
    open_claim_total: Decimal
    contact_count: int


class HistoryEntry(_Out):
    id: int
    action: str
    user_id: int | None = None
    user_name: str | None = None
    details: dict | None = None
    created_at: datetime


class HistoryPage(_Out):
    items: list[HistoryEntry]
    total: int
    page: int
    page_size: int


# ── documents / entries ──────────────────────────────────────────────────────

class DocumentOut(_Out):
    id: int
    file_name: str | None = None
    download_url: str
    preview_url: str | None = None
    uploaded_by: UserRef | None = None
    uploaded_at: datetime | None = None
    stage_key: str | None = None
    component_key: str | None = None
    entry_id: int | None = None


class EntryOut(_Out):
    id: int
    entry_type: EntryTypeLiteral
    stage_key: str | None = None
    context_key: str | None = None
    content: str | None = None
    channel: ChannelLiteral | None = None
    occurred_at: datetime | None = None
    created_by: UserRef | None = None
    created_at: datetime
    updated_by: UserRef | None = None
    updated_at: datetime | None = None
    can_modify: bool
    documents: list[DocumentOut]


class EntryPage(_Out):
    items: list[EntryOut]
    # Pass as ``before_id`` to load older entries; null when there are none.
    next_before_id: int | None = None


class EntryUpdate(_In):
    """Only the fields sent are changed; null clears content (when allowed)."""
    content: str | None = None
    channel: ChannelLiteral | None = None
    occurred_at: datetime | None = None

    @model_validator(mode="after")
    def _not_empty(self):
        if not self.model_fields_set:
            raise ValueError("at least one field must be provided")
        return self


# ── team ─────────────────────────────────────────────────────────────────────

class AssigneeOut(_Out):
    user: UserRef
    assigned_by: UserRef | None = None
    assigned_at: datetime


class TeamOut(_Out):
    owner: UserRef | None = None
    assignees: list[AssigneeOut]


class AssignBody(_In):
    user_id: int


# ── configuration ────────────────────────────────────────────────────────────

class StageDefinitionOut(_Out):
    key: str
    label: str
    description: str | None = None
    position: int
    requires_communication: bool
    components: list[StageComponentOut]
