"""Contacts (אנשי קשר) as used by the legal proceedings module.

There is no separate IAM resource for contacts yet: they are managed through the
``legal_proceeding`` permissions. Searching and creating need ``write`` (they are
done while opening a proceeding); viewing needs ``read`` and editing ``update``, and
a non-Admin may view / edit only a contact of a proceeding they can see. Changes
are recorded in ``audit_logs`` (entity='contact') with before/after values.
Creation never blocks on look-alikes: similar active contacts are returned as a
warning so the user can pick the existing card instead.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from backend.iam.enums import Action
from backend.models.contact import CONTACT_AUDIT_ENTITY, Contact, ContactKind
from backend.repositories.contact_repository import ContactRepository
from backend.services.audit_service import AuditService
from backend.services.legal_access import LegalAccess, changed_fields, is_admin, legal_error

CONTACT_FIELDS = ("kind", "name", "email", "phone", "phone_2", "address", "notes", "is_active")
_MAX_LEN = {"name": 255, "email": 255, "phone": 50, "phone_2": 50, "address": 500}


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def snapshot(contact: Contact) -> dict:
    return {f: getattr(contact, f) for f in CONTACT_FIELDS}


def clean_contact_values(values: dict, *, partial: bool) -> dict:
    """Trim strings, turn blanks into NULL, validate kind / name / lengths."""
    cleaned: dict = {}
    for key, value in values.items():
        if key not in CONTACT_FIELDS:
            continue
        if isinstance(value, str):
            value = value.strip() or None
        cleaned[key] = value
    if not partial or "kind" in cleaned:
        if cleaned.get("kind") not in ContactKind.ALL:
            raise legal_error(422, "invalid_contact_kind", "kind must be 'person' or 'business'")
    if not partial or "name" in cleaned:
        if not cleaned.get("name"):
            raise legal_error(422, "contact_name_required", "A contact name is required")
    if "is_active" in cleaned and cleaned["is_active"] is None:
        raise legal_error(422, "invalid_is_active", "is_active cannot be empty")
    for key, limit in _MAX_LEN.items():
        if cleaned.get(key) and len(cleaned[key]) > limit:
            raise legal_error(422, "value_too_long", f"{key} is longer than {limit} characters", field=key)
    if cleaned.get("email") is not None:
        cleaned["email"] = cleaned["email"].lower()
    return cleaned


@dataclass
class ContactCreateResult:
    contact: Contact
    similar: list[Contact]


class ContactService:
    def __init__(self, db: AsyncSession, user):
        self.db = db
        self.user = user
        self.repo = ContactRepository(db)
        self.access = LegalAccess(db, user)
        self.audit = AuditService(db)

    async def _log(self, contact_id: int, event: str, details: dict) -> None:
        await self.audit.log_action(self.user.id, event, CONTACT_AUDIT_ENTITY, str(contact_id), details)

    async def search(self, term: str | None, *, limit: int = 20) -> list[Contact]:
        await self.access.require(Action.WRITE.value)
        return await self.repo.search(term, limit=max(1, min(limit, 50)))

    async def create(self, values: dict) -> ContactCreateResult:
        """Called directly (``POST /contacts``) or while opening a proceeding."""
        await self.access.require(Action.WRITE.value)
        data = clean_contact_values(values, partial=False)
        data.pop("is_active", None)
        similar = await self.repo.find_similar(name=data["name"], phone=data.get("phone"), email=data.get("email"))
        contact = await self.repo.add(Contact(**data, created_by=self.user.id, created_at=_now()))
        await self._log(contact.id, "created", {"after": snapshot(contact)})
        return ContactCreateResult(contact, similar)

    async def _load_visible(self, contact_id: int, action: str, *, for_update: bool = False) -> Contact:
        await self.access.require(action)
        contact = await self.repo.get(contact_id, for_update=for_update)
        if contact is None:
            raise HTTPException(status_code=404, detail="Contact not found")
        if not is_admin(self.user) and not await self.access.repo.has_visible_for_contact(contact.id, self.user.id):
            raise HTTPException(status_code=403, detail="Access denied")
        return contact

    async def get(self, contact_id: int) -> Contact:
        return await self._load_visible(contact_id, Action.READ.value)

    async def update(self, contact_id: int, values: dict) -> Contact:
        """Edits the general contact card (seen by every proceeding of the contact)."""
        contact = await self._load_visible(contact_id, Action.UPDATE.value, for_update=True)
        data = clean_contact_values(values, partial=True)
        before = snapshot(contact)
        for key, value in data.items():
            setattr(contact, key, value)
        old, new = changed_fields(before, snapshot(contact), CONTACT_FIELDS)
        if new:
            contact.updated_at = _now()
            await self.db.flush()
            await self._log(contact.id, "updated", {"before": old, "after": new})
        return contact
