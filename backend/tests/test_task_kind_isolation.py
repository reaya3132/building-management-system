"""Stage 1 of the collection-tasks module: regular task screens are isolated
from collection (גבייה) tasks.

Collection tasks share the ``tasks`` table (``task_kind='collection'``) but must
never surface through the regular task API, counters, notifications or the
nightly archive job. These tests insert a regular and a collection task side by
side (directly through ``test_db`` — there is no collection API yet) and assert
that every regular entry point returns only the regular one.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.security import create_access_token
from backend.models.task import Task, TaskKind, TaskLabel, TaskMessage, TaskStatus, task_assignees
from backend.models.user import User
from backend.models.user_notification import NotificationType, UserNotification
from backend.repositories.notification_repository import NotificationRepository
from backend.repositories.task_label_repository import TaskLabelRepository
from backend.repositories.task_repository import TaskRepository

GENERAL_TITLE = "isolation-general"
COLLECTION_TITLE = "isolation-collection"


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _naive_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


async def _add_pair(db: AsyncSession, user: User, **fields) -> tuple[Task, Task]:
    """Insert a regular and a collection task with identical fields, both
    assigned (primary + co-owner row) to ``user``."""
    general = Task(title=GENERAL_TITLE, assigned_to_user_id=user.id, **fields)
    collection = Task(
        title=COLLECTION_TITLE,
        task_kind=TaskKind.COLLECTION,
        assigned_to_user_id=user.id,
        **fields,
    )
    db.add_all([general, collection])
    await db.flush()
    await db.execute(
        task_assignees.insert(),
        [
            {"task_id": general.id, "user_id": user.id},
            {"task_id": collection.id, "user_id": user.id},
        ],
    )
    await db.commit()
    return general, collection


async def _titles(client: AsyncClient, url: str, token: str, params: dict | None = None) -> set[str]:
    response = await client.get(url, headers=_auth(token), params=params or {})
    assert response.status_code == 200, response.text
    return {task["title"] for task in response.json()}


@pytest.mark.asyncio
class TestTaskKindColumn:
    async def test_default_kind_is_general(self, test_db: AsyncSession, member_user: User):
        task = Task(title="no-kind-given", assigned_to_user_id=member_user.id)
        test_db.add(task)
        await test_db.commit()
        await test_db.refresh(task)
        assert task.task_kind == TaskKind.GENERAL

    async def test_unknown_kind_rejected_by_check_constraint(
        self, test_db: AsyncSession, member_user: User
    ):
        test_db.add(Task(title="bad-kind", task_kind="other", assigned_to_user_id=member_user.id))
        with pytest.raises(IntegrityError):
            await test_db.commit()
        await test_db.rollback()


@pytest.mark.api
@pytest.mark.asyncio
class TestRegularListsExcludeCollection:
    async def test_list_admin_and_member(
        self, test_client: AsyncClient, test_db: AsyncSession,
        admin_token: str, member_token: str, member_user: User,
    ):
        await _add_pair(test_db, member_user)
        for token in (admin_token, member_token):
            titles = await _titles(test_client, "/api/v1/tasks/", token)
            assert GENERAL_TITLE in titles
            assert COLLECTION_TITLE not in titles

    async def test_list_admin_filtered_by_user_and_dates(
        self, test_client: AsyncClient, test_db: AsyncSession,
        admin_token: str, member_user: User,
    ):
        start = _naive_now()
        await _add_pair(test_db, member_user, start_time=start, end_time=start + timedelta(hours=1))
        params = {
            "assigned_to_user_id": member_user.id,
            "start": (start - timedelta(days=1)).isoformat(),
            "end": (start + timedelta(days=1)).isoformat(),
        }
        titles = await _titles(test_client, "/api/v1/tasks/", admin_token, params)
        assert titles == {GENERAL_TITLE}

    async def test_list_include_archived(
        self, test_client: AsyncClient, test_db: AsyncSession,
        admin_token: str, member_user: User,
    ):
        await _add_pair(test_db, member_user, is_archived=True, archived_at=_naive_now())
        titles = await _titles(test_client, "/api/v1/tasks/", admin_token, {"include_archived": True})
        assert titles == {GENERAL_TITLE}

    async def test_archived_list(
        self, test_client: AsyncClient, test_db: AsyncSession,
        admin_token: str, member_token: str, member_user: User,
    ):
        await _add_pair(test_db, member_user, is_archived=True, archived_at=_naive_now())
        for token in (admin_token, member_token):
            assert await _titles(test_client, "/api/v1/tasks/archived", token) == {GENERAL_TITLE}

    async def test_backlog(
        self, test_client: AsyncClient, test_db: AsyncSession,
        admin_token: str, member_token: str, member_user: User,
    ):
        await _add_pair(test_db, member_user, start_time=None, status=TaskStatus.PENDING)
        for token in (admin_token, member_token):
            assert await _titles(test_client, "/api/v1/tasks/backlog", token) == {GENERAL_TITLE}

    async def test_super_tasks(
        self, test_client: AsyncClient, test_db: AsyncSession,
        admin_token: str, member_user: User,
    ):
        await _add_pair(test_db, member_user, is_super_task=True)
        assert await _titles(test_client, "/api/v1/tasks/super", admin_token) == {GENERAL_TITLE}


@pytest.mark.asyncio
class TestRepositoryEntryPoints:
    """Reception-desk lists/counts and the nightly archive job call the
    repository directly, so they are asserted at that level."""

    async def test_apartment_lists_and_counts(self, test_db: AsyncSession, member_user: User):
        apartment_id = 4242
        await _add_pair(test_db, member_user, apartment_id=apartment_id, start_time=None)
        repo = TaskRepository(test_db)

        assert [t.title for t in await repo.list_by_apartment(apartment_id)] == [GENERAL_TITLE]
        assert await repo.count_open_by_apartment_ids([apartment_id]) == {apartment_id: 1}

        for task in (await test_db.execute(select(Task))).scalars():
            task.is_archived = True
            task.archived_at = _naive_now()
        await test_db.commit()
        assert [t.title for t in await repo.list_archived_by_apartment(apartment_id)] == [GENERAL_TITLE]

    async def test_get_defaults_to_general(self, test_db: AsyncSession, member_user: User):
        general, collection = await _add_pair(test_db, member_user)
        repo = TaskRepository(test_db)
        assert (await repo.get(general.id)) is not None
        assert (await repo.get(collection.id)) is None
        assert (await repo.get(collection.id, kind=TaskKind.COLLECTION)) is not None

    async def test_nightly_archive_skips_collection(self, test_db: AsyncSession, member_user: User):
        yesterday = _naive_now() - timedelta(days=2)
        general, collection = await _add_pair(
            test_db, member_user, status=TaskStatus.COMPLETED, completed_at=yesterday
        )
        archived = await TaskRepository(test_db).archive_completed_tasks()
        await test_db.commit()
        assert archived == 1
        await test_db.refresh(general)
        await test_db.refresh(collection)
        assert general.is_archived is True
        assert collection.is_archived is False

    async def test_label_usage_counts_only_regular_tasks(
        self, test_db: AsyncSession, member_user: User
    ):
        general, collection = await _add_pair(test_db, member_user)
        label = TaskLabel(name="isolation-label")
        test_db.add(label)
        await test_db.flush()
        general_loaded = await TaskRepository(test_db).get(general.id)
        collection_loaded = await TaskRepository(test_db).get(collection.id, kind=TaskKind.COLLECTION)
        general_loaded.labels.append(label)
        collection_loaded.labels.append(label)
        await test_db.commit()
        assert await TaskLabelRepository(test_db).count_tasks_for_label(label.id) == 1


@pytest.mark.api
@pytest.mark.asyncio
class TestRegularApiRejectsCollectionTask:
    """Every regular per-task endpoint answers 404 for a collection task, so it
    can't be read, changed, archived, restored or deleted through it."""

    @pytest_asyncio.fixture
    async def collection_task_id(self, test_db: AsyncSession, member_user: User) -> int:
        _, collection = await _add_pair(test_db, member_user)
        return collection.id

    @pytest.mark.parametrize(
        "method,suffix,kwargs",
        [
            ("get", "", {}),
            ("put", "", {"json": {"title": "hijack"}}),
            ("delete", "", {}),
            ("post", "/archive", {}),
            ("post", "/restore", {}),
            ("post", "/acknowledge", {}),
            ("post", "/remind", {}),
            ("post", "/respond", {"json": {"response": "accepted"}}),
            ("get", "/checklist", {}),
            ("post", "/checklist", {"json": {"text": "item"}}),
            # Task-level files of a collection task live under /collection-tasks.
            ("post", "/attachments", {"files": {"file": ("a.txt", b"x", "text/plain")}}),
        ],
    )
    async def test_endpoint_returns_404(
        self, test_client: AsyncClient, admin_token: str, collection_task_id: int,
        method: str, suffix: str, kwargs: dict,
    ):
        response = await getattr(test_client, method)(
            f"/api/v1/tasks/{collection_task_id}{suffix}", headers=_auth(admin_token), **kwargs
        )
        assert response.status_code == 404, (method, suffix, response.status_code, response.text)

    async def test_shared_chat_uses_regular_access_rule(
        self, test_client: AsyncClient, test_db: AsyncSession, member_token: str, admin_token: str,
        collection_task_id: int,
    ):
        """The chat endpoints are shared by design and apply the regular rule to
        both kinds (Admin or an assignee/participant). A collection task also
        needs collection_task:read: the assigned member here has none."""
        url = f"/api/v1/tasks/{collection_task_id}/messages"
        assert (await test_client.get(url, headers=_auth(member_token))).status_code == 403
        assert (await test_client.post(url, headers=_auth(member_token), data={"message": "hi"})).status_code == 403
        assert (await test_client.get(url, headers=_auth(admin_token))).status_code == 200

        outsider = User(email="outsider@test.com", password_hash="x", full_name="Outsider",
                        role="Member", is_active=True, email_verified=True)
        test_db.add(outsider)
        await test_db.commit()
        outsider_token = create_access_token(outsider.id)
        assert (await test_client.get(url, headers=_auth(outsider_token))).status_code == 403

    async def test_collection_task_left_untouched(
        self, test_client: AsyncClient, test_db: AsyncSession, admin_token: str, collection_task_id: int,
    ):
        await test_client.put(
            f"/api/v1/tasks/{collection_task_id}", headers=_auth(admin_token), json={"title": "hijack"}
        )
        await test_client.delete(f"/api/v1/tasks/{collection_task_id}", headers=_auth(admin_token))
        await test_client.post(f"/api/v1/tasks/{collection_task_id}/archive", headers=_auth(admin_token))
        test_db.expire_all()
        task = await test_db.get(Task, collection_task_id)
        assert task is not None
        assert task.title == COLLECTION_TITLE
        assert task.is_archived is False


@pytest.mark.api
@pytest.mark.asyncio
class TestRegularCreateIsAlwaysGeneral:
    async def test_client_cannot_choose_kind(
        self, test_client: AsyncClient, test_db: AsyncSession, admin_token: str, member_user: User,
    ):
        with patch(
            "backend.api.v1.endpoints.tasks.create_outlook_event", new=AsyncMock(return_value=None)
        ) as outlook:
            response = await test_client.post(
                "/api/v1/tasks/",
                headers=_auth(admin_token),
                json={
                    "title": "tries-collection",
                    "assigned_to_user_id": member_user.id,
                    "task_kind": TaskKind.COLLECTION,
                },
            )
        assert response.status_code == 200, response.text
        assert response.json()["task_kind"] == TaskKind.GENERAL
        stored = await test_db.get(Task, response.json()["id"])
        assert stored.task_kind == TaskKind.GENERAL
        # Regular creation keeps syncing to Outlook exactly as before.
        outlook.assert_awaited_once()


@pytest.mark.api
@pytest.mark.asyncio
class TestCountersAndNotifications:
    async def test_unread_summary_counts_only_regular_tasks(
        self, test_client: AsyncClient, test_db: AsyncSession,
        member_token: str, member_user: User, admin_user: User,
    ):
        general, collection = await _add_pair(test_db, member_user)
        test_db.add_all([
            TaskMessage(task_id=general.id, user_id=admin_user.id, message="g"),
            TaskMessage(task_id=collection.id, user_id=admin_user.id, message="c"),
        ])
        await test_db.commit()
        response = await test_client.get("/api/v1/tasks/unread-summary", headers=_auth(member_token))
        assert response.status_code == 200, response.text
        assert response.json() == {"total_unread": 1, "task_count": 1}

    async def test_general_notification_center_excludes_collection(
        self, test_client: AsyncClient, test_db: AsyncSession,
        member_token: str, member_user: User,
    ):
        general, collection = await _add_pair(test_db, member_user)
        test_db.add_all([
            UserNotification(user_id=member_user.id, type=NotificationType.TASK_MESSAGE,
                             title="on-general", task_id=general.id),
            UserNotification(user_id=member_user.id, type=NotificationType.TASK_MESSAGE,
                             title="on-collection", task_id=collection.id),
            UserNotification(user_id=member_user.id, type=NotificationType.TASK_REMINDER,
                             title="no-task", task_id=None),
        ])
        await test_db.commit()

        response = await test_client.get("/api/v1/notifications/", headers=_auth(member_token))
        assert response.status_code == 200, response.text
        assert {n["title"] for n in response.json()} == {"on-general", "no-task"}

        response = await test_client.get("/api/v1/notifications/unread-count", headers=_auth(member_token))
        assert response.json() == {"count": 2}

        repo = NotificationRepository(test_db)
        collection_items = await repo.list_for_user(member_user.id, task_kind=TaskKind.COLLECTION)
        assert [n.title for n in collection_items] == ["on-collection"]
        assert await repo.count_unread(member_user.id, task_kind=TaskKind.COLLECTION) == 1
