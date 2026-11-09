"""Queries for contacts (אנשי קשר).

Reads by id come from :class:`BaseRepository`. Writes deliberately do NOT use
``BaseRepository.create`` (it commits): a contact may be created inside the
transaction that opens a proceeding, so ``add`` only flushes.
"""
from __future__ import annotations

from sqlalchemy import or_, select, text

from backend.models.contact import Contact
from backend.repositories.base import BaseRepository

LIKE_ESCAPE = "\\"
# First key of the phone advisory locks, so they cannot collide with any other use.
_PHONE_LOCK_NAMESPACE = 72001


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

    async def lock_many(self, contact_ids: list[int]) -> dict[int, Contact]:
        """Lock the given contacts in ascending id order, so that two requests
        locking the same contacts cannot deadlock."""
        if not contact_ids:
            return {}
        stmt = select(Contact).where(Contact.id.in_(set(contact_ids))).order_by(Contact.id).with_for_update()
        return {c.id: c for c in (await self.db.execute(stmt)).scalars()}

    async def lock_phones(self, phones: list[str]) -> None:
        """Serialize duplicate checks per normalized phone until the transaction ends.
        Always in sorted order, so two requests cannot deadlock. PostgreSQL only."""
        if self.db.get_bind().dialect.name != "postgresql":
            return
        for phone in sorted(set(phones)):
            await self.db.execute(text("SELECT pg_advisory_xact_lock(:namespace, hashtext(:phone))"),
                                  {"namespace": _PHONE_LOCK_NAMESPACE, "phone": phone})

    async def add(self, contact: Contact) -> Contact:
        """Flush only — the caller's transaction decides when to commit."""
        self.db.add(contact)
        await self.db.flush()
        return contact

    async def search(self, term: str | None, *, phone_term: str | None = None, include_inactive: bool = False,
                     limit: int = 20) -> list[Contact]:
        """Name / email contains ``term`` (case-insensitive), or a phone contains
        ``phone_term`` (the digits of the term; phones are stored normalized)."""
        stmt = select(Contact)
        if not include_inactive:
            stmt = stmt.where(Contact.is_active.is_(True))
        if term and term.strip():
            pattern = contains_pattern(term.strip())
            conditions = [Contact.name.ilike(pattern, escape=LIKE_ESCAPE), Contact.email.ilike(pattern, escape=LIKE_ESCAPE)]
            if phone_term:
                phone_pattern = contains_pattern(phone_term)
                conditions += [Contact.phone.ilike(phone_pattern, escape=LIKE_ESCAPE),
                               Contact.phone_2.ilike(phone_pattern, escape=LIKE_ESCAPE)]
            stmt = stmt.where(or_(*conditions))
        stmt = stmt.order_by(Contact.name, Contact.id).limit(limit)
        return list((await self.db.execute(stmt)).scalars())

    async def find_similar(self, *, phones: list[str], exclude_id: int | None = None, limit: int = 5) -> list[Contact]:
        """Active contacts holding any of the normalized ``phones``, on either phone
        column. Phones only: names and emails are not compared."""
        if not phones:
            return []
        stmt = select(Contact).where(Contact.is_active.is_(True),
                                     or_(Contact.phone.in_(phones), Contact.phone_2.in_(phones)))
        if exclude_id is not None:
            stmt = stmt.where(Contact.id != exclude_id)
        return list((await self.db.execute(stmt.order_by(Contact.id).limit(limit))).scalars())
