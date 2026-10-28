"""Schemas for collection (גבייה) tasks.

Amounts are ``Decimal`` (ILS, two decimal places) and serialize to JSON as
strings, so no float rounding ever reaches the client. ``billing_month`` accepts
``YYYY-MM`` or a full date and is always normalized to the first of the month.
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, field_serializer, model_validator

from backend.models.collection_task import CollectionType
from backend.schemas.task import TaskAttachmentOut, to_utc_z

# Positive ILS amount, max 9,999,999,999.99, at most two decimal places.
Money = Annotated[Decimal, Field(gt=0, max_digits=12, decimal_places=2)]

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
    sort_order: int | None = Field(default=None, ge=0)


class LedgerItemUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    subject: Annotated[Subject, BeforeValidator(_strip)] | None = None
    amount: Money | None = None
    sort_order: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _not_empty(self):
        if not self.model_fields_set:
            raise ValueError("at least one field must be provided")
        for field in ("subject", "amount"):
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
    items: list[LedgerItemCreate] = []

    @model_validator(mode="after")
    def _type_rules(self):
        if self.collection_type == CollectionType.SINGLE:
            if self.initial_amount is None:
                raise ValueError("initial_amount is required for a single collection task")
            if self.items:
                raise ValueError("items are allowed only for a ledger collection task")
        elif self.initial_amount is not None:
            raise ValueError("initial_amount is not allowed for a ledger collection task")
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

    amount: Money
    note: str | None = None


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


class AdjustmentOut(BaseModel):
    id: int
    amount: Decimal
    note: str | None = None
    created_by: UserBrief | None = None
    created_at: datetime

    _serialize_created_at = field_serializer("created_at")(staticmethod(to_utc_z))


class LedgerItemOut(BaseModel):
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
