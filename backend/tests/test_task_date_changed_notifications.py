"""task_date_changed notifications: changing a general task's date (PUT /tasks/{id}).

Who: everyone tied to the task (assignees, participants, creator) as they are
after the edit, except the user who changed it. When: only when the DATE changed
— a time change on the same day, re-sending the same value, or editing other
fields notifies nobody. Backlog: scheduling (no date → date) and moving back
(date → no date) notify too. Collection tasks are not reachable through this
endpoint. One notification per recipient per edit.
"""
from __future__ import annotations

from datetime import datetime

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.security import create_access_token, hash_password
from backend.models.project import Project
from backend.models.task import Task, TaskParticipant, TaskStatus, task_assignees
from backend.models.user import User, UserRole
from backend.models.user_notification import NotificationType, UserNotification
from backend.iam.engine import PermissionsEngine

pytestmark = pytest.mark.asyncio

DATE_CHANGED = NotificationType.TASK_DATE_CHANGED
OLD_START = datetime(2026, 11, 24, 10, 0)
OLD_END = datetime(2026, 11, 24, 11, 0)


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
    """creator (not assigned), primary assignee, co-assignee, participant, an Admin
    tied to nothing, and an unrelated member."""
    return {
        "creator": await _user(test_db, "creator@x.io", "היוצרת"),
        "primary": await _user(test_db, "primary@x.io", "דנה כהן"),
        "co": await _user(test_db, "co@x.io", "שותפה"),
        "participant": await _user(test_db, "part@x.io", "משתתפת"),
        "admin": await _user(test_db, "boss@x.io", "מנהלת", UserRole.ADMIN.value),
        "stranger": await _user(test_db, "stranger@x.io", "זרה"),
    }


async def _task(db: AsyncSession, p: dict[str, User], *, start=OLD_START, end=OLD_END,
                recurrence_rule: str = "", is_backlog: bool = False) -> int:
    task = Task(title="הכנת דוח", assigned_to_user_id=p["primary"].id, created_by_user_id=p["creator"].id,
                status=TaskStatus.PENDING, start_time=start, end_time=end,
                recurrence_rule=recurrence_rule, is_backlog=is_backlog)
    db.add(task)
    await db.flush()
    await db.execute(task_assignees.insert().values([dict(task_id=task.id, user_id=p["primary"].id),
                                                     dict(task_id=task.id, user_id=p["co"].id)]))
    db.add(TaskParticipant(task_id=task.id, user_id=p["participant"].id, response_status="accepted"))
    await db.commit()
    task_id = task.id
    db.expunge_all()
    return task_id


async def _put(client: AsyncClient, user: User, task_id: int, **body):
    return await client.put(f"/api/v1/tasks/{task_id}", headers=_auth(user), json=body)


async def _notes(db: AsyncSession, task_id: int) -> list[UserNotification]:
    db.expunge_all()
    rows = await db.execute(
        select(UserNotification)
        .where(UserNotification.task_id == task_id, UserNotification.type == DATE_CHANGED)
        .order_by(UserNotification.user_id, UserNotification.id)
    )
    return list(rows.scalars())


def _recipients(notes: list[UserNotification]) -> list[int]:
    return sorted(n.user_id for n in notes)


# ── who is notified, and the text ────────────────────────────────────────────

async def test_date_change_notifies_everyone_tied_except_the_actor(test_client, test_db, people):
    p = people
    task_id = await _task(test_db, p)
    r = await _put(test_client, p["primary"], task_id,
                   start_time="2026-11-28T10:00:00", end_time="2026-11-28T11:00:00")
    assert r.status_code == 200, r.text

    notes = await _notes(test_db, task_id)
    # One each for co-assignee, participant and creator; not the actor, not outsiders.
    assert _recipients(notes) == sorted([p["co"].id, p["participant"].id, p["creator"].id])
    for n in notes:
        assert n.from_user_id == p["primary"].id
        assert n.title == "תאריך המשימה שונה: הכנת דוח"
        assert n.body == "תאריך המשימה 'הכנת דוח' שונה על ידי דנה כהן מ־24.11.2026 ל־28.11.2026"
        assert n.read_at is None


async def test_admin_actor_notifies_all_assignees_and_not_itself(test_client, test_db, people):
    p = people
    task_id = await _task(test_db, p)
    assert (await _put(test_client, p["admin"], task_id,
                       start_time="2026-11-25T10:00:00", end_time="2026-11-25T11:00:00")).status_code == 200
    assert _recipients(await _notes(test_db, task_id)) == sorted(
        [p["primary"].id, p["co"].id, p["participant"].id, p["creator"].id])


async def test_shows_in_the_notification_center_count_and_list(test_client, test_db, people):
    p = people
    task_id = await _task(test_db, p)
    await _put(test_client, p["primary"], task_id, start_time="2026-11-28T10:00:00", end_time="2026-11-28T11:00:00")
    count = (await test_client.get("/api/v1/notifications/unread-count", headers=_auth(p["co"]),
                                   params={"scope": "all"})).json()
    assert count["count"] == 1
    items = (await test_client.get("/api/v1/notifications/", headers=_auth(p["co"]),
                                   params={"scope": "all"})).json()
    items = items["items"] if isinstance(items, dict) else items
    mine = [n for n in items if n["type"] == DATE_CHANGED]
    assert len(mine) == 1 and mine[0]["task_id"] == task_id
    assert "24.11.2026" in mine[0]["body_preview"] and "28.11.2026" in mine[0]["body_preview"]


# ── backlog ──────────────────────────────────────────────────────────────────

async def test_scheduling_from_the_backlog(test_client, test_db, people):
    p = people
    task_id = await _task(test_db, p, start=None, end=None, is_backlog=True)
    r = await _put(test_client, p["primary"], task_id,
                   start_time="2026-12-01T09:00:00", end_time="2026-12-01T10:00:00")
    assert r.status_code == 200 and r.json()["is_backlog"] is False
    notes = await _notes(test_db, task_id)
    assert len(notes) == 3
    assert notes[0].title == "המשימה תוזמנה: הכנת דוח"
    assert notes[0].body == "המשימה 'הכנת דוח' תוזמנה ל־01.12.2026 על ידי דנה כהן"


async def test_moving_back_to_the_backlog(test_client, test_db, people):
    p = people
    task_id = await _task(test_db, p)
    r = await _put(test_client, p["primary"], task_id, start_time=None, end_time=None, is_backlog=True)
    assert r.status_code == 200, r.text
    notes = await _notes(test_db, task_id)
    assert len(notes) == 3
    assert notes[0].title == "המשימה הוחזרה ל-Backlog: הכנת דוח"
    assert notes[0].body == "המשימה 'הכנת דוח' הוחזרה ל-Backlog על ידי דנה כהן"


async def test_backlog_task_staying_without_a_date_does_not_notify(test_client, test_db, people):
    p = people
    task_id = await _task(test_db, p, start=None, end=None, is_backlog=True)
    assert (await _put(test_client, p["primary"], task_id, title="כותרת חדשה", start_time=None)).status_code == 200
    assert await _notes(test_db, task_id) == []


# ── no false notifications ───────────────────────────────────────────────────

async def test_editing_other_fields_does_not_notify(test_client, test_db, people):
    p = people
    task_id = await _task(test_db, p)
    for body in ({"title": "דוח רבעוני"}, {"description": "פרטים"}, {"status": "in_progress"},
                 {"participant_ids": []}):
        assert (await _put(test_client, p["primary"], task_id, **body)).status_code == 200
    # Admin reassigning only (no date change).
    assert (await _put(test_client, p["admin"], task_id,
                       assigned_to_user_ids=[p["stranger"].id])).status_code == 200
    assert await _notes(test_db, task_id) == []


async def test_resending_the_same_date_does_not_notify(test_client, test_db, people):
    """The edit form re-sends start/end with every save."""
    p = people
    task_id = await _task(test_db, p)
    r = await _put(test_client, p["primary"], task_id, title="דוח", start_time="2026-11-24T10:00:00",
                   end_time="2026-11-24T11:00:00")
    assert r.status_code == 200
    assert await _notes(test_db, task_id) == []


async def test_time_change_on_the_same_day_does_not_notify(test_client, test_db, people):
    p = people
    task_id = await _task(test_db, p)
    # Drag to another hour of the same day, and an end time on the next day.
    assert (await _put(test_client, p["primary"], task_id,
                       start_time="2026-11-24T16:30:00", end_time="2026-11-25T09:00:00")).status_code == 200
    assert await _notes(test_db, task_id) == []


async def test_failed_edit_creates_nothing(test_client, test_db, people):
    p = people
    task_id = await _task(test_db, p)
    # An outsider may not edit: 403, no notification.
    r = await _put(test_client, p["stranger"], task_id, start_time="2026-11-28T10:00:00", end_time="2026-11-28T11:00:00")
    assert r.status_code == 403
    # A non-admin reassignment is rejected before anything is saved.
    r = await _put(test_client, p["primary"], task_id, start_time="2026-11-28T10:00:00",
                   end_time="2026-11-28T11:00:00", assigned_to_user_ids=[p["stranger"].id])
    assert r.status_code == 403
    assert await _notes(test_db, task_id) == []
    task = await test_db.get(Task, task_id)
    assert task.start_time == OLD_START


# ── no duplicates ────────────────────────────────────────────────────────────

async def test_one_notification_per_recipient_even_with_several_ties(test_client, test_db, people):
    """The creator is also a co-assignee and a participant: still one notification."""
    p = people
    task_id = await _task(test_db, p)
    await test_db.execute(task_assignees.insert().values(task_id=task_id, user_id=p["creator"].id))
    test_db.add(TaskParticipant(task_id=task_id, user_id=p["creator"].id, response_status="accepted"))
    await test_db.commit()
    await _put(test_client, p["primary"], task_id, start_time="2026-11-28T10:00:00", end_time="2026-11-28T11:00:00")
    notes = await _notes(test_db, task_id)
    assert [n.user_id for n in notes].count(p["creator"].id) == 1
    assert len(notes) == len({n.user_id for n in notes}) == 3


async def test_each_edit_notifies_once(test_client, test_db, people):
    p = people
    task_id = await _task(test_db, p)
    await _put(test_client, p["primary"], task_id, start_time="2026-11-28T10:00:00", end_time="2026-11-28T11:00:00")
    await _put(test_client, p["primary"], task_id, start_time="2026-11-28T12:00:00", end_time="2026-11-28T13:00:00")
    await _put(test_client, p["primary"], task_id, start_time="2026-11-30T10:00:00", end_time="2026-11-30T11:00:00")
    bodies = [n.body for n in await _notes(test_db, task_id) if n.user_id == p["co"].id]
    assert bodies == [
        "תאריך המשימה 'הכנת דוח' שונה על ידי דנה כהן מ־24.11.2026 ל־28.11.2026",
        "תאריך המשימה 'הכנת דוח' שונה על ידי דנה כהן מ־28.11.2026 ל־30.11.2026",
    ]


# ── recipients after the edit, recurrence, collection ────────────────────────

async def test_recipients_follow_the_assignees_after_the_edit(test_client, test_db, people):
    p = people
    task_id = await _task(test_db, p)
    r = await _put(test_client, p["admin"], task_id, start_time="2026-11-28T10:00:00",
                   end_time="2026-11-28T11:00:00", assigned_to_user_ids=[p["stranger"].id])
    assert r.status_code == 200, r.text
    # primary / co were removed; stranger was added; participant and creator stay.
    assert _recipients(await _notes(test_db, task_id)) == sorted(
        [p["stranger"].id, p["participant"].id, p["creator"].id])


async def test_recurring_task_one_notification_for_the_whole_series(test_client, test_db, people):
    p = people
    task_id = await _task(test_db, p, recurrence_rule="weekly")
    await _put(test_client, p["primary"], task_id, start_time="2026-11-26T10:00:00", end_time="2026-11-26T11:00:00")
    notes = await _notes(test_db, task_id)
    assert len(notes) == 3
    assert notes[0].body == ("תאריך המשימה 'הכנת דוח' שונה על ידי דנה כהן מ־24.11.2026 ל־26.11.2026"
                             " · משימה חוזרת: השינוי חל על כל הסדרה")


async def test_collection_task_is_not_reachable_and_not_notified(test_client, test_db, people):
    p = people
    for action in ("read", "write"):
        await PermissionsEngine(test_db).grant_resource_permission(p["primary"].id, "collection_task", "*", action)
    project = Project(name="פרויקט", is_active=True)
    test_db.add(project)
    await test_db.commit()
    r = await test_client.post("/api/v1/collection-tasks/", headers=_auth(p["primary"]), json={
        "title": "גביית ועד", "collection_type": "single", "project_id": project.id,
        "billing_month": "2026-10", "assignee_ids": [p["primary"].id, p["co"].id], "initial_amount": "100.00"})
    assert r.status_code == 201, r.text
    collection_id = r.json()["id"]
    r = await _put(test_client, p["admin"], collection_id, start_time="2026-11-28T10:00:00",
                   end_time="2026-11-28T11:00:00")
    assert r.status_code == 404
    assert await _notes(test_db, collection_id) == []
