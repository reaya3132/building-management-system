"""Contacts (אנשי קשר) as used by the legal proceedings module.

There is no separate IAM resource for contacts yet: they are managed through the
``legal_proceeding`` permissions. Searching and creating need ``write`` (they are
done while opening a proceeding); viewing needs ``read``, and a non-Admin may view only
a contact of a proceeding they can see. Only Admin / SuperAdmin edit a card. Changes
are recorded in ``audit_logs`` (entity='contact') with before/after values.
Phones are stored normalized (digits only, Israeli numbers in local 0... form), so
every comparison is on the normalized value. A phone already on an active contact
stops the creation until the user explicitly confirms it (general answer only).
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from backend.iam.enums import Action
from backend.models.contact import CONTACT_AUDIT_ENTITY, Contact, ContactKind
from backend.repositories.contact_repository import ContactRepository
from backend.services.audit_service import AuditService
from backend.services.legal_access import changed_fields, is_admin, legal_error, LegalAccess, utc_now

CONTACT_FIELDS = ("kind", "name", "email", "phone", "phone_2", "address", "notes", "is_active")
OPEN_PROCEEDING_REQUIRED = ("email", "address")  # cannot be cleared while a proceeding of the contact is open
DUPLICATE_PHONE_UPDATE_WARNING = "מספר הטלפון כבר קיים אצל איש קשר אחר. האם לשמור בכל זאת?"
DUPLICATE_PHONE_WARNING = "מספר הטלפון כבר קיים אצל איש קשר אחר. האם ליצור איש קשר חדש בכל זאת?"
_MAX_LEN = {"name": 255, "email": 255, "phone": 50, "phone_2": 50, "address": 500}


def _local_digits(digits: str) -> str:
    """Drop the 00 international prefix; Israeli numbers go to their local 0... form."""
    if digits.startswith("00"):
        digits = digits[2:]
    if digits.startswith("972"):
        rest = digits[3:]
        digits = rest if rest.startswith("0") else f"0{rest}"
    return digits


def normalize_phone(value, *, field: str = "phone") -> str:
    """The one normalization of contact phones. Accepts spaces, dashes, dots, slashes,
    parentheses and a leading +; 050-1234567, +972 50 123 4567 and 00972501234567
    all become 0501234567."""
    raw = str(value).strip()
    digits = _local_digits(re.sub(r"\D", "", raw))
    if re.search(r"[^\d\s().\-/+]", raw) or "+" in raw[1:] or not 9 <= len(digits) <= 15:
        raise legal_error(422, "invalid_phone", "The phone number is not valid", field=field)
    return digits


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
    if not partial or "phone" in cleaned:
        if not cleaned.get("phone"):
            raise legal_error(422, "contact_phone_required", "A primary phone number is required")
    for key in ("phone", "phone_2"):
        if cleaned.get(key) is not None:
            cleaned[key] = normalize_phone(cleaned[key], field=key)
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
    has_match: bool     # one of its phones is already on another active contact


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
        digits = _local_digits(re.sub(r"\D", "", term or ""))
        return await self.repo.search(term, phone_term=digits or None, limit=max(1, min(limit, 50)))

    async def has_duplicate(self, phone: str, phone_2: str | None = None, *, exclude_id: int | None = None) -> bool:
        """Is either number already on an active contact? General answer only."""
        await self.access.require(Action.WRITE.value)
        phones = [normalize_phone(phone)] + ([normalize_phone(phone_2, field="phone_2")] if phone_2 and phone_2.strip() else [])
        return bool(await self.repo.find_similar(phones=phones, exclude_id=exclude_id, limit=1))

    async def lock_phones_of(self, new_contacts: list[dict]) -> None:
        """Lock every phone of the new contacts of one request together, in one
        sorted pass (two new contacts locked one by one could deadlock)."""
        phones = [normalize_phone(details[key], field=key) for details in new_contacts for key in ("phone", "phone_2")
                  if isinstance(details.get(key), str) and details[key].strip()]
        await self.repo.lock_phones(phones)

    async def create(self, values: dict, *, confirm_duplicate: bool = False) -> ContactCreateResult:
        """Called directly (``POST /contacts``) or while opening a proceeding."""
        await self.access.require(Action.WRITE.value)
        data = clean_contact_values(values, partial=False)
        data.pop("is_active", None)
        phones = [p for p in (data.get("phone"), data.get("phone_2")) if p]
        await self.repo.lock_phones(phones)  # held until the commit: the check below sees any concurrent card
        has_match = bool(await self.repo.find_similar(phones=phones, limit=1))
        if has_match and not confirm_duplicate:
            raise legal_error(409, "duplicate_phone", DUPLICATE_PHONE_WARNING, has_match=True)
        contact = await self.repo.add(Contact(**data, created_by=self.user.id, created_at=utc_now()))
        await self._log(contact.id, "created", {"after": snapshot(contact),
                                                **({"duplicate_phone_confirmed": True} if has_match else {})})
        return ContactCreateResult(contact, has_match)

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

    async def update(self, contact_id: int, values: dict, *, confirm_duplicate: bool = False) -> Contact:
        """Edits the general contact card (seen by every proceeding of the contact)."""
        if not is_admin(self.user):
            raise HTTPException(status_code=403, detail="Only an administrator can edit contact details")
        data = clean_contact_values(values, partial=True)
        sent_phones = [data[key] for key in ("phone", "phone_2") if data.get(key)]
        await self.repo.lock_phones(sent_phones)  # before the row lock: the same order as opening a proceeding
        contact = await self.repo.get(contact_id, for_update=True)
        if contact is None:
            raise HTTPException(status_code=404, detail="Contact not found")
        cleared = [f for f in OPEN_PROCEEDING_REQUIRED if f in data and data[f] is None and getattr(contact, f) is not None]
        if cleared and await self.access.repo.has_open_proceeding_for_contact(contact.id):
            raise legal_error(422, "contact_required_for_open_proceeding",
                              "לא ניתן למחוק פרטים הנדרשים להליך משפטי פתוח", fields=cleared)
        new_phones = [p for p in sent_phones if p not in (contact.phone, contact.phone_2)]
        has_match = bool(await self.repo.find_similar(phones=new_phones, exclude_id=contact.id, limit=1))
        if has_match and not confirm_duplicate:
            raise legal_error(409, "duplicate_phone", DUPLICATE_PHONE_UPDATE_WARNING, has_match=True)
        before = snapshot(contact)
        for key, value in data.items():
            setattr(contact, key, value)
        old, new = changed_fields(before, snapshot(contact), CONTACT_FIELDS)
        if new:
            contact.updated_at = utc_now()
            await self.db.flush()
            await self._log(contact.id, "updated", {"before": old, "after": new,
                                                    **({"duplicate_phone_confirmed": True} if has_match else {})})
        return contact
