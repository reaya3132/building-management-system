# [PermSys-Core-007]
"""Concrete implementations of the IAM repository interfaces.

These classes use async SQLAlchemy to persist role assignments and
resource policies. The engine depends on the ABCs, not on these classes
directly -- the wiring happens through dependency injection at app
startup.
"""

from __future__ import annotations

import json
import logging
from typing import Sequence

from sqlalchemy import select, delete as sa_delete, and_

logger = logging.getLogger(__name__)
from sqlalchemy.ext.asyncio import AsyncSession

from backend.iam.interfaces import RoleRepository, PermissionProvider
from backend.iam.models import (
    ProjectRoleAssignment,
    ResourcePolicy,
    PermissionAuditLog,
)
from backend.iam.enums import GlobalRole, ProjectRole, Action, ResourceType
from backend.models.user import User
from backend.models.project import Project


# ---------------------------------------------------------------------------
# Role policies: which actions each role is allowed per resource type
# Extension point: add entries here when new roles or resources are created.
# ---------------------------------------------------------------------------

_ALL_ACTIONS: set[str] = {a.value for a in Action}

_GLOBAL_ROLE_POLICIES: dict[str, dict[str, set[str]]] = {
    GlobalRole.SUPER_ADMIN.value: {
        # SuperAdmin can do everything on every resource type
        rt.value: {a.value for a in Action}
        for rt in ResourceType
    },
    GlobalRole.ADMIN.value: {
        ResourceType.PROJECT.value: _ALL_ACTIONS,
        ResourceType.TRANSACTION.value: _ALL_ACTIONS,
        ResourceType.BUDGET.value: _ALL_ACTIONS,
        ResourceType.REPORT.value: {Action.READ.value, Action.WRITE.value},
        ResourceType.USER.value: _ALL_ACTIONS,
        ResourceType.SUPPLIER.value: _ALL_ACTIONS,
        ResourceType.TASK.value: _ALL_ACTIONS,
        # Collection tasks: read / write (create, add amounts and items) / update
        # (edit, status incl. reopen, archive and unarchive). No DELETE: collection
        # tasks and their financial data are never deleted.
        ResourceType.COLLECTION_TASK.value: {
            Action.READ.value, Action.WRITE.value, Action.UPDATE.value,
        },
        ResourceType.CATEGORY.value: _ALL_ACTIONS,
        ResourceType.AUDIT_LOG.value: {Action.READ.value},
        ResourceType.CONTRACT.value: _ALL_ACTIONS,
        ResourceType.QUOTE.value: _ALL_ACTIONS,
        ResourceType.MEMBER_INVITE.value: _ALL_ACTIONS,
        ResourceType.ADMIN_INVITE.value: _ALL_ACTIONS,
        ResourceType.NOTIFICATION.value: {Action.READ.value},
        ResourceType.DASHBOARD.value: {Action.READ.value},
        ResourceType.CEMS_WAREHOUSE.value: _ALL_ACTIONS,
        ResourceType.CEMS_CONSUMABLE.value: _ALL_ACTIONS,
        ResourceType.CEMS_FIXED_ASSET.value: _ALL_ACTIONS,
        ResourceType.CEMS_TRANSFER.value: _ALL_ACTIONS,
        ResourceType.CEMS_WAREHOUSE_RETURN.value: _ALL_ACTIONS,
        ResourceType.CEMS_RETIREMENT.value: _ALL_ACTIONS,
        ResourceType.CEMS_DOCUMENT.value: _ALL_ACTIONS,
        ResourceType.CEMS_REPORT.value: _ALL_ACTIONS,
        # Admins fully manage the Building Reception Desk (buildings, apartments,
        # keys, tenants, vehicles, deliveries).
        ResourceType.BUILDING_RECEPTION.value: _ALL_ACTIONS,
        # Structural building/project management is admin-only: only admins may
        # create, edit or delete whole buildings and their projects. Desk
        # operators keep BUILDING_RECEPTION access for the contents.
        ResourceType.BUILDING.value: _ALL_ACTIONS,
    },
    GlobalRole.MEMBER.value: {
        # Members get an empty permission set on every resource by default...
        **{rt.value: set() for rt in ResourceType},
        # ...except they may CREATE (write) tasks for any user via the task
        # calendar. Read/update/delete remain denied so Members cannot edit or
        # delete shared task labels gated by the generic "task" resource.
        ResourceType.TASK.value: {Action.WRITE.value},
        # The Building Reception Desk is admin-managed by default; Members get
        # no access unless explicitly granted (keeps the Member baseline to
        # task-write only). Grant per-user later if non-admin desk operators
        # are needed.
    },
}

_PROJECT_ROLE_POLICIES: dict[str, dict[str, set[str]]] = {
    ProjectRole.MANAGER.value: {
        ResourceType.PROJECT.value: _ALL_ACTIONS,
        ResourceType.TRANSACTION.value: _ALL_ACTIONS,
        ResourceType.BUDGET.value: _ALL_ACTIONS,
        ResourceType.SUPPLIER.value: _ALL_ACTIONS,
        ResourceType.TASK.value: _ALL_ACTIONS,
        ResourceType.CONTRACT.value: _ALL_ACTIONS,
        ResourceType.CATEGORY.value: {Action.READ.value, Action.WRITE.value},
        ResourceType.REPORT.value: {Action.READ.value, Action.WRITE.value},
    },
    ProjectRole.CONTRIBUTOR.value: {
        ResourceType.PROJECT.value: {Action.READ.value},
        ResourceType.TRANSACTION.value: {Action.READ.value, Action.WRITE.value, Action.UPDATE.value},
        ResourceType.BUDGET.value: {Action.READ.value},
        ResourceType.REPORT.value: {Action.READ.value},
        ResourceType.SUPPLIER.value: {Action.READ.value},
        ResourceType.TASK.value: {Action.READ.value, Action.WRITE.value, Action.UPDATE.value},
        ResourceType.CATEGORY.value: {Action.READ.value},
        ResourceType.CONTRACT.value: {Action.READ.value},
    },
    ProjectRole.VIEWER.value: {
        ResourceType.PROJECT.value: {Action.READ.value},
        ResourceType.TRANSACTION.value: {Action.READ.value},
        ResourceType.BUDGET.value: {Action.READ.value},
        ResourceType.REPORT.value: {Action.READ.value},
        ResourceType.SUPPLIER.value: {Action.READ.value},
        ResourceType.TASK.value: {Action.READ.value},
        ResourceType.CATEGORY.value: {Action.READ.value},
        ResourceType.CONTRACT.value: {Action.READ.value},
    },
}


class SQLAlchemyRoleRepository(RoleRepository):
    """Async SQLAlchemy implementation of RoleRepository."""

    def __init__(self, db: AsyncSession) -> None:
        self._db = db

    async def get_user_global_role(self, user_id: int) -> str | None:
        """Fetch the global role from the users table."""
        result = await self._db.execute(
            select(User.role).where(User.id == user_id)
        )
        row = result.scalar_one_or_none()
        return row if row else None

    async def get_user_project_roles(
        self, user_id: int, project_id: int | None = None
    ) -> list[dict[str, str | int]]:
        """Fetch project-role assignments from iam_project_role_assignments."""
        stmt = select(ProjectRoleAssignment).where(
            ProjectRoleAssignment.user_id == user_id
        )
        if project_id is not None:
            stmt = stmt.where(ProjectRoleAssignment.project_id == project_id)
        result = await self._db.execute(stmt)
        rows = result.scalars().all()

        # Also check if user is the project manager (legacy relationship)
        manager_projects: list[int] = []
        if project_id is not None:
            mgr_result = await self._db.execute(
                select(Project.id).where(
                    and_(Project.id == project_id, Project.manager_id == user_id)
                )
            )
            manager_projects = [r for r in mgr_result.scalars().all()]
        else:
            mgr_result = await self._db.execute(
                select(Project.id).where(Project.manager_id == user_id)
            )
            manager_projects = [r for r in mgr_result.scalars().all()]

        assignments: list[dict[str, str | int]] = [
            {"project_id": r.project_id, "role": r.role} for r in rows
        ]

        # Merge manager_id-based implicit role (avoid duplicates)
        existing_pids = {a["project_id"] for a in assignments}
        for pid in manager_projects:
            if pid not in existing_pids:
                assignments.append(
                    {"project_id": pid, "role": ProjectRole.MANAGER.value}
                )

        return assignments

    async def assign_project_role(
        self, user_id: int, project_id: int, role: str
    ) -> None:
        """Create or update a project role assignment."""
        result = await self._db.execute(
            select(ProjectRoleAssignment).where(
                and_(
                    ProjectRoleAssignment.user_id == user_id,
                    ProjectRoleAssignment.project_id == project_id,
                )
            )
        )
        existing = result.scalar_one_or_none()
        if existing:
            existing.role = role
        else:
            self._db.add(
                ProjectRoleAssignment(
                    user_id=user_id, project_id=project_id, role=role
                )
            )
        await self._db.flush()

    async def revoke_project_role(
        self, user_id: int, project_id: int, role: str
    ) -> None:
        """Delete a project role assignment."""
        await self._db.execute(
            sa_delete(ProjectRoleAssignment).where(
                and_(
                    ProjectRoleAssignment.user_id == user_id,
                    ProjectRoleAssignment.project_id == project_id,
                    ProjectRoleAssignment.role == role,
                )
            )
        )
        await self._db.flush()

    async def get_project_members(
        self, project_id: int
    ) -> Sequence[dict[str, str | int]]:
        """Return all users with a role in the given project."""
        result = await self._db.execute(
            select(
                ProjectRoleAssignment.user_id,
                ProjectRoleAssignment.role,
                User.full_name,
                User.email,
            )
            .join(User, User.id == ProjectRoleAssignment.user_id)
            .where(ProjectRoleAssignment.project_id == project_id)
        )
        rows = result.all()
        members: list[dict[str, str | int]] = [
            {
                "user_id": r.user_id,
                "role": r.role,
                "full_name": r.full_name,
                "email": r.email,
            }
            for r in rows
        ]

        # Include the legacy manager_id relationship
        mgr_result = await self._db.execute(
            select(Project.manager_id).where(Project.id == project_id)
        )
        manager_id = mgr_result.scalar_one_or_none()
        if manager_id and not any(m["user_id"] == manager_id for m in members):
            mgr_user_result = await self._db.execute(
                select(User.full_name, User.email).where(User.id == manager_id)
            )
            mgr_user = mgr_user_result.one_or_none()
            if mgr_user:
                members.append(
                    {
                        "user_id": manager_id,
                        "role": ProjectRole.MANAGER.value,
                        "full_name": mgr_user.full_name,
                        "email": mgr_user.email,
                    }
                )

        return members


class SQLAlchemyPermissionProvider(PermissionProvider):
    """Async SQLAlchemy implementation of PermissionProvider.

    Resolution order (first match wins):
    1. Explicit DENY resource policy -> denied
    2. Explicit ALLOW resource policy -> allowed
    3. Project-level role policies -> allowed/denied
    4. Global-level role policies -> allowed/denied
    5. Default -> denied
    """

    def __init__(self, db: AsyncSession) -> None:
        self._db = db
        self._role_repo = SQLAlchemyRoleRepository(db)

    async def has_permission(
        self,
        user_id: int,
        action: str,
        resource_type: str,
        resource_id: int | str | None = None,
        domain: str | None = None,
    ) -> bool:
        """Evaluate permission using the resolution chain described above."""
        try:
            # 1. Check explicit resource-level policies
            if resource_id is not None:
                resource_result = await self._check_resource_policy(
                    user_id, action, resource_type, str(resource_id)
                )
                if resource_result is not None:
                    return resource_result

            # 1b. Check wildcard resource policy ("*" applies to all instances)
            wildcard_result = await self._check_resource_policy(
                user_id, action, resource_type, "*"
            )
            if wildcard_result is not None:
                return wildcard_result

            # 2. Check project-level role policies
            project_id = await self._resolve_project_id(domain, resource_type, resource_id)
            if project_id is not None:
                project_result = await self._check_project_role(
                    user_id, action, resource_type, project_id
                )
                if project_result:
                    return True

            # 3. Check global role policies
            return await self._check_global_role(user_id, action, resource_type)

        except Exception as e:
            logger.error("שגיאה בבדיקת הרשאה (user_id=%s, action=%s, resource=%s): %s", user_id, action, resource_type, e, exc_info=True)
            return False

    async def get_user_permissions(
        self,
        user_id: int,
        domain: str | None = None,
    ) -> list[dict[str, str]]:
        """Aggregate all permissions for a user."""
        permissions: list[dict[str, str]] = []

        # Global role permissions
        global_role = await self._role_repo.get_user_global_role(user_id)
        if global_role and global_role in _GLOBAL_ROLE_POLICIES:
            for rt, actions in _GLOBAL_ROLE_POLICIES[global_role].items():
                for a in actions:
                    permissions.append(
                        {"resource_type": rt, "action": a, "source": f"global:{global_role}"}
                    )

        # Project role permissions
        project_id = int(domain) if domain and domain.isdigit() else None
        proj_roles = await self._role_repo.get_user_project_roles(user_id, project_id)
        for pr in proj_roles:
            role_name = str(pr["role"])
            pid = pr["project_id"]
            if role_name in _PROJECT_ROLE_POLICIES:
                for rt, actions in _PROJECT_ROLE_POLICIES[role_name].items():
                    for a in actions:
                        permissions.append(
                            {
                                "resource_type": rt,
                                "action": a,
                                "source": f"project:{pid}:{role_name}",
                            }
                        )

        # Explicit resource policies
        result = await self._db.execute(
            select(ResourcePolicy).where(ResourcePolicy.user_id == user_id)
        )
        for rp in result.scalars().all():
            permissions.append(
                {
                    "resource_type": rp.resource_type,
                    "action": rp.action,
                    "resource_id": rp.resource_id,
                    "effect": "allow",
                    "source": "resource_policy",
                }
            )

        return permissions

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    async def _check_resource_policy(
        self,
        user_id: int,
        action: str,
        resource_type: str,
        resource_id: str,
    ) -> bool | None:
        """Check explicit resource-level policies. Returns True/False if a
        matching policy exists, or None if no policy applies."""
        result = await self._db.execute(
            select(ResourcePolicy).where(
                and_(
                    ResourcePolicy.user_id == user_id,
                    ResourcePolicy.resource_type == resource_type,
                    ResourcePolicy.resource_id == resource_id,
                    ResourcePolicy.action == action,
                )
            )
        )
        policy = result.scalar_one_or_none()
        if policy is None:
            return None
        return True  # A policy existing always means "allow" now

    async def _check_project_role(
        self,
        user_id: int,
        action: str,
        resource_type: str,
        project_id: int,
    ) -> bool:
        """Check if any of the user's project roles grant the action."""
        roles = await self._role_repo.get_user_project_roles(user_id, project_id)
        for role_entry in roles:
            role_name = str(role_entry["role"])
            allowed_actions = (
                _PROJECT_ROLE_POLICIES.get(role_name, {}).get(resource_type, set())
            )
            if action in allowed_actions:
                return True
        return False

    async def _check_global_role(
        self,
        user_id: int,
        action: str,
        resource_type: str,
    ) -> bool:
        """Check if the user's global role grants the action."""
        global_role = await self._role_repo.get_user_global_role(user_id)
        if not global_role:
            return False
        allowed_actions = (
            _GLOBAL_ROLE_POLICIES.get(global_role, {}).get(resource_type, set())
        )
        return action in allowed_actions

    async def _resolve_project_id(
        self,
        domain: str | None,
        resource_type: str,
        resource_id: int | str | None,
    ) -> int | None:
        """Resolve project_id either from explicit domain or by looking up the resource.

        Today we only support resolving from the domain string (when provided)
        and from a transaction's project_id when the resource_type is "transaction".
        """
        # Preferred: explicit domain (usually taken from project_id path/query param)
        if domain is not None:
            try:
                return int(domain)
            except (ValueError, TypeError):
                return None

        # Fallback: infer project_id from the resource itself for known resource types
        if resource_type == ResourceType.TRANSACTION.value and resource_id is not None:
            from backend.models.transaction import Transaction

            try:
                tx_id = int(resource_id)
            except (ValueError, TypeError):
                return None

            result = await self._db.execute(
                select(Transaction.project_id).where(Transaction.id == tx_id)
            )
            project_id = result.scalar_one_or_none()
            return project_id

        return None
