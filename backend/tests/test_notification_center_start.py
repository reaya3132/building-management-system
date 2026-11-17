"""NOTIFICATION_CENTER_START — the notification center starts at one fixed, global
moment. Notifications created before it are not listed, counted, toasted (latest)
or opened (GET / PATCH) through the center (scope=all); they stay in the database,
and every other path (scope=general, collection, task chat) is unchanged.

Configuration: an ISO time with a zone, read once from the environment (never from
the clock), required in production / on Render — the server refuses to start
without it.
"""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest
import pytest_asyncio
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.config import Settings, parse_notification_center_start, settings
from backend.core.security import create_access_token, hash_password
from backend.models.task import Task
from backend.models.user import User, UserRole
from backend.models.user_notification import NotificationType, UserNotification
from backend.repositories.task_repository import TaskRepository
from backend.services.notification_service import create_task_message_notifications

pytestmark = pytest.mark.asyncio

API = "/api/v1/notifications"
# In the past, so a message merged "now" is after it.
START = datetime.utcnow().replace(microsecond=0) - timedelta(hours=1)


def _h(user_id: int) -> dict:
    return {"Authorization": f"Bearer {create_access_token(user_id)}"}


@pytest.fixture
def center_start(monkeypatch):
    monkeypatch.setattr(settings, "NOTIFICATION_CENTER_START", START)
    return START


@pytest_asyncio.fixture
async def inbox(test_db: AsyncSession, center_start) -> dict:
    me = User(email="me@x.io", full_name="אני", password_hash=hash_password("x"), role=UserRole.MEMBER.value,
              is_active=True, email_verified=True)
    other = User(email="sender@x.io", full_name="השולחת", password_hash=hash_password("x"),
                 role=UserRole.MEMBER.value, is_active=True, email_verified=True)
    test_db.add_all([me, other])
    await test_db.flush()
    task = Task(title="משימה", assigned_to_user_id=me.id, created_by_user_id=other.id)
    test_db.add(task)
    await test_db.flush()

    def note(title, at, **kw):
        return UserNotification(user_id=me.id, from_user_id=other.id, task_id=task.id, title=title, created_at=at,
                                type=kw.pop("type", NotificationType.TASK_ASSIGNMENT), **kw)

    rows = {
        "old_unread": note("ישנה שלא נקראה", START - timedelta(days=30)),
        "old_read": note("ישנה שנקראה", START - timedelta(days=20), read_at=START - timedelta(days=19)),
        "old_chat": note("הודעה חדשה במשימה: משימה", START - timedelta(days=2), type=NotificationType.TASK_MESSAGE),
        "at_start": note("בדיוק בהתחלה", START),
        "new_unread": note("חדשה", START + timedelta(minutes=5)),
        "new_read": note("חדשה שנקראה", START + timedelta(minutes=10), read_at=START + timedelta(minutes=11)),
    }
    test_db.add_all(rows.values())
    await test_db.commit()
    ids = {k: v.id for k, v in rows.items()}
    ids.update(me=me.id, other=other.id, task=task.id)
    test_db.expunge_all()
    return ids


async def _ids(client, user_id, path=f"{API}/", **params) -> list[int]:
    r = await client.get(path, headers=_h(user_id), params=params)
    assert r.status_code == 200, r.text
    return [n["id"] for n in r.json()]


# ── the center (scope=all) starts at the configured moment ───────────────────

async def test_the_list_holds_only_what_was_created_from_the_start(test_client, inbox):
    i = inbox
    assert await _ids(test_client, i["me"], scope="all", view="all") == [i["new_read"], i["new_unread"], i["at_start"]]
    assert await _ids(test_client, i["me"], scope="all", view="unread") == [i["new_unread"], i["at_start"]]
    assert await _ids(test_client, i["me"], scope="all", view="read") == [i["new_read"]]


async def test_paging_stays_after_the_start(test_client, inbox):
    i = inbox
    seen, cursor = [], None
    while True:
        params = {"scope": "all", "view": "all", "limit": 1, **({"cursor": cursor} if cursor else {})}
        r = await test_client.get(f"{API}/", headers=_h(i["me"]), params=params)
        seen += [n["id"] for n in r.json()]
        cursor = r.headers.get("x-next-cursor")
        if not cursor:
            break
    assert seen == [i["new_read"], i["new_unread"], i["at_start"]]           # never reaches the old ones


async def test_the_count_and_latest_ignore_old_ones(test_client, inbox):
    i = inbox
    r = (await test_client.get(f"{API}/unread-count", headers=_h(i["me"]),
                               params={"scope": "all", "latest": 10})).json()
    assert r["count"] == 2                                                   # at_start + new_unread
    assert [n["id"] for n in r["latest"]] == [i["new_unread"], i["at_start"]]


async def test_only_old_ones_means_an_empty_center(test_client, test_db, center_start):
    me = User(email="only-old@x.io", full_name="ותיק", password_hash=hash_password("x"),
              role=UserRole.MEMBER.value, is_active=True, email_verified=True)
    test_db.add(me)
    await test_db.flush()
    test_db.add_all([UserNotification(user_id=me.id, type="general", title=f"o{k}",
                                      created_at=START - timedelta(days=k)) for k in range(1, 6)])
    await test_db.commit()
    assert await _ids(test_client, me.id, scope="all", view="all") == []
    r = (await test_client.get(f"{API}/unread-count", headers=_h(me.id), params={"scope": "all", "latest": 10})).json()
    assert r == {"count": 0, "latest": []}
    # still in the database, not deleted
    assert (await test_db.execute(select(func.count()).select_from(UserNotification)
                                  .where(UserNotification.user_id == me.id))).scalar() == 5


async def test_an_old_one_cannot_be_opened_or_marked_through_the_center(test_client, inbox):
    i = inbox
    h = _h(i["me"])
    assert (await test_client.get(f"{API}/{i['old_unread']}", headers=h, params={"scope": "all"})).status_code == 404
    patched = await test_client.patch(f"{API}/{i['old_unread']}/read?read=true&scope=all", headers=h)
    assert patched.status_code == 404
    assert (await test_client.get(f"{API}/{i['new_unread']}", headers=h, params={"scope": "all"})).status_code == 200
    assert (await test_client.patch(f"{API}/{i['new_unread']}/read?read=true&scope=all", headers=h)).status_code == 200
    # the old one was not touched by the refused PATCH
    still = (await test_client.get(f"{API}/{i['old_unread']}", headers=h)).json()
    assert still["read_at"] is None


async def test_a_merged_message_on_an_old_notification_is_new(test_client, test_db, inbox):
    """A new chat message bumps the unread notification to now: it is a new update."""
    i = inbox
    assert i["old_chat"] not in await _ids(test_client, i["me"], scope="all", view="unread")
    task = await TaskRepository(test_db).get(i["task"])
    await create_task_message_notifications(test_db, task, i["other"], "שוב")
    await test_db.commit()
    test_db.expunge_all()
    unread = await _ids(test_client, i["me"], scope="all", view="unread")
    assert unread[0] == i["old_chat"]                                        # merged, same id, now visible


# ── everything else is unchanged ──────────────────────────────────────────────

async def test_other_paths_are_not_filtered(test_client, inbox):
    i = inbox
    h = _h(i["me"])
    legacy = await _ids(test_client, i["me"])                               # scope=general, as before
    assert {i["old_unread"], i["old_read"], i["old_chat"]} <= set(legacy)
    assert (await test_client.get(f"{API}/unread-count", headers=h)).json() == {"count": 4}
    assert (await test_client.get(f"{API}/{i['old_unread']}", headers=h)).status_code == 200
    assert (await test_client.patch(f"{API}/{i['old_unread']}/read?read=true", headers=h)).status_code == 200


async def test_another_users_notifications_stay_apart(test_client, inbox):
    assert await _ids(test_client, inbox["other"], scope="all", view="all") == []


async def test_without_a_start_nothing_is_filtered(test_client, inbox, monkeypatch):
    monkeypatch.setattr(settings, "NOTIFICATION_CENTER_START", None)
    assert len(await _ids(test_client, inbox["me"], scope="all", view="all")) == 6


# ── configuration ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("raw, expected", [
    ("2026-11-20T06:00:00Z", datetime(2026, 11, 20, 6, 0)),
    ("2026-11-20T08:00:00+02:00", datetime(2026, 11, 20, 6, 0)),          # Israel, winter
    ("2026-07-01T09:00:00+03:00", datetime(2026, 7, 1, 6, 0)),            # Israel, summer
    ("  2026-11-20T06:00:00.250000z ", datetime(2026, 11, 20, 6, 0, 0, 250000)),
    ("", None),
    (None, None),
])
async def test_the_start_is_parsed_to_naive_utc(raw, expected):
    assert parse_notification_center_start(raw) == expected


@pytest.mark.parametrize("raw", ["2026-11-20T06:00:00", "20/11/2026 06:00", "tomorrow"])
async def test_an_invalid_or_zoneless_start_fails(raw):
    with pytest.raises(ValueError, match="NOTIFICATION_CENTER_START"):
        parse_notification_center_start(raw)


async def test_the_start_is_fixed_not_derived_from_the_clock(monkeypatch):
    """The same configured value on every start, restart and instance."""
    monkeypatch.setenv("NOTIFICATION_CENTER_START", "2026-11-20T06:00:00Z")
    first, second = Settings(), Settings()
    assert first.NOTIFICATION_CENTER_START == second.NOTIFICATION_CENTER_START == datetime(2026, 11, 20, 6, 0)


@pytest.mark.parametrize("env", [{"ENVIRONMENT": "production"}, {"RENDER": "true"}])
async def test_required_in_production_and_on_render(monkeypatch, env):
    monkeypatch.delenv("NOTIFICATION_CENTER_START", raising=False)
    monkeypatch.delenv("RENDER", raising=False)
    monkeypatch.setenv("ENVIRONMENT", "development")
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    s = Settings()
    assert s.NOTIFICATION_CENTER_START is None and s.requires_notification_center_start
    with pytest.raises(ValueError, match="NOTIFICATION_CENTER_START is not set"):
        s.validate_notification_center()
    monkeypatch.setenv("NOTIFICATION_CENTER_START", "2026-11-20T06:00:00Z")
    Settings().validate_notification_center()                               # set: fine


async def test_optional_in_development(monkeypatch):
    monkeypatch.delenv("NOTIFICATION_CENTER_START", raising=False)
    monkeypatch.delenv("RENDER", raising=False)
    monkeypatch.setenv("ENVIRONMENT", "development")
    Settings().validate_notification_center()


async def test_the_server_refuses_to_start_without_it_on_render(monkeypatch):
    from backend.main import create_app
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.setattr(settings, "NOTIFICATION_CENTER_START", None)
    with pytest.raises(SystemExit, match="NOTIFICATION_CENTER_START"):
        create_app()
