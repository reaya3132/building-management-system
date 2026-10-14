"""
Tests for restoring users from the archive.
"""
import json
import uuid
from datetime import datetime
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.iam.models import PermissionAuditLog, ProjectRoleAssignment, ResourcePolicy
from backend.models.audit_log import AuditLog
from backend.models.cems_warehouse import Warehouse
from backend.models.user import User
from backend.services.user_archive_service import UserArchiveService

USERS = "/api/v1/users"
GRANTED_AT = datetime(2025, 3, 1, 9, 30, 0)


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


async def _archive(client: AsyncClient, token: str, user_id: int) -> None:
    response = await client.post(f"{USERS}/{user_id}/archive", headers=_auth(token))
    assert response.status_code == 200, response.text


async def _restore(client: AsyncClient, token: str, user_id: int):
    return await client.post(f"{USERS}/{user_id}/restore", headers=_auth(token))


async def _roles(db: AsyncSession, user_id: int) -> list[ProjectRoleAssignment]:
    return list((await db.execute(
        select(ProjectRoleAssignment).where(ProjectRoleAssignment.user_id == user_id)
    )).scalars().all())


async def _policies(db: AsyncSession, user_id: int) -> list[ResourcePolicy]:
    return list((await db.execute(
        select(ResourcePolicy).where(ResourcePolicy.user_id == user_id)
    )).scalars().all())


@pytest.mark.api
@pytest.mark.asyncio
class TestUserRestore:
    async def test_archived_user_is_restored(
        self, test_client: AsyncClient, test_db: AsyncSession, admin_token: str, member_user: User
    ):
        await _archive(test_client, admin_token, member_user.id)

        response = await _restore(test_client, admin_token, member_user.id)
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["user"]["id"] == member_user.id
        assert body["user"]["is_active"] is True
        assert body["report"]["snapshot_found"] is True
        assert body["report"]["skipped"] == []

        await test_db.refresh(member_user)
        assert member_user.is_active is True
        assert member_user.archived_at is None

        log = (await test_db.execute(
            select(AuditLog).where(AuditLog.entity == "user", AuditLog.action == "restore")
        )).scalar_one()
        assert log.entity_id == str(member_user.id)
        perm_log = (await test_db.execute(
            select(PermissionAuditLog).where(PermissionAuditLog.action == "restore_grants")
        )).scalar_one()
        assert perm_log.target_user_id == member_user.id

    async def test_restored_user_returns_to_lists(
        self, test_client: AsyncClient, admin_token: str, member_user: User
    ):
        await _archive(test_client, admin_token, member_user.id)
        await _restore(test_client, admin_token, member_user.id)

        regular = {u["id"] for u in (await test_client.get(f"{USERS}/", headers=_auth(admin_token))).json()}
        archived = {u["id"] for u in (await test_client.get(f"{USERS}/archived", headers=_auth(admin_token))).json()}
        for_tasks = {u["id"] for u in (await test_client.get(f"{USERS}/for-tasks", headers=_auth(admin_token))).json()}
        assert member_user.id in regular
        assert member_user.id not in archived
        assert member_user.id in for_tasks

    async def test_restored_user_can_log_in_and_refresh(
        self, test_client: AsyncClient, admin_token: str, member_user: User
    ):
        await _archive(test_client, admin_token, member_user.id)
        await _restore(test_client, admin_token, member_user.id)

        login = await test_client.post(
            "/api/v1/auth/login", json={"email": "member@test.com", "password": "testpass123"}
        )
        assert login.status_code == 200, login.text
        tokens = login.json()
        assert (await test_client.get(f"{USERS}/me", headers=_auth(tokens["access_token"]))).status_code == 200
        refresh = await test_client.post("/api/v1/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
        assert refresh.status_code == 200

    async def test_restored_user_can_be_edited_again(
        self, test_client: AsyncClient, admin_token: str, member_user: User
    ):
        await _archive(test_client, admin_token, member_user.id)
        blocked = await test_client.put(f"{USERS}/{member_user.id}", headers=_auth(admin_token), json={"full_name": "X"})
        assert blocked.status_code == 409

        await _restore(test_client, admin_token, member_user.id)
        edited = await test_client.put(f"{USERS}/{member_user.id}", headers=_auth(admin_token), json={"full_name": "X"})
        assert edited.status_code == 200

    async def test_all_snapshot_permissions_are_restored(
        self, test_client: AsyncClient, test_db: AsyncSession, admin_token: str,
        admin_user: User, member_user: User, test_project: dict
    ):
        warehouse = Warehouse(name="Store")
        test_db.add(warehouse)
        test_db.add(ProjectRoleAssignment(
            user_id=member_user.id, project_id=test_project["id"], role="editor",
            assigned_by=admin_user.id, created_at=GRANTED_AT,
        ))
        test_db.add(ResourcePolicy(
            user_id=member_user.id, resource_type="project", resource_id=str(test_project["id"]),
            action="write", effect="allow", granted_by=admin_user.id, created_at=GRANTED_AT,
        ))
        test_db.add(ResourcePolicy(
            user_id=member_user.id, resource_type="report", resource_id="*", action="read",
            granted_by=admin_user.id,
        ))
        await test_db.flush()
        member_user.cems_role = "Worker"
        member_user.cems_warehouse_id = warehouse.id
        await test_db.commit()

        await _archive(test_client, admin_token, member_user.id)
        assert await _roles(test_db, member_user.id) == []
        assert await _policies(test_db, member_user.id) == []

        response = await _restore(test_client, admin_token, member_user.id)
        assert response.status_code == 200, response.text
        report = response.json()["report"]
        assert len(report["restored_project_roles"]) == 1
        assert len(report["restored_resource_policies"]) == 2
        assert report["restored_cems_role"] == "Worker"
        assert report["restored_cems_warehouse_id"] == str(warehouse.id)
        assert report["skipped"] == []

        [role] = await _roles(test_db, member_user.id)
        assert (role.project_id, role.role, role.assigned_by) == (test_project["id"], "editor", admin_user.id)
        assert role.created_at == GRANTED_AT

        policies = {(p.resource_type, p.resource_id, p.action): p for p in await _policies(test_db, member_user.id)}
        assert set(policies) == {("project", str(test_project["id"]), "write"), ("report", "*", "read")}
        project_policy = policies[("project", str(test_project["id"]), "write")]
        assert project_policy.effect == "allow"
        assert project_policy.granted_by == admin_user.id
        assert project_policy.created_at == GRANTED_AT

        await test_db.refresh(member_user)
        assert member_user.cems_role == "Worker"
        assert member_user.cems_warehouse_id == warehouse.id

    async def test_missing_entities_are_skipped_without_failing(
        self, test_client: AsyncClient, test_db: AsyncSession, admin_token: str,
        admin_user: User, member_user: User, test_project: dict
    ):
        # Grants pointing at entities that will not exist at restore time
        # (SQLite does not enforce these foreign keys, which lets us seed them).
        test_db.add(ProjectRoleAssignment(user_id=member_user.id, project_id=test_project["id"], role="viewer"))
        test_db.add(ProjectRoleAssignment(user_id=member_user.id, project_id=999_999, role="viewer"))
        test_db.add(ResourcePolicy(
            user_id=member_user.id, resource_type="building_reception", resource_id="999999", action="read",
        ))
        test_db.add(ResourcePolicy(
            user_id=member_user.id, resource_type="project", resource_id=str(test_project["id"]), action="read",
            granted_by=888_888,  # grantor no longer exists
        ))
        member_user.cems_role = "Worker"
        member_user.cems_warehouse_id = uuid.uuid4()
        await test_db.commit()

        await _archive(test_client, admin_token, member_user.id)
        response = await _restore(test_client, admin_token, member_user.id)
        assert response.status_code == 200, response.text
        report = response.json()["report"]

        skipped = {(s["kind"], s["reason"]) for s in report["skipped"]}
        assert skipped == {
            ("project_role", "project_not_found"),
            ("resource_policy", "resource_not_found"),
            ("cems_warehouse", "warehouse_not_found"),
        }
        assert [r["project_id"] for r in report["restored_project_roles"]] == [test_project["id"]]
        assert len(report["restored_resource_policies"]) == 1

        [policy] = await _policies(test_db, member_user.id)
        assert policy.granted_by is None
        await test_db.refresh(member_user)
        assert member_user.is_active is True
        assert member_user.archived_at is None
        assert member_user.cems_role == "Worker"
        assert member_user.cems_warehouse_id is None

    async def test_grants_given_while_archived_are_not_duplicated(
        self, test_client: AsyncClient, test_db: AsyncSession, admin_token: str,
        member_user: User, test_project: dict
    ):
        test_db.add(ProjectRoleAssignment(user_id=member_user.id, project_id=test_project["id"], role="viewer"))
        await test_db.commit()
        await _archive(test_client, admin_token, member_user.id)

        test_db.add(ProjectRoleAssignment(user_id=member_user.id, project_id=test_project["id"], role="editor"))
        await test_db.commit()

        response = await _restore(test_client, admin_token, member_user.id)
        assert response.status_code == 200, response.text
        assert [(s["kind"], s["reason"]) for s in response.json()["report"]["skipped"]] == [
            ("project_role", "already_exists")
        ]
        [role] = await _roles(test_db, member_user.id)
        assert role.role == "editor"

    async def test_non_archived_user_conflicts(
        self, test_client: AsyncClient, admin_token: str, member_user: User
    ):
        response = await _restore(test_client, admin_token, member_user.id)
        assert response.status_code == 409

    async def test_unknown_user_not_found(self, test_client: AsyncClient, admin_token: str):
        response = await _restore(test_client, admin_token, 999_999)
        assert response.status_code == 404

    async def test_member_cannot_restore(
        self, test_client: AsyncClient, test_db: AsyncSession, admin_token: str,
        member_token: str, member_user: User
    ):
        other = User(email="other@test.com", full_name="Other", role="Member", is_active=True)
        test_db.add(other)
        await test_db.commit()
        await test_db.refresh(other)
        await _archive(test_client, admin_token, other.id)

        response = await _restore(test_client, member_token, other.id)
        assert response.status_code == 403
        await test_db.refresh(other)
        assert other.archived_at is not None

    async def test_unauthenticated_cannot_restore(self, test_client: AsyncClient, member_user: User):
        response = await test_client.post(f"{USERS}/{member_user.id}/restore")
        assert response.status_code == 401

    async def test_audit_failure_rolls_back_restore(
        self, test_client: AsyncClient, test_db: AsyncSession, admin_token: str,
        admin_user: User, member_user: User, test_project: dict
    ):
        test_db.add(ProjectRoleAssignment(user_id=member_user.id, project_id=test_project["id"], role="viewer"))
        member_user.cems_role = "Worker"
        await test_db.commit()
        await _archive(test_client, admin_token, member_user.id)

        with (
            patch(
                "backend.services.user_archive_service.AuditService.log_user_action",
                new=AsyncMock(side_effect=RuntimeError("audit down")),
            ),
            pytest.raises(RuntimeError),
        ):
            await UserArchiveService(test_db).restore(member_user.id, admin_user)

        await test_db.refresh(member_user)
        assert member_user.is_active is False
        assert member_user.archived_at is not None
        assert member_user.cems_role is None
        assert await _roles(test_db, member_user.id) == []
        restore_logs = (await test_db.execute(
            select(PermissionAuditLog).where(PermissionAuditLog.action == "restore_grants")
        )).scalars().all()
        assert restore_logs == []

    async def test_archive_restore_archive_uses_latest_snapshot(
        self, test_client: AsyncClient, test_db: AsyncSession, admin_token: str,
        member_user: User, test_project: dict
    ):
        await _archive(test_client, admin_token, member_user.id)
        await _restore(test_client, admin_token, member_user.id)

        test_db.add(ProjectRoleAssignment(user_id=member_user.id, project_id=test_project["id"], role="editor"))
        await test_db.commit()
        await _archive(test_client, admin_token, member_user.id)

        response = await _restore(test_client, admin_token, member_user.id)
        assert response.status_code == 200, response.text
        assert [r["role"] for r in response.json()["report"]["restored_project_roles"]] == ["editor"]

    async def test_unsupported_snapshot_version_is_refused(
        self, test_client: AsyncClient, test_db: AsyncSession, admin_token: str, member_user: User
    ):
        await _archive(test_client, admin_token, member_user.id)
        log = (await test_db.execute(
            select(AuditLog).where(AuditLog.entity == "user", AuditLog.action == "archive")
        )).scalar_one()
        details = json.loads(log.details)
        details["restore_snapshot"]["version"] = 99
        log.details = json.dumps(details)
        await test_db.commit()

        response = await _restore(test_client, admin_token, member_user.id)
        assert response.status_code == 409
        await test_db.refresh(member_user)
        assert member_user.archived_at is not None
