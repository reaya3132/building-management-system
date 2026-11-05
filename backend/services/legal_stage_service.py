"""Stages of a legal proceeding: explicit complete / skip / reopen only.

Adding a note or a document never changes a stage status. Before completing, the
documentation of the stage is checked against configurations/legal/stages.py:
- stage 1: at least one communication entry with an attached document;
- stages 2-5: every component has at least one document (notes never count).
Anything missing is a NON-blocking warning: the first call answers 409
``stage_requirements_missing`` with the list; repeating it with ``confirm=True``
completes the stage anyway, and the history records what was missing.
Skipping ("not relevant") counts as done for the progress. Reopening a completed
or skipped stage returns it to pending; every change is in ``audit_logs``.
The proceeding row is locked first, so concurrent stage actions are serialised.
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from backend.configurations.legal.stages import StageDefinition, document_context_key, get_stage
from backend.iam.enums import Action
from backend.models.legal_proceeding import (
    LEGAL_PROCEEDING_AUDIT_ENTITY,
    LegalEvent,
    LegalProceedingStage,
    StageStatus,
)
from backend.repositories.legal_proceeding_repository import LegalProceedingRepository, StageDocumentationCounts
from backend.services.audit_service import AuditService
from backend.services.legal_access import LegalAccess, legal_error

COMMUNICATION_REQUIREMENT = "communication_with_file"
COMMUNICATION_REQUIREMENT_LABEL = "תיעוד תקשורת אחד לפחות עם קובץ מצורף"


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _clean(reason: str | None) -> str | None:
    return (reason or "").strip() or None


def missing_documentation(stage: StageDefinition, counts: StageDocumentationCounts) -> list[dict]:
    """What is still undocumented in ``stage``: [{key, label}] in configuration order."""
    missing = []
    if stage.requires_communication and counts.communications_with_file == 0:
        missing.append({"key": COMMUNICATION_REQUIREMENT, "label": COMMUNICATION_REQUIREMENT_LABEL})
    for component in stage.components:
        if counts.component_documents.get(document_context_key(stage.key, component.key), 0) == 0:
            missing.append({"key": component.key, "label": component.label})
    return missing


class LegalStageService:
    def __init__(self, db: AsyncSession, user):
        self.db = db
        self.user = user
        self.repo = LegalProceedingRepository(db)
        self.access = LegalAccess(db, user)
        self.audit = AuditService(db)

    async def _locked_stage(self, proceeding_id: int, stage_key: str) -> tuple[StageDefinition, LegalProceedingStage]:
        definition = get_stage(stage_key)
        await self.access.load(proceeding_id, Action.UPDATE.value, for_update=True, require_open=True)
        stage = await self.repo.get_stage(proceeding_id, stage_key, for_update=True) if definition else None
        if stage is None:
            raise HTTPException(status_code=404, detail="Stage not found")
        return definition, stage

    async def _log_change(self, stage: LegalProceedingStage, before: str, **details) -> None:
        await self.audit.log_action(self.user.id, LegalEvent.STAGE_STATUS_CHANGED, LEGAL_PROCEEDING_AUDIT_ENTITY,
                                    str(stage.proceeding_id),
                                    {"stage_key": stage.stage_key, "from": before, "to": stage.status, **details})

    def _resolve(self, stage: LegalProceedingStage, status: str) -> None:
        now = _now()
        stage.status, stage.resolved_at, stage.resolved_by, stage.updated_at = status, now, self.user.id, now

    async def missing(self, proceeding_id: int, stage_key: str) -> list[dict]:
        """The warning, for display before the user clicks "סיום שלב"."""
        definition = get_stage(stage_key)
        await self.access.load(proceeding_id)
        if definition is None:
            raise HTTPException(status_code=404, detail="Stage not found")
        return missing_documentation(definition, await self.repo.documentation_counts(proceeding_id))

    async def complete(self, proceeding_id: int, stage_key: str, *, confirm: bool = False) -> LegalProceedingStage:
        definition, stage = await self._locked_stage(proceeding_id, stage_key)
        if stage.status != StageStatus.PENDING:
            raise legal_error(409, "stage_not_pending", "Only a pending stage can be completed; reopen it first",
                              status=stage.status)
        missing = missing_documentation(definition, await self.repo.documentation_counts(proceeding_id))
        if missing and not confirm:
            raise legal_error(409, "stage_requirements_missing",
                              "Some documentation of this stage is missing; confirm to complete anyway",
                              missing=missing)
        self._resolve(stage, StageStatus.COMPLETED)
        await self.db.flush()
        await self._log_change(stage, StageStatus.PENDING, missing=missing, forced=bool(missing))
        return stage

    async def skip(self, proceeding_id: int, stage_key: str, *, reason: str | None = None) -> LegalProceedingStage:
        _, stage = await self._locked_stage(proceeding_id, stage_key)
        if stage.status != StageStatus.PENDING:
            raise legal_error(409, "stage_not_pending", "Only a pending stage can be marked not relevant",
                              status=stage.status)
        self._resolve(stage, StageStatus.SKIPPED)
        await self.db.flush()
        await self._log_change(stage, StageStatus.PENDING, reason=_clean(reason))
        return stage

    async def reopen(self, proceeding_id: int, stage_key: str, *, reason: str | None = None) -> LegalProceedingStage:
        _, stage = await self._locked_stage(proceeding_id, stage_key)
        if stage.status not in StageStatus.RESOLVED:
            raise legal_error(409, "stage_not_resolved", "Only a completed or skipped stage can be reopened",
                              status=stage.status)
        before = stage.status
        previous = {"resolved_at": stage.resolved_at.isoformat(), "resolved_by": stage.resolved_by}
        stage.status, stage.resolved_at, stage.resolved_by, stage.updated_at = StageStatus.PENDING, None, None, _now()
        await self.db.flush()
        await self._log_change(stage, before, reason=_clean(reason), previous=previous)
        return stage
