"""Operational assignment of employees to a legal proceeding.

The creator is the primary owner (``legal_proceedings.created_by``) and is never
listed here. Only the creator or an Admin assigns / unassigns (plus the IAM
``update`` action); an assigned employee cannot assign others. Assignment grants
visibility of the proceeding; what the employee may then do is still decided by
their IAM permissions. Every change is recorded in ``audit_logs``.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

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
from backend.services.legal_access import LegalAccess, is_admin, legal_error


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


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
        if not (is_admin(self.user) or self.access.is_primary_owner(proceeding)):
            raise HTTPException(status_code=403, detail="Only the proceeding's creator or an admin can assign employees")
        return proceeding

    async def team(self, proceeding_id: int) -> Team:
        proceeding = await self.access.load(proceeding_id)
        rows = (await self.repo.assignees_for([proceeding.id]))[proceeding.id]
        users = await self.repo.users_by_id([proceeding.created_by] + [r.user_id for r in rows]
                                            + [r.assigned_by for r in rows])
        return Team(users.get(proceeding.created_by),
                    [AssigneeView(users[r.user_id], users.get(r.assigned_by), r.assigned_at) for r in rows])

    async def assign(self, proceeding_id: int, user_id: int) -> Team:
        proceeding = await self._load_for_assign(proceeding_id)
        if user_id == proceeding.created_by:
            raise legal_error(422, "creator_is_owner", "The creator is already the proceeding's primary owner")
        target = await UserRepository(self.db).get_by_id(user_id)
        if target is None or not target.is_active or target.archived_at is not None:
            raise legal_error(422, "user_not_assignable", "The user does not exist or is not active", user_id=user_id)
        if await self.repo.get_assignee(proceeding.id, user_id) is not None:
            raise legal_error(409, "already_assigned", "The user is already assigned", user_id=user_id)
        await self.repo.add(LegalProceedingAssignee(proceeding_id=proceeding.id, user_id=user_id,
                                                    assigned_by=self.user.id, assigned_at=_now()))
        await self.audit.log_action(self.user.id, LegalEvent.ASSIGNEE_ADDED, LEGAL_PROCEEDING_AUDIT_ENTITY,
                                    str(proceeding.id), {"user_id": user_id, "full_name": target.full_name})
        return await self.team(proceeding.id)

    async def unassign(self, proceeding_id: int, user_id: int) -> Team:
        proceeding = await self._load_for_assign(proceeding_id)
        row = await self.repo.get_assignee(proceeding.id, user_id)
        if row is None:
            raise HTTPException(status_code=404, detail="The user is not assigned to this proceeding")
        await self.repo.delete_assignee(row)
        await self.audit.log_action(self.user.id, LegalEvent.ASSIGNEE_REMOVED, LEGAL_PROCEEDING_AUDIT_ENTITY,
                                    str(proceeding.id), {"user_id": user_id, "assigned_by": row.assigned_by,
                                                         "assigned_at": row.assigned_at.isoformat()})
        return await self.team(proceeding.id)
