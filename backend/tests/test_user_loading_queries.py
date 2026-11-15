"""Loading a user must not load the user's tasks, messages or notifications.

Every authenticated request loads the current user (get_current_user). Its five
activity lists (tasks, assigned_tasks, task_participations, task_messages,
notifications) are never used through the user object, so they must stay
unloaded — before, they were loaded automatically on every request and pulled a
large part of the task graph with them. ``preferences`` is used by the user
responses and stays loaded.

Also covers what the reverse side of those relationships (back_populates) must
keep doing: assigning and removing task assignees and participants.
"""
from __future__ import annotations

import re

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import event, inspect, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.security import hash_password
from backend.models.task import Task, TaskMessage, TaskParticipant, task_assignees
from backend.models.user import User, UserRole
from backend.models.user_notification import UserNotification
from backend.repositories.user_repository import UserRepository

pytestmark = pytest.mark.asyncio

ACTIVITY_LISTS = ("tasks", "assigned_tasks", "task_participations", "task_messages", "notifications")
ACTIVITY_TABLES = {"tasks", "task_assignees", "task_participants", "task_messages", "user_notifications",
                   "task_message_attachments"}


async def _user(db: AsyncSession, email: str, role: str = UserRole.MEMBER.value) -> User:
    user = User(email=email, full_name=email.split("@")[0], password_hash=hash_password("Passw0rd!"),
                role=role, is_active=True, email_verified=True)
    db.add(user)
    await db.commit()
    return user


@pytest_asyncio.fixture
async def busy_user(test_db: AsyncSession, admin_user: User) -> User:
    """A user with activity in every list: tasks, an assignment, a participation, a message, a notification."""
    user = await _user(test_db, "busy@example.com")
    task = Task(title="t", assigned_to_user_id=user.id, created_by_user_id=admin_user.id)
    test_db.add(task)
    await test_db.flush()
    await test_db.execute(task_assignees.insert().values(task_id=task.id, user_id=user.id))
    test_db.add_all([
        TaskParticipant(task_id=task.id, user_id=user.id, response_status="pending"),
        TaskMessage(task_id=task.id, user_id=user.id, message="hi"),
        UserNotification(user_id=user.id, task_id=task.id, type="task_message", title="n"),
    ])
    await test_db.commit()
    test_db.expunge_all()  # the next load reads from the database, as a request does
    return user


class _Statements:
    """The SQL statements run while the context is open, by table."""

    def __init__(self, engine):
        self.engine, self.tables = engine.sync_engine, []

    def _on(self, conn, cursor, statement, params, context, executemany):
        match = re.search(r"\bFROM\s+\"?(\w+)", statement)  # the first table (FROM may follow a line break)
        self.tables.append(match.group(1) if match else statement.split()[0])

    def __enter__(self):
        event.listen(self.engine, "before_cursor_execute", self._on)
        return self

    def __exit__(self, *exc):
        event.remove(self.engine, "before_cursor_execute", self._on)


# ── the user load itself ──────────────────────────────────────────────────────

async def test_loading_a_user_leaves_the_activity_lists_unloaded(test_db: AsyncSession, busy_user: User):
    user = await UserRepository(test_db).get_by_id(busy_user.id)
    state = inspect(user)
    assert set(ACTIVITY_LISTS) <= state.unloaded, f"loaded: {set(ACTIVITY_LISTS) - state.unloaded}"
    assert "preferences" not in state.unloaded  # still loaded: the user responses use it


async def test_reading_a_list_by_accident_fails_loudly(test_db: AsyncSession, busy_user: User):
    """lazy='raise_on_sql': an implicit load is an explicit error, never a silent slow query."""
    user = await UserRepository(test_db).get_by_id(busy_user.id)
    for name in ACTIVITY_LISTS:
        with pytest.raises(Exception, match="raise_on_sql|lazy load"):
            getattr(user, name)


async def test_a_list_can_still_be_loaded_explicitly(test_db: AsyncSession, busy_user: User):
    from sqlalchemy.orm import selectinload
    user = (await test_db.execute(select(User).where(User.id == busy_user.id)
                                  .options(selectinload(User.task_messages)))).scalar_one()
    assert [m.message for m in user.task_messages] == ["hi"]


# ── authenticated requests ────────────────────────────────────────────────────

@pytest.mark.parametrize("path", ["/api/v1/users/me", "/api/v1/notifications/unread-count", "/api/v1/users/for-tasks"])
async def test_authentication_does_not_touch_the_activity_tables(test_client: AsyncClient, test_engine, test_db,
                                                                 busy_user: User, path):
    from backend.core.security import create_access_token
    headers = {"Authorization": f"Bearer {create_access_token(busy_user.id)}"}
    await test_client.get(path, headers=headers)  # warm-up
    test_db.expunge_all()
    with _Statements(test_engine) as seen:
        r = await test_client.get(path, headers=headers)
    assert r.status_code == 200, r.text
    touched = set(seen.tables) & ACTIVITY_TABLES
    if path.endswith("unread-count"):
        touched -= {"user_notifications", "tasks"}  # the endpoint's own count query
    assert not touched, f"{path} loaded {sorted(touched)}"
    assert len(seen.tables) <= 4, f"{path}: {len(seen.tables)} statements {seen.tables}"


async def test_me_returns_the_preferences(test_client: AsyncClient, test_db: AsyncSession, admin_user: User,
                                          admin_token: str):
    from backend.models.user_preference import UserPreference
    test_db.add(UserPreference(user_id=admin_user.id, calendar_color="#123456"))
    await test_db.commit()
    test_db.expunge_all()
    r = await test_client.get("/api/v1/users/me", headers={"Authorization": f"Bearer {admin_token}"})
    assert r.status_code == 200 and r.json()["calendar_color"] == "#123456"


# ── back_populates: assigning and removing still work ─────────────────────────

async def _ids(db: AsyncSession, table, task_id: int) -> set[int]:
    return set((await db.execute(select(table.c.user_id).where(table.c.task_id == task_id))).scalars())


async def test_task_assignees_and_participants_are_added_and_removed(test_client: AsyncClient, test_db: AsyncSession,
                                                                     admin_token: str):
    a, b, c, d = [await _user(test_db, f"{n}@example.com") for n in "abcd"]
    h = {"Authorization": f"Bearer {admin_token}"}
    r = await test_client.post("/api/v1/tasks/", headers=h, json={
        "title": "assign", "assigned_to_user_id": a.id, "assigned_to_user_ids": [a.id, b.id], "participant_ids": [c.id]})
    assert r.status_code in (200, 201), r.text
    tid = r.json()["id"]
    assert await _ids(test_db, task_assignees, tid) == {a.id, b.id}

    test_db.expunge_all()
    r = await test_client.put(f"/api/v1/tasks/{tid}", headers=h, json={
        "assigned_to_user_id": a.id, "assigned_to_user_ids": [a.id, c.id], "participant_ids": [d.id]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["assigned_to_user_ids"] == [a.id, c.id]
    assert [p["user_id"] for p in body["participants"]] == [d.id]
    assert await _ids(test_db, task_assignees, tid) == {a.id, c.id}           # b removed, c added
    parts = set((await test_db.execute(select(TaskParticipant.user_id).where(TaskParticipant.task_id == tid))).scalars())
    assert parts == {d.id}                                                     # c removed (now an assignee), d added

    test_db.expunge_all()
    r = await test_client.put(f"/api/v1/tasks/{tid}", headers=h, json={"participant_ids": []})
    assert r.status_code == 200 and r.json()["participants"] == []


async def test_orm_assignment_with_unloaded_reverse_lists(test_db: AsyncSession, admin_user: User):
    """task.assignees = [...] updates the users' reverse list passively, without loading it."""
    a, b = await _user(test_db, "orm-a@example.com"), await _user(test_db, "orm-b@example.com")
    task = Task(title="orm", assigned_to_user_id=a.id, created_by_user_id=admin_user.id)
    test_db.add(task)
    await test_db.commit()
    test_db.expunge_all()

    task = (await test_db.execute(select(Task).where(Task.title == "orm"))).scalar_one()
    users = (await test_db.execute(select(User).where(User.id.in_([a.id, b.id])).order_by(User.id))).scalars().all()
    assert all("assigned_tasks" in inspect(u).unloaded for u in users)
    task.assignees = list(users)
    await test_db.commit()
    assert await _ids(test_db, task_assignees, task.id) == {a.id, b.id}
    task.assignees = [users[0]]
    await test_db.commit()
    assert await _ids(test_db, task_assignees, task.id) == {a.id}


async def test_collection_task_assignees_are_replaced(test_db: AsyncSession, admin_user: User):
    from datetime import date
    from decimal import Decimal
    from backend.models.project import Project
    from backend.schemas.collection_task import CollectionTaskCreate, CollectionTaskUpdate
    from backend.services.collection_task_service import CollectionTaskService

    a, b = await _user(test_db, "col-a@example.com"), await _user(test_db, "col-b@example.com")
    project = Project(name="p", is_active=True)
    test_db.add(project)
    await test_db.commit()
    service = CollectionTaskService(test_db, admin_user)
    task_id = await service.create(
        CollectionTaskCreate(title="גבייה", collection_type="single", project_id=project.id,
                             billing_month=date(2026, 11, 1), assignee_ids=[a.id], initial_amount=Decimal("10")),
        [a])
    await test_db.commit()
    test_db.expunge_all()
    admin = (await test_db.execute(select(User).where(User.id == admin_user.id))).scalar_one()
    users = (await test_db.execute(select(User).where(User.id.in_([a.id, b.id])).order_by(User.id))).scalars().all()
    await CollectionTaskService(test_db, admin).update(task_id, CollectionTaskUpdate(assignee_ids=[b.id]), [users[1]])
    await test_db.commit()
    assert await _ids(test_db, task_assignees, task_id) == {b.id}
