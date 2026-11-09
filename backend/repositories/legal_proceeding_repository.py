"""Queries for legal proceedings (הליכים משפטיים) and everything attached to them.

Visibility mirrors the tasks module (``TaskRepository._visible_to_user_clause``):
a non-Admin sees a proceeding they created or are assigned to. Every list is a
fixed number of queries regardless of its size — related rows (stages, documents,
uploaders) are fetched in one batched query per kind, never per row.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal

from sqlalchemy import and_, case, exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from backend.models.audit_log import AuditLog
from backend.models.contact import Contact
from backend.models.document import Document
from backend.models.legal_proceeding import (
    LEGAL_ENTRY_DOCUMENT_ENTITY,
    LEGAL_PROCEEDING_AUDIT_ENTITY,
    LEGAL_PROCEEDING_DOCUMENT_ENTITY,
    EntryType,
    LegalEvent,
    LegalProceeding,
    LegalProceedingAssignee,
    LegalProceedingEntry,
    LegalProceedingStage,
    PartyRole,
    ProceedingStatus,
)
from backend.models.project import Project
from backend.models.user import User
from backend.repositories.contact_repository import LIKE_ESCAPE, contains_pattern


def visible_to_user_clause(user_id: int):
    """Proceedings a (non-Admin) user may see: created by them or assigned to them."""
    return or_(
        LegalProceeding.created_by == user_id,
        exists()
        .where(LegalProceedingAssignee.proceeding_id == LegalProceeding.id)
        .where(LegalProceedingAssignee.user_id == user_id),
    )


@dataclass
class ProceedingFilters:
    status: str | None = None             # 'open' | 'closed' | None (all)
    project_id: int | None = None
    include_subprojects: bool = False     # with project_id: also its sub-projects
    contact_id: int | None = None
    landlord_contact_id: int | None = None   # the landlord linked to a tenant's proceeding
    search: str | None = None             # title / contact name / unit
    assigned_user_id: int | None = None   # creator or assignee (Admin filter)


@dataclass
class ProceedingRow:
    proceeding: LegalProceeding
    contact_name: str
    project_name: str | None
    created_by_name: str | None
    linked_landlord_name: str | None = None   # only in a tenant's proceeding


@dataclass
class ProjectSummaryRow:
    project_id: int | None
    project_name: str | None
    open_count: int
    closed_count: int
    open_claim_total: Decimal
    contact_count: int


@dataclass
class DocumentUpload:
    user_id: int | None
    uploaded_at: datetime


@dataclass
class StageDocumentationCounts:
    """Inputs of the "missing documentation" warning of one proceeding."""
    component_documents: dict[str, int] = field(default_factory=dict)  # documents.context_key -> count
    communications_with_file: int = 0


class LegalProceedingRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    # ── proceedings ──────────────────────────────────────────────────────────

    async def get(self, proceeding_id: int, *, for_update: bool = False) -> LegalProceeding | None:
        stmt = select(LegalProceeding).where(LegalProceeding.id == proceeding_id)
        if for_update:
            stmt = stmt.with_for_update()
        return (await self.db.execute(stmt)).scalar_one_or_none()

    async def is_assignee(self, proceeding_id: int, user_id: int) -> bool:
        stmt = select(exists().where(LegalProceedingAssignee.proceeding_id == proceeding_id,
                                     LegalProceedingAssignee.user_id == user_id))
        return bool((await self.db.execute(stmt)).scalar())

    async def add(self, obj) -> None:
        self.db.add(obj)
        await self.db.flush()

    def _filtered(self, filters: ProceedingFilters, visible_to: int | None):
        stmt = (
            select(LegalProceeding)
            .join(Contact, Contact.id == LegalProceeding.contact_id)
            .outerjoin(Project, Project.id == LegalProceeding.project_id)
        )
        if visible_to is not None:
            stmt = stmt.where(visible_to_user_clause(visible_to))
        if filters.assigned_user_id is not None:
            stmt = stmt.where(visible_to_user_clause(filters.assigned_user_id))
        if filters.status:
            stmt = stmt.where(LegalProceeding.status == filters.status)
        if filters.contact_id is not None:
            stmt = stmt.where(LegalProceeding.contact_id == filters.contact_id)
        if filters.landlord_contact_id is not None:
            stmt = stmt.where(LegalProceeding.linked_to_landlord(filters.landlord_contact_id))
        if filters.project_id is not None:
            if filters.include_subprojects:
                stmt = stmt.where(or_(LegalProceeding.project_id == filters.project_id,
                                      Project.relation_project == filters.project_id))
            else:
                stmt = stmt.where(LegalProceeding.project_id == filters.project_id)
        if filters.search and filters.search.strip():
            pattern = contains_pattern(filters.search.strip())
            stmt = stmt.where(or_(
                LegalProceeding.title.ilike(pattern, escape=LIKE_ESCAPE),
                Contact.name.ilike(pattern, escape=LIKE_ESCAPE),
                LegalProceeding.apartment_number.ilike(pattern, escape=LIKE_ESCAPE),
            ))
        return stmt

    async def list(self, filters: ProceedingFilters, *, visible_to: int | None,
                   offset: int, limit: int) -> tuple[list[ProceedingRow], int]:
        base = self._filtered(filters, visible_to)
        total = (await self.db.execute(
            select(func.count()).select_from(base.with_only_columns(LegalProceeding.id).subquery())
        )).scalar_one()
        creator = aliased(User, name="creator")
        landlord = aliased(Contact, name="linked_landlord")
        stmt = (
            base.add_columns(Contact.name, Project.name, creator.full_name, landlord.name)
            .outerjoin(creator, creator.id == LegalProceeding.created_by)
            .outerjoin(landlord, and_(LegalProceeding.party_role == PartyRole.TENANT,
                                      landlord.id == LegalProceeding.landlord_contact_id))
            .order_by(LegalProceeding.status.desc(),  # 'open' before 'closed'
                      LegalProceeding.opened_at.desc(), LegalProceeding.id.desc())
            .offset(offset).limit(limit)
        )
        rows = [ProceedingRow(p, cname, pname, uname, lname)
                for p, cname, pname, uname, lname in (await self.db.execute(stmt))]
        return rows, total

    async def linked_landlords(self, *, visible_to: int | None) -> list[tuple[int, str]]:
        """(id, name) of every landlord linked to a visible tenant's proceeding, once each."""
        stmt = (
            select(Contact.id, Contact.name)
            .join(LegalProceeding, LegalProceeding.landlord_contact_id == Contact.id)
            .where(LegalProceeding.party_role == PartyRole.TENANT)
            .distinct()
            .order_by(Contact.name, Contact.id)
        )
        if visible_to is not None:
            stmt = stmt.where(visible_to_user_clause(visible_to))
        return [(row.id, row.name) for row in await self.db.execute(stmt)]

    async def has_open_tenant_proceeding(self, contact_id: int) -> bool:
        """Is this contact the tenant of an open proceeding, whoever can see it?"""
        stmt = select(exists().where(LegalProceeding.contact_id == contact_id,
                                     LegalProceeding.party_role == PartyRole.TENANT,
                                     LegalProceeding.status == ProceedingStatus.OPEN))
        return bool((await self.db.execute(stmt)).scalar())

    async def has_open_proceeding_for_contact(self, contact_id: int) -> bool:
        """Is this contact a party (primary or linked landlord) of an open proceeding?"""
        stmt = select(exists().where(or_(LegalProceeding.contact_id == contact_id,
                                         LegalProceeding.landlord_contact_id == contact_id),
                                     LegalProceeding.status == ProceedingStatus.OPEN))
        return bool((await self.db.execute(stmt)).scalar())

    async def has_visible_for_contact(self, contact_id: int, user_id: int) -> bool:
        stmt = select(exists().where(LegalProceeding.contact_id == contact_id, visible_to_user_clause(user_id)))
        return bool((await self.db.execute(stmt)).scalar())

    async def project_summary(self, *, visible_to: int | None, rollup_to_parent: bool,
                              project_id: int | None = None) -> list[ProjectSummaryRow]:
        """Proceedings grouped by project (one query). With ``rollup_to_parent``
        sub-projects count under their parent project."""
        parent = aliased(Project, name="parent_project")
        group_id = (func.coalesce(Project.relation_project, Project.id) if rollup_to_parent
                    else LegalProceeding.project_id)
        group_name = (func.coalesce(parent.name, Project.name) if rollup_to_parent else Project.name)
        is_open = LegalProceeding.status == ProceedingStatus.OPEN
        stmt = (
            select(
                group_id.label("pid"),
                group_name.label("pname"),
                func.count().filter(is_open),
                func.count().filter(~is_open),
                func.coalesce(func.sum(case((is_open, LegalProceeding.claim_amount), else_=None)), 0),
                func.count(func.distinct(LegalProceeding.contact_id)),
            )
            .select_from(LegalProceeding)
            .outerjoin(Project, Project.id == LegalProceeding.project_id)
            .outerjoin(parent, parent.id == Project.relation_project)
            .group_by(group_id, group_name)
        )
        if visible_to is not None:
            stmt = stmt.where(visible_to_user_clause(visible_to))
        if project_id is not None:
            stmt = stmt.where(group_id == project_id)
        rows = [
            ProjectSummaryRow(pid, pname, o, c, Decimal(t).quantize(Decimal("0.01")), n)
            for pid, pname, o, c, t, n in await self.db.execute(stmt)
        ]
        rows.sort(key=lambda r: (-r.open_count, r.project_name or ""))
        return rows

    # ── stages ───────────────────────────────────────────────────────────────

    async def stages_for(self, proceeding_ids: list[int]) -> dict[int, list[LegalProceedingStage]]:
        result: dict[int, list[LegalProceedingStage]] = {pid: [] for pid in proceeding_ids}
        if not proceeding_ids:
            return result
        stmt = select(LegalProceedingStage).where(LegalProceedingStage.proceeding_id.in_(proceeding_ids))
        for stage in (await self.db.execute(stmt)).scalars():
            result[stage.proceeding_id].append(stage)
        return result

    async def get_stage(self, proceeding_id: int, stage_key: str, *, for_update: bool = False
                        ) -> LegalProceedingStage | None:
        stmt = select(LegalProceedingStage).where(LegalProceedingStage.proceeding_id == proceeding_id,
                                                  LegalProceedingStage.stage_key == stage_key)
        if for_update:
            stmt = stmt.with_for_update()
        return (await self.db.execute(stmt)).scalar_one_or_none()

    async def documentation_counts(self, proceeding_id: int) -> StageDocumentationCounts:
        """Two aggregate queries: component documents by context_key, and stage-1
        communications that have at least one attached document."""
        counts = StageDocumentationCounts()
        comp = (
            select(Document.context_key, func.count())
            .where(Document.entity_type == LEGAL_PROCEEDING_DOCUMENT_ENTITY,
                   Document.entity_id == proceeding_id, Document.context_key.is_not(None))
            .group_by(Document.context_key)
        )
        counts.component_documents = {k: n for k, n in await self.db.execute(comp)}
        has_file = exists().where(Document.entity_type == LEGAL_ENTRY_DOCUMENT_ENTITY,
                                  Document.entity_id == LegalProceedingEntry.id)
        comm = select(func.count()).where(
            LegalProceedingEntry.proceeding_id == proceeding_id,
            LegalProceedingEntry.entry_type == EntryType.COMMUNICATION,
            has_file,
        )
        counts.communications_with_file = (await self.db.execute(comm)).scalar_one()
        return counts

    # ── entries ──────────────────────────────────────────────────────────────

    async def list_entries(self, proceeding_id: int, *, stage_key: str | None = None, general_only: bool = False,
                           context_key: str | None = None, entry_type: str | None = None,
                           before_id: int | None = None, limit: int = 50) -> list[LegalProceedingEntry]:
        stmt = select(LegalProceedingEntry).where(LegalProceedingEntry.proceeding_id == proceeding_id)
        if general_only:
            stmt = stmt.where(LegalProceedingEntry.stage_key.is_(None))
        elif stage_key is not None:
            stmt = stmt.where(LegalProceedingEntry.stage_key == stage_key)
        if context_key is not None:
            stmt = stmt.where(LegalProceedingEntry.context_key == context_key)
        if entry_type is not None:
            stmt = stmt.where(LegalProceedingEntry.entry_type == entry_type)
        if before_id is not None:
            stmt = stmt.where(LegalProceedingEntry.id < before_id)
        stmt = stmt.order_by(LegalProceedingEntry.id.desc()).limit(limit)
        return list((await self.db.execute(stmt)).scalars())

    async def get_entry(self, proceeding_id: int, entry_id: int, *, for_update: bool = False
                        ) -> LegalProceedingEntry | None:
        stmt = select(LegalProceedingEntry).where(LegalProceedingEntry.id == entry_id,
                                                  LegalProceedingEntry.proceeding_id == proceeding_id)
        if for_update:
            stmt = stmt.with_for_update()
        return (await self.db.execute(stmt)).scalar_one_or_none()

    async def delete_entry(self, entry: LegalProceedingEntry) -> None:
        await self.db.delete(entry)
        await self.db.flush()

    # ── documents (shared documents table, isolated by entity_type) ──────────

    async def documents_for_proceeding(self, proceeding_id: int) -> list[Document]:
        """Every document of the proceeding — general, stage components and entry
        attachments — in one query."""
        entry_ids = select(LegalProceedingEntry.id).where(LegalProceedingEntry.proceeding_id == proceeding_id)
        stmt = select(Document).where(or_(
            and_(Document.entity_type == LEGAL_PROCEEDING_DOCUMENT_ENTITY, Document.entity_id == proceeding_id),
            and_(Document.entity_type == LEGAL_ENTRY_DOCUMENT_ENTITY, Document.entity_id.in_(entry_ids)),
        )).order_by(Document.id)
        return list((await self.db.execute(stmt)).scalars())

    async def documents_for_entries(self, entry_ids: list[int]) -> dict[int, list[Document]]:
        result: dict[int, list[Document]] = {eid: [] for eid in entry_ids}
        if not entry_ids:
            return result
        stmt = (select(Document)
                .where(Document.entity_type == LEGAL_ENTRY_DOCUMENT_ENTITY, Document.entity_id.in_(entry_ids))
                .order_by(Document.id))
        for doc in (await self.db.execute(stmt)).scalars():
            result[doc.entity_id].append(doc)
        return result

    async def get_proceeding_document(self, proceeding_id: int, document_id: int) -> Document | None:
        stmt = select(Document).where(Document.id == document_id,
                                      Document.entity_type == LEGAL_PROCEEDING_DOCUMENT_ENTITY,
                                      Document.entity_id == proceeding_id)
        return (await self.db.execute(stmt)).scalar_one_or_none()

    async def get_entry_document(self, entry_id: int, document_id: int) -> Document | None:
        stmt = select(Document).where(Document.id == document_id,
                                      Document.entity_type == LEGAL_ENTRY_DOCUMENT_ENTITY,
                                      Document.entity_id == entry_id)
        return (await self.db.execute(stmt)).scalar_one_or_none()

    async def count_entry_documents(self, entry_id: int) -> int:
        stmt = select(func.count()).where(Document.entity_type == LEGAL_ENTRY_DOCUMENT_ENTITY,
                                          Document.entity_id == entry_id)
        return (await self.db.execute(stmt)).scalar_one()

    async def document_uploads(self, proceeding_id: int) -> dict[int, DocumentUpload]:
        """Who uploaded each document and when, from the proceeding's audit trail
        (one query; the upload entry is written in the same transaction as the row)."""
        stmt = select(AuditLog.user_id, AuditLog.created_at, AuditLog.details).where(
            AuditLog.entity == LEGAL_PROCEEDING_AUDIT_ENTITY,
            AuditLog.entity_id == str(proceeding_id),
            AuditLog.action == LegalEvent.DOCUMENT_UPLOADED,
        )
        result: dict[int, DocumentUpload] = {}
        for user_id, created_at, details in await self.db.execute(stmt):
            try:
                doc_id = int(json.loads(details or "{}").get("document_id"))
            except (TypeError, ValueError):
                continue
            result[doc_id] = DocumentUpload(user_id, created_at)
        return result

    # ── assignees ────────────────────────────────────────────────────────────

    async def assignees_for(self, proceeding_ids: list[int]) -> dict[int, list[LegalProceedingAssignee]]:
        result: dict[int, list[LegalProceedingAssignee]] = {pid: [] for pid in proceeding_ids}
        if not proceeding_ids:
            return result
        stmt = (select(LegalProceedingAssignee)
                .where(LegalProceedingAssignee.proceeding_id.in_(proceeding_ids))
                .order_by(LegalProceedingAssignee.assigned_at))
        for row in (await self.db.execute(stmt)).scalars():
            result[row.proceeding_id].append(row)
        return result

    async def get_assignee(self, proceeding_id: int, user_id: int) -> LegalProceedingAssignee | None:
        stmt = select(LegalProceedingAssignee).where(LegalProceedingAssignee.proceeding_id == proceeding_id,
                                                     LegalProceedingAssignee.user_id == user_id)
        return (await self.db.execute(stmt)).scalar_one_or_none()

    async def delete_assignee(self, row: LegalProceedingAssignee) -> None:
        await self.db.delete(row)
        await self.db.flush()

    # ── history ──────────────────────────────────────────────────────────────

    async def history(self, proceeding_id: int, *, page: int, page_size: int
                      ) -> tuple[list[tuple[AuditLog, str | None]], int]:
        """Same query shape as the collection module's history (uses the
        ix_audit_logs_entity_entity_id_created_at index)."""
        where = and_(AuditLog.entity == LEGAL_PROCEEDING_AUDIT_ENTITY, AuditLog.entity_id == str(proceeding_id))
        rows = (await self.db.execute(
            select(AuditLog, User.full_name)
            .outerjoin(User, User.id == AuditLog.user_id)
            .where(where)
            .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
            .limit(page_size)
            .offset((page - 1) * page_size)
        )).all()
        total = (await self.db.execute(select(func.count(AuditLog.id)).where(where))).scalar_one()
        return [(log, name) for log, name in rows], total
