"""Queries for contacts (אנשי קשר).

Reads by id come from :class:`BaseRepository`. Writes deliberately do NOT use
``BaseRepository.create`` (it commits): a contact may be created inside the
transaction that opens a proceeding, so ``add`` only flushes.
"""
from __future__ import annotations

from sqlalchemy import func, or_, select

from backend.models.contact import Contact
from backend.repositories.base import BaseRepository

LIKE_ESCAPE = "\\"


def contains_pattern(term: str) -> str:
    """``%term%`` with LIKE wildcards escaped (use with ``escape=LIKE_ESCAPE``).
    The single implementation for the contacts / legal proceedings searches."""
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


class ContactRepository(BaseRepository[Contact]):
    model = Contact

    async def get(self, contact_id: int, *, for_update: bool = False) -> Contact | None:
        if not for_update:
            return await self.get_by_id(contact_id)
        stmt = select(Contact).where(Contact.id == contact_id).with_for_update()
        return (await self.db.execute(stmt)).scalar_one_or_none()

    async def add(self, contact: Contact) -> Contact:
        """Flush only — the caller's transaction decides when to commit."""
        self.db.add(contact)
        await self.db.flush()
        return contact

    async def search(self, term: str | None, *, include_inactive: bool = False, limit: int = 20) -> list[Contact]:
        """Name / phone / email contains ``term`` (case-insensitive); newest first."""
        stmt = select(Contact)
        if not include_inactive:
            stmt = stmt.where(Contact.is_active.is_(True))
        if term and term.strip():
            pattern = contains_pattern(term.strip())
            stmt = stmt.where(or_(
                Contact.name.ilike(pattern, escape=LIKE_ESCAPE),
                Contact.email.ilike(pattern, escape=LIKE_ESCAPE),
                Contact.phone.ilike(pattern, escape=LIKE_ESCAPE),
                Contact.phone_2.ilike(pattern, escape=LIKE_ESCAPE),
            ))
        stmt = stmt.order_by(Contact.name, Contact.id).limit(limit)
        return list((await self.db.execute(stmt)).scalars())

    async def find_similar(self, *, name: str, phone: str | None, email: str | None,
                           exclude_id: int | None = None, limit: int = 5) -> list[Contact]:
        """Active contacts that look like the same person: same phone or email
        (on either phone column), or exactly the same name. Used for the
        non-blocking duplicate warning."""
        conditions = [func.lower(func.trim(Contact.name)) == name.strip().lower()]
        if phone:
            conditions += [Contact.phone == phone, Contact.phone_2 == phone]
        if email:
            conditions.append(func.lower(Contact.email) == email.strip().lower())
        stmt = select(Contact).where(Contact.is_active.is_(True), or_(*conditions))
        if exclude_id is not None:
            stmt = stmt.where(Contact.id != exclude_id)
        return list((await self.db.execute(stmt.order_by(Contact.id).limit(limit))).scalars())
