"""Legal proceedings constraints on a real PostgreSQL (TEST_POSTGRES_URL).

Re-runs the whole SQLite constraint matrix (test_legal_models) against a database
built by the migration SQL files, and adds what SQLite cannot enforce: the composite
stage FK and every RESTRICT relation.
"""
from datetime import datetime

import pytest
import pytest_asyncio
from sqlalchemy import delete, text
from sqlalchemy.exc import IntegrityError

from backend.tests.test_legal_models import *  # noqa: F401,F403  (same matrix, PostgreSQL engine)
from backend.tests.test_legal_models import _accepts, _entry, _rejects, base  # noqa: F401
from backend.configurations.legal.stages import STAGE1_KEY
from backend.models.contact import Contact
from backend.models.legal_proceeding import (
    LegalProceeding,
    LegalProceedingAssignee,
    LegalProceedingStage,
)
from backend.models.project import Project
from backend.models.user import User

NOW = datetime(2026, 11, 1, 10, 0)


async def _restricts(db, sql, params):
    with pytest.raises(IntegrityError) as exc:
        async with db.begin_nested():
            await db.execute(text(sql), params)
    assert "violates foreign key constraint" in str(exc.value)


@pytest.mark.asyncio
async def test_composite_stage_fk(base):
    db, user = base["db"], base["user"]
    # A second proceeding that has only stage 1.
    other = LegalProceeding(contact_id=base["contact"].id, party_role="other", title="x", created_by=user.id)
    await _accepts(db, other)
    await _accepts(db, LegalProceedingStage(proceeding_id=other.id, stage_key=STAGE1_KEY))
    # stage of the same proceeding: ok; general entry (NULL stage): ok
    await _accepts(db, _entry(base, stage_key="lawyer_warning"))
    await _accepts(db, _entry(base, stage_key=None))
    # stage that exists only on ANOTHER proceeding / nowhere: rejected
    base_other = dict(base, proc=other)
    await _rejects(db, _entry(base_other, stage_key="lawyer_warning"))
    await _rejects(db, _entry(base, stage_key="no_such_stage"))


@pytest.mark.asyncio
async def test_restrict_relations(base):
    db, user, proc, contact = base["db"], base["user"], base["proc"], base["contact"]
    project = Project(name="Legal P", is_active=True)
    db.add(project)
    await db.flush()
    proc.project_id = project.id
    member = User(email="legal-m@x.io", full_name="M", password_hash="x", role="Member", is_active=True)
    db.add(member)
    await db.flush()
    db.add(LegalProceedingAssignee(proceeding_id=proc.id, user_id=member.id, assigned_by=user.id))
    db.add(_entry(base, stage_key=STAGE1_KEY))
    await db.commit()

    # A proceeding cannot be hard-deleted while stages / entries / assignees exist.
    await _restricts(db, "DELETE FROM legal_proceedings WHERE id = :i", {"i": proc.id})
    await _restricts(db, "DELETE FROM legal_proceeding_stages WHERE proceeding_id = :i AND stage_key = :k",
                     {"i": proc.id, "k": STAGE1_KEY})  # an entry uses this stage
    await _restricts(db, "DELETE FROM contacts WHERE id = :i", {"i": contact.id})
    await _restricts(db, "DELETE FROM projects WHERE id = :i", {"i": project.id})
    await _restricts(db, "DELETE FROM users WHERE id = :i", {"i": user.id})      # creator / author
    await _restricts(db, "DELETE FROM users WHERE id = :i", {"i": member.id})    # assignee
    # Removing an assignment row itself is allowed.
    async with db.begin_nested():
        await db.execute(delete(LegalProceedingAssignee).where(LegalProceedingAssignee.user_id == member.id))


@pytest.mark.asyncio
async def test_contact_created_by_set_null(base):
    db = base["db"]
    tmp = User(email="tmp@x.io", full_name="T", password_hash="x", role="Member", is_active=True)
    db.add(tmp)
    await db.flush()
    c = Contact(kind="person", name="n", created_by=tmp.id)
    db.add(c)
    await db.commit()
    await db.execute(text("DELETE FROM users WHERE id = :i"), {"i": tmp.id})
    await db.commit()
    assert (await db.execute(text("SELECT created_by FROM contacts WHERE id = :i"), {"i": c.id})).scalar() is None


@pytest.mark.asyncio
async def test_resolved_and_closed_rules_with_real_users(base):
    db, user, proc = base["db"], base["user"], base["proc"]
    stage = LegalProceedingStage(proceeding_id=proc.id, stage_key="x_extra", status="completed",
                                 resolved_at=NOW, resolved_by=user.id)
    await _accepts(db, stage)
    with pytest.raises(IntegrityError):  # back to pending without clearing resolved_*
        async with db.begin_nested():
            await db.execute(text("UPDATE legal_proceeding_stages SET status='pending' WHERE id=:i"), {"i": stage.id})
    async with db.begin_nested():  # proper reopen
        await db.execute(text("UPDATE legal_proceeding_stages SET status='pending', resolved_at=NULL, "
                              "resolved_by=NULL WHERE id=:i"), {"i": stage.id})
    with pytest.raises(IntegrityError):  # reopen a proceeding without clearing the close fields
        async with db.begin_nested():
            await db.execute(text("UPDATE legal_proceedings SET status='closed', closed_at=now(), "
                                  "closed_by=:u, close_reason='paid' WHERE id=:i"), {"u": user.id, "i": proc.id})
            await db.execute(text("UPDATE legal_proceedings SET status='open' WHERE id=:i"), {"i": proc.id})
