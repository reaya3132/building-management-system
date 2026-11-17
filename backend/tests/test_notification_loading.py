"""A notification shows only its sender's name and its task's title; loading it must
not load the whole User / Task (the task's assignees, participants, labels, apartment,
the users' preferences). The existing notification API must return the same data.
"""
from __future__ import annotations

import re

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import event, inspect, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.security import create_access_token, hash_password
from backend.models.task import Task, TaskKind, TaskParticipant, task_assignees
from backend.models.user import User, UserRole
from backend.models.user_notification import UserNotification
from backend.repositories.notification_repository import NotificationRepository

pytestmark = pytest.mark.asyncio

HEAVY_TABLES = {"task_assignees", "task_participants", "task_task_labels", "task_labels", "apartments",
                "user_preferences"}


async def _user(db: AsyncSession, email: str, name: str) -> User:
    user = User(email=email, full_name=name, password_hash=hash_password("Passw0rd!"),
                role=UserRole.MEMBER.value, is_active=True, email_verified=True)
    db.add(user)
    await db.commit()
    return user


@pytest_asyncio.fixture
async def inbox(test_db: AsyncSession):
    """A user with notifications: with a sender and a task (general and collection),
    without a task, without a sender, one read. The task has assignees and a participant."""
    me = await _user(test_db, "me@example.com", "אני")
    sender = await _user(test_db, "sender@example.com", "השולחת")
    general = Task(title="משימה רגילה", assigned_to_user_id=sender.id, created_by_user_id=sender.id)
    collection = Task(title="משימת גבייה", task_kind=TaskKind.COLLECTION, assigned_to_user_id=me.id,
                      created_by_user_id=sender.id)
    test_db.add_all([general, collection])
    await test_db.flush()
    await test_db.execute(task_assignees.insert().values([dict(task_id=general.id, user_id=me.id),
                                                          dict(task_id=general.id, user_id=sender.id)]))
    test_db.add(TaskParticipant(task_id=general.id, user_id=me.id, response_status="pending"))
    from datetime import datetime, timedelta
    base = datetime(2026, 11, 1, 9, 0)
    rows = [
        UserNotification(user_id=me.id, from_user_id=sender.id, task_id=general.id, type="task_message",
                         title="הודעה חדשה במשימה", body="שלום", created_at=base),
        UserNotification(user_id=me.id, from_user_id=sender.id, task_id=None, type="instruction",
                         title="הוראה", created_at=base - timedelta(minutes=1)),
        UserNotification(user_id=me.id, from_user_id=None, task_id=general.id, type="task_reminder",
                         title="תזכורת", created_at=base - timedelta(minutes=2), read_at=base),
        UserNotification(user_id=me.id, from_user_id=sender.id, task_id=collection.id, type="task_assignment",
                         title="משימת גבייה חדשה", created_at=base - timedelta(minutes=3)),
    ]
    test_db.add_all(rows)
    await test_db.commit()
    ids = {"me": me.id, "sender": sender.id, "general": general.id, "collection": collection.id,
           "with_task": rows[0].id, "no_task": rows[1].id, "no_sender": rows[2].id}
    test_db.expunge_all()
    return ids


class _Tables:
    def __init__(self, engine):
        self.engine, self.tables, self.count = engine.sync_engine, set(), 0

    def _on(self, conn, cursor, statement, params, context, executemany):
        self.count += 1
        self.tables.update(re.findall(r"\b(?:FROM|JOIN)\s+\"?(\w+)", statement))

    def __enter__(self):
        event.listen(self.engine, "before_cursor_execute", self._on)
        return self

    def __exit__(self, *exc):
        event.remove(self.engine, "before_cursor_execute", self._on)


def _headers(user_id: int) -> dict:
    return {"Authorization": f"Bearer {create_access_token(user_id)}"}


# ── the model ─────────────────────────────────────────────────────────────────

async def test_a_plain_load_leaves_task_and_sender_unloaded(test_db: AsyncSession, inbox):
    n = (await test_db.execute(select(UserNotification).where(UserNotification.id == inbox["with_task"]))).scalar_one()
    assert {"task", "from_user"} <= inspect(n).unloaded
    for name in ("task", "from_user"):
        with pytest.raises(Exception, match="raise_on_sql|lazy load"):
            getattr(n, name)


async def test_the_repository_loads_only_the_title_and_the_name(test_db: AsyncSession, test_engine, inbox):
    repo = NotificationRepository(test_db)
    with _Tables(test_engine) as seen:
        items = await repo.list_for_user(inbox["me"])
    assert seen.count == 1                                       # one query, the two joins included
    assert not seen.tables & HEAVY_TABLES, sorted(seen.tables & HEAVY_TABLES)
    n = next(i for i in items if i.id == inbox["with_task"])
    assert n.task.title == "משימה רגילה" and n.from_user.full_name == "השולחת"
    assert {"assignees", "participants", "labels", "apartment"} <= inspect(n.task).unloaded
    assert "preferences" in inspect(n.from_user).unloaded


# ── the existing API, same output ─────────────────────────────────────────────

async def test_list_returns_the_same_fields(test_client: AsyncClient, test_engine, test_db, inbox):
    await test_client.get("/api/v1/notifications/", headers=_headers(inbox["me"]))
    test_db.expunge_all()
    with _Tables(test_engine) as seen:
        r = await test_client.get("/api/v1/notifications/", headers=_headers(inbox["me"]))
    assert r.status_code == 200, r.text
    by_id = {n["id"]: n for n in r.json()}
    assert [n["id"] for n in r.json()] == [inbox["with_task"], inbox["no_task"], inbox["no_sender"]]  # newest first, no collection
    expected = {"from_user_name": "השולחת", "task_title": "משימה רגילה", "task_id": inbox["general"],
                "from_user_id": inbox["sender"], "user_id": inbox["me"], "type": "task_message",
                "title": "הודעה חדשה במשימה", "body": "שלום", "read_at": None}
    assert {k: by_id[inbox["with_task"]][k] for k in expected} == expected
    assert by_id[inbox["no_task"]]["task_title"] is None and by_id[inbox["no_task"]]["from_user_name"] == "השולחת"
    assert by_id[inbox["no_sender"]]["from_user_name"] is None and by_id[inbox["no_sender"]]["task_title"] == "משימה רגילה"
    assert by_id[inbox["no_sender"]]["read_at"] is not None
    assert not seen.tables & HEAVY_TABLES - {"user_preferences"}  # user_preferences: the authenticated user only
    unread = await test_client.get("/api/v1/notifications/?unread_only=true", headers=_headers(inbox["me"]))
    assert [n["id"] for n in unread.json()] == [inbox["with_task"], inbox["no_task"]]


async def test_get_one_and_mark_read_and_unread_keep_the_title_and_name(test_client: AsyncClient, test_db, inbox):
    h = _headers(inbox["me"])
    one = (await test_client.get(f"/api/v1/notifications/{inbox['with_task']}", headers=h)).json()
    assert (one["from_user_name"], one["task_title"]) == ("השולחת", "משימה רגילה")
    test_db.expunge_all()
    read = await test_client.patch(f"/api/v1/notifications/{inbox['with_task']}/read?read=true", headers=h)
    assert read.status_code == 200, read.text
    assert read.json()["read_at"] is not None
    assert (read.json()["from_user_name"], read.json()["task_title"]) == ("השולחת", "משימה רגילה")
    test_db.expunge_all()
    unread = await test_client.patch(f"/api/v1/notifications/{inbox['with_task']}/read?read=false", headers=h)
    assert unread.status_code == 200 and unread.json()["read_at"] is None
    assert unread.json()["task_title"] == "משימה רגילה"
    count = await test_client.get("/api/v1/notifications/unread-count", headers=h)
    assert count.json() == {"count": 2}


async def test_another_users_notification_is_not_found(test_client: AsyncClient, inbox):
    h = _headers(inbox["sender"])
    assert (await test_client.get(f"/api/v1/notifications/{inbox['with_task']}", headers=h)).status_code == 404
    assert (await test_client.patch(f"/api/v1/notifications/{inbox['with_task']}/read", headers=h)).status_code == 404


async def test_collection_notifications_keep_the_title(test_client: AsyncClient, test_db, inbox, admin_user):
    from backend.iam.engine import PermissionsEngine
    await PermissionsEngine(test_db).grant_resource_permission(inbox["me"], "collection_task", "*", "read")
    await test_db.commit()
    r = await test_client.get("/api/v1/collection-tasks/notifications", headers=_headers(inbox["me"]))
    assert r.status_code == 200, r.text
    assert [(n["title"], n["task_title"], n["from_user_name"]) for n in r.json()] == [
        ("משימת גבייה חדשה", "משימת גבייה", "השולחת")]


async def test_send_returns_the_sender_name(test_client: AsyncClient, admin_user, admin_token, inbox):
    r = await test_client.post("/api/v1/notifications/send", headers={"Authorization": f"Bearer {admin_token}"},
                               json={"user_ids": [inbox["me"]], "title": "כללי", "body": "x", "type": "general"})
    assert r.status_code == 200, r.text
    assert [(n["from_user_name"], n["task_title"]) for n in r.json()] == [(admin_user.full_name, None)]
