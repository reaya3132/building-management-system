"""Moving users to the archive instead of deleting them.

Archiving keeps the user row and every business/historical record that
references it (projects, transactions, tasks, notifications, audit logs).
It only:
  - deactivates the account (``is_active=False``), which every authentication
    path already rejects (login, OAuth, token refresh, ``get_current_user``),
  - stamps ``archived_at`` so the user is listed only in the archive,
  - revokes the user's permission grants (IAM project roles, resource
    policies such as building-reception access, and CEMS role/warehouse).

All of the above, plus the audit entries holding the restore snapshot, are
committed in a single transaction: either everything is saved or nothing is.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.config import settings
from backend.iam.models import PermissionAuditLog, ProjectRoleAssignment, ResourcePolicy
from backend.models.cems_warehouse import Warehouse
from backend.models.user import User
from backend.repositories.user_repository import UserRepository
from backend.services.audit_service import AuditService

# Bump when the snapshot structure changes so a future restore can parse old entries.
SNAPSHOT_VERSION = 1

SUPER_ADMIN_ROLE = "SuperAdmin"


def is_super_admin(user: User) -> bool:
    """The env-seeded super admin (by email) or any user holding the SuperAdmin role."""
    if user.role == SUPER_ADMIN_ROLE:
        return True
    return bool(settings.SUPER_ADMIN_EMAIL) and user.email.lower() == settings.SUPER_ADMIN_EMAIL.lower()


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


class UserArchiveService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.users = UserRepository(db)

    async def list_archived(self) -> list[User]:
        return await self.users.list_archived()

    async def archive(self, user_id: int, actor: User) -> User:
        user = await self.users.get_by_id(user_id)
        if not user:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
        if user_id == actor.id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="You cannot archive yourself",
            )
        if user.archived_at is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="User is already archived",
            )
        if is_super_admin(user):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="The super admin cannot be archived",
            )
        await self._ensure_not_warehouse_manager(user)

        try:
            snapshot = await self._revoke_permissions(user)

            user.is_active = False
            user.archived_at = datetime.now(UTC).replace(tzinfo=None)  # naive UTC for DB
            self.db.add(user)

            await AuditService(self.db).log_user_action(
                user_id=actor.id,
                action="archive",
                target_user_id=user_id,
                details={
                    "email": user.email,
                    "full_name": user.full_name,
                    "restore_snapshot": snapshot,
                },
            )
            self.db.add(
                PermissionAuditLog(
                    actor_user_id=actor.id,
                    target_user_id=user_id,
                    action="archive_revoke_all",
                    detail=json.dumps(snapshot, ensure_ascii=False),
                )
            )
            # Single commit: archive flags, revoked grants and audit entries are saved together.
            await self.db.commit()
        except Exception:
            await self.db.rollback()
            raise

        await self.db.refresh(user)
        return user

    async def _ensure_not_warehouse_manager(self, user: User) -> None:
        """A warehouse's current manager gates CEMS approvals, and the manager history
        requires a new manager, so the warehouse must be reassigned before archiving."""
        res = await self.db.execute(
            select(Warehouse.name).where(Warehouse.current_manager_id == user.id)
        )
        managed = [name for (name,) in res.all()]
        if managed:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    "המשתמש מנהל מחסנים פעילים. יש להעביר את ניהולם למשתמש אחר לפני העברה לארכיון: "
                    + ", ".join(managed)
                ),
            )

    async def _revoke_permissions(self, user: User) -> dict[str, Any]:
        """Remove every permission grant held by the user and return a full snapshot
        of what was removed, sufficient to restore it later. Does not commit."""
        roles = (await self.db.execute(
            select(ProjectRoleAssignment).where(ProjectRoleAssignment.user_id == user.id)
        )).scalars().all()
        policies = (await self.db.execute(
            select(ResourcePolicy).where(ResourcePolicy.user_id == user.id)
        )).scalars().all()

        snapshot: dict[str, Any] = {
            "version": SNAPSHOT_VERSION,
            "user": {
                "role": user.role,
                "group_id": user.group_id,
                "is_active": user.is_active,
                "cems_role": user.cems_role,
                "cems_warehouse_id": str(user.cems_warehouse_id) if user.cems_warehouse_id else None,
            },
            "project_roles": [
                {
                    "project_id": r.project_id,
                    "role": r.role,
                    "assigned_by": r.assigned_by,
                    "created_at": _iso(r.created_at),
                    "updated_at": _iso(r.updated_at),
                }
                for r in roles
            ],
            "resource_policies": [
                {
                    "resource_type": p.resource_type,
                    "resource_id": p.resource_id,
                    "action": p.action,
                    "effect": p.effect,
                    "granted_by": p.granted_by,
                    "created_at": _iso(p.created_at),
                    "updated_at": _iso(p.updated_at),
                }
                for p in policies
            ],
        }

        await self.db.execute(delete(ProjectRoleAssignment).where(ProjectRoleAssignment.user_id == user.id))
        await self.db.execute(delete(ResourcePolicy).where(ResourcePolicy.user_id == user.id))
        user.cems_role = None
        user.cems_warehouse_id = None
        return snapshot
