"""Schemas for collection (גבייה) tasks.

Amounts are ``Decimal`` (ILS, two decimal places) and serialize to JSON as
strings, so no float rounding ever reaches the client. ``billing_month`` accepts
``YYYY-MM`` or a full date and is always normalized to the first of the month.
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, BeforeValidator, ConfigDict, Field, field_serializer, model_validator

from backend.models.collection_task import CollectionType
from backend.schemas.task import TaskAttachmentOut, to_utc_z

# Positive ILS amount, max 9,999,999,999.99, at most two decimal places.
Money = Annotated[Decimal, Field(gt=0, max_digits=12, decimal_places=2)]


def _nonzero(value: Decimal) -> Decimal:
    if value == 0:
        raise ValueError("amount must not be zero")
    return value


# Signed, non-zero ILS amount for adjustments: > 0 adds, < 0 reduces.
SignedMoney = Annotated[Decimal, Field(max_digits=12, decimal_places=2), AfterValidator(_nonzero)]

CollectionTypeLiteral = Literal["single", "ledger"]
CollectionStatusLiteral = Literal["open", "in_progress", "closed"]


def _first_of_month(value: Any) -> Any:
    """Accept 'YYYY-MM', 'YYYY-MM-DD' or a date; return the month's first day."""
    if isinstance(value, datetime):
        value = value.date()
    if isinstance(value, date):
        return value.replace(day=1)
    if isinstance(value, str):
        text = value.strip()
        try:
            if len(text) == 7:
                return date.fromisoformat(f"{text}-01")
            return date.fromisoformat(text[:10]).replace(day=1)
        except ValueError:
            raise ValueError("billing_month must be YYYY-MM or YYYY-MM-DD")
    return value


BillingMonth = Annotated[date, BeforeValidator(_first_of_month)]
Title = Annotated[str, Field(min_length=1, max_length=255)]
Subject = Annotated[str, Field(min_length=1, max_length=255)]


def _strip(value: Any) -> Any:
    return value.strip() if isinstance(value, str) else value


# ── Input ────────────────────────────────────────────────────────────────────

class LedgerItemCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    subject: Annotated[Subject, BeforeValidator(_strip)]
    amount: Money
    # Does ``amount`` include VAT? Omitted = included (the amount to pay is the amount
    # entered). The rate is never sent: the server freezes the current VAT_RATE.
    vat_included: bool = True
    sort_order: int | None = Field(default=None, ge=0)


class LedgerItemUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    subject: Annotated[Subject, BeforeValidator(_strip)] | None = None
    amount: Money | None = None
    # Omitted = keep the item's VAT choice. Changing the amount of an item saved
    # before VAT support requires it (explicit choice; see the service).
    vat_included: bool | None = None
    sort_order: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _not_empty(self):
        if not self.model_fields_set:
            raise ValueError("at least one field must be provided")
        for field in ("subject", "amount", "vat_included"):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null")
        return self


class CollectionTaskCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: Annotated[Title, BeforeValidator(_strip)]
    description: str | None = None
    collection_type: CollectionTypeLiteral
    project_id: int
    billing_month: BillingMonth
    assignee_ids: list[int] = Field(min_length=1)
    initial_amount: Money | None = None
    # ``single`` only: does initial_amount include VAT? Omitted = included.
    initial_vat_included: bool | None = None
    items: list[LedgerItemCreate] = []

    @model_validator(mode="after")
    def _type_rules(self):
        if self.collection_type == CollectionType.SINGLE:
            if self.initial_amount is None:
                raise ValueError("initial_amount is required for a single collection task")
            if self.items:
                raise ValueError("items are allowed only for a ledger collection task")
            if self.initial_vat_included is None:
                self.initial_vat_included = True
        elif self.initial_amount is not None:
            raise ValueError("initial_amount is not allowed for a ledger collection task")
        elif self.initial_vat_included is not None:
            raise ValueError("initial_vat_included is not allowed for a ledger collection task")
        return self


class CollectionTaskUpdate(BaseModel):
    """Editable general fields. ``collection_type``, ``initial_amount`` and
    ``billing_month`` are rejected here (extra='forbid'); the month moves only
    through the explicit move-month action."""
    model_config = ConfigDict(extra="forbid")

    title: Annotated[Title, BeforeValidator(_strip)] | None = None
    description: str | None = None
    project_id: int | None = None
    assignee_ids: list[int] | None = Field(default=None, min_length=1)

    @model_validator(mode="after")
    def _not_empty(self):
        if not self.model_fields_set:
            raise ValueError("at least one field must be provided")
        for field in ("title", "project_id", "assignee_ids"):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null")
        return self


class MoveMonthIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    billing_month: BillingMonth
    reason: str | None = None


class StatusIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: CollectionStatusLiteral


class AdjustmentCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    amount: SignedMoney
    # Required detail of the addition / reduction; stored and shown in the history.
    note: Annotated[str, BeforeValidator(_strip), Field(min_length=1)]
    # Does ``amount`` include VAT? Omitted = included. The rate is never sent.
    vat_included: bool = True


class AdjustmentVatUpdate(BaseModel):
    """The VAT choice of an existing adjustment (its amount and note never change)."""
    model_config = ConfigDict(extra="forbid")

    vat_included: bool


class InitialAmountUpdate(BaseModel):
    """New initial amount of a ``single`` task (always positive)."""
    model_config = ConfigDict(extra="forbid")

    initial_amount: Money
    # Omitted = keep the current VAT choice. Changing an amount saved before VAT
    # support requires it (explicit choice; see the service).
    initial_vat_included: bool | None = None


# ── Output ───────────────────────────────────────────────────────────────────

class UserBrief(BaseModel):
    id: int
    full_name: str
    avatar_url: str | None = None


class ProjectBrief(BaseModel):
    id: int
    name: str
    relation_project: int | None = None
    parent_name: str | None = None


class ProjectOption(BaseModel):
    id: int
    name: str
    relation_project: int | None = None
    is_parent_project: bool = False
    # False only for an inactive parent shown to group its active sub-projects;
    # such a parent cannot be selected.
    is_active: bool = True


class VatFields(BaseModel):
    """VAT of one amount (services/vat.py). ``vat_included``/``vat_rate`` are the
    frozen facts; ``net_amount``/``vat_amount`` are None when they are unknown
    (an amount saved before VAT support). ``gross_amount`` is the amount to pay."""
    vat_included: bool | None = None
    vat_rate: Decimal | None = None
    net_amount: Decimal | None = None
    vat_amount: Decimal | None = None
    gross_amount: Decimal


class AdjustmentOut(VatFields):
    id: int
    amount: Decimal
    note: str | None = None
    created_by: UserBrief | None = None
    created_at: datetime

    _serialize_created_at = field_serializer("created_at")(staticmethod(to_utc_z))


class LedgerItemOut(VatFields):
    id: int
    subject: str
    amount: Decimal
    sort_order: int
    created_by_user_id: int
    updated_by_user_id: int | None = None
    created_at: datetime
    updated_at: datetime
    archived_at: datetime | None = None
    archived_by_user_id: int | None = None

    _serialize_created_at = field_serializer("created_at")(staticmethod(to_utc_z))
    _serialize_updated_at = field_serializer("updated_at")(staticmethod(to_utc_z))
    _serialize_archived_at = field_serializer("archived_at")(staticmethod(to_utc_z))


class CollectionTaskListItem(BaseModel):
    id: int
    title: str
    status: CollectionStatusLiteral
    collection_type: CollectionTypeLiteral
    billing_month: date
    project: ProjectBrief
    assignees: list[UserBrief]
    total_amount: Decimal
    is_archived: bool
    unread_messages_count: int = 0
    created_at: datetime
    updated_at: datetime

    _serialize_created_at = field_serializer("created_at")(staticmethod(to_utc_z))
    _serialize_updated_at = field_serializer("updated_at")(staticmethod(to_utc_z))


class CollectionTaskDetail(CollectionTaskListItem):
    description: str | None = None
    initial_amount: Decimal | None = None
    # ``single``: VAT of the initial amount (each adjustment carries its own).
    initial_vat: VatFields | None = None
    # ``ledger``: totals of the active items; None when any of them has no known VAT.
    # ``total_amount`` stays the amount to pay in both types.
    total_net_amount: Decimal | None = None
    total_vat_amount: Decimal | None = None
    adjustments: list[AdjustmentOut] = []
    ledger_items: list[LedgerItemOut] = []
    attachments: list[TaskAttachmentOut] = []
    created_by_user_id: int | None = None
    completed_at: datetime | None = None
    archived_at: datetime | None = None

    _serialize_completed_at = field_serializer("completed_at")(staticmethod(to_utc_z))
    _serialize_archived_at = field_serializer("archived_at")(staticmethod(to_utc_z))


class CollectionTaskPage(BaseModel):
    items: list[CollectionTaskListItem]
    total: int
    page: int
    page_size: int


class StatusSummary(BaseModel):
    count: int = 0
    total_amount: Decimal = Decimal("0.00")


class CollectionSummary(BaseModel):
    by_status: dict[str, StatusSummary]
    count: int
    total_amount: Decimal


class CollectionUnreadSummary(BaseModel):
    total_unread: int
    task_count: int


class AdjustmentResult(BaseModel):
    adjustment: AdjustmentOut
    total_amount: Decimal


class InitialAmountResult(BaseModel):
    initial_amount: Decimal
    initial_vat: VatFields
    total_amount: Decimal


class VatRateOut(BaseModel):
    """The rate in force now (VAT_RATE) — for previews only; the server freezes it."""
    vat_rate: Decimal


class LedgerItemResult(BaseModel):
    item: LedgerItemOut
    total_amount: Decimal


class AuditEntryOut(BaseModel):
    id: int
    action: str
    user_id: int | None = None
    user_name: str | None = None
    details: dict | None = None
    created_at: datetime

    _serialize_created_at = field_serializer("created_at")(staticmethod(to_utc_z))


class AuditPage(BaseModel):
    items: list[AuditEntryOut]
    total: int
    page: int
    page_size: int


# ── ledger statement (PDF) ───────────────────────────────────────────────────

class StatementLineIn(BaseModel):
    """One line of the exported document — edited in the export window only;
    it is never written back to the ledger."""
    model_config = ConfigDict(extra="forbid")

    subject: Annotated[Subject, BeforeValidator(_strip)]
    amount: Money
    # The ledger item this line came from (its frozen VAT rate is used), or None for
    # a line added in the export window (the current VAT_RATE). A rate is never sent.
    item_id: int | None = None
    # Omitted: an item's own choice; a new line = included.
    vat_included: bool | None = None


class StatementRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[StatementLineIn] = Field(default_factory=list, max_length=500)


class MonthCount(BaseModel):
    month: date
    count: int


class MonthCounts(BaseModel):
    year: int
    months: list[MonthCount]
