"""Stage 3 of the collection-tasks module: access rules, service and API.

Members get collection permissions only by explicit grant (``grant``); tokens are
minted directly to keep the suite fast.
"""
from __future__ import annotations

from decimal import Decimal

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import event, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.security import create_access_token, hash_password
from backend.iam.engine import PermissionsEngine
from backend.models.audit_log import AuditLog
from backend.models.collection_task import CollectionTaskDetails
from backend.models.project import Project
from backend.models.task import Task, TaskKind, TaskMessage
from backend.models.user import User, UserRole
from backend.schemas.collection_task import CollectionTaskCreate
from backend.services.audit_service import AuditService
from backend.services.collection_task_service import CollectionTaskService

API = "/api/v1/collection-tasks"
MONTH = "2026-10"


def _auth(user: User) -> dict:
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def _grant(db: AsyncSession, user: User, *actions: str) -> None:
    engine = PermissionsEngine(db)
    for action in actions:
        await engine.grant_resource_permission(user.id, "collection_task", "*", action)
    await db.commit()


async def _audit_actions(db: AsyncSession, task_id: int) -> list[str]:
    rows = await db.execute(
        select(AuditLog.action)
        .where(AuditLog.entity == "collection_task", AuditLog.entity_id == str(task_id))
        .order_by(AuditLog.id)
    )
    return list(rows.scalars())


@pytest_asyncio.fixture
async def other_member(test_db: AsyncSession) -> User:
    user = User(email="member2@test.com", password_hash=hash_password("x"), full_name="Second Member",
                role=UserRole.MEMBER.value, is_active=True, email_verified=True)
    test_db.add(user)
    await test_db.commit()
    await test_db.refresh(user)
    return user


@pytest_asyncio.fixture
async def project(test_db: AsyncSession) -> Project:
    project = Project(name="Collection Project", is_active=True)
    test_db.add(project)
    await test_db.commit()
    return project


def _single(project_id: int, assignee_ids: list[int], **overrides) -> dict:
    body = {
        "title": "Single collection",
        "collection_type": "single",
        "project_id": project_id,
        "billing_month": MONTH,
        "assignee_ids": assignee_ids,
        "initial_amount": "1000.00",
    }
    body.update(overrides)
    return body


def _ledger(project_id: int, assignee_ids: list[int], **overrides) -> dict:
    body = {
        "title": "Ledger collection",
        "collection_type": "ledger",
        "project_id": project_id,
        "billing_month": MONTH,
        "assignee_ids": assignee_ids,
        "items": [{"subject": "ועד", "amount": "250.00"}, {"subject": "חניה", "amount": "80.50"}],
    }
    body.update(overrides)
    return body


async def _create(client: AsyncClient, user: User, body: dict) -> dict:
    response = await client.post(f"{API}/", headers=_auth(user), json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _code(response) -> str | None:
    detail = response.json().get("detail")
    return detail.get("code") if isinstance(detail, dict) else None


# ── create & validation ──────────────────────────────────────────────────────

@pytest.mark.asyncio
class TestCreate:
    async def test_admin_creates_single(self, test_client, test_db, admin_user, member_user, project):
        await _grant(test_db, member_user, "read")
        task = await _create(test_client, admin_user, _single(project.id, [member_user.id]))
        assert task["status"] == "open"
        assert task["billing_month"] == "2026-10-01"
        assert task["total_amount"] == "1000.00"
        assert task["initial_amount"] == "1000.00"
        assert [a["id"] for a in task["assignees"]] == [member_user.id]
        stored = await test_db.get(Task, task["id"])
        assert stored.task_kind == TaskKind.COLLECTION and stored.start_time is None
        assert await _audit_actions(test_db, task["id"]) == ["created"]

    async def test_ledger_total_from_items(self, test_client, admin_user, project):
        task = await _create(test_client, admin_user, _ledger(project.id, [admin_user.id]))
        assert task["total_amount"] == "330.50"
        assert [i["subject"] for i in task["ledger_items"]] == ["ועד", "חניה"]

    @pytest.mark.parametrize("overrides", [
        {"initial_amount": None},                       # single without amount
        {"initial_amount": "0"},
        {"initial_amount": "-5"},
        {"initial_amount": "10.005"},                   # 3 decimal places
        {"items": [{"subject": "x", "amount": "1"}]},   # single with items
        {"collection_type": "monthly"},
        {"billing_month": "2026-13"},
        {"assignee_ids": []},
        {"task_kind": "general"},                       # unknown field
    ])
    async def test_invalid_single_rejected(self, test_client, admin_user, project, overrides):
        body = {**_single(project.id, [admin_user.id]), **overrides}
        response = await test_client.post(f"{API}/", headers=_auth(admin_user), json=body)
        assert response.status_code == 422, response.text

    async def test_ledger_with_initial_amount_rejected(self, test_client, admin_user, project):
        response = await test_client.post(f"{API}/", headers=_auth(admin_user),
                                          json=_ledger(project.id, [admin_user.id], initial_amount="5"))
        assert response.status_code == 422

    async def test_month_normalized_to_first_day(self, test_client, admin_user, project):
        task = await _create(test_client, admin_user, _single(project.id, [admin_user.id], billing_month="2026-10-17"))
        assert task["billing_month"] == "2026-10-01"

    async def test_inactive_project_rejected(self, test_client, test_db, admin_user):
        inactive = Project(name="Inactive", is_active=False)
        test_db.add(inactive)
        await test_db.commit()
        response = await test_client.post(f"{API}/", headers=_auth(admin_user),
                                          json=_single(inactive.id, [admin_user.id]))
        assert response.status_code == 422 and _code(response) == "project_not_active"

    async def test_active_subproject_of_inactive_parent_allowed(self, test_client, test_db, admin_user):
        parent = Project(name="Parent", is_active=False, is_parent_project=True)
        test_db.add(parent)
        await test_db.flush()
        child = Project(name="Child", is_active=True, relation_project=parent.id)
        test_db.add(child)
        await test_db.commit()
        task = await _create(test_client, admin_user, _single(child.id, [admin_user.id]))
        assert task["project"] == {"id": child.id, "name": "Child", "relation_project": parent.id,
                                   "parent_name": "Parent"}

    async def test_create_requires_explicit_write(self, test_client, test_db, member_user, other_member, project):
        """Like a regular task, creation is gated by the IAM decorator — but
        collection_task:write is never granted by default."""
        body = _single(project.id, [other_member.id])
        no_grant = await test_client.post(f"{API}/", headers=_auth(member_user), json=body)
        assert no_grant.status_code == 403
        assert no_grant.json()["detail"] == "Permission denied: write on collection_task"
        await _grant(test_db, member_user, "read")
        assert (await test_client.post(f"{API}/", headers=_auth(member_user), json=body)).status_code == 403

        await _grant(test_db, member_user, "write")
        # Same as a regular task: the creator need not be an assignee, and an
        # assignee needs no collection permission of their own.
        task = await _create(test_client, member_user, body)
        assert [a["id"] for a in task["assignees"]] == [other_member.id]

    async def test_inactive_assignee_rejected_like_regular_task(self, test_client, test_db, admin_user, other_member, project):
        other_member.is_active = False
        await test_db.commit()
        collection = await test_client.post(f"{API}/", headers=_auth(admin_user),
                                            json=_single(project.id, [other_member.id]))
        regular = await test_client.post("/api/v1/tasks/", headers=_auth(admin_user),
                                         json={"title": "r", "assigned_to_user_id": other_member.id})
        assert collection.status_code == regular.status_code == 404
        assert collection.json()["detail"] == regular.json()["detail"] == "User not found"

    async def test_create_is_atomic(self, test_db, admin_user, project, monkeypatch):
        """A failure after the rows are written leaves nothing behind (the request
        session rolls back as a unit)."""
        async def boom(*args, **kwargs):
            raise RuntimeError("audit failure")
        monkeypatch.setattr(AuditService, "log_action", boom)
        data = CollectionTaskCreate(**_ledger(project.id, [admin_user.id], title="atomic-check"))
        with pytest.raises(RuntimeError):
            await CollectionTaskService(test_db, admin_user).create(data, [admin_user])
        await test_db.rollback()
        assert (await test_db.execute(select(func.count(Task.id)).where(Task.title == "atomic-check"))).scalar() == 0
        assert (await test_db.execute(select(func.count()).select_from(CollectionTaskDetails))).scalar() == 0


# ── visibility & permissions (same rules as the regular tasks) ───────────────

async def _regular_task(client: AsyncClient, admin: User, assignee: User, title: str) -> dict:
    response = await client.post("/api/v1/tasks/", headers=_auth(admin),
                                 json={"title": title, "assigned_to_user_id": assignee.id})
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.asyncio
class TestAccess:
    async def test_member_sees_only_assigned_like_regular(
        self, test_client, test_db, admin_user, member_user, other_member, project,
    ):
        """With collection_task:read, a member sees only their own tasks;
        another user's task answers 403 exactly like a regular task."""
        await _grant(test_db, member_user, "read")
        mine = await _create(test_client, admin_user, _single(project.id, [member_user.id], title="mine"))
        theirs = await _create(test_client, admin_user, _single(project.id, [other_member.id], title="theirs"))
        regular_theirs = await _regular_task(test_client, admin_user, other_member, "regular-theirs")

        page = (await test_client.get(f"{API}/", headers=_auth(member_user), params={"month": MONTH})).json()
        assert [t["title"] for t in page["items"]] == ["mine"] and page["total"] == 1
        assert (await test_client.get(f"{API}/{mine['id']}", headers=_auth(member_user))).status_code == 200

        collection = await test_client.get(f"{API}/{theirs['id']}", headers=_auth(member_user))
        regular = await test_client.get(f"/api/v1/tasks/{regular_theirs['id']}", headers=_auth(member_user))
        assert collection.status_code == regular.status_code == 403
        assert collection.json()["detail"] == regular.json()["detail"] == "Access denied"
        assert (await test_client.get(f"{API}/999999", headers=_auth(member_user))).json()["detail"] == "Task not found"

        admin_page = (await test_client.get(f"{API}/", headers=_auth(admin_user), params={"month": MONTH})).json()
        assert admin_page["total"] == 2

    async def test_read_permission_required_everywhere(self, test_client, test_db, admin_user, member_user, project):
        """An assignee WITHOUT collection_task:read reaches no collection data —
        lists, counters, notifications, the task itself, its actions or its chat."""
        task = await _create(test_client, admin_user, _single(project.id, [member_user.id]))
        tid = task["id"]
        denied = "Permission denied: read on collection_task"
        requests = [
            ("get", f"{API}/", {"params": {"month": MONTH}}),
            ("get", f"{API}/summary", {"params": {"month": MONTH}}),
            ("get", f"{API}/unread-summary", {}),
            ("get", f"{API}/notifications", {}),
            ("get", f"{API}/notifications/unread-count", {}),
            ("get", f"{API}/project-options", {}),
            ("get", f"{API}/{tid}", {}),
            ("get", f"{API}/{tid}/history", {}),
            ("get", f"{API}/{tid}/ledger-items", {}),
            ("patch", f"{API}/{tid}", {"json": {"title": "x"}}),
            ("post", f"{API}/{tid}/status", {"json": {"status": "closed"}}),
            ("post", f"{API}/{tid}/adjustments", {"json": {"amount": "1"}}),
            ("post", f"{API}/{tid}/archive", {}),
            ("get", f"/api/v1/tasks/{tid}/messages", {}),
            ("post", f"/api/v1/tasks/{tid}/messages", {"data": {"message": "hi"}}),
        ]
        for method, url, kwargs in requests:
            response = await getattr(test_client, method)(url, headers=_auth(member_user), **kwargs)
            assert response.status_code == 403, (method, url, response.status_code)
            assert response.json()["detail"] == denied, (method, url)

        await _grant(test_db, member_user, "read")
        for method, url, kwargs in requests[:10]:
            response = await getattr(test_client, method)(url, headers=_auth(member_user), **kwargs)
            assert response.status_code == 200, (method, url, response.status_code, response.text)

    async def test_read_granted_through_generic_iam_endpoint(
        self, test_client, admin_user, member_user, other_member, project,
    ):
        """The path the generic permissions screen uses (POST /iam/resource-policies,
        resource_id='*'): a collection_task grant never opens another user's task."""
        response = await test_client.post("/api/v1/iam/resource-policies", headers=_auth(admin_user), params={
            "user_id": member_user.id, "resource_type": "collection_task", "resource_id": "*", "action": "read",
        })
        assert response.status_code == 200, response.text
        mine = await _create(test_client, admin_user, _single(project.id, [member_user.id], title="mine"))
        theirs = await _create(test_client, admin_user, _single(project.id, [other_member.id], title="theirs"))

        assert (await test_client.get(f"{API}/{mine['id']}", headers=_auth(member_user))).status_code == 200
        assert (await test_client.get(f"{API}/{theirs['id']}", headers=_auth(member_user))).status_code == 403
        page = (await test_client.get(f"{API}/", headers=_auth(member_user), params={"month": MONTH})).json()
        assert [t["id"] for t in page["items"]] == [mine["id"]]

    async def test_super_admin_role_follows_regular_rules(self, test_client, test_db, admin_user, project):
        """Regular tasks treat only role 'Admin' as all-seeing; collection tasks do the same."""
        super_admin = User(email="sa@test.com", password_hash=hash_password("x"), full_name="SA",
                           role="SuperAdmin", is_active=True, email_verified=True)
        test_db.add(super_admin)
        await test_db.commit()
        collection = await _create(test_client, admin_user, _single(project.id, [admin_user.id]))
        regular = await _regular_task(test_client, admin_user, admin_user, "regular")

        regular_get = await test_client.get(f"/api/v1/tasks/{regular['id']}", headers=_auth(super_admin))
        collection_get = await test_client.get(f"{API}/{collection['id']}", headers=_auth(super_admin))
        assert collection_get.status_code == regular_get.status_code == 403
        page = (await test_client.get(f"{API}/", headers=_auth(super_admin), params={"month": MONTH})).json()
        assert page["total"] == 0

    async def test_edit_and_reassign_like_regular(
        self, test_client, test_db, admin_user, member_user, other_member, project,
    ):
        await _grant(test_db, member_user, "read")
        await _grant(test_db, other_member, "read")
        task = await _create(test_client, admin_user, _single(project.id, [member_user.id]))
        url = f"{API}/{task['id']}"

        # An assignee (with read) edits; a non-assignee cannot.
        response = await test_client.patch(url, headers=_auth(member_user), json={"title": "renamed"})
        assert response.status_code == 200 and response.json()["title"] == "renamed"
        denied = await test_client.patch(url, headers=_auth(other_member), json={"title": "x"})
        assert denied.status_code == 403
        assert denied.json()["detail"] == "Access denied. Only an assignee or admin can edit."

        # Re-sending the current assignees is accepted and ignored; changing them is Admin-only.
        same = await test_client.patch(url, headers=_auth(member_user), json={"assignee_ids": [member_user.id]})
        assert same.status_code == 200
        changed = await test_client.patch(url, headers=_auth(member_user), json={"assignee_ids": [other_member.id]})
        assert changed.status_code == 403
        assert changed.json()["detail"] == "רק מנהל יכול לשנות את המשתמשים המוקצים למשימה"
        response = await test_client.patch(url, headers=_auth(admin_user),
                                           json={"assignee_ids": [member_user.id, other_member.id]})
        assert response.status_code == 200
        assert {a["id"] for a in response.json()["assignees"]} == {member_user.id, other_member.id}

        for forbidden in ({"collection_type": "ledger"}, {"initial_amount": "5"}, {"billing_month": "2026-11"}):
            assert (await test_client.patch(url, headers=_auth(admin_user), json=forbidden)).status_code == 422

        actions = await _audit_actions(test_db, task["id"])
        assert actions == ["created", "updated", "assignees_changed"]

    async def test_regular_task_api_still_isolated(self, test_client, admin_user, project):
        task = await _create(test_client, admin_user, _single(project.id, [admin_user.id]))
        regular = (await test_client.get("/api/v1/tasks/", headers=_auth(admin_user))).json()
        assert task["id"] not in {t["id"] for t in regular}
        assert (await test_client.get(f"/api/v1/tasks/{task['id']}", headers=_auth(admin_user))).status_code == 404
        assert (await test_client.delete(f"{API}/{task['id']}", headers=_auth(admin_user))).status_code == 405


# ── amounts ──────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
class TestAmounts:
    async def test_single_adjustments_append_only(self, test_client, test_db, admin_user, project):
        task = await _create(test_client, admin_user, _single(project.id, [admin_user.id]))
        url = f"{API}/{task['id']}/adjustments"
        first = await test_client.post(url, headers=_auth(admin_user), json={"amount": "0.10"})
        second = await test_client.post(url, headers=_auth(admin_user), json={"amount": "0.20", "note": "fee"})
        assert first.status_code == second.status_code == 201
        assert second.json()["total_amount"] == "1000.30"
        assert second.json()["adjustment"]["created_by"]["id"] == admin_user.id

        for bad in ("0", "-1", "1.001"):
            assert (await test_client.post(url, headers=_auth(admin_user), json={"amount": bad})).status_code == 422

        detail = (await test_client.get(f"{API}/{task['id']}", headers=_auth(admin_user))).json()
        assert detail["initial_amount"] == "1000.00" and detail["total_amount"] == "1000.30"
        assert [a["amount"] for a in detail["adjustments"]] == ["0.10", "0.20"]
        assert (await _audit_actions(test_db, task["id"]))[-2:] == ["adjustment_added", "adjustment_added"]

    async def test_wrong_type_actions_rejected(self, test_client, admin_user, project):
        single = await _create(test_client, admin_user, _single(project.id, [admin_user.id]))
        ledger = await _create(test_client, admin_user, _ledger(project.id, [admin_user.id]))
        r1 = await test_client.post(f"{API}/{ledger['id']}/adjustments", headers=_auth(admin_user), json={"amount": "5"})
        r2 = await test_client.post(f"{API}/{single['id']}/ledger-items", headers=_auth(admin_user),
                                    json={"subject": "x", "amount": "5"})
        assert r1.status_code == r2.status_code == 409
        assert _code(r1) == _code(r2) == "wrong_collection_type"

    async def test_ledger_items_edit_and_archive(self, test_client, test_db, admin_user, project):
        task = await _create(test_client, admin_user, _ledger(project.id, [admin_user.id]))
        items_url = f"{API}/{task['id']}/ledger-items"
        added = await test_client.post(items_url, headers=_auth(admin_user), json={"subject": "מים", "amount": "19.50"})
        assert added.status_code == 201 and added.json()["total_amount"] == "350.00"
        item_id = added.json()["item"]["id"]

        edited = await test_client.patch(f"{items_url}/{item_id}", headers=_auth(admin_user), json={"amount": "20.00"})
        assert edited.json()["total_amount"] == "350.50"

        archived = await test_client.post(f"{items_url}/{item_id}/archive", headers=_auth(admin_user))
        assert archived.json()["total_amount"] == "330.50"
        assert archived.json()["item"]["archived_at"] is not None
        again = await test_client.patch(f"{items_url}/{item_id}", headers=_auth(admin_user), json={"amount": "1"})
        assert again.status_code == 409 and _code(again) == "item_archived"

        active = (await test_client.get(items_url, headers=_auth(admin_user))).json()
        everything = (await test_client.get(items_url, headers=_auth(admin_user), params={"include_archived": True})).json()
        assert len(active) == 2 and len(everything) == 3
        actions = await _audit_actions(test_db, task["id"])
        assert actions[-3:] == ["ledger_item_added", "ledger_item_updated", "ledger_item_archived"]

    async def test_equal_amount_is_not_a_change_but_one_agora_is(self, test_client, test_db, admin_user, project):
        task = await _create(test_client, admin_user, _ledger(project.id, [admin_user.id], items=[]))
        items_url = f"{API}/{task['id']}/ledger-items"
        item_id = (await test_client.post(items_url, headers=_auth(admin_user),
                                          json={"subject": "x", "amount": "20"})).json()["item"]["id"]

        same = await test_client.patch(f"{items_url}/{item_id}", headers=_auth(admin_user), json={"amount": "20.00"})
        assert same.status_code == 200
        assert "ledger_item_updated" not in await _audit_actions(test_db, task["id"])

        real = await test_client.patch(f"{items_url}/{item_id}", headers=_auth(admin_user), json={"amount": "20.01"})
        assert real.json()["total_amount"] == "20.01"
        history = (await test_client.get(f"{API}/{task['id']}/history", headers=_auth(admin_user))).json()
        updated = [e for e in history["items"] if e["action"] == "ledger_item_updated"]
        assert len(updated) == 1
        assert updated[0]["details"] == {"before": {"amount": "20.00"}, "after": {"amount": "20.01"},
                                         "item_id": item_id}


# ── status & archive ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
class TestStatusAndArchive:
    async def test_close_locks_amounts_and_reopen_unlocks(self, test_client, test_db, admin_user, project):
        task = await _create(test_client, admin_user, _single(project.id, [admin_user.id]))
        url = f"{API}/{task['id']}"
        closed = await test_client.post(f"{url}/status", headers=_auth(admin_user), json={"status": "closed"})
        assert closed.json()["status"] == "closed" and closed.json()["completed_at"] is not None

        locked = await test_client.post(f"{url}/adjustments", headers=_auth(admin_user), json={"amount": "5"})
        assert locked.status_code == 409 and _code(locked) == "task_closed"

        reopened = await test_client.post(f"{url}/status", headers=_auth(admin_user), json={"status": "open"})
        assert reopened.json()["status"] == "open" and reopened.json()["completed_at"] is None
        assert (await test_client.post(f"{url}/adjustments", headers=_auth(admin_user), json={"amount": "5"})).status_code == 201
        # Same status again is a no-op (no extra history entry).
        await test_client.post(f"{url}/status", headers=_auth(admin_user), json={"status": "open"})
        assert await _audit_actions(test_db, task["id"]) == ["created", "status_changed", "reopened", "adjustment_added"]

    async def test_archive_rules(self, test_client, test_db, admin_user, project):
        task = await _create(test_client, admin_user, _single(project.id, [admin_user.id]))
        url = f"{API}/{task['id']}"
        await test_client.post(f"{url}/status", headers=_auth(admin_user), json={"status": "closed"})
        archived = await test_client.post(f"{url}/archive", headers=_auth(admin_user))
        assert archived.json()["is_archived"] is True

        reopen = await test_client.post(f"{url}/status", headers=_auth(admin_user), json={"status": "open"})
        assert reopen.status_code == 409 and _code(reopen) == "unarchive_first"
        edit = await test_client.patch(url, headers=_auth(admin_user), json={"title": "x"})
        assert edit.status_code == 409 and _code(edit) == "task_archived"

        listed = (await test_client.get(f"{API}/", headers=_auth(admin_user), params={"month": MONTH})).json()
        archived_list = (await test_client.get(f"{API}/", headers=_auth(admin_user),
                                               params={"month": MONTH, "archived": "true"})).json()
        assert listed["total"] == 0 and archived_list["total"] == 1

        assert (await test_client.post(f"{url}/unarchive", headers=_auth(admin_user))).json()["is_archived"] is False
        assert (await test_client.post(f"{url}/status", headers=_auth(admin_user), json={"status": "open"})).status_code == 200
        # Archiving deletes nothing.
        assert await test_db.get(CollectionTaskDetails, task["id"]) is not None
        assert (await _audit_actions(test_db, task["id"]))[-3:] == ["archived", "unarchived", "reopened"]

    async def test_move_month_is_explicit_and_audited(self, test_client, test_db, admin_user, project):
        task = await _create(test_client, admin_user, _single(project.id, [admin_user.id]))
        moved = await test_client.post(f"{API}/{task['id']}/move-month", headers=_auth(admin_user),
                                       json={"billing_month": "2026-11", "reason": "late"})
        assert moved.json()["billing_month"] == "2026-11-01"
        history = (await test_client.get(f"{API}/{task['id']}/history", headers=_auth(admin_user))).json()
        assert history["items"][0]["action"] == "month_changed"
        assert history["items"][0]["details"] == {"before": {"billing_month": "2026-10-01"},
                                                  "after": {"billing_month": "2026-11-01"}, "reason": "late"}

    async def test_archive_and_restore_like_regular(
        self, test_client, test_db, admin_user, member_user, other_member, project,
    ):
        """Archive: Admin, an assignee or the creator (no IAM). Restore: Admin
        only, behind the update permission — the regular tasks' rules."""
        await _grant(test_db, member_user, "read", "write")
        created_by_member = await _create(test_client, member_user, _single(project.id, [other_member.id]))
        assigned_to_member = await _create(test_client, admin_user, _single(project.id, [member_user.id]))
        stranger = await _create(test_client, admin_user, _single(project.id, [admin_user.id]))

        assert (await test_client.post(f"{API}/{created_by_member['id']}/archive",
                                       headers=_auth(member_user))).status_code == 200
        assert (await test_client.post(f"{API}/{assigned_to_member['id']}/archive",
                                       headers=_auth(member_user))).status_code == 200
        denied = await test_client.post(f"{API}/{stranger['id']}/archive", headers=_auth(member_user))
        assert denied.status_code == 403 and denied.json()["detail"] == "אין לך הרשאה לארכב משימה זו"

        restore = f"{API}/{assigned_to_member['id']}/unarchive"
        assert (await test_client.post(restore, headers=_auth(member_user))).json()["detail"] \
            == "Permission denied: update on collection_task"
        await _grant(test_db, member_user, "update")
        admin_only = await test_client.post(restore, headers=_auth(member_user))
        assert admin_only.status_code == 403
        assert admin_only.json()["detail"] == "Only admins can restore archived tasks"
        assert (await test_client.post(restore, headers=_auth(admin_user))).status_code == 200


# ── list, summary, efficiency ────────────────────────────────────────────────

@pytest.mark.asyncio
class TestListing:
    async def test_filters_pagination_and_summary(self, test_client, admin_user, project):
        for i in range(3):
            await _create(test_client, admin_user, _single(project.id, [admin_user.id], title=f"s{i}"))
        ledger = await _create(test_client, admin_user, _ledger(project.id, [admin_user.id]))
        await _create(test_client, admin_user, _single(project.id, [admin_user.id], billing_month="2026-09"))
        await test_client.post(f"{API}/{ledger['id']}/status", headers=_auth(admin_user), json={"status": "closed"})

        page = (await test_client.get(f"{API}/", headers=_auth(admin_user),
                                      params={"month": MONTH, "page_size": 2})).json()
        assert page["total"] == 4 and len(page["items"]) == 2
        closed = (await test_client.get(f"{API}/", headers=_auth(admin_user),
                                        params={"month": MONTH, "status": ["closed"]})).json()
        assert [t["id"] for t in closed["items"]] == [ledger["id"]]
        typed = (await test_client.get(f"{API}/", headers=_auth(admin_user),
                                       params={"month": MONTH, "collection_type": "single", "search": "s1"})).json()
        assert [t["title"] for t in typed["items"]] == ["s1"]

        summary = (await test_client.get(f"{API}/summary", headers=_auth(admin_user), params={"month": MONTH})).json()
        assert summary["count"] == 4
        assert summary["by_status"]["open"] == {"count": 3, "total_amount": "3000.00"}
        assert summary["by_status"]["closed"] == {"count": 1, "total_amount": "330.50"}
        assert summary["total_amount"] == "3330.50"

        assert (await test_client.get(f"{API}/", headers=_auth(admin_user), params={"month": "10-2026"})).status_code == 422

    async def test_list_query_count_is_constant(self, test_client, test_engine, admin_user, project):
        async def count_queries(page_size: int) -> int:
            statements: list[str] = []
            listener = lambda *args: statements.append(args[2])  # noqa: E731
            event.listen(test_engine.sync_engine, "before_cursor_execute", listener)
            try:
                response = await test_client.get(f"{API}/", headers=_auth(admin_user),
                                                 params={"month": MONTH, "page_size": page_size})
                assert response.status_code == 200
            finally:
                event.remove(test_engine.sync_engine, "before_cursor_execute", listener)
            return len(statements)

        for i in range(6):
            await _create(test_client, admin_user, _ledger(project.id, [admin_user.id], title=f"l{i}"))
        assert await count_queries(2) == await count_queries(6)

    async def test_project_options(self, test_client, test_db, admin_user):
        parent = Project(name="P-inactive", is_active=False, is_parent_project=True)
        leaf = Project(name="Leaf-inactive", is_active=False)
        test_db.add_all([parent, leaf])
        await test_db.flush()
        test_db.add(Project(name="Child-active", is_active=True, relation_project=parent.id))
        await test_db.commit()
        options = {o["name"]: o for o in (await test_client.get(f"{API}/project-options",
                                                                headers=_auth(admin_user))).json()}
        assert options["P-inactive"]["is_active"] is False
        assert options["Child-active"]["relation_project"] == parent.id
        assert "Leaf-inactive" not in options


# ── chat, unread counters, notifications ─────────────────────────────────────

@pytest.mark.asyncio
class TestChatAndCounters:
    async def test_shared_chat_with_audit_and_separate_counters(
        self, test_client, test_db, admin_user, member_user, other_member, project,
    ):
        await _grant(test_db, member_user, "read")
        await _grant(test_db, other_member, "read")
        task = await _create(test_client, admin_user, _single(project.id, [member_user.id]))
        chat = f"/api/v1/tasks/{task['id']}/messages"

        posted = await test_client.post(chat, headers=_auth(admin_user), data={"message": "שלום"})
        assert posted.status_code == 200
        assert "message_added" in await _audit_actions(test_db, task["id"])
        # Same chat rule as a regular task: the assignee is in, anyone else gets 403.
        assert (await test_client.get(chat, headers=_auth(member_user))).status_code == 200
        assert (await test_client.get(chat, headers=_auth(other_member))).status_code == 403

        # The member opened the chat above; a new message from the admin is unread.
        await test_client.post(chat, headers=_auth(admin_user), data={"message": "עוד הודעה"})
        member_unread = (await test_client.get(f"{API}/unread-summary", headers=_auth(member_user))).json()
        assert member_unread == {"total_unread": 1, "task_count": 1}
        general = (await test_client.get("/api/v1/tasks/unread-summary", headers=_auth(member_user))).json()
        assert general == {"total_unread": 0, "task_count": 0}
        # Admins count only collection tasks they are assigned to.
        test_db.add(TaskMessage(task_id=task["id"], user_id=member_user.id, message="reply"))
        await test_db.commit()
        admin_unread = (await test_client.get(f"{API}/unread-summary", headers=_auth(admin_user))).json()
        assert admin_unread == {"total_unread": 0, "task_count": 0}

        # Collection notifications only in the collection feed.
        feed = (await test_client.get(f"{API}/notifications", headers=_auth(member_user))).json()
        assert {n["task_id"] for n in feed} == {task["id"]}
        center = (await test_client.get("/api/v1/notifications/", headers=_auth(member_user))).json()
        assert task["id"] not in {n["task_id"] for n in center}

        # Opening the task reads the chat.
        await test_client.get(f"{API}/{task['id']}", headers=_auth(member_user))
        member_unread = (await test_client.get(f"{API}/unread-summary", headers=_auth(member_user))).json()
        assert member_unread["total_unread"] == 0

    async def test_chat_preview_in_history_is_80_chars(self, test_client, admin_user, project):
        task = await _create(test_client, admin_user, _single(project.id, [admin_user.id]))
        text = "א" * 200
        posted = await test_client.post(f"/api/v1/tasks/{task['id']}/messages", headers=_auth(admin_user),
                                        data={"message": text})
        assert posted.status_code == 200
        history = (await test_client.get(f"{API}/{task['id']}/history", headers=_auth(admin_user))).json()
        entry = next(e for e in history["items"] if e["action"] == "message_added")
        assert entry["details"]["preview"] == text[:80] + "…"

    async def test_task_attachments(self, test_client, test_db, admin_user, project):
        task = await _create(test_client, admin_user, _single(project.id, [admin_user.id]))
        uploaded = await test_client.post(f"{API}/{task['id']}/attachments", headers=_auth(admin_user),
                                          files={"file": ("invoice.pdf", b"%PDF-1.4", "application/pdf")})
        assert uploaded.status_code == 201
        detail = (await test_client.get(f"{API}/{task['id']}", headers=_auth(admin_user))).json()
        assert [a["file_name"] for a in detail["attachments"]] == ["invoice.pdf"]
        deleted = await test_client.delete(f"{API}/{task['id']}/attachments/{uploaded.json()['id']}",
                                           headers=_auth(admin_user))
        assert deleted.status_code == 204
        assert (await _audit_actions(test_db, task["id"]))[-2:] == ["attachment_added", "attachment_deleted"]

    async def test_attachment_rules_like_regular(self, test_client, test_db, admin_user, member_user, other_member, project):
        """Upload: write permission + Admin/assignee/creator. Delete: update
        permission + Admin or the PRIMARY assignee — the regular tasks' rules."""
        task = await _create(test_client, admin_user, _single(project.id, [member_user.id, other_member.id]))
        upload_url = f"{API}/{task['id']}/attachments"
        pdf = {"file": ("a.pdf", b"%PDF-1.4", "application/pdf")}

        no_write = await test_client.post(upload_url, headers=_auth(member_user), files=pdf)
        assert no_write.json()["detail"] == "Permission denied: write on collection_task"
        await _grant(test_db, member_user, "read", "write", "update")
        await _grant(test_db, other_member, "read", "write", "update")
        uploaded = await test_client.post(upload_url, headers=_auth(member_user), files=pdf)
        assert uploaded.status_code == 201

        delete_url = f"{upload_url}/{uploaded.json()['id']}"
        co_assignee = await test_client.delete(delete_url, headers=_auth(other_member))
        assert co_assignee.status_code == 403 and co_assignee.json()["detail"] == "Access denied."
        assert (await test_client.delete(delete_url, headers=_auth(member_user))).status_code == 204
