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
from datetime import datetime
from decimal import Decimal, InvalidOperation

from sqlalchemy.ext.asyncio import AsyncSession

from backend.configurations.legal.stages import STAGE_KEYS, StageDefinition, STAGES
from backend.iam.enums import Action
from backend.models.contact import Contact
from backend.models.user import User
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
from backend.repositories.user_repository import UserRepository
from backend.repositories.legal_proceeding_repository import (
    LegalProceedingRepository,
    ProceedingFilters,
    ProceedingRow,
    ProjectSummaryRow,
)
from backend.services.audit_service import AuditService
from backend.services.contact_service import ContactService
from backend.services.legal_access import changed_fields, clean_text, is_admin, legal_error, LegalAccess, utc_now

IMMUTABLE_PARTY_FIELDS = ("contact_id", "party_role", "landlord_contact_id")
# Required on every party of a proceeding (contacts themselves only require name and phone).
REQUIRED_PARTY_FIELDS = ("name", "phone", "email", "address")
INCOMPLETE_CARD_MESSAGE = "חסרים פרטי חובה בכרטיס איש הקשר. יש לפנות למנהל להשלמת הפרטים."
OPEN_PROCEEDING_WARNING = "לאיש קשר זה כבר קיים הליך משפטי פתוח. האם להמשיך?"
_MAX_AMOUNT = Decimal("999999999999.99")  # NUMERIC(14, 2)


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
        "contact_id", "project_id", "party_role", "landlord_contact_id", "apartment_number", "title", "claim_details", "claim_amount",
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
class ProceedingDetail:
    proceeding: LegalProceeding
    contact: Contact
    linked_landlord: Contact | None   # only in a tenant's proceeding
    project_name: str | None
    stages: list[tuple[StageDefinition, LegalProceedingStage]]
    progress: Progress
    assignee_ids: list[int]
    users: dict[int, User]          # creator, closer, stage resolvers
    can_update: bool
    can_assign: bool
    can_delete_others: bool


@dataclass
class CreateResult:
    proceeding: LegalProceeding
    contact: Contact
    has_match: bool                         # a new contact's phone is already on another contact


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
                raise legal_error(422, "invalid_party_role", "party_role must be tenant, landlord, supplier or other")
            data["party_role"] = values["party_role"]
        if "title" in values:
            data["title"] = clean_text(values["title"], limit=255, field_name="title")
            if not data["title"]:
                raise legal_error(422, "title_required", "A title is required")
        if "apartment_number" in values:
            data["apartment_number"] = clean_text(values["apartment_number"], limit=32, field_name="apartment_number")
            if not data["apartment_number"]:
                raise legal_error(422, "apartment_number_required", "An apartment number is required")
        if "claim_details" in values:
            data["claim_details"] = clean_text(values["claim_details"])
        if "claim_amount" in values:
            data["claim_amount"] = _amount(values["claim_amount"])
        return data

    async def _resolve_parties(self, party_role: str, contact: dict, landlord: dict | None,
                               confirm_duplicate: bool) -> tuple[Contact, Contact | None, bool]:
        """The contact (and, for a tenant, the landlord) of a new proceeding: each an
        existing card, used exactly as it is, or a new one. Selecting never changes a
        card; missing details are completed through an explicit contact edit first.
        Selected cards are locked in id order, so the required-details check holds."""
        if party_role != PartyRole.TENANT and landlord:
            raise legal_error(422, "landlord_not_allowed", "Only a tenant's proceeding has a linked landlord")
        if party_role == PartyRole.TENANT and not landlord:
            raise legal_error(422, "landlord_required", "A tenant's proceeding requires a landlord")
        selections = [("contact", contact)] + ([("landlord", landlord)] if landlord else [])
        contacts = ContactService(self.db, self.user)
        await contacts.lock_phones_of([s["details"] for _, s in selections if not s.get("contact_id") and s.get("details")])
        locked = await ContactRepository(self.db).lock_many([s["contact_id"] for _, s in selections if s.get("contact_id")])
        resolved: dict[str, Contact] = {}
        has_match = False
        for party, selection in selections:
            contact_id = selection.get("contact_id")
            if contact_id:
                card = locked.get(contact_id)
                if card is None:
                    raise legal_error(422, "contact_not_found", "The contact does not exist", contact_id=contact_id)
                if not card.is_active:
                    raise legal_error(422, "contact_inactive", "The contact is inactive")
            else:
                created = await contacts.create(selection.get("details") or {}, confirm_duplicate=confirm_duplicate)
                card, has_match = created.contact, has_match or created.has_match
            missing = [f for f in REQUIRED_PARTY_FIELDS if not getattr(card, f)]
            if missing:
                message = INCOMPLETE_CARD_MESSAGE if contact_id else "Required contact details are missing"
                raise legal_error(422, "contact_details_incomplete", message, party=party, missing=missing)
            resolved[party] = card
        return resolved["contact"], resolved.get("landlord"), has_match

    # ── open ─────────────────────────────────────────────────────────────────

    async def create(self, values: dict, *, contact: dict | None = None, landlord: dict | None = None,
                     confirm_open_proceeding: bool = False, confirm_duplicate_contact: bool = False) -> CreateResult:
        """Open a proceeding. ``contact`` / ``landlord`` are {"contact_id", "details"}:
        an existing card (never changed here) or a new one. Everything
        runs in one transaction; the caller commits. Creates every stage (pending)."""
        await self.access.require(Action.WRITE.value)
        if not contact or not (contact.get("contact_id") or contact.get("details")):
            raise legal_error(422, "contact_required", "Select an existing contact or provide a new one")
        for required in ("party_role", "title", "apartment_number"):
            if required not in values:
                raise legal_error(422, f"{required}_required", f"{required} is required")
        data = self._validated_fields(values)
        project_id = await self._validate_project(values.get("project_id"))
        had_open = (data["party_role"] == PartyRole.TENANT and bool(contact.get("contact_id"))
                    and await self.repo.has_open_tenant_proceeding(contact["contact_id"]))
        if had_open and not confirm_open_proceeding:
            raise legal_error(409, "tenant_has_open_proceeding", OPEN_PROCEEDING_WARNING)
        primary, linked_landlord, has_match = await self._resolve_parties(
            data["party_role"], contact, landlord, confirm_duplicate_contact)

        now = utc_now()
        proceeding = LegalProceeding(contact_id=primary.id, project_id=project_id,
                                     landlord_contact_id=linked_landlord.id if linked_landlord else None,
                                     status=ProceedingStatus.OPEN,
                                     opened_at=now, created_by=self.user.id, created_at=now, **data)
        await self.repo.add(proceeding)
        for key in STAGE_KEYS:
            self.db.add(LegalProceedingStage(proceeding_id=proceeding.id, stage_key=key, status=StageStatus.PENDING))
        await self.db.flush()
        await self._log(proceeding.id, LegalEvent.CREATED, {
            "after": snapshot(proceeding),
            "had_open_proceeding": had_open,
        })
        return CreateResult(proceeding, primary, has_match)

    # ── edit ─────────────────────────────────────────────────────────────────

    async def update(self, proceeding_id: int, values: dict) -> LegalProceeding:
        """Claim details, amount, apartment number, title, project. The parties are
        not editable here."""
        changed = [f for f in IMMUTABLE_PARTY_FIELDS if f in values]
        if changed:
            raise legal_error(422, "contact_immutable", "The parties of a proceeding cannot be changed here",
                              fields=changed)
        proceeding = await self.access.load(proceeding_id, Action.UPDATE.value, for_update=True, require_open=True)
        data = self._validated_fields(values)
        if "project_id" in values:
            data["project_id"] = await self._validate_project(values["project_id"])
        before = snapshot(proceeding)
        for key, value in data.items():
            setattr(proceeding, key, value)
        old, new = changed_fields(before, snapshot(proceeding))
        if new:
            proceeding.updated_at = utc_now()
            await self.db.flush()
            await self._log(proceeding.id, LegalEvent.UPDATED, {"before": old, "after": new})
        return proceeding

    async def close(self, proceeding_id: int, reason: str) -> LegalProceeding:
        proceeding = await self.access.load(proceeding_id, Action.UPDATE.value, for_update=True)
        if proceeding.status == ProceedingStatus.CLOSED:
            raise legal_error(409, "already_closed", "The proceeding is already closed")
        reason = clean_text(reason)
        if not reason:
            raise legal_error(422, "close_reason_required", "A reason is required to close a proceeding")
        now = utc_now()
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
        proceeding.updated_at = utc_now()
        await self.db.flush()
        await self._log(proceeding.id, LegalEvent.REOPENED, {"previous_close": previous, "reason": clean_text(reason)})
        return proceeding

    # ── read ─────────────────────────────────────────────────────────────────

    async def get(self, proceeding_id: int) -> LegalProceeding:
        return await self.access.load(proceeding_id)

    async def detail(self, proceeding_id: int) -> ProceedingDetail:
        """Everything the proceeding page shows at the top (6 queries)."""
        p = await self.access.load(proceeding_id)
        return await self.detail_of(p)

    async def detail_of(self, p: LegalProceeding) -> ProceedingDetail:
        """Detail of a proceeding already loaded through ``access.load``."""
        stages = (await self.repo.stages_for([p.id]))[p.id]
        assignees = (await self.repo.assignees_for([p.id]))[p.id]
        contact = await ContactRepository(self.db).get(p.contact_id)
        landlord = await ContactRepository(self.db).get(p.landlord_id) if p.landlord_id else None
        project = await ProjectRepository(self.db).get_by_id(p.project_id) if p.project_id else None
        users = await UserRepository(self.db).users_by_id([p.created_by, p.closed_by] + [s.resolved_by for s in stages])
        can_update = await self.access.allowed(Action.UPDATE.value)
        return ProceedingDetail(
            p, contact, landlord, project.name if project else None, ordered_stages(stages), progress_of(stages),
            [a.user_id for a in assignees], users, can_update,
            can_update and (is_admin(self.user) or self.access.is_primary_owner(p)),
            await self.access.allowed(Action.DELETE.value),
        )

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

    async def linked_landlords(self) -> list[tuple[int, str]]:
        """The landlords to offer in the list filter (visible proceedings only)."""
        await self.access.require(Action.READ.value)
        return await self.repo.linked_landlords(visible_to=self.access.visible_to)

    async def has_open_proceeding(self, contact_id: int) -> bool:
        """The general warning shown while opening a proceeding for a tenant."""
        await self.access.require(Action.WRITE.value)
        return await self.repo.has_open_tenant_proceeding(contact_id)

    async def history(self, proceeding_id: int, *, page: int = 1, page_size: int = 50):
        """The proceeding's audit trail (stages, entries, documents, assignees...)."""
        await self.access.load(proceeding_id)
        page, page_size = max(1, page), max(1, min(page_size, 200))
        return await self.repo.history(proceeding_id, page=page, page_size=page_size)
