"""Legal proceedings — stage catalogue and DB constraints (stage 1 of the module).

Runs on the default SQLite test DB; the same CHECK expressions are used verbatim by
the PostgreSQL migration, so this matrix also documents the allowed combinations.
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal

import pytest
import pytest_asyncio
from sqlalchemy.exc import IntegrityError

from backend.configurations.legal import stages as catalogue
from backend.models.contact import Contact
from backend.models.document import Document
from backend.models.legal_proceeding import (
    LegalProceeding,
    LegalProceedingAssignee,
    LegalProceedingEntry,
    LegalProceedingStage,
)

NOW = datetime(2026, 11, 1, 10, 0)


# ── catalogue ─────────────────────────────────────────────────────────────────

def test_catalogue_order_and_components():
    assert catalogue.STAGE_KEYS == (
        "collection_messages", "first_door_notice", "second_door_notice", "lawyer_warning", "supervisor_claim",
    )
    assert catalogue.STAGE1_KEY == catalogue.STAGES[0].key
    assert catalogue.STAGES[0].requires_communication and catalogue.STAGES[0].components == ()
    door = ("door_placement", "letter_file", "email_proof", "whatsapp_proof")
    assert catalogue.get_stage("first_door_notice").component_keys == door
    assert catalogue.get_stage("second_door_notice").component_keys == door
    assert catalogue.get_stage("lawyer_warning").component_keys == (
        "lawyer_letter", "whatsapp_proof", "email_proof", "registered_mail_proof", "registered_mail_signature",
    )
    assert catalogue.get_stage("supervisor_claim").component_keys == ("claim_filing", "supervisor_decision")
    assert all(s.label for s in catalogue.STAGES)
    assert catalogue.stage_position("lawyer_warning") == 4


def test_component_validation_and_document_context_key():
    assert catalogue.is_valid_component("lawyer_warning", "registered_mail_signature")
    assert not catalogue.is_valid_component("first_door_notice", "lawyer_letter")
    assert not catalogue.is_valid_component(catalogue.STAGE1_KEY, "email_proof")
    assert not catalogue.is_valid_component(None, "email_proof")
    key = catalogue.document_context_key("second_door_notice", "email_proof")
    assert key == "second_door_notice.email_proof"
    assert catalogue.parse_document_context_key(key) == ("second_door_notice", "email_proof")
    assert catalogue.parse_document_context_key("second_door_notice.lawyer_letter") is None
    assert catalogue.parse_document_context_key("nonsense") is None


# ── constraints ───────────────────────────────────────────────────────────────

@pytest_asyncio.fixture
async def base(test_db, admin_user):
    contact = Contact(kind="person", name="ישראל ישראלי")
    test_db.add(contact)
    await test_db.flush()
    proc = LegalProceeding(contact_id=contact.id, party_role="tenant", title="חוב ועד בית", created_by=admin_user.id)
    test_db.add(proc)
    await test_db.flush()
    for key in catalogue.STAGE_KEYS:
        test_db.add(LegalProceedingStage(proceeding_id=proc.id, stage_key=key))
    await test_db.commit()
    return {"db": test_db, "user": admin_user, "contact": contact, "proc": proc}


async def _accepts(db, obj):
    async with db.begin_nested():
        db.add(obj)
        await db.flush()


async def _rejects(db, obj):
    with pytest.raises(IntegrityError):
        async with db.begin_nested():
            db.add(obj)
            await db.flush()


def _entry(base, **kw):
    values = dict(proceeding_id=base["proc"].id, entry_type="note", content="טקסט",
                  created_by_user_id=base["user"].id)
    values.update(kw)
    return LegalProceedingEntry(**values)


@pytest.mark.asyncio
async def test_contact_constraints(base):
    db = base["db"]
    await _rejects(db, Contact(kind="robot", name="x"))
    await _rejects(db, Contact(kind="person", name="   "))
    await _accepts(db, Contact(kind="business", name="חברת ניהול בע\"מ"))


@pytest.mark.asyncio
async def test_proceeding_amount_and_close_constraints(base):
    db, user, contact = base["db"], base["user"], base["contact"]

    def proc(**kw):
        values = dict(contact_id=contact.id, party_role="owner", title="t", created_by=user.id)
        values.update(kw)
        return LegalProceeding(**values)

    await _rejects(db, proc(claim_amount=Decimal("0")))
    await _rejects(db, proc(claim_amount=Decimal("-1")))
    await _accepts(db, proc(claim_amount=Decimal("1250.50")))
    await _accepts(db, proc(claim_amount=None))
    await _rejects(db, proc(party_role="judge"))
    await _rejects(db, proc(title=" "))
    # closed requires closed_at + closed_by + a non-blank reason
    await _rejects(db, proc(status="closed", closed_at=NOW, closed_by=user.id))
    await _rejects(db, proc(status="closed", closed_at=NOW, closed_by=user.id, close_reason="  "))
    await _rejects(db, proc(status="closed", closed_by=user.id, close_reason="שולם"))
    await _accepts(db, proc(status="closed", closed_at=NOW, closed_by=user.id, close_reason="שולם"))
    # open must have every close field cleared
    await _rejects(db, proc(status="open", close_reason="leftover"))
    await _rejects(db, proc(status="open", closed_at=NOW))
    await _rejects(db, proc(status="pending"))


@pytest.mark.asyncio
async def test_stage_constraints(base):
    db, user, proc = base["db"], base["user"], base["proc"]
    other = LegalProceeding(contact_id=base["contact"].id, party_role="other", title="t2", created_by=user.id)
    await _accepts(db, other)
    await _rejects(db, LegalProceedingStage(proceeding_id=proc.id, stage_key=catalogue.STAGE1_KEY))  # unique
    await _rejects(db, LegalProceedingStage(proceeding_id=other.id, stage_key="a", status="done"))
    await _rejects(db, LegalProceedingStage(proceeding_id=other.id, stage_key="b", status="completed"))
    await _rejects(db, LegalProceedingStage(proceeding_id=other.id, stage_key="c", status="skipped", resolved_at=NOW))
    await _rejects(db, LegalProceedingStage(proceeding_id=other.id, stage_key="d", resolved_at=NOW, resolved_by=user.id))
    await _rejects(db, LegalProceedingStage(proceeding_id=other.id, stage_key="e", resolved_by=user.id))
    await _accepts(db, LegalProceedingStage(proceeding_id=other.id, stage_key="f"))
    await _accepts(db, LegalProceedingStage(proceeding_id=other.id, stage_key="g", status="completed",
                                            resolved_at=NOW, resolved_by=user.id))
    await _accepts(db, LegalProceedingStage(proceeding_id=other.id, stage_key="h", status="skipped",
                                            resolved_at=NOW, resolved_by=user.id))


@pytest.mark.asyncio
async def test_note_combinations(base):
    db = base["db"]
    # allowed: general / stage / component, with or without channel and occurred_at
    await _accepts(db, _entry(base))
    await _accepts(db, _entry(base, occurred_at=NOW, channel="whatsapp"))
    await _accepts(db, _entry(base, stage_key="first_door_notice"))
    await _accepts(db, _entry(base, stage_key="first_door_notice", context_key="letter_file",
                              channel="email", occurred_at=NOW))
    await _accepts(db, _entry(base, stage_key=catalogue.STAGE1_KEY, channel="other"))
    # rejected
    await _rejects(db, _entry(base, content=None))
    await _rejects(db, _entry(base, content="   "))
    await _rejects(db, _entry(base, channel="sms"))
    await _rejects(db, _entry(base, context_key="letter_file"))  # component without a stage
    await _rejects(db, _entry(base, entry_type="memo"))


@pytest.mark.asyncio
async def test_communication_combinations(base):
    db = base["db"]
    s1 = catalogue.STAGE1_KEY

    def comm(**kw):
        values = dict(entry_type="communication", stage_key=s1, channel="email", occurred_at=NOW)
        values.update(kw)
        return _entry(base, **values)

    await _accepts(db, comm())
    await _accepts(db, comm(content=None))  # text optional; a file is enforced by the service
    await _accepts(db, comm(channel="whatsapp", content="נשלחה תזכורת"))
    await _rejects(db, comm(channel=None))
    await _rejects(db, comm(occurred_at=None))
    await _rejects(db, comm(stage_key="first_door_notice"))
    await _rejects(db, comm(stage_key=None))
    await _rejects(db, comm(context_key="email_proof"))
    await _rejects(db, comm(content="  "))


@pytest.mark.asyncio
async def test_assignee_primary_key(base):
    db, user, proc = base["db"], base["user"], base["proc"]
    await _accepts(db, LegalProceedingAssignee(proceeding_id=proc.id, user_id=user.id, assigned_by=user.id))
    await _rejects(db, LegalProceedingAssignee(proceeding_id=proc.id, user_id=user.id, assigned_by=user.id))


@pytest.mark.asyncio
async def test_document_context_key_is_optional(base):
    db = base["db"]
    await _accepts(db, Document(entity_type="project", entity_id=1, file_path="x"))
    doc = Document(entity_type="legal_proceeding", entity_id=base["proc"].id, file_path="y",
                   context_key=catalogue.document_context_key("supervisor_claim", "claim_filing"))
    await _accepts(db, doc)
    assert doc.context_key == "supervisor_claim.claim_filing"
