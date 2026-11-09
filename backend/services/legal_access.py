"""Access rules of the legal proceedings module.

Two independent layers, applied by every operation:

1. IAM (``iam_resource_policies`` / role policies) decides WHAT a user may do on
   ``legal_proceeding``: read / write / update / delete. Checked first, before any
   lookup, so a missing proceeding is not revealed to an unauthorised user.
2. Visibility decides WHICH proceedings: exactly the tasks rule
   (``services/task_access``) — Admin sees every proceeding; anyone else only
   those they created (the primary owner) or are assigned to.

Authored content (entries, documents) is changed by its author; changing or
deleting someone else's requires the IAM ``delete`` action.
"""
from __future__ import annotations

from datetime import datetime, timezone
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from backend.iam.engine import PermissionsEngine
from backend.iam.enums import Action, GlobalRole, ResourceType
from backend.models.legal_proceeding import LegalProceeding, ProceedingStatus
from backend.repositories.legal_proceeding_repository import LegalProceedingRepository

RESOURCE = ResourceType.LEGAL_PROCEEDING.value


def utc_now() -> datetime:
    """Naive UTC, the module's storage convention."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def legal_error(status_code: int, code: str, message: str, **extra) -> HTTPException:
    """Business-rule errors carry a stable ``code`` the client can translate."""
    return HTTPException(status_code=status_code, detail={"code": code, "message": message, **extra})


def clean_text(value, *, limit: int | None = None, field_name: str = "") -> str | None:
    """Trimmed text; blank becomes None. ``limit`` rejects longer values."""
    if value is None:
        return None
    value = str(value).strip()
    if limit and len(value) > limit:
        raise legal_error(422, "value_too_long", f"{field_name} is longer than {limit} characters", field=field_name)
    return value or None


def changed_fields(before: dict, after: dict, keys=None) -> tuple[dict, dict]:
    """Only the keys whose value changed, as (before, after) — the shape of every
    ``updated`` audit entry of the module. ``keys`` limits (and orders) the check."""
    keys = [k for k in (keys if keys is not None else after) if before.get(k) != after.get(k)]
    return {k: before.get(k) for k in keys}, {k: after.get(k) for k in keys}


def is_admin(user) -> bool:
    """Admin or the higher SuperAdmin, the same two roles as ``core.deps.require_admin``."""
    return getattr(user, "role", None) in (GlobalRole.ADMIN.value, GlobalRole.SUPER_ADMIN.value)


class LegalAccess:
    def __init__(self, db: AsyncSession, user):
        self.db = db
        self.user = user
        self.repo = LegalProceedingRepository(db)
        self._engine = PermissionsEngine(db)
        self._allowed: dict[str, bool] = {}

    async def allowed(self, action: str) -> bool:
        if action not in self._allowed:
            self._allowed[action] = await self._engine.has_permission(self.user.id, action, RESOURCE)
        return self._allowed[action]

    async def require(self, action: str) -> None:
        if not await self.allowed(action):
            raise HTTPException(status_code=403, detail=f"Permission denied: {action} on {RESOURCE}")

    @property
    def visible_to(self) -> int | None:
        """``None`` = no visibility filter (Admin); otherwise the user id to filter by."""
        return None if is_admin(self.user) else self.user.id

    async def can_view(self, proceeding: LegalProceeding) -> bool:
        if is_admin(self.user) or proceeding.created_by == self.user.id:
            return True
        return await self.repo.is_assignee(proceeding.id, self.user.id)

    async def load(self, proceeding_id: int, action: str = Action.READ.value, *,
                   for_update: bool = False, require_open: bool = False) -> LegalProceeding:
        """IAM ``action`` -> existence -> visibility (-> open). Every endpoint that
        touches one proceeding, or anything inside it, goes through here."""
        await self.require(action)
        proceeding = await self.repo.get(proceeding_id, for_update=for_update)
        if proceeding is None:
            raise HTTPException(status_code=404, detail="Proceeding not found")
        if not await self.can_view(proceeding):
            raise HTTPException(status_code=403, detail="Access denied")
        if require_open and proceeding.status != ProceedingStatus.OPEN:
            raise legal_error(409, "proceeding_closed", "The proceeding is closed; reopen it first")
        return proceeding

    def is_primary_owner(self, proceeding: LegalProceeding) -> bool:
        return proceeding.created_by == self.user.id

    async def can_change_authored(self, author_id: int | None) -> bool:
        """The author, or a holder of the IAM ``delete`` action (others' content)."""
        return author_id == self.user.id or await self.allowed(Action.DELETE.value)

    async def require_change_authored(self, author_id: int | None) -> None:
        if not await self.can_change_authored(author_id):
            raise HTTPException(status_code=403, detail="Only the author or a user with delete permission can do this")
