"""
Tests for moving users to the archive (replaces hard user deletion).
"""
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException
from httpx import AsyncClient, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.config import settings
from backend.core.security import (
    create_access_token,
    create_initial_password_reset_token,
    create_password_reset_token,
    hash_password,
)
from backend.iam.models import PermissionAuditLog, ProjectRoleAssignment, ResourcePolicy
from backend.models.audit_log import AuditLog
from backend.models.cems_warehouse import Warehouse
from backend.models.user import User
from backend.services.oauth_service import OAuthService
from backend.services.user_archive_service import UserArchiveService

USERS = "/api/v1/users"


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


async def _login(client: AsyncClient, email: str) -> Response:
    return await client.post("/api/v1/auth/login", json={"email": email, "password": "testpass123"})


@pytest.mark.api
@pytest.mark.asyncio
class TestUserArchive:
    async def test_archive_sets_fields_and_keeps_user(
        self, test_client: AsyncClient, test_db: AsyncSession, admin_token: str, member_user: User
    ):
        response = await test_client.post(f"{USERS}/{member_user.id}/archive", headers=_auth(admin_token))
        assert response.status_code == 200, response.text
        data = response.json()
        assert data["id"] == member_user.id
        assert data["is_active"] is False
        assert data["archived_at"] is not None
        assert data["email"] == "member@test.com"

        await test_db.refresh(member_user)
        assert member_user.is_active is False
        assert member_user.archived_at is not None
        assert member_user.full_name == "Test Member"

        log = (await test_db.execute(
            select(AuditLog).where(AuditLog.entity == "user", AuditLog.action == "archive")
        )).scalar_one()
        assert log.entity_id == str(member_user.id)

    async def test_archive_revokes_permissions(
        self, test_client: AsyncClient, test_db: AsyncSession, admin_token: str,
        member_user: User, test_project: dict
    ):
        test_db.add(ProjectRoleAssignment(user_id=member_user.id, project_id=test_project["id"], role="viewer"))
        test_db.add(ResourcePolicy(
            user_id=member_user.id, resource_type="building_reception", resource_id="1", action="read"
        ))
        member_user.cems_role = "Worker"
        await test_db.commit()

        response = await test_client.post(f"{USERS}/{member_user.id}/archive", headers=_auth(admin_token))
        assert response.status_code == 200, response.text

        roles = (await test_db.execute(
            select(ProjectRoleAssignment).where(ProjectRoleAssignment.user_id == member_user.id)
        )).scalars().all()
        policies = (await test_db.execute(
            select(ResourcePolicy).where(ResourcePolicy.user_id == member_user.id)
        )).scalars().all()
        assert roles == []
        assert policies == []
        await test_db.refresh(member_user)
        assert member_user.cems_role is None

    async def test_archived_user_cannot_login(
        self, test_client: AsyncClient, admin_token: str, member_user: User
    ):
        await test_client.post(f"{USERS}/{member_user.id}/archive", headers=_auth(admin_token))
        response = await _login(test_client, "member@test.com")
        assert response.status_code == 401

    async def test_existing_tokens_rejected_after_archive(
        self, test_client: AsyncClient, admin_token: str, member_user: User
    ):
        login = await _login(test_client, "member@test.com")
        assert login.status_code == 200
        tokens = login.json()

        await test_client.post(f"{USERS}/{member_user.id}/archive", headers=_auth(admin_token))

        me = await test_client.get(f"{USERS}/me", headers=_auth(tokens["access_token"]))
        assert me.status_code == 401
        refresh = await test_client.post(
            "/api/v1/auth/refresh", json={"refresh_token": tokens["refresh_token"]}
        )
        assert refresh.status_code == 401

    async def test_lists_separate_archived_from_inactive(
        self, test_client: AsyncClient, test_db: AsyncSession, admin_token: str, member_user: User
    ):
        inactive = User(
            email="inactive@test.com", full_name="Inactive User", role="Member", is_active=False
        )
        test_db.add(inactive)
        await test_db.commit()
        await test_db.refresh(inactive)

        await test_client.post(f"{USERS}/{member_user.id}/archive", headers=_auth(admin_token))

        regular_ids = {u["id"] for u in (await test_client.get(f"{USERS}/", headers=_auth(admin_token))).json()}
        archived = (await test_client.get(f"{USERS}/archived", headers=_auth(admin_token))).json()
        archived_ids = {u["id"] for u in archived}

        assert inactive.id in regular_ids
        assert member_user.id not in regular_ids
        assert archived_ids == {member_user.id}
        assert archived[0]["archived_at"] is not None

    async def test_cannot_archive_self(self, test_client: AsyncClient, admin_token: str, admin_user: User):
        response = await test_client.post(f"{USERS}/{admin_user.id}/archive", headers=_auth(admin_token))
        assert response.status_code == 400

    async def test_archive_twice_conflicts(self, test_client: AsyncClient, admin_token: str, member_user: User):
        await test_client.post(f"{USERS}/{member_user.id}/archive", headers=_auth(admin_token))
        response = await test_client.post(f"{USERS}/{member_user.id}/archive", headers=_auth(admin_token))
        assert response.status_code == 409

    async def test_archive_unknown_user(self, test_client: AsyncClient, admin_token: str):
        response = await test_client.post(f"{USERS}/999999/archive", headers=_auth(admin_token))
        assert response.status_code == 404

    async def test_member_cannot_archive(
        self, test_client: AsyncClient, member_token: str, admin_user: User
    ):
        response = await test_client.post(f"{USERS}/{admin_user.id}/archive", headers=_auth(member_token))
        assert response.status_code == 403

    async def test_archived_user_cannot_be_edited(
        self, test_client: AsyncClient, admin_token: str, member_user: User
    ):
        await test_client.post(f"{USERS}/{member_user.id}/archive", headers=_auth(admin_token))
        response = await test_client.put(
            f"{USERS}/{member_user.id}", headers=_auth(admin_token), json={"is_active": True}
        )
        assert response.status_code == 409

    async def test_delete_endpoint_removed(self, test_client: AsyncClient, admin_token: str, member_user: User):
        response = await test_client.delete(f"{USERS}/{member_user.id}", headers=_auth(admin_token))
        assert response.status_code == 405


async def _add_grants(db: AsyncSession, user: User, project_id: int, granted_by: int) -> None:
    db.add(ProjectRoleAssignment(user_id=user.id, project_id=project_id, role="viewer", assigned_by=granted_by))
    db.add(ResourcePolicy(
        user_id=user.id, resource_type="building_reception", resource_id="7",
        action="read", granted_by=granted_by,
    ))
    user.cems_role = "Worker"
    await db.commit()


async def _make_user(db: AsyncSession, email: str, *, is_active: bool = True,
                     password: str | None = "testpass123", role: str = "Member") -> User:
    user = User(
        email=email, full_name=email.split("@")[0], role=role, is_active=is_active,
        password_hash=hash_password(password) if password else None,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


@pytest.mark.api
@pytest.mark.asyncio
class TestUserArchiveAtomicity:
    async def test_audit_failure_rolls_back_everything(
        self, test_client: AsyncClient, test_db: AsyncSession, admin_user: User,
        member_user: User, test_project: dict
    ):
        await _add_grants(test_db, member_user, test_project["id"], admin_user.id)

        with (
            patch(
                "backend.services.user_archive_service.AuditService.log_user_action",
                new=AsyncMock(side_effect=RuntimeError("audit down")),
            ),
            pytest.raises(RuntimeError),
        ):
            await UserArchiveService(test_db).archive(member_user.id, admin_user)

        await test_db.refresh(member_user)
        assert member_user.is_active is True
        assert member_user.archived_at is None
        assert member_user.cems_role == "Worker"
        roles = (await test_db.execute(
            select(ProjectRoleAssignment).where(ProjectRoleAssignment.user_id == member_user.id)
        )).scalars().all()
        policies = (await test_db.execute(
            select(ResourcePolicy).where(ResourcePolicy.user_id == member_user.id)
        )).scalars().all()
        assert len(roles) == 1
        assert len(policies) == 1
        perm_logs = (await test_db.execute(select(PermissionAuditLog))).scalars().all()
        assert perm_logs == []

    async def test_snapshot_holds_everything_needed_to_restore(
        self, test_client: AsyncClient, test_db: AsyncSession, admin_token: str,
        admin_user: User, member_user: User, test_project: dict
    ):
        await _add_grants(test_db, member_user, test_project["id"], admin_user.id)

        response = await test_client.post(f"{USERS}/{member_user.id}/archive", headers=_auth(admin_token))
        assert response.status_code == 200, response.text

        log = (await test_db.execute(
            select(AuditLog).where(AuditLog.entity == "user", AuditLog.action == "archive")
        )).scalar_one()
        snapshot = json.loads(log.details)["restore_snapshot"]
        assert snapshot["version"] == 1
        assert snapshot["user"] == {
            "role": "Member", "group_id": None, "is_active": True,
            "cems_role": "Worker", "cems_warehouse_id": None,
        }
        [role] = snapshot["project_roles"]
        assert role["project_id"] == test_project["id"]
        assert role["role"] == "viewer"
        assert role["assigned_by"] == admin_user.id
        assert role["created_at"]
        [policy] = snapshot["resource_policies"]
        assert policy["resource_type"] == "building_reception"
        assert policy["resource_id"] == "7"
        assert policy["action"] == "read"
        assert policy["effect"] == "allow"
        assert policy["granted_by"] == admin_user.id

        perm_log = (await test_db.execute(
            select(PermissionAuditLog).where(PermissionAuditLog.action == "archive_revoke_all")
        )).scalar_one()
        assert perm_log.target_user_id == member_user.id
        assert json.loads(perm_log.detail) == snapshot


@pytest.mark.api
@pytest.mark.asyncio
class TestSuperAdminAndWarehouseGuards:
    async def test_super_admin_cannot_be_archived(
        self, test_client: AsyncClient, test_db: AsyncSession, admin_token: str
    ):
        super_admin = await _make_user(test_db, settings.SUPER_ADMIN_EMAIL, role="Admin")
        response = await test_client.post(f"{USERS}/{super_admin.id}/archive", headers=_auth(admin_token))
        assert response.status_code == 403
        await test_db.refresh(super_admin)
        assert super_admin.archived_at is None
        assert super_admin.is_active is True

    async def test_super_admin_cannot_be_deactivated(
        self, test_client: AsyncClient, test_db: AsyncSession, admin_token: str
    ):
        super_admin = await _make_user(test_db, settings.SUPER_ADMIN_EMAIL, role="Admin")
        response = await test_client.put(
            f"{USERS}/{super_admin.id}", headers=_auth(admin_token), json={"is_active": False}
        )
        assert response.status_code == 403
        await test_db.refresh(super_admin)
        assert super_admin.is_active is True

    async def test_regular_user_can_still_be_deactivated(
        self, test_client: AsyncClient, admin_token: str, member_user: User
    ):
        response = await test_client.put(
            f"{USERS}/{member_user.id}", headers=_auth(admin_token), json={"is_active": False}
        )
        assert response.status_code == 200
        assert response.json()["is_active"] is False

    async def test_warehouse_manager_must_be_reassigned_first(
        self, test_client: AsyncClient, test_db: AsyncSession, admin_token: str, member_user: User
    ):
        warehouse = Warehouse(name="Main Warehouse", current_manager_id=member_user.id)
        test_db.add(warehouse)
        await test_db.commit()

        response = await test_client.post(f"{USERS}/{member_user.id}/archive", headers=_auth(admin_token))
        assert response.status_code == 409
        assert "Main Warehouse" in response.json()["detail"]

        await test_db.refresh(member_user)
        await test_db.refresh(warehouse)
        assert member_user.archived_at is None
        assert warehouse.current_manager_id == member_user.id


@pytest.mark.api
@pytest.mark.asyncio
class TestInactiveUserAuthPaths:
    async def test_oauth_link_rejects_inactive_user(self, test_db: AsyncSession):
        user = await _make_user(test_db, "oauth@test.com", is_active=False, password=None)

        service = OAuthService(test_db)
        google_response = MagicMock()
        google_response.json.return_value = {"email": "oauth@test.com", "id": "g-123", "name": "O"}
        service.google_client = MagicMock(
            fetch_token=AsyncMock(return_value={"access_token": "x"}),
            get=AsyncMock(return_value=google_response),
        )

        with pytest.raises(HTTPException) as exc:
            await service.handle_google_callback(code="code")
        assert exc.value.status_code == 401

        await test_db.refresh(user)
        assert user.oauth_id is None
        assert user.oauth_provider is None

    async def test_outlook_connect_rejects_inactive_user(
        self, test_client: AsyncClient, test_db: AsyncSession, member_user: User
    ):
        token = create_access_token(member_user.id)
        active = await test_client.get("/api/v1/outlook/connect", params={"token": token})
        assert active.status_code != 401

        member_user.is_active = False
        await test_db.commit()
        inactive = await test_client.get("/api/v1/outlook/connect", params={"token": token})
        assert inactive.status_code == 401

    async def test_reset_password_rejects_inactive_user(
        self, test_client: AsyncClient, test_db: AsyncSession, member_user: User
    ):
        member_user.is_active = False
        await test_db.commit()
        response = await test_client.post(
            "/api/v1/auth/reset-password",
            json={"token": create_password_reset_token("member@test.com"), "new_password": "NewPass123!"},
        )
        assert response.status_code == 400

    @pytest.mark.parametrize("token_kind", ["initial", "reset"])
    async def test_reset_password_with_token_rejects_inactive_user(
        self, test_client: AsyncClient, test_db: AsyncSession, member_user: User, token_kind: str
    ):
        token = (
            create_initial_password_reset_token(member_user.id)
            if token_kind == "initial"
            else create_password_reset_token("member@test.com")
        )
        old_hash = member_user.password_hash
        member_user.is_active = False
        await test_db.commit()

        response = await test_client.post(
            "/api/v1/auth/reset-password-with-token",
            json={"token": token, "new_password": "NewPass123!"},
        )
        assert response.status_code == 400
        await test_db.refresh(member_user)
        assert member_user.password_hash == old_hash

    async def test_reset_password_with_token_still_works_for_active_user(
        self, test_client: AsyncClient, member_user: User
    ):
        response = await test_client.post(
            "/api/v1/auth/reset-password-with-token",
            json={"token": create_initial_password_reset_token(member_user.id), "new_password": "NewPass123!"},
        )
        assert response.status_code == 200, response.text
