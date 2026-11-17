"""Notification-center stage 3e-1: what the details panel needs from the API.

- ``task_archived`` on every notification (list, latest, one, PATCH): whether its task
  is archived now — False / True (general and collection) / None without a task or
  once the task is deleted. Loaded with the same light join (no extra query, no
  heavy tables).
- ``scope=all`` on GET /{id} and PATCH /{id}/read: answers like the center's list —
  no ``body`` (a chat message's text is not sent), ``body_preview`` instead. Without
  it both answer as before.
"""
from __future__ import annotations

import pytest
from sqlalchemy import delete, update

from backend.models.task import Task, TaskParticipant, task_assignees
from backend.models.user_notification import UserNotification
from backend.tests.test_notification_center_api import (  # noqa: F401  (world is a fixture)
    API, HEAVY_TABLES, LEGACY_KEYS, _Seen, _get, _h, world,
)

pytestmark = pytest.mark.asyncio


async def _archive(db, task_id: int) -> None:
    await db.execute(update(Task).where(Task.id == task_id).values(is_archived=True))
    await db.commit()
    db.expunge_all()


# ── task_archived ─────────────────────────────────────────────────────────────

async def test_task_archived_everywhere_the_center_reads(test_client, test_db, world):
    w = world
    await _archive(test_db, w["collection"])                  # the collection task is archived; general is not

    listed = {n["id"]: n for n in (await _get(test_client, w["me"], scope="all")).json()}
    assert listed[w["gen_assign"]]["task_archived"] is False
    assert listed[w["coll_assign"]]["task_archived"] is True   # a regular notification on an archived task
    assert listed[w["archived"]]["task_archived"] is True
    assert listed[w["admin"]]["task_archived"] is None         # no task

    latest = (await _get(test_client, w["me"], f"{API}/unread-count", scope="all", latest=10)).json()["latest"]
    assert {n["id"]: n["task_archived"] for n in latest}[w["coll_assign"]] is True

    one = (await _get(test_client, w["me"], f"{API}/{w['gen_assign']}", scope="all")).json()
    assert one["task_archived"] is False
    patched = await test_client.patch(f"{API}/{w['coll_assign']}/read?read=true&scope=all", headers=_h(w["me"]))
    assert patched.status_code == 200 and patched.json()["task_archived"] is True


async def test_task_archived_for_an_archived_general_task(test_client, test_db, world):
    await _archive(test_db, world["general"])
    one = (await _get(test_client, world["me"], f"{API}/{world['chat']}", scope="all")).json()
    assert (one["task_archived"], one["task_kind"]) == (True, "general")


async def test_task_archived_is_none_once_the_task_is_deleted(test_client, test_db, world):
    w = world
    if test_db.bind.dialect.name != "postgresql":             # SQLite here does not enforce ON DELETE SET NULL
        await test_db.execute(update(UserNotification).where(UserNotification.task_id == w["general"])
                              .values(task_id=None))
    await test_db.execute(delete(task_assignees).where(task_assignees.c.task_id == w["general"]))
    await test_db.execute(delete(TaskParticipant).where(TaskParticipant.task_id == w["general"]))
    await test_db.execute(delete(Task).where(Task.id == w["general"]))
    await test_db.commit()
    test_db.expunge_all()
    one = (await _get(test_client, w["me"], f"{API}/{w['gen_assign']}", scope="all")).json()
    assert (one["task_id"], one["task_archived"], one["task_kind"], one["task_title"]) == (None, None, None, None)
    assert one["title"] == "משימה חדשה: משימה רגילה"           # the notification itself is intact


# ── scope=all on one notification ─────────────────────────────────────────────

async def test_one_and_patch_with_scope_all_do_not_send_chat_text(test_client, world):
    w = world
    one = (await _get(test_client, w["me"], f"{API}/{w['chat']}", scope="all")).json()
    assert one["body"] is None and one["body_preview"] is None
    assert (one["from_user_name"], one["task_title"]) == ("השולחת", "משימה רגילה")
    for read in ("true", "false"):
        r = await test_client.patch(f"{API}/{w['chat']}/read?read={read}&scope=all", headers=_h(w["me"]))
        assert r.status_code == 200 and r.json()["body"] is None
    assert (r.json()["read_at"] is None)                          # the last one marked it unread

    admin = (await _get(test_client, w["me"], f"{API}/{w['admin']}", scope="all")).json()
    assert admin["body"] is None and admin["body_preview"].startswith("שורה ראשונה")


async def test_without_scope_one_and_patch_answer_as_before(test_client, world):
    w = world
    one = (await _get(test_client, w["me"], f"{API}/{w['chat']}")).json()
    assert LEGACY_KEYS <= set(one)
    assert one["body"] == "תוכן פרטי של הצ'אט"                    # body still sent here
    assert one["task_title"] == "משימה רגילה" and one["from_user_name"] == "השולחת"
    r = await test_client.patch(f"{API}/{w['chat']}/read?read=true", headers=_h(w["me"]))
    assert r.status_code == 200
    assert r.json()["body"] == "תוכן פרטי של הצ'אט" and r.json()["read_at"] is not None
    # a collection notification is still found by id (scope does not filter a single one)
    assert (await test_client.get(f"{API}/{w['coll_assign']}", headers=_h(w["me"]))).status_code == 200


async def test_another_users_notification_is_not_found(test_client, world):
    w = world
    for scope in ("all", "general"):
        assert (await test_client.get(f"{API}/{w['foreign']}", headers=_h(w["me"]),
                                      params={"scope": scope})).status_code == 404
        assert (await test_client.patch(f"{API}/{w['foreign']}/read?scope={scope}",
                                        headers=_h(w["me"]))).status_code == 404


async def test_invalid_scope_is_rejected(test_client, world):
    r = await test_client.get(f"{API}/{world['chat']}", headers=_h(world["me"]), params={"scope": "everything"})
    assert r.status_code == 422


# ── still light ───────────────────────────────────────────────────────────────

async def test_task_archived_adds_no_query_and_no_heavy_table(test_client, test_engine, test_db, world):
    w = world

    async def seen(method: str, path: str):
        await test_client.request(method, path, headers=_h(w["me"]))
        test_db.expunge_all()
        with _Seen(test_engine) as s:
            r = await test_client.request(method, path, headers=_h(w["me"]))
        assert r.status_code == 200, r.text
        return s

    for method, path in [("GET", f"{API}/?scope=all&view=all&limit=30"),
                         ("GET", f"{API}/{w['chat']}?scope=all"),
                         ("PATCH", f"{API}/{w['chat']}/read?read=true&scope=all"),
                         ("GET", f"{API}/unread-count?scope=all&latest=10")]:
        s = await seen(method, path)
        assert not s.tables & HEAVY_TABLES, (path, sorted(s.tables & HEAVY_TABLES))
    # one query for the notification(s) with both joins, whatever the number of rows
    few = (await seen("GET", f"{API}/?scope=all&view=all&limit=30")).count
    test_db.add_all([UserNotification(user_id=w["me"], task_id=w["general"], type="task_assignment",
                                      title=f"x{i}") for i in range(20)])
    await test_db.commit()
    assert (await seen("GET", f"{API}/?scope=all&view=all&limit=30")).count == few
