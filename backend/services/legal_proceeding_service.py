"""Legal proceedings (הליכים משפטיים): open, edit, close / reopen, list, project view.

Every proceeding is independent: one contact, an optional project, its own claim
details and amount, its own stages. Opening one never blocks on the contact's
other open proceedings — they come back as a warning. Proceedings are closed and
reopened, never deleted. Every public method runs in the request's transaction
(committed once at the end); history goes to ``audit_logs``
(entity='legal_proceeding', entity_id = proceeding id).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

from sqlalchemy.ext.asyncio import AsyncSession

from backend.configurations.legal.stages import STAGE_KEYS, StageDefinition, STAGES
from backend.iam.enums import Action
from backend.models.contact import Contact
from backend.models.legal_proceeding import (
    LEGAL_PROCEEDING_AUDIT_ENTITY,
    LegalEvent,
    LegalProceeding,
    LegalProceedingStage,
    PartyRole,
    ProceedingStatus,
    StageStatus,
)
from backend.repositories.contact_repository import ContactRepository
from backend.repositories.project_repository import ProjectRepository
from backend.repositories.legal_proceeding_repository import (
    LegalProceedingRepository,
    ProceedingFilters,
    ProceedingRow,
    ProjectSummaryRow,
)
from backend.services.audit_service import AuditService
from backend.services.contact_service import ContactService
from backend.services.legal_access import LegalAccess, changed_fields, legal_error

EDITABLE_FIELDS = ("party_role", "unit_label", "title", "claim_details", "claim_amount", "project_id")
_MAX_AMOUNT = Decimal("999999999999.99")  # NUMERIC(14, 2)


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _text(value, *, limit: int | None = None, field_name: str = "") -> str | None:
    if value is None:
        return None
    value = str(value).strip()
    if limit and len(value) > limit:
        raise legal_error(422, "value_too_long", f"{field_name} is longer than {limit} characters", field=field_name)
    return value or None


def _amount(value) -> Decimal | None:
    if value is None or value == "":
        return None
    try:
        amount = Decimal(str(value))
    except InvalidOperation:
        raise legal_error(422, "invalid_amount", "claim_amount must be a number")
    if not amount.is_finite() or amount <= 0 or amount > _MAX_AMOUNT or amount != amount.quantize(Decimal("0.01")):
        raise legal_error(422, "invalid_amount", "claim_amount must be greater than 0 with at most two decimals")
    return amount.quantize(Decimal("0.01"))


def _audit_value(value):
    if isinstance(value, Decimal):
        return f"{value:.2f}"
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def snapshot(p: LegalProceeding) -> dict:
    return {k: _audit_value(getattr(p, k)) for k in (
        "contact_id", "project_id", "party_role", "unit_label", "title", "claim_details", "claim_amount",
        "status", "opened_at", "closed_at", "closed_by", "close_reason")}


@dataclass
class Progress:
    """Derived from the stage statuses (no stored "current stage")."""
    resolved: int
    total: int
    next_stage_key: str | None   # first pending stage in the configured order

    @property
    def percent(self) -> int:
        return round(100 * self.resolved / self.total) if self.total else 0


def progress_of(stages: list[LegalProceedingStage]) -> Progress:
    by_key = {s.stage_key: s for s in stages}
    resolved = sum(1 for s in stages if s.status in StageStatus.RESOLVED)
    next_key = next((k for k in STAGE_KEYS if k in by_key and by_key[k].status == StageStatus.PENDING), None)
    return Progress(resolved, len(stages), next_key)


def ordered_stages(stages: list[LegalProceedingStage]) -> list[tuple[StageDefinition, LegalProceedingStage]]:
    by_key = {s.stage_key: s for s in stages}
    return [(d, by_key[d.key]) for d in STAGES if d.key in by_key]


@dataclass
class ProceedingListItem:
    row: ProceedingRow
    progress: Progress
    assignee_ids: list[int] = field(default_factory=list)


@dataclass
class CreateResult:
    proceeding: LegalProceeding
    contact: Contact
    open_proceedings: list[ProceedingRow]   # the warning: other open proceedings of the contact
    similar_contacts: list[Contact]         # the warning when a new contact looks like an existing one


class LegalProceedingService:
    def __init__(self, db: AsyncSession, user):
        self.db = db
        self.user = user
        self.repo = LegalProceedingRepository(db)
        self.access = LegalAccess(db, user)
        self.audit = AuditService(db)

    async def _log(self, proceeding_id: int, event: str, details: dict | None = None) -> None:
        await self.audit.log_action(self.user.id, event, LEGAL_PROCEEDING_AUDIT_ENTITY, str(proceeding_id), details)

    async def _validate_project(self, project_id) -> int | None:
        if project_id is None:
            return None
        if await ProjectRepository(self.db).get_by_id(int(project_id)) is None:
            raise legal_error(422, "project_not_found", "The project does not exist", project_id=project_id)
        return int(project_id)

    def _validated_fields(self, values: dict) -> dict:
        data: dict = {}
        if "party_role" in values:
            if values["party_role"] not in PartyRole.ALL:
                raise legal_error(422, "invalid_party_role", "party_role must be owner, tenant or other")
            data["party_role"] = values["party_role"]
        if "title" in values:
            data["title"] = _text(values["title"], limit=255, field_name="title")
            if not data["title"]:
                raise legal_error(422, "title_required", "A title is required")
        if "unit_label" in values:
            data["unit_label"] = _text(values["unit_label"], limit=100, field_name="unit_label")
        if "claim_details" in values:
            data["claim_details"] = _text(values["claim_details"])
        if "claim_amount" in values:
            data["claim_amount"] = _amount(values["claim_amount"])
        return data

    # ── open ─────────────────────────────────────────────────────────────────

    async def create(self, values: dict, *, contact_id: int | None = None,
                     new_contact: dict | None = None) -> CreateResult:
        """Open a proceeding for an existing contact or for a contact created in
        the same transaction. Creates every stage (pending)."""
        await self.access.require(Action.WRITE.value)
        if (contact_id is None) == (new_contact is None):
            raise legal_error(422, "contact_required", "Provide either contact_id or a new contact")
        for required in ("party_role", "title"):
            if required not in values:
                raise legal_error(422, f"{required}_required", f"{required} is required")
        data = self._validated_fields(values)
        project_id = await self._validate_project(values.get("project_id"))

        similar: list[Contact] = []
        if new_contact is not None:
            created = await ContactService(self.db, self.user).create(new_contact)
            contact, similar = created.contact, created.similar
        else:
            contact = await ContactRepository(self.db).get(contact_id)
            if contact is None:
                raise legal_error(422, "contact_not_found", "The contact does not exist", contact_id=contact_id)
            if not contact.is_active:
                raise legal_error(422, "contact_inactive", "The contact is inactive")

        open_rows = await self.repo.open_for_contact(contact.id)
        now = _now()
        proceeding = LegalProceeding(contact_id=contact.id, project_id=project_id, status=ProceedingStatus.OPEN,
                                     opened_at=now, created_by=self.user.id, created_at=now, **data)
        await self.repo.add(proceeding)
        for key in STAGE_KEYS:
            self.db.add(LegalProceedingStage(proceeding_id=proceeding.id, stage_key=key, status=StageStatus.PENDING))
        await self.db.flush()
        await self._log(proceeding.id, LegalEvent.CREATED, {
            "after": snapshot(proceeding),
            "open_proceedings_of_contact": [r.proceeding.id for r in open_rows],
        })
        return CreateResult(proceeding, contact, open_rows, similar)

    # ── edit ─────────────────────────────────────────────────────────────────

    async def update(self, proceeding_id: int, values: dict) -> LegalProceeding:
        """Claim details, amount, role, unit, title, project. The contact never changes."""
        if "contact_id" in values:
            raise legal_error(422, "contact_immutable", "The contact of a proceeding cannot be changed")
        proceeding = await self.access.load(proceeding_id, Action.UPDATE.value, for_update=True, require_open=True)
        data = self._validated_fields(values)
        if "project_id" in values:
            data["project_id"] = await self._validate_project(values["project_id"])
        before = snapshot(proceeding)
        for key, value in data.items():
            setattr(proceeding, key, value)
        old, new = changed_fields(before, snapshot(proceeding))
        if new:
            proceeding.updated_at = _now()
            await self.db.flush()
            await self._log(proceeding.id, LegalEvent.UPDATED, {"before": old, "after": new})
        return proceeding

    async def close(self, proceeding_id: int, reason: str) -> LegalProceeding:
        proceeding = await self.access.load(proceeding_id, Action.UPDATE.value, for_update=True)
        if proceeding.status == ProceedingStatus.CLOSED:
            raise legal_error(409, "already_closed", "The proceeding is already closed")
        reason = _text(reason)
        if not reason:
            raise legal_error(422, "close_reason_required", "A reason is required to close a proceeding")
        now = _now()
        proceeding.status, proceeding.closed_at = ProceedingStatus.CLOSED, now
        proceeding.closed_by, proceeding.close_reason, proceeding.updated_at = self.user.id, reason, now
        await self.db.flush()
        await self._log(proceeding.id, LegalEvent.CLOSED, {"close_reason": reason})
        return proceeding

    async def reopen(self, proceeding_id: int, reason: str | None = None) -> LegalProceeding:
        proceeding = await self.access.load(proceeding_id, Action.UPDATE.value, for_update=True)
        if proceeding.status == ProceedingStatus.OPEN:
            raise legal_error(409, "already_open", "The proceeding is already open")
        previous = {"closed_at": _audit_value(proceeding.closed_at), "closed_by": proceeding.closed_by,
                    "close_reason": proceeding.close_reason}
        proceeding.status = ProceedingStatus.OPEN
        proceeding.closed_at = proceeding.closed_by = proceeding.close_reason = None
        proceeding.updated_at = _now()
        await self.db.flush()
        await self._log(proceeding.id, LegalEvent.REOPENED, {"previous_close": previous, "reason": _text(reason)})
        return proceeding

    # ── read ─────────────────────────────────────────────────────────────────

    async def get(self, proceeding_id: int) -> LegalProceeding:
        return await self.access.load(proceeding_id)

    async def list(self, filters: ProceedingFilters, *, page: int = 1, page_size: int = 50
                   ) -> tuple[list[ProceedingListItem], int]:
        """A page of visible proceedings with progress and assignees (3 queries)."""
        await self.access.require(Action.READ.value)
        page, page_size = max(1, page), max(1, min(page_size, 200))
        rows, total = await self.repo.list(filters, visible_to=self.access.visible_to,
                                           offset=(page - 1) * page_size, limit=page_size)
        ids = [r.proceeding.id for r in rows]
        stages = await self.repo.stages_for(ids)
        assignees = await self.repo.assignees_for(ids)
        items = [ProceedingListItem(r, progress_of(stages[r.proceeding.id]),
                                    [a.user_id for a in assignees[r.proceeding.id]]) for r in rows]
        return items, total

    async def project_summary(self, *, rollup_to_parent: bool = False,
                              project_id: int | None = None) -> list[ProjectSummaryRow]:
        """Open / closed counts and open claim totals per project (visible proceedings)."""
        await self.access.require(Action.READ.value)
        return await self.repo.project_summary(visible_to=self.access.visible_to,
                                               rollup_to_parent=rollup_to_parent, project_id=project_id)

    async def open_proceedings_of_contact(self, contact_id: int, *, exclude_id: int | None = None
                                          ) -> list[ProceedingRow]:
        """The warning shown while opening a proceeding (before submitting)."""
        await self.access.require(Action.WRITE.value)
        return await self.repo.open_for_contact(contact_id, exclude_id=exclude_id)

    async def history(self, proceeding_id: int, *, page: int = 1, page_size: int = 50):
        """The proceeding's audit trail (stages, entries, documents, assignees...)."""
        await self.access.load(proceeding_id)
        page, page_size = max(1, page), max(1, min(page_size, 200))
        return await self.repo.history(proceeding_id, page=page, page_size=page_size)
