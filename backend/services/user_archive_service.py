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

Restoring reverses an archive from that snapshot: the account is reactivated,
``archived_at`` is cleared and every revoked grant is re-created, skipping
(and reporting) grants whose target no longer exists. Also one transaction.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.config import settings
from backend.iam.models import PermissionAuditLog, ProjectRoleAssignment, ResourcePolicy
from backend.models.audit_log import AuditLog
from backend.models.budget import Budget
from backend.models.building import Building
from backend.models.category import Category
from backend.models.cems_warehouse import Warehouse
from backend.models.project import Project
from backend.models.supplier import Supplier
from backend.models.task import Task
from backend.models.transaction import Transaction
from backend.models.user import User
from backend.repositories.user_repository import UserRepository
from backend.services.audit_service import AuditService

logger = logging.getLogger(__name__)

# Bump when the snapshot structure changes so a future restore can parse old entries.
SNAPSHOT_VERSION = 1

# Resource-policy types whose ``resource_id`` is the integer id of a row in one
# table, so restore can check the target still exists. Wildcard ("*") policies
# and types without a single backing row (reports, dashboards, ...) are restored as-is.
_POLICY_TARGET_MODELS: dict[str, type] = {
    "project": Project,
    "building": Building,
    "building_reception": Building,
    "transaction": Transaction,
    "task": Task,
    "supplier": Supplier,
    "budget": Budget,
    "category": Category,
    "user": User,
}

SUPER_ADMIN_ROLE = "SuperAdmin"


def is_super_admin(user: User) -> bool:
    """The env-seeded super admin (by email) or any user holding the SuperAdmin role."""
    if user.role == SUPER_ADMIN_ROLE:
        return True
    return bool(settings.SUPER_ADMIN_EMAIL) and user.email.lower() == settings.SUPER_ADMIN_EMAIL.lower()


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _created_at(entry: dict[str, Any]) -> dict[str, datetime]:
    """Original grant time from the snapshot (inverse of ``_iso``); omitted when
    missing so the column default applies instead of an explicit NULL."""
    value = entry.get("created_at")
    return {"created_at": datetime.fromisoformat(value)} if value else {}


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

    async def restore(self, user_id: int, actor: User) -> tuple[User, dict[str, Any]]:
        """Return an archived user to the state they had before archiving.

        Returns the user and a report of what was restored and what was skipped
        because its target no longer exists (or was granted again meanwhile).
        """
        user = await self.users.get_by_id(user_id)
        if not user:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
        if user.archived_at is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="User is not archived",
            )
        snapshot = await self._load_snapshot(user_id)

        try:
            report = await self._restore_permissions(user, snapshot)

            user.is_active = True
            user.archived_at = None
            self.db.add(user)

            await AuditService(self.db).log_user_action(
                user_id=actor.id,
                action="restore",
                target_user_id=user_id,
                details={
                    "email": user.email,
                    "full_name": user.full_name,
                    "restore_report": report,
                },
            )
            self.db.add(
                PermissionAuditLog(
                    actor_user_id=actor.id,
                    target_user_id=user_id,
                    action="restore_grants",
                    detail=json.dumps(report, ensure_ascii=False),
                )
            )
            # Single commit: reactivation, re-created grants and audit entries are saved together.
            await self.db.commit()
        except Exception:
            await self.db.rollback()
            raise

        if report["skipped"]:
            logger.warning(
                "User %s restored with %d skipped grant(s): %s",
                user_id, len(report["skipped"]), report["skipped"],
            )
        await self.db.refresh(user)
        return user, report

    async def _load_snapshot(self, user_id: int) -> dict[str, Any] | None:
        """The snapshot saved by the most recent archive of this user, if any."""
        log = (await self.db.execute(
            select(AuditLog)
            .where(
                AuditLog.entity == "user",
                AuditLog.entity_id == str(user_id),
                AuditLog.action == "archive",
            )
            .order_by(AuditLog.id.desc())
            .limit(1)
        )).scalar_one_or_none()
        if log is None or not log.details:
            logger.warning("No archive snapshot found for user %s; restoring without grants", user_id)
            return None

        snapshot = json.loads(log.details).get("restore_snapshot")
        if snapshot is None:
            logger.warning("Archive entry %s for user %s has no snapshot; restoring without grants", log.id, user_id)
            return None
        if snapshot.get("version") != SNAPSHOT_VERSION:
            # Refuse rather than silently dropping grants we cannot interpret.
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Unsupported archive snapshot version: {snapshot.get('version')}",
            )
        return snapshot

    async def _restore_permissions(self, user: User, snapshot: dict[str, Any] | None) -> dict[str, Any]:
        """Re-create the grants recorded in the snapshot. Does not commit."""
        report: dict[str, Any] = {
            "snapshot_found": snapshot is not None,
            "restored_project_roles": [],
            "restored_resource_policies": [],
            "restored_cems_role": None,
            "restored_cems_warehouse_id": None,
            "skipped": [],
        }
        if snapshot is None:
            return report

        def skip(kind: str, item: Any, reason: str) -> None:
            report["skipped"].append({"kind": kind, "item": item, "reason": reason})

        for entry in snapshot.get("project_roles", []):
            if await self.db.get(Project, entry["project_id"]) is None:
                skip("project_role", entry, "project_not_found")
                continue
            existing = (await self.db.execute(
                select(ProjectRoleAssignment.id).where(
                    ProjectRoleAssignment.user_id == user.id,
                    ProjectRoleAssignment.project_id == entry["project_id"],
                )
            )).first()
            if existing:
                skip("project_role", entry, "already_exists")
                continue
            self.db.add(ProjectRoleAssignment(
                user_id=user.id,
                project_id=entry["project_id"],
                role=entry["role"],
                assigned_by=await self._existing_user_id(entry.get("assigned_by")),
                **_created_at(entry),
            ))
            report["restored_project_roles"].append(entry)

        for entry in snapshot.get("resource_policies", []):
            if not await self._policy_target_exists(entry["resource_type"], entry["resource_id"]):
                skip("resource_policy", entry, "resource_not_found")
                continue
            existing = (await self.db.execute(
                select(ResourcePolicy.id).where(
                    ResourcePolicy.user_id == user.id,
                    ResourcePolicy.resource_type == entry["resource_type"],
                    ResourcePolicy.resource_id == entry["resource_id"],
                    ResourcePolicy.action == entry["action"],
                )
            )).first()
            if existing:
                skip("resource_policy", entry, "already_exists")
                continue
            self.db.add(ResourcePolicy(
                user_id=user.id,
                resource_type=entry["resource_type"],
                resource_id=entry["resource_id"],
                action=entry["action"],
                effect=entry.get("effect") or "allow",
                granted_by=await self._existing_user_id(entry.get("granted_by")),
                **_created_at(entry),
            ))
            report["restored_resource_policies"].append(entry)

        user_state = snapshot.get("user", {})
        if user_state.get("cems_role"):
            user.cems_role = user_state["cems_role"]
            report["restored_cems_role"] = user_state["cems_role"]
        warehouse_id = user_state.get("cems_warehouse_id")
        if warehouse_id:
            warehouse = None
            try:
                warehouse = await self.db.get(Warehouse, uuid.UUID(warehouse_id))
            except ValueError:
                pass
            if warehouse is None:
                skip("cems_warehouse", warehouse_id, "warehouse_not_found")
            else:
                user.cems_warehouse_id = warehouse.id
                report["restored_cems_warehouse_id"] = warehouse_id

        await self.db.flush()
        return report

    async def _policy_target_exists(self, resource_type: str, resource_id: str) -> bool:
        if resource_id == "*":
            return True
        model = _POLICY_TARGET_MODELS.get(resource_type)
        if model is None:
            return True  # not backed by a single row - nothing to check
        try:
            target_id = int(resource_id)
        except (TypeError, ValueError):
            return False
        return await self.db.get(model, target_id) is not None

    async def _existing_user_id(self, user_id: int | None) -> int | None:
        """Keep a grantor reference only if that user still exists (mirrors FK SET NULL)."""
        if user_id is None:
            return None
        return user_id if await self.db.get(User, user_id) is not None else None

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
