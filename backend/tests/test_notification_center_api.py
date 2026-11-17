"""Notification-center stage 3b: the existing notification API, extended.

GET /notifications/      scope (general | all), view (unread | read | all), cursor
                         keyset paging with X-Next-Cursor, task_kind, body_preview.
GET /unread-count        scope=all (every module, capped), latest=N (for toasts).
Without the new parameters both endpoints answer exactly as before.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import event, insert, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.security import create_access_token, hash_password
from backend.models.task import Task, TaskKind
from backend.models.user import User, UserRole
from backend.models.user_notification import NotificationType, UserNotification

pytestmark = pytest.mark.asyncio

API = "/api/v1/notifications"
BASE = datetime(2026, 11, 10, 9, 0)
HEAVY_TABLES = {"task_assignees", "task_participants", "task_task_labels", "task_labels", "apartments"}
LEGACY_KEYS = {"id", "user_id", "from_user_id", "task_id", "type", "title", "body", "read_at", "created_at",
               "from_user_name", "task_title"}


def _h(user_id: int) -> dict:
    return {"Authorization": f"Bearer {create_access_token(user_id)}"}


async def _user(db: AsyncSession, email: str, name: str) -> User:
    user = User(email=email, full_name=name, password_hash=hash_password("Passw0rd!"),
                role=UserRole.MEMBER.value, is_active=True, email_verified=True)
    db.add(user)
    await db.commit()
    return user


@pytest_asyncio.fixture
async def world(test_db: AsyncSession) -> dict:
    """me: one notification of each kind, newest first —
    chat (general task), archived (collection), assignment (collection),
    assignment (general), admin message (no task), reminder (read).
    other: notifications that must never show up for me."""
    me = await _user(test_db, "me@x.io", "אני")
    sender = await _user(test_db, "sender@x.io", "השולחת")
    other = await _user(test_db, "other@x.io", "אחרת")
    general = Task(title="משימה רגילה", assigned_to_user_id=me.id, created_by_user_id=sender.id)
    collection = Task(title="גביית ועד", task_kind=TaskKind.COLLECTION, assigned_to_user_id=me.id,
                      created_by_user_id=sender.id)
    test_db.add_all([general, collection])
    await test_db.flush()
    long_body = "שורה ראשונה\nשורה שנייה " + "א" * 300
    specs = [
        ("chat", dict(type=NotificationType.TASK_MESSAGE, task_id=general.id, title="הודעות חדשות במשימה: משימה רגילה",
                      body="תוכן פרטי של הצ'אט")),
        ("archived", dict(type=NotificationType.TASK_ARCHIVED, task_id=collection.id,
                          title="משימת גבייה אורכבה: גביית ועד", body="סוג: משימת גבייה · אורכבה על ידי השולחת")),
        ("coll_assign", dict(type=NotificationType.TASK_ASSIGNMENT, task_id=collection.id,
                             title="משימת גבייה חדשה: גביית ועד", body=None)),
        ("gen_assign", dict(type=NotificationType.TASK_ASSIGNMENT, task_id=general.id,
                            title="משימה חדשה: משימה רגילה", body="לבדוק את המעלית")),
        ("admin", dict(type=NotificationType.GENERAL, task_id=None, title="הודעה מהנהלה", body=long_body)),
        ("reminder", dict(type=NotificationType.TASK_REMINDER, task_id=general.id, title="תזכורת: משימה רגילה",
                          body="מחר", read_at=BASE)),
    ]
    rows = {}
    for i, (key, spec) in enumerate(specs):
        rows[key] = UserNotification(user_id=me.id, from_user_id=sender.id, created_at=BASE - timedelta(minutes=i),
                                     **spec)
    rows["foreign"] = UserNotification(user_id=other.id, from_user_id=sender.id, task_id=collection.id,
                                       type=NotificationType.TASK_ASSIGNMENT, title="של מישהי אחרת",
                                       created_at=BASE + timedelta(hours=1))
    test_db.add_all(rows.values())
    await test_db.commit()
    ids = {k: n.id for k, n in rows.items()}
    ids.update(me=me.id, other=other.id, sender=sender.id, general=general.id, collection=collection.id)
    test_db.expunge_all()
    return ids


class _Seen:
    def __init__(self, engine):
        self.engine, self.count, self.tables = engine.sync_engine, 0, set()

    def _on(self, conn, cursor, statement, *a):
        self.count += 1
        self.tables.update(re.findall(r"\b(?:FROM|JOIN)\s+\"?(\w+)", statement))

    def __enter__(self):
        event.listen(self.engine, "before_cursor_execute", self._on)
        return self

    def __exit__(self, *exc):
        event.remove(self.engine, "before_cursor_execute", self._on)


async def _get(client, user_id, path=f"{API}/", **params):
    r = await client.get(path, headers=_h(user_id), params=params)
    assert r.status_code == 200, r.text
    return r


# ── backward compatibility ────────────────────────────────────────────────────

async def test_without_new_parameters_the_answers_keep_their_meaning(test_client, world):
    w = world
    r = await _get(test_client, w["me"])
    items = r.json()
    # general scope as before: no collection notifications; newest first
    assert [n["id"] for n in items] == [w["chat"], w["gen_assign"], w["admin"], w["reminder"]]
    assert LEGACY_KEYS <= set(items[0])                         # every existing field is still there
    assert items[0]["body"] == "תוכן פרטי של הצ'אט"             # and body is still sent here
    assert "x-next-cursor" not in r.headers                     # one page
    assert (await _get(test_client, w["me"], f"{API}/unread-count")).json() == {"count": 3}
    unread = (await _get(test_client, w["me"], unread_only="true")).json()
    assert [n["id"] for n in unread] == [w["chat"], w["gen_assign"], w["admin"]]
    assert [n["id"] for n in (await _get(test_client, w["me"], limit=2, offset=1)).json()] == [
        w["gen_assign"], w["admin"]]


async def test_collection_module_endpoints_are_unchanged(test_client, test_db, world):
    from backend.iam.engine import PermissionsEngine
    await PermissionsEngine(test_db).grant_resource_permission(world["me"], "collection_task", "*", "read")
    await test_db.commit()
    listed = (await _get(test_client, world["me"], "/api/v1/collection-tasks/notifications")).json()
    assert [n["id"] for n in listed] == [world["archived"], world["coll_assign"]]
    count = (await _get(test_client, world["me"], "/api/v1/collection-tasks/notifications/unread-count")).json()
    assert count == {"count": 2}


# ── scope=all and the three views ─────────────────────────────────────────────

async def test_scope_all_and_the_three_views(test_client, world):
    w = world
    mine = [w["chat"], w["archived"], w["coll_assign"], w["gen_assign"], w["admin"], w["reminder"]]

    async def ids(**params):
        return [n["id"] for n in (await _get(test_client, w["me"], scope="all", **params)).json()]

    assert await ids(view="all") == mine
    assert await ids(view="unread") == mine[:5]
    assert await ids(view="read") == [w["reminder"]]
    assert await ids() == mine                                   # no view, no unread_only: everything
    assert await ids(view="read", unread_only="true") == [w["reminder"]]    # view wins
    count = (await _get(test_client, w["me"], f"{API}/unread-count", scope="all")).json()
    assert count == {"count": 5}


async def test_another_users_notifications_never_appear(test_client, world):
    w = world
    for params in ({"scope": "all", "view": "all"}, {}):
        assert w["foreign"] not in {n["id"] for n in (await _get(test_client, w["me"], **params)).json()}
    theirs = (await _get(test_client, w["other"], scope="all")).json()
    assert [n["id"] for n in theirs] == [w["foreign"]]
    latest = (await _get(test_client, w["me"], f"{API}/unread-count", scope="all", latest=20)).json()
    assert w["foreign"] not in {n["id"] for n in latest["latest"]}


async def test_new_fields_task_kind_and_body_preview(test_client, world):
    w = world
    by_id = {n["id"]: n for n in (await _get(test_client, w["me"], scope="all")).json()}
    chat, admin = by_id[w["chat"]], by_id[w["admin"]]
    assert chat["task_kind"] == "general" and by_id[w["coll_assign"]]["task_kind"] == "collection"
    assert admin["task_kind"] is None
    # the center never receives a chat message's text
    assert chat["body"] is None and chat["body_preview"] is None
    # one line, at most 140 characters + an ellipsis; body itself is not sent in scope=all
    assert admin["body"] is None
    assert "\n" not in admin["body_preview"] and admin["body_preview"].endswith("…")
    assert len(admin["body_preview"]) == 141 and admin["body_preview"].startswith("שורה ראשונה שורה שנייה")
    assert by_id[w["gen_assign"]]["body_preview"] == "לבדוק את המעלית"


# ── keyset paging ─────────────────────────────────────────────────────────────

async def _many(db: AsyncSession, user_id: int, n: int, *, same_time: bool = False) -> list[int]:
    rows = [UserNotification(user_id=user_id, type=NotificationType.GENERAL, title=f"n{i}",
                             created_at=BASE if same_time else BASE - timedelta(seconds=i)) for i in range(n)]
    db.add_all(rows)
    await db.commit()
    ids = [r.id for r in rows]
    db.expunge_all()
    return ids


async def _walk(client, user_id, **params) -> tuple[list[int], list[bool]]:
    seen, headers, cursor = [], [], None
    while True:
        p = dict(params, **({"cursor": cursor} if cursor else {}))
        r = await _get(client, user_id, **p)
        seen += [n["id"] for n in r.json()]
        cursor = r.headers.get("x-next-cursor")
        headers.append(cursor is not None)
        if not cursor:
            return seen, headers


async def test_paging_returns_everything_once_and_says_when_it_ends(test_client, test_db):
    me = await _user(test_db, "pager@x.io", "דפדוף")
    await _many(test_db, me.id, 7)
    everything = [n["id"] for n in (await _get(test_client, me.id, scope="all", limit=200)).json()]
    seen, headers = await _walk(test_client, me.id, scope="all", limit=3)
    assert seen == everything and headers == [True, True, False]


async def test_exactly_limit_items_means_no_next_page(test_client, test_db):
    me = await _user(test_db, "exact@x.io", "בדיוק")
    await _many(test_db, me.id, 6)
    seen, headers = await _walk(test_client, me.id, scope="all", limit=3)
    assert len(seen) == 6 and headers == [True, False]          # no empty third request
    one = await _get(test_client, me.id, scope="all", limit=6)
    assert "x-next-cursor" not in one.headers


async def test_paging_through_identical_timestamps(test_client, test_db):
    me = await _user(test_db, "ties@x.io", "זהים")
    ids = await _many(test_db, me.id, 5, same_time=True)
    seen, _ = await _walk(test_client, me.id, scope="all", limit=2)
    assert seen == sorted(ids, reverse=True)                    # id breaks the tie, no duplicates or gaps


async def test_a_merge_while_paging_neither_duplicates_nor_skips(test_client, test_db):
    """A merged chat notification moves to the top (created_at = now). Pages already
    being walked continue below the cursor: it is not repeated, nothing is skipped;
    the next refresh of the first page shows it."""
    me = await _user(test_db, "merge@x.io", "מיזוג")
    ids = await _many(test_db, me.id, 6)                        # ids[0] newest … ids[5] oldest
    first = await _get(test_client, me.id, scope="all", view="unread", limit=2)
    assert [n["id"] for n in first.json()] == ids[:2]
    moved = ids[4]                                              # still ahead of the cursor
    await test_db.execute(update(UserNotification).where(UserNotification.id == moved)
                          .values(created_at=BASE + timedelta(minutes=5)))
    await test_db.commit()
    rest, _ = await _walk(test_client, me.id, scope="all", view="unread", limit=2,
                          cursor=first.headers["x-next-cursor"])
    assert rest == [ids[2], ids[3], ids[5]]                      # the moved one is above the cursor now
    top = (await _get(test_client, me.id, scope="all", view="unread", limit=2)).json()
    assert top[0]["id"] == moved


async def test_paging_inside_a_view(test_client, test_db):
    me = await _user(test_db, "views@x.io", "תצוגות")
    ids = await _many(test_db, me.id, 6)
    await test_db.execute(update(UserNotification).where(UserNotification.id.in_(ids[::2]))
                          .values(read_at=BASE))
    await test_db.commit()
    unread, _ = await _walk(test_client, me.id, scope="all", view="unread", limit=2)
    read, _ = await _walk(test_client, me.id, scope="all", view="read", limit=2)
    assert unread == ids[1::2] and read == ids[::2]


@pytest.mark.parametrize("cursor", ["not-base64!", "Zm9v", "MjAyNi0xMS0xMHx4", ""])
async def test_an_invalid_cursor_is_rejected(test_client, world, cursor):
    r = await test_client.get(f"{API}/", headers=_h(world["me"]), params={"cursor": cursor, "scope": "all"})
    if cursor == "":
        assert r.status_code == 200                             # empty = no cursor
    else:
        assert r.status_code == 422, r.text


async def test_the_next_cursor_header_is_exposed_to_the_browser(test_client, test_db):
    me = await _user(test_db, "cors@x.io", "דפדפן")
    await _many(test_db, me.id, 3)
    r = await test_client.get(f"{API}/", params={"scope": "all", "limit": 1},
                              headers={**_h(me.id), "Origin": "http://localhost:5173"})
    assert "x-next-cursor" in r.headers.get("access-control-expose-headers", "").lower()


# ── unread-count: scope=all, cap, latest (for toasts) ─────────────────────────

async def test_latest_carries_everything_a_toast_shows(test_client, world):
    w = world
    r = (await _get(test_client, w["me"], f"{API}/unread-count", scope="all", latest=10)).json()
    assert r["count"] == 5
    latest = {n["id"]: n for n in r["latest"]}
    assert list(latest) == [w["chat"], w["archived"], w["coll_assign"], w["gen_assign"], w["admin"]]
    assert all(n["read_at"] is None for n in latest.values())

    chat = latest[w["chat"]]                                    # sender + task, no content
    assert (chat["from_user_name"], chat["task_title"], chat["task_kind"]) == ("השולחת", "משימה רגילה", "general")
    assert chat["body"] is None and chat["body_preview"] is None
    arch = latest[w["archived"]]                                # kind and who archived
    assert arch["title"] == "משימת גבייה אורכבה: גביית ועד"
    assert arch["body_preview"] == "סוג: משימת גבייה · אורכבה על ידי השולחת"
    coll = latest[w["coll_assign"]]                             # collection: title + kind
    assert (coll["title"], coll["task_title"], coll["task_kind"]) == ("משימת גבייה חדשה: גביית ועד", "גביית ועד",
                                                                       "collection")
    admin = latest[w["admin"]]                                  # regular: title + short description
    assert admin["title"] == "הודעה מהנהלה" and admin["body_preview"].startswith("שורה ראשונה")

    two = (await _get(test_client, w["me"], f"{API}/unread-count", scope="all", latest=2)).json()
    assert [n["id"] for n in two["latest"]] == [w["chat"], w["archived"]]
    assert (await _get(test_client, w["me"], f"{API}/unread-count", latest=10)).json()["count"] == 3
    bad = await test_client.get(f"{API}/unread-count", headers=_h(w["me"]), params={"latest": 21})
    assert bad.status_code == 422


async def test_the_poll_runs_a_fixed_small_number_of_light_queries(test_client, test_engine, test_db, world):
    """Same statements whatever the number of notifications; no task assignees,
    participants or labels."""
    w = world

    async def poll():
        await _get(test_client, w["me"], f"{API}/unread-count", scope="all", latest=10)
        test_db.expunge_all()
        with _Seen(test_engine) as seen:
            await _get(test_client, w["me"], f"{API}/unread-count", scope="all", latest=10)
        return seen

    few = await poll()
    await _many(test_db, w["me"], 40)
    many = await poll()
    assert few.count == many.count
    assert not many.tables & HEAVY_TABLES, sorted(many.tables & HEAVY_TABLES)


async def test_the_center_list_is_also_light(test_client, test_engine, test_db, world):
    test_db.expunge_all()
    with _Seen(test_engine) as seen:
        await _get(test_client, world["me"], scope="all", view="all", limit=30)
    assert not seen.tables & HEAVY_TABLES, sorted(seen.tables & HEAVY_TABLES)


async def test_scope_all_count_is_capped(test_client, test_db):
    me = await _user(test_db, "lots@x.io", "הרבה")
    await test_db.execute(insert(UserNotification), [
        dict(user_id=me.id, type=NotificationType.GENERAL, title=f"n{i}", created_at=BASE - timedelta(seconds=i))
        for i in range(1005)])
    await test_db.commit()
    assert (await _get(test_client, me.id, f"{API}/unread-count", scope="all")).json() == {"count": 1000}
    assert (await _get(test_client, me.id, f"{API}/unread-count")).json() == {"count": 1005}   # legacy: exact
