"""Notification-center stage 3a: who is notified, the merged-message wording, and the
task_archived notification of a manual archive (general and collection tasks).

Archiving: everyone tied to the task except the user who archived it; one set of
notifications per archiving (conditional archive + NOT EXISTS); in the archive's
transaction; complete after the task / the archiving user are deleted; none for
unarchiving or for the nightly auto-archive.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.core.security import create_access_token, hash_password
from backend.iam.engine import PermissionsEngine
from backend.models.project import Project
from backend.models.task import Task, TaskKind, TaskParticipant, TaskStatus, task_assignees
from backend.models.user import User, UserRole
from backend.models.user_notification import NotificationType, UserNotification
from backend.repositories.task_repository import TaskRepository
from backend.services.collection_task_service import CollectionTaskService
from backend.services.notification_service import (
    create_task_archived_notifications,
    create_task_message_notifications,
)

pytestmark = pytest.mark.asyncio

ARCHIVED = NotificationType.TASK_ARCHIVED


def _auth(user: User) -> dict:
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def _user(db: AsyncSession, email: str, name: str, role: str = UserRole.MEMBER.value) -> User:
    user = User(email=email, full_name=name, password_hash=hash_password("Passw0rd!"), role=role,
                is_active=True, email_verified=True)
    db.add(user)
    await db.commit()
    return user


@pytest_asyncio.fixture
async def people(test_db: AsyncSession) -> dict[str, User]:
    """creator (not assigned), primary assignee, co-assignee, participant, an
    unrelated Admin and an unrelated member."""
    return {
        "creator": await _user(test_db, "creator@x.io", "היוצרת"),
        "primary": await _user(test_db, "primary@x.io", "המוקצית"),
        "co": await _user(test_db, "co@x.io", "שותפה"),
        "participant": await _user(test_db, "part@x.io", "משתתפת"),
        "admin": await _user(test_db, "boss@x.io", "מנהלת", UserRole.ADMIN.value),
        "stranger": await _user(test_db, "stranger@x.io", "זרה"),
    }


async def _general_task(db: AsyncSession, p: dict[str, User], title: str = "לתקן מעלית") -> int:
    task = Task(title=title, assigned_to_user_id=p["primary"].id, created_by_user_id=p["creator"].id,
                status=TaskStatus.COMPLETED, completed_at=datetime(2026, 11, 1, 9))
    db.add(task)
    await db.flush()
    await db.execute(task_assignees.insert().values([dict(task_id=task.id, user_id=p["primary"].id),
                                                     dict(task_id=task.id, user_id=p["co"].id)]))
    db.add(TaskParticipant(task_id=task.id, user_id=p["participant"].id, response_status="accepted"))
    await db.commit()
    task_id = task.id
    db.expunge_all()
    return task_id


async def _collection_task(client: AsyncClient, db: AsyncSession, p: dict[str, User], by: User) -> int:
    for u in p.values():
        engine = PermissionsEngine(db)
        for action in ("read", "write", "update"):
            await engine.grant_resource_permission(u.id, "collection_task", "*", action)
    project = Project(name="פרויקט גבייה", is_active=True)
    db.add(project)
    await db.commit()
    r = await client.post("/api/v1/collection-tasks/", headers=_auth(by), json={
        "title": "גביית ועד", "collection_type": "single", "project_id": project.id,
        "billing_month": "2026-10", "assignee_ids": [p["primary"].id, p["co"].id], "initial_amount": "100.00"})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _archived(db: AsyncSession, task_id: int | None = None) -> list[UserNotification]:
    q = select(UserNotification).where(UserNotification.type == ARCHIVED).order_by(UserNotification.user_id)
    if task_id is not None:
        q = q.where(UserNotification.task_id == task_id)
    db.expunge_all()
    return list((await db.execute(q)).scalars())


async def _archived_at(db: AsyncSession, task_id: int) -> datetime | None:
    return (await db.execute(select(Task.archived_at).where(Task.id == task_id))).scalar_one()


# ── manual archive: general task ──────────────────────────────────────────────

async def test_general_archive_notifies_everyone_tied_except_the_actor(test_client, test_db, people):
    p = people
    task_id = await _general_task(test_db, p)
    r = await test_client.post(f"/api/v1/tasks/{task_id}/archive", headers=_auth(p["primary"]))
    assert r.status_code == 200, r.text
    assert r.json()["is_archived"] is True

    rows = await _archived(test_db, task_id)
    # the creator (not assigned) is notified; the actor, the unrelated Admin and member are not
    assert {n.user_id for n in rows} == {p["creator"].id, p["co"].id, p["participant"].id}
    archived_at = await _archived_at(test_db, task_id)
    for n in rows:
        assert n.title == "משימה אורכבה: לתקן מעלית"
        assert n.body == "סוג: משימה כללית · אורכבה על ידי המוקצית"
        assert n.from_user_id == p["primary"].id
        assert n.created_at == archived_at                      # the archive time as stored
        assert n.read_at is None


async def test_second_archive_request_is_refused_and_adds_nothing(test_client, test_db, people):
    p = people
    task_id = await _general_task(test_db, p)
    assert (await test_client.post(f"/api/v1/tasks/{task_id}/archive", headers=_auth(p["creator"]))).status_code == 200
    again = await test_client.post(f"/api/v1/tasks/{task_id}/archive", headers=_auth(p["creator"]))
    assert again.status_code == 400 and again.json()["detail"] == "המשימה כבר נמצאת בארכיון"   # unchanged
    assert len(await _archived(test_db, task_id)) == 3


async def test_restore_does_not_notify_and_rearchiving_notifies_again(test_client, test_db, people):
    p = people
    task_id = await _general_task(test_db, p)
    await test_client.post(f"/api/v1/tasks/{task_id}/archive", headers=_auth(p["admin"]))
    first = await _archived_at(test_db, task_id)
    assert len(await _archived(test_db, task_id)) == 4          # admin acted: all four tied users

    restored = await test_client.post(f"/api/v1/tasks/{task_id}/restore", headers=_auth(p["admin"]))
    assert restored.status_code == 200 and restored.json()["is_archived"] is False
    assert len(await _archived(test_db, task_id)) == 4          # restoring notifies nobody

    await test_db.execute(update(UserNotification).values(created_at=first - timedelta(seconds=5)))
    await test_db.commit()                                      # the earlier archive, clearly before
    await test_client.post(f"/api/v1/tasks/{task_id}/archive", headers=_auth(p["admin"]))
    second = await _archived_at(test_db, task_id)
    rows = await _archived(test_db, task_id)
    assert len(rows) == 8                                       # a new archive, a new set
    assert sorted({n.created_at for n in rows}) == [first - timedelta(seconds=5), second]


async def test_admin_unrelated_to_the_task_gets_nothing(test_client, test_db, people):
    p = people
    task_id = await _general_task(test_db, p)
    await test_client.post(f"/api/v1/tasks/{task_id}/archive", headers=_auth(p["creator"]))
    assert p["admin"].id not in {n.user_id for n in await _archived(test_db, task_id)}


async def test_nightly_auto_archive_creates_no_notifications(test_db, people):
    task_id = await _general_task(test_db, people)
    assert await TaskRepository(test_db).archive_completed_tasks() == 1
    await test_db.commit()
    assert await _archived_at(test_db, task_id) is not None
    assert await _archived(test_db) == []


# ── manual archive: collection task ───────────────────────────────────────────

async def test_collection_archive_notifies_and_unarchive_does_not(test_client, test_db, people):
    p = people
    task_id = await _collection_task(test_client, test_db, p, by=p["creator"])
    r = await test_client.post(f"/api/v1/collection-tasks/{task_id}/archive", headers=_auth(p["primary"]))
    assert r.status_code == 200, r.text
    assert r.json()["is_archived"] is True

    rows = await _archived(test_db, task_id)
    assert {n.user_id for n in rows} == {p["creator"].id, p["co"].id}
    archived_at = await _archived_at(test_db, task_id)
    for n in rows:
        assert n.title == "משימת גבייה אורכבה: גביית ועד"
        assert n.body == "סוג: משימת גבייה · אורכבה על ידי המוקצית"
        assert n.created_at == archived_at and n.from_user_id == p["primary"].id

    again = await test_client.post(f"/api/v1/collection-tasks/{task_id}/archive", headers=_auth(p["primary"]))
    assert again.status_code == 200                               # a no-op, as before
    assert len(await _archived(test_db, task_id)) == 2
    un = await test_client.post(f"/api/v1/collection-tasks/{task_id}/unarchive", headers=_auth(p["admin"]))
    assert un.status_code == 200 and un.json()["is_archived"] is False
    assert len(await _archived(test_db, task_id)) == 2


async def test_collection_archive_history_is_logged_once(test_client, test_db, people):
    from backend.models.audit_log import AuditLog
    p = people
    task_id = await _collection_task(test_client, test_db, p, by=p["creator"])
    for _ in range(2):
        await test_client.post(f"/api/v1/collection-tasks/{task_id}/archive", headers=_auth(p["creator"]))
    actions = (await test_db.execute(select(AuditLog.action).where(
        AuditLog.entity == "collection_task", AuditLog.entity_id == str(task_id)))).scalars().all()
    assert list(actions).count("archived") == 1


# ── duplicates, transaction ───────────────────────────────────────────────────

async def test_not_exists_skips_a_second_call_for_the_same_archive(test_db, people):
    p = people
    task_id = await _general_task(test_db, p)
    repo = TaskRepository(test_db)
    archived_at = await repo.archive_if_active(task_id, TaskKind.GENERAL)
    task = await repo.get(task_id)
    for _ in range(2):
        await create_task_archived_notifications(test_db, task, p["admin"], archived_at)
    await test_db.commit()
    assert len(await _archived(test_db, task_id)) == 4
    assert await repo.archive_if_active(task_id, TaskKind.GENERAL) is None    # already archived


async def test_archive_if_active_respects_the_task_kind(test_client, test_db, people):
    general = await _general_task(test_db, people)
    collection = await _collection_task(test_client, test_db, people, by=people["creator"])
    repo = TaskRepository(test_db)
    assert await repo.archive_if_active(general, TaskKind.COLLECTION) is None
    assert await repo.archive_if_active(collection, TaskKind.GENERAL) is None
    await test_db.commit()
    assert await _archived_at(test_db, general) is None and await _archived_at(test_db, collection) is None


async def test_rollback_leaves_neither_archive_nor_notifications(test_db, people):
    p = people
    task_id = await _general_task(test_db, p)
    repo = TaskRepository(test_db)
    archived_at = await repo.archive_if_active(task_id, TaskKind.GENERAL)
    await create_task_archived_notifications(test_db, await repo.get(task_id), p["admin"], archived_at)
    assert archived_at is not None
    await test_db.rollback()                                    # e.g. the request failed later
    assert await _archived_at(test_db, task_id) is None
    assert await _archived(test_db) == []


async def test_a_failure_after_archiving_rolls_both_back(test_client, test_db, people, monkeypatch):
    """The endpoint's archive and notifications share one transaction."""
    from backend.api.v1.endpoints import tasks as tasks_endpoint
    p = people
    task_id = await _general_task(test_db, p)

    def boom(*a, **kw):
        raise RuntimeError("serialization failed")
    monkeypatch.setattr(tasks_endpoint, "_task_to_out", boom)
    r = await test_client.post(f"/api/v1/tasks/{task_id}/archive", headers=_auth(p["creator"]))
    assert r.status_code == 500                                 # the app's error handler
    await test_db.rollback()                                    # what get_db does on an exception
    assert await _archived_at(test_db, task_id) is None
    assert await _archived(test_db) == []


async def test_concurrent_archive_requests_create_one_set(test_engine, test_db, people):
    """Two sessions archive the same task at once: one wins, one set of notifications."""
    if test_engine.dialect.name != "postgresql":
        pytest.skip("needs real concurrent transactions (PostgreSQL)")
    p = people
    task_id = await _general_task(test_db, p)
    sessions = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    started = asyncio.Event()

    async def archive(delay: float):
        async with sessions() as db:
            repo = TaskRepository(db)
            task = await repo.get(task_id)                      # both read it as not archived
            await asyncio.sleep(delay)
            archived_at = await repo.archive_if_active(task_id, TaskKind.GENERAL)
            if archived_at is not None:
                started.set()
                await create_task_archived_notifications(db, task, p["admin"], archived_at)
                await asyncio.sleep(0.3)                        # hold the row lock while the other waits
            await db.commit()
            return archived_at

    results = await asyncio.gather(archive(0), archive(0.1))
    assert sum(r is not None for r in results) == 1
    rows = await _archived(test_db, task_id)
    assert len(rows) == 4 and len({n.user_id for n in rows}) == 4


# ── deletion ──────────────────────────────────────────────────────────────────

async def test_notification_stays_complete_after_task_and_actor_are_deleted(test_client, test_db, people):
    p = people
    task_id = await _general_task(test_db, p)
    actor = await _user(test_db, "temp-admin@x.io", "מנהלת זמנית", UserRole.ADMIN.value)
    await test_client.post(f"/api/v1/tasks/{task_id}/archive", headers=_auth(actor))
    archived_at = await _archived_at(test_db, task_id)

    if not _is_pg(test_db):
        # SQLite here does not enforce foreign keys: apply the model's ON DELETE SET NULL
        # by hand (PostgreSQL does it itself, which the _pg run checks).
        await test_db.execute(update(UserNotification).where(UserNotification.task_id == task_id)
                              .values(task_id=None))
        await test_db.execute(update(UserNotification).where(UserNotification.from_user_id == actor.id)
                              .values(from_user_id=None))
    await test_db.execute(delete(task_assignees).where(task_assignees.c.task_id == task_id))
    await test_db.execute(delete(TaskParticipant).where(TaskParticipant.task_id == task_id))
    await test_db.execute(delete(Task).where(Task.id == task_id))
    await test_db.execute(delete(User).where(User.id == actor.id))
    await test_db.commit()

    rows = await _archived(test_db)
    assert {n.user_id for n in rows} == {p["creator"].id, p["primary"].id, p["co"].id, p["participant"].id}
    for n in rows:
        assert n.title == "משימה אורכבה: לתקן מעלית"                     # task name and kind
        assert n.body == "סוג: משימה כללית · אורכבה על ידי מנהלת זמנית"   # kind and who archived
        assert n.created_at == archived_at                                # when
        assert n.task_id is None and n.from_user_id is None

    # and the existing API still returns it to its recipient
    listed = await test_client.get("/api/v1/notifications/?type=task_archived", headers=_auth(p["creator"]))
    assert listed.status_code == 200, listed.text
    [item] = listed.json()
    assert (item["title"], item["body"]) == (rows[0].title, rows[0].body)


def _is_pg(db: AsyncSession) -> bool:
    return db.bind.dialect.name == "postgresql"




# ── recipients and wording of chat-message notifications ──────────────────────

async def test_message_notifies_the_creator_and_merges_in_the_plural(test_db, people):
    p = people
    task_id = await _general_task(test_db, p)
    task = await TaskRepository(test_db).get(task_id)
    await create_task_message_notifications(test_db, task, p["primary"].id, "שלום")
    await test_db.commit()

    async def messages():
        test_db.expunge_all()
        return list((await test_db.execute(select(UserNotification).where(
            UserNotification.type == NotificationType.TASK_MESSAGE).order_by(UserNotification.id))).scalars())

    first = await messages()
    assert {n.user_id for n in first} == {p["creator"].id, p["co"].id, p["participant"].id}  # not the author
    assert {n.title for n in first} == {"הודעה חדשה במשימה: לתקן מעלית"}

    creator_row = next(n for n in first if n.user_id == p["creator"].id)
    before = creator_row.created_at
    task = await TaskRepository(test_db).get(task_id)
    await create_task_message_notifications(test_db, task, p["co"].id, "עוד הודעה")
    await test_db.commit()
    second = await messages()
    mine = [n for n in second if n.user_id == p["creator"].id]
    assert len(mine) == 1 and mine[0].id == creator_row.id           # merged, no duplicate
    assert mine[0].title == "הודעות חדשות במשימה: לתקן מעלית"         # plural, no count
    assert mine[0].created_at >= before and mine[0].from_user_id == p["co"].id

    await test_db.execute(update(UserNotification).where(UserNotification.id == creator_row.id)
                          .values(read_at=datetime.utcnow()))
    await test_db.commit()
    task = await TaskRepository(test_db).get(task_id)
    await create_task_message_notifications(test_db, task, p["co"].id, "אחרי קריאה")
    await test_db.commit()
    after_read = [n for n in await messages() if n.user_id == p["creator"].id]
    assert len(after_read) == 2                                        # read → a new notification
    assert after_read[-1].title == "הודעה חדשה במשימה: לתקן מעלית"


async def test_author_who_is_the_creator_is_not_notified(test_db, people):
    p = people
    task_id = await _general_task(test_db, p)
    task = await TaskRepository(test_db).get(task_id)
    await create_task_message_notifications(test_db, task, p["creator"].id, "מהיוצרת")
    await test_db.commit()
    rows = (await test_db.execute(select(UserNotification.user_id).where(
        UserNotification.type == NotificationType.TASK_MESSAGE))).scalars().all()
    assert set(rows) == {p["primary"].id, p["co"].id, p["participant"].id}
