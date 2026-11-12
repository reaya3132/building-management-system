"""Operational assignment of employees to a legal proceeding.

The creator is the primary owner (``legal_proceedings.created_by``) and is never
listed here. Only the creator or an Admin assigns / unassigns (plus the IAM
``update`` action); an assigned employee cannot assign others. Assignment grants
visibility of the proceeding; what the employee may then do is still decided by
their IAM permissions. Every change is recorded in ``audit_logs``.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from backend.iam.enums import Action
from backend.models.legal_proceeding import (
    LEGAL_PROCEEDING_AUDIT_ENTITY,
    LegalEvent,
    LegalProceeding,
    LegalProceedingAssignee,
)
from backend.models.user import User
from backend.repositories.legal_proceeding_repository import LegalProceedingRepository
from backend.repositories.user_repository import UserRepository
from backend.services.audit_service import AuditService
from backend.services.legal_access import is_admin, legal_error, LegalAccess, utc_now
from backend.services.user_lookup import load_active_users


@dataclass
class AssigneeView:
    user: User
    assigned_by: User | None
    assigned_at: datetime


@dataclass
class Team:
    owner: User | None            # the creator — primary owner
    assignees: list[AssigneeView]


class LegalAssigneeService:
    def __init__(self, db: AsyncSession, user):
        self.db = db
        self.user = user
        self.repo = LegalProceedingRepository(db)
        self.access = LegalAccess(db, user)
        self.audit = AuditService(db)

    async def _load_for_assign(self, proceeding_id: int) -> LegalProceeding:
        proceeding = await self.access.load(proceeding_id, Action.UPDATE.value, for_update=True, require_open=True)
        self._require_can_assign(proceeding)
        return proceeding

    def _require_can_assign(self, proceeding: LegalProceeding) -> None:
        """On top of IAM ``update`` and an open proceeding (``access.load``)."""
        if not (is_admin(self.user) or self.access.is_primary_owner(proceeding)):
            raise HTTPException(status_code=403, detail="Only the proceeding's creator or an admin can assign employees")

    async def _current_ids(self, proceeding: LegalProceeding) -> list[int]:
        return [r.user_id for r in (await self.repo.assignees_for([proceeding.id]))[proceeding.id]]

    async def _apply(self, proceeding: LegalProceeding, user_ids: list[int]) -> None:
        """Bring the assigned users to exactly ``user_ids`` — the single place that
        writes assignments. Checks the users (shared rule: exist and active), never
        accepts the creator, writes only the difference and one audit entry per user
        added or removed. Flushes only: the caller's transaction commits everything
        (with the proceeding itself on creation), or rolls it all back."""
        wanted = list(dict.fromkeys(user_ids))
        if proceeding.created_by in wanted:
            raise legal_error(422, "creator_is_owner", "The creator is already the proceeding's primary owner")
        users = await load_active_users(
            UserRepository(self.db), wanted,
            not_found=lambda uid: legal_error(422, "user_not_assignable", "The user does not exist or is not active",
                                              user_id=uid))
        rows = {r.user_id: r for r in (await self.repo.assignees_for([proceeding.id]))[proceeding.id]}
        for user_id, row in rows.items():
            if user_id in wanted:
                continue
            await self.repo.delete_assignee(row)
            await self.audit.log_action(self.user.id, LegalEvent.ASSIGNEE_REMOVED, LEGAL_PROCEEDING_AUDIT_ENTITY,
                                        str(proceeding.id), {"user_id": user_id, "assigned_by": row.assigned_by,
                                                             "assigned_at": row.assigned_at.isoformat()})
        for target in users:
            if target.id in rows:
                continue
            await self.repo.add(LegalProceedingAssignee(proceeding_id=proceeding.id, user_id=target.id,
                                                        assigned_by=self.user.id, assigned_at=utc_now()))
            await self.audit.log_action(self.user.id, LegalEvent.ASSIGNEE_ADDED, LEGAL_PROCEEDING_AUDIT_ENTITY,
                                        str(proceeding.id), {"user_id": target.id, "full_name": target.full_name})

    async def assign_on_create(self, proceeding: LegalProceeding, user_ids: list[int]) -> None:
        """Assignments sent with a new proceeding, in its creation transaction. None
        sent: nothing is checked, so ``write`` alone still opens a proceeding. Any
        sent: the same rule as assigning later (IAM ``update``; the creator is the
        primary owner and the proceeding is open)."""
        if not user_ids:
            return
        await self.access.require(Action.UPDATE.value)
        self._require_can_assign(proceeding)
        await self._apply(proceeding, user_ids)

    async def replace(self, proceeding: LegalProceeding, user_ids: list[int]) -> None:
        """The full set sent with ``PATCH`` (``[]`` removes everyone). ``proceeding``
        was loaded for ``update`` on an open proceeding. As in collection, re-sending
        the unchanged set is ignored for a user who may not change it."""
        if set(user_ids) == set(await self._current_ids(proceeding)):
            return
        self._require_can_assign(proceeding)
        await self._apply(proceeding, user_ids)

    async def team(self, proceeding_id: int) -> Team:
        proceeding = await self.access.load(proceeding_id)
        rows = (await self.repo.assignees_for([proceeding.id]))[proceeding.id]
        users = await UserRepository(self.db).users_by_id([proceeding.created_by] + [r.user_id for r in rows]
                                            + [r.assigned_by for r in rows])
        return Team(users.get(proceeding.created_by),
                    [AssigneeView(users[r.user_id], users.get(r.assigned_by), r.assigned_at) for r in rows])

    async def assign(self, proceeding_id: int, user_id: int) -> Team:
        """One user (``POST …/assignees``, kept for existing clients) — the current set plus one."""
        proceeding = await self._load_for_assign(proceeding_id)
        current = await self._current_ids(proceeding)
        if user_id in current:
            raise legal_error(409, "already_assigned", "The user is already assigned", user_id=user_id)
        await self._apply(proceeding, current + [user_id])
        return await self.team(proceeding.id)

    async def unassign(self, proceeding_id: int, user_id: int) -> Team:
        """One user (``DELETE …/assignees/{user_id}``) — the current set minus one."""
        proceeding = await self._load_for_assign(proceeding_id)
        current = await self._current_ids(proceeding)
        if user_id not in current:
            raise HTTPException(status_code=404, detail="The user is not assigned to this proceeding")
        await self._apply(proceeding, [uid for uid in current if uid != user_id])
        return await self.team(proceeding.id)
