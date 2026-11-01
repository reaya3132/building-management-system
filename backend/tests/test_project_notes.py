"""Project documentation boards: access, board separation, policy, pagination,
search, history and query count."""
from __future__ import annotations

import json

import pytest
import pytest_asyncio
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.security import create_access_token, hash_password
from backend.iam.engine import PermissionsEngine
from backend.models.audit_log import AuditLog
from backend.models.fund import Fund
from backend.models.project import Project
from backend.models.project_note import ProjectNote
from backend.models.user import User, UserRole


def _auth(user: User) -> dict:
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


def _url(project_id: int, board: str = "general", *rest) -> str:
    return "/".join([f"/api/v1/projects/{project_id}/notes/{board}", *map(str, rest)])


async def _grant(db: AsyncSession, user: User, project: Project, *actions: str) -> None:
    engine = PermissionsEngine(db)
    for action in actions:
        await engine.grant_resource_permission(user.id, "project", str(project.id), action)
    await db.commit()


async def _project(db: AsyncSession, name: str, *, parent: Project | None = None, is_parent=False, fund=False) -> Project:
    project = Project(name=name, is_active=True, is_parent_project=is_parent,
                      relation_project=parent.id if parent else None)
    db.add(project)
    await db.flush()
    if fund:
        db.add(Fund(project_id=project.id, current_balance=0, monthly_amount=0))
    await db.commit()
    return project


async def _audit(db: AsyncSession, note_id: int) -> list[tuple[str, dict]]:
    rows = await db.execute(
        select(AuditLog.action, AuditLog.details)
        .where(AuditLog.entity == "project_note", AuditLog.entity_id == str(note_id)).order_by(AuditLog.id)
    )
    return [(action, json.loads(details) if details else {}) for action, details in rows.all()]


@pytest_asyncio.fixture
async def parent(test_db) -> Project:
    return await _project(test_db, "Parent", is_parent=True)


@pytest_asyncio.fixture
async def sub(test_db, parent) -> Project:
    return await _project(test_db, "Sub A", parent=parent, fund=True)


@pytest_asyncio.fixture
async def other_sub(test_db, parent) -> Project:
    return await _project(test_db, "Sub B", parent=parent, fund=True)


@pytest_asyncio.fixture
async def other_member(test_db) -> User:
    user = User(email="notes2@test.com", password_hash=hash_password("x"), full_name="Second Member",
                role=UserRole.MEMBER.value, is_active=True, email_verified=True)
    test_db.add(user)
    await test_db.commit()
    return user


async def _create(client, user, project_id, board="general", title="עדכון", content="תוכן"):
    response = await client.post(_url(project_id, board), headers=_auth(user), json={"title": title, "content": content})
    assert response.status_code == 201, response.text
    return response.json()


@pytest.mark.asyncio
class TestBoards:
    async def test_create_and_list_with_author_and_exact_time(self, test_client, admin_user, sub):
        note = await _create(test_client, admin_user, sub.id, title="  פגישה עם ועד  ", content="סוכם על תיקון")
        assert note["title"] == "פגישה עם ועד"
        assert note["created_by"]["full_name"] == admin_user.full_name
        assert note["created_at"].endswith("Z") and note["updated_at"] is None and note["updated_by"] is None
        page = (await test_client.get(_url(sub.id), headers=_auth(admin_user))).json()
        assert [n["id"] for n in page["items"]] == [note["id"]] and page["next_before_id"] is None

    async def test_standalone_project_has_both_boards(self, test_client, test_db, admin_user):
        standalone = await _project(test_db, "Standalone", fund=True)
        await _create(test_client, admin_user, standalone.id, "general")
        await _create(test_client, admin_user, standalone.id, "fund")

    async def test_parent_project_has_no_boards(self, test_client, admin_user, parent):
        for board in ("general", "fund"):
            response = await test_client.get(_url(parent.id, board), headers=_auth(admin_user))
            assert response.status_code == 409 and response.json()["detail"]["code"] == "parent_project"
            response = await test_client.post(_url(parent.id, board), headers=_auth(admin_user), json={"title": "x", "content": "y"})
            assert response.status_code == 409

    async def test_unknown_board_and_project(self, test_client, admin_user, sub):
        assert (await test_client.get(_url(sub.id, "other"), headers=_auth(admin_user))).status_code == 422
        assert (await test_client.get(_url(999999), headers=_auth(admin_user))).status_code == 404

    async def test_boards_and_projects_are_fully_separated(self, test_client, admin_user, sub, other_sub):
        general = await _create(test_client, admin_user, sub.id, "general", title="כללי")
        fund = await _create(test_client, admin_user, sub.id, "fund", title="קופה")
        elsewhere = await _create(test_client, admin_user, other_sub.id, "general", title="אחר")

        def ids(response):
            return [n["id"] for n in response.json()["items"]]

        assert ids(await test_client.get(_url(sub.id, "general"), headers=_auth(admin_user))) == [general["id"]]
        assert ids(await test_client.get(_url(sub.id, "fund"), headers=_auth(admin_user))) == [fund["id"]]
        assert ids(await test_client.get(_url(other_sub.id, "general"), headers=_auth(admin_user))) == [elsewhere["id"]]
        # A note is unreachable through another board or another project.
        for url in (_url(sub.id, "fund", general["id"]), _url(other_sub.id, "general", general["id"])):
            assert (await test_client.patch(url, headers=_auth(admin_user), json={"title": "x"})).status_code == 404
            assert (await test_client.delete(url, headers=_auth(admin_user))).status_code == 404
            assert (await test_client.get(f"{url}/history", headers=_auth(admin_user))).status_code == 404


@pytest.mark.asyncio
class TestFundBoard:
    async def test_unavailable_without_fund_and_notes_kept_across_fund_recreation(self, test_client, test_db, admin_user, sub):
        note = await _create(test_client, admin_user, sub.id, "fund", title="הפקדה")
        fund = (await test_db.execute(select(Fund).where(Fund.project_id == sub.id))).scalar_one()
        await test_db.delete(fund)
        await test_db.commit()

        response = await test_client.get(_url(sub.id, "fund"), headers=_auth(admin_user))
        assert response.status_code == 409 and response.json()["detail"]["code"] == "no_fund"
        assert (await test_client.post(_url(sub.id, "fund"), headers=_auth(admin_user), json={"title": "x", "content": "y"})).status_code == 409
        assert (await test_db.get(ProjectNote, note["id"])) is not None  # kept
        # The general board is not affected.
        assert (await test_client.get(_url(sub.id, "general"), headers=_auth(admin_user))).status_code == 200

        test_db.add(Fund(project_id=sub.id, current_balance=0, monthly_amount=0))
        await test_db.commit()
        page = (await test_client.get(_url(sub.id, "fund"), headers=_auth(admin_user))).json()
        assert [n["id"] for n in page["items"]] == [note["id"]]


@pytest.mark.asyncio
class TestPermissions:
    async def test_project_read_is_required_for_everything(self, test_client, test_db, admin_user, member_user, sub):
        note = await _create(test_client, admin_user, sub.id)
        calls = [
            ("get", _url(sub.id), None),
            ("post", _url(sub.id), {"title": "x", "content": "y"}),
            ("patch", _url(sub.id, "general", note["id"]), {"title": "x"}),
            ("delete", _url(sub.id, "general", note["id"]), None),
            ("get", _url(sub.id, "general", note["id"], "history"), None),
        ]
        for method, url, body in calls:
            kwargs = {"json": body} if body else {}
            response = await getattr(test_client, method)(url, headers=_auth(member_user), **kwargs)
            assert response.status_code == 403, (method, url)

    async def test_viewer_reads_and_adds_but_edits_only_own(self, test_client, test_db, admin_user, member_user, sub):
        await _grant(test_db, member_user, sub, "read")
        admins = await _create(test_client, admin_user, sub.id, title="של מנהל")
        mine = await _create(test_client, member_user, sub.id, title="שלי")

        page = (await test_client.get(_url(sub.id), headers=_auth(member_user))).json()
        flags = {n["id"]: n["can_modify"] for n in page["items"]}
        assert flags == {admins["id"]: False, mine["id"]: True}

        assert (await test_client.patch(_url(sub.id, "general", admins["id"]), headers=_auth(member_user), json={"title": "x"})).status_code == 403
        assert (await test_client.delete(_url(sub.id, "general", admins["id"]), headers=_auth(member_user))).status_code == 403
        assert (await test_client.patch(_url(sub.id, "general", mine["id"]), headers=_auth(member_user), json={"title": "עודכן"})).status_code == 200
        assert (await test_client.delete(_url(sub.id, "general", mine["id"]), headers=_auth(member_user))).status_code == 204

    async def test_project_update_holder_moderates_all(self, test_client, test_db, admin_user, member_user, sub):
        await _grant(test_db, member_user, sub, "read", "update")
        admins = await _create(test_client, admin_user, sub.id)
        response = await test_client.patch(_url(sub.id, "general", admins["id"]), headers=_auth(member_user), json={"content": "תוקן"})
        assert response.status_code == 200 and response.json()["updated_by"]["id"] == member_user.id
        assert (await test_client.delete(_url(sub.id, "general", admins["id"]), headers=_auth(member_user))).status_code == 204

    async def test_read_on_one_project_does_not_open_another(self, test_client, test_db, admin_user, member_user, sub, other_sub):
        await _grant(test_db, member_user, sub, "read")
        await _create(test_client, admin_user, other_sub.id)
        assert (await test_client.get(_url(other_sub.id), headers=_auth(member_user))).status_code == 403


@pytest.mark.asyncio
class TestHistory:
    async def test_create_edit_delete_are_audited_with_full_snapshot(self, test_client, test_db, admin_user, member_user, sub):
        await _grant(test_db, member_user, sub, "read")
        note = await _create(test_client, member_user, sub.id, "fund", title="ישן", content="תוכן ישן")

        # An unchanged value is not an edit.
        same = await test_client.patch(_url(sub.id, "fund", note["id"]), headers=_auth(member_user), json={"title": "ישן"})
        assert same.json()["updated_at"] is None

        edited = (await test_client.patch(_url(sub.id, "fund", note["id"]), headers=_auth(member_user),
                                          json={"title": "חדש", "content": "תוכן חדש"})).json()
        assert edited["updated_at"].endswith("Z") and edited["updated_by"]["id"] == member_user.id

        history = (await test_client.get(_url(sub.id, "fund", note["id"], "history"), headers=_auth(member_user))).json()
        assert [h["action"] for h in history] == ["updated", "created"]
        assert history[0]["details"]["before"] == {"title": "ישן", "content": "תוכן ישן"}
        assert history[0]["details"]["after"] == {"title": "חדש", "content": "תוכן חדש"}

        assert (await test_client.delete(_url(sub.id, "fund", note["id"]), headers=_auth(admin_user))).status_code == 204
        assert (await test_db.get(ProjectNote, note["id"])) is None
        actions = await _audit(test_db, note["id"])
        assert [a for a, _ in actions] == ["created", "updated", "deleted"]
        snapshot = actions[-1][1]
        assert snapshot["title"] == "חדש" and snapshot["content"] == "תוכן חדש"
        assert snapshot["project_id"] == sub.id and snapshot["board"] == "fund"
        assert snapshot["created_by_user_id"] == member_user.id and snapshot["updated_by_user_id"] == member_user.id
        assert snapshot["created_at"] and snapshot["updated_at"] and snapshot["deleted_at"]
        assert snapshot["deleted_by_user_id"] == admin_user.id

    @pytest.mark.parametrize("body", [
        {"title": " ", "content": "x"}, {"title": "x" * 256, "content": "x"},
        {"title": "x", "content": "x" * 10_001}, {"title": "x", "content": "y", "board": "fund"},
    ])
    async def test_validation(self, test_client, admin_user, sub, body):
        assert (await test_client.post(_url(sub.id), headers=_auth(admin_user), json=body)).status_code == 422

    async def test_content_is_optional_on_both_boards(self, test_client, admin_user, sub):
        for board in ("general", "fund"):
            for body in ({"title": "רק כותרת"}, {"title": "רק כותרת", "content": "   "},
                         {"title": "רק כותרת", "content": None}):
                response = await test_client.post(_url(sub.id, board), headers=_auth(admin_user), json=body)
                assert response.status_code == 201, response.text
                assert response.json()["content"] == ""
        note = await _create(test_client, admin_user, sub.id, content="יש תוכן")
        cleared = await test_client.patch(_url(sub.id, "general", note["id"]), headers=_auth(admin_user), json={"content": ""})
        assert cleared.status_code == 200 and cleared.json()["content"] == ""
        refilled = await test_client.patch(_url(sub.id, "general", note["id"]), headers=_auth(admin_user), json={"content": "שוב"})
        assert refilled.json()["content"] == "שוב"
        # null clears the content as well (stored as "", the column stays NOT NULL)
        nulled = await test_client.patch(_url(sub.id, "general", note["id"]), headers=_auth(admin_user), json={"content": None})
        assert nulled.status_code == 200 and nulled.json()["content"] == ""
        # the title rules are unchanged
        assert (await test_client.patch(_url(sub.id, "general", note["id"]), headers=_auth(admin_user), json={"title": None})).status_code == 422
        assert (await test_client.post(_url(sub.id), headers=_auth(admin_user), json={"content": "בלי כותרת"})).status_code == 422


@pytest.mark.asyncio
class TestListing:
    async def test_keyset_pagination_newest_first(self, test_client, admin_user, sub):
        ids = [(await _create(test_client, admin_user, sub.id, title=f"רשומה {i}"))["id"] for i in range(5)]
        first = (await test_client.get(_url(sub.id), params={"limit": 2}, headers=_auth(admin_user))).json()
        assert [n["id"] for n in first["items"]] == ids[:-3:-1]
        second = (await test_client.get(_url(sub.id), params={"limit": 2, "before_id": first["next_before_id"]},
                                        headers=_auth(admin_user))).json()
        third = (await test_client.get(_url(sub.id), params={"limit": 2, "before_id": second["next_before_id"]},
                                       headers=_auth(admin_user))).json()
        assert [n["id"] for n in second["items"] + third["items"]] == ids[2::-1]
        assert third["next_before_id"] is None

    async def test_search_title_and_content_with_literal_wildcards(self, test_client, admin_user, sub):
        a = await _create(test_client, admin_user, sub.id, title="תיקון מעלית", content="טכנאי הגיע")
        b = await _create(test_client, admin_user, sub.id, title="ועד", content="דיון על מעלית חדשה")
        c = await _create(test_client, admin_user, sub.id, title="הנחה 50%", content="x")

        async def found(term):
            page = (await test_client.get(_url(sub.id), params={"search": term}, headers=_auth(admin_user))).json()
            return {n["id"] for n in page["items"]}

        assert await found("מעלית") == {a["id"], b["id"]}
        assert await found("50%") == {c["id"]}
        assert await found("%") == {c["id"]}  # % is matched literally, not as a wildcard

    async def test_list_query_count_does_not_grow_with_notes(self, test_client, test_engine, admin_user, member_user, test_db, sub):
        await _grant(test_db, member_user, sub, "read")
        for i in range(3):
            await _create(test_client, member_user, sub.id, title=f"n{i}")

        async def count_queries() -> int:
            counter = {"n": 0}

            def on_execute(*_):
                counter["n"] += 1

            event.listen(test_engine.sync_engine, "before_cursor_execute", on_execute)
            try:
                response = await test_client.get(_url(sub.id), headers=_auth(admin_user))
                assert response.status_code == 200
            finally:
                event.remove(test_engine.sync_engine, "before_cursor_execute", on_execute)
            return counter["n"]

        few = await count_queries()
        for i in range(10):
            await _create(test_client, member_user, sub.id, title=f"m{i}")
        assert await count_queries() == few
