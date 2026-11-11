"""Entries of a legal proceeding: notes and stage-1 communication records.

- note: content required; general (no stage), of a stage, or of a stage component;
  channel and occurred_at optional.
- communication: always stage 1; channel and occurred_at required; content optional
  ONLY when at least one file is attached — so a communication is created together
  with its files in one request, and its last file cannot be removed while it has
  no text.
``occurred_at`` is when it really happened and is never derived from created_at.
Entries never change a stage status. Editing / deleting someone else's entry
requires the IAM ``delete`` action. Deleting writes a full snapshot (entry +
documents) to ``audit_logs`` before the rows go, then removes the stored files.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import HTTPException, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from backend.configurations.legal.stages import STAGE1_KEY, get_stage, is_valid_component
from backend.iam.enums import Action
from backend.models.document import Document
from backend.models.legal_proceeding import (
    LEGAL_ENTRY_DOCUMENT_ENTITY,
    LEGAL_PROCEEDING_AUDIT_ENTITY,
    CommunicationChannel,
    EntryType,
    LegalEvent,
    LegalProceedingEntry,
)
from backend.models.user import User
from backend.repositories.legal_proceeding_repository import LegalProceedingRepository
from backend.repositories.user_repository import UserRepository
from backend.services.audit_service import AuditService
from backend.services.legal_access import changed_fields, clean_text, legal_error, LegalAccess, utc_now
from backend.services.legal_document_service import LegalDocumentService, document_snapshot

_UNSET = object()


def _naive_utc(value: datetime | None) -> datetime | None:
    if value is not None and value.tzinfo is not None:
        value = value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


def entry_snapshot(entry: LegalProceedingEntry) -> dict:
    def iso(v):
        return v.isoformat() if isinstance(v, datetime) else v
    return {k: iso(getattr(entry, k)) for k in (
        "id", "entry_type", "stage_key", "context_key", "content", "channel", "occurred_at",
        "created_by_user_id", "created_at", "updated_by_user_id", "updated_at")}


@dataclass
class EntryView:
    entry: LegalProceedingEntry
    documents: list
    created_by: User | None
    updated_by: User | None
    can_modify: bool


class LegalEntryService:
    def __init__(self, db: AsyncSession, user):
        self.db = db
        self.user = user
        self.repo = LegalProceedingRepository(db)
        self.access = LegalAccess(db, user)
        self.audit = AuditService(db)
        self.documents = LegalDocumentService(db, user)
        self.documents.access = self.access  # one permission cache per request

    async def _log(self, proceeding_id: int, event: str, details: dict) -> None:
        await self.audit.log_action(self.user.id, event, LEGAL_PROCEEDING_AUDIT_ENTITY, str(proceeding_id), details)

    @staticmethod
    def _validate_channel(channel: str | None) -> str | None:
        if channel is not None and channel not in CommunicationChannel.ALL:
            raise legal_error(422, "invalid_channel", "channel must be email, whatsapp or other")
        return channel

    def _validated_new(self, entry_type: str, stage_key: str | None, context_key: str | None,
                       content: str | None, channel: str | None, occurred_at: datetime | None,
                       has_files: bool) -> dict:
        if entry_type not in EntryType.ALL:
            raise legal_error(422, "invalid_entry_type", "entry_type must be note or communication")
        channel = self._validate_channel(channel)
        if entry_type == EntryType.COMMUNICATION:
            if stage_key not in (None, STAGE1_KEY) or context_key is not None:
                raise legal_error(422, "communication_stage_only",
                                  "A communication record belongs to stage 1 and to no component")
            if channel is None:
                raise legal_error(422, "channel_required", "A communication record requires a channel")
            if occurred_at is None:
                raise legal_error(422, "occurred_at_required", "A communication record requires its date")
            if content is None and not has_files:
                raise legal_error(422, "communication_needs_content_or_file",
                                  "Add a description or attach at least one file")
            stage_key = STAGE1_KEY
        else:
            if content is None:
                raise legal_error(422, "content_required", "A note requires content")
            if stage_key is not None and get_stage(stage_key) is None:
                raise legal_error(422, "invalid_stage", "Unknown stage", stage_key=stage_key)
            if context_key is not None and not is_valid_component(stage_key, context_key):
                raise legal_error(422, "invalid_component", "Unknown documentation component for this stage",
                                  stage_key=stage_key, component_key=context_key)
        return dict(entry_type=entry_type, stage_key=stage_key, context_key=context_key, content=content,
                    channel=channel, occurred_at=occurred_at)

    # ── create ───────────────────────────────────────────────────────────────

    async def create(self, proceeding_id: int, *, entry_type: str, stage_key: str | None = None,
                     context_key: str | None = None, content: str | None = None, channel: str | None = None,
                     occurred_at: datetime | None = None, files: list[UploadFile] | None = None) -> EntryView:
        files = [f for f in (files or []) if f is not None]
        await self.access.load(proceeding_id, Action.UPDATE.value, require_open=True)
        data = self._validated_new(entry_type, stage_key, context_key, clean_text(content), channel,
                                   _naive_utc(occurred_at), bool(files))
        stored = await self.documents.store_files(proceeding_id, files) if files else []
        try:
            entry = LegalProceedingEntry(proceeding_id=proceeding_id, created_by_user_id=self.user.id,
                                         created_at=utc_now(), **data)
            await self.repo.add(entry)
            await self._log(proceeding_id, LegalEvent.ENTRY_CREATED, {"after": entry_snapshot(entry)})
            docs = await self.documents.add_document_rows(proceeding_id, stored, entity_type=LEGAL_ENTRY_DOCUMENT_ENTITY,
                                                          entity_id=entry.id, entry_id=entry.id)
        except (Exception, asyncio.CancelledError):
            if stored:
                await self.documents.undo_upload(stored)
            raise
        await self.documents.commit_upload(stored)  # with or without files: the one commit of this operation
        return (await self._views(proceeding_id, [entry], {entry.id: docs}))[0]

    # ── update ───────────────────────────────────────────────────────────────

    async def update(self, proceeding_id: int, entry_id: int, *, content=_UNSET, channel=_UNSET,
                     occurred_at=_UNSET) -> EntryView:
        """Text, channel and date. The type, stage and component never change."""
        await self.access.load(proceeding_id, Action.UPDATE.value, require_open=True)
        entry = await self.repo.get_entry(proceeding_id, entry_id, for_update=True)
        if entry is None:
            raise HTTPException(status_code=404, detail="Entry not found")
        await self.access.require_change_authored(entry.created_by_user_id)
        before = entry_snapshot(entry)
        if content is not _UNSET:
            entry.content = clean_text(content)
            if entry.content is None:
                if entry.entry_type == EntryType.NOTE:
                    raise legal_error(422, "content_required", "A note requires content")
                if await self.repo.count_entry_documents(entry.id) == 0:
                    raise legal_error(409, "communication_needs_content_or_file",
                                      "A communication without files must keep its description")
        if channel is not _UNSET:
            entry.channel = self._validate_channel(channel)
            if entry.entry_type == EntryType.COMMUNICATION and entry.channel is None:
                raise legal_error(422, "channel_required", "A communication record requires a channel")
        if occurred_at is not _UNSET:
            entry.occurred_at = _naive_utc(occurred_at)
            if entry.entry_type == EntryType.COMMUNICATION and entry.occurred_at is None:
                raise legal_error(422, "occurred_at_required", "A communication record requires its date")
        old, new = changed_fields(before, entry_snapshot(entry), ("content", "channel", "occurred_at"))
        if new:
            entry.updated_by_user_id, entry.updated_at = self.user.id, utc_now()
            await self.db.flush()
            await self._log(proceeding_id, LegalEvent.ENTRY_UPDATED,
                            {"entry_id": entry.id, "before": old, "after": new})
        return (await self._views(proceeding_id, [entry]))[0]

    # ── delete ───────────────────────────────────────────────────────────────

    async def delete(self, proceeding_id: int, entry_id: int) -> None:
        await self.access.load(proceeding_id, Action.UPDATE.value, require_open=True)
        entry = await self.repo.get_entry(proceeding_id, entry_id, for_update=True)
        if entry is None:
            raise HTTPException(status_code=404, detail="Entry not found")
        await self.access.require_change_authored(entry.created_by_user_id)
        docs = (await self.repo.documents_for_entries([entry.id]))[entry.id]
        doc_snaps = [document_snapshot(d) for d in docs]
        await self._log(proceeding_id, LegalEvent.ENTRY_DELETED, {"entry": entry_snapshot(entry), "documents": doc_snaps})
        free = await self.documents.delete_rows(docs, {(LEGAL_ENTRY_DOCUMENT_ENTITY, entry.id)})
        await self.repo.delete_entry(entry)
        await self.db.commit()
        await self.documents.remove_after_commit(proceeding_id, free)

    # ── read ─────────────────────────────────────────────────────────────────

    async def list(self, proceeding_id: int, *, stage_key: str | None = None, general_only: bool = False,
                   context_key: str | None = None, entry_type: str | None = None,
                   before_id: int | None = None, limit: int = 50) -> list[EntryView]:
        """Entries newest first (keyset by id), each with its documents (3-4 queries)."""
        await self.access.load(proceeding_id)
        entries = await self.repo.list_entries(proceeding_id, stage_key=stage_key, general_only=general_only,
                                               context_key=context_key, entry_type=entry_type,
                                               before_id=before_id, limit=max(1, min(limit, 200)))
        return await self._views(proceeding_id, entries)

    async def _views(self, proceeding_id: int, entries: list[LegalProceedingEntry],
                     docs: dict[int, list[Document]] | None = None) -> list[EntryView]:
        if docs is None:
            docs = await self.repo.documents_for_entries([e.id for e in entries])
        doc_views = {v.document.id: v for v in await self.documents.views(
            proceeding_id, [d for ds in docs.values() for d in ds])} if any(docs.values()) else {}
        users = await UserRepository(self.db).users_by_id(
            [e.created_by_user_id for e in entries] + [e.updated_by_user_id for e in entries])
        can_delete_others = await self.access.allowed(Action.DELETE.value)
        return [EntryView(e, [doc_views[d.id] for d in docs.get(e.id, [])], users.get(e.created_by_user_id),
                          users.get(e.updated_by_user_id),
                          e.created_by_user_id == self.user.id or can_delete_others) for e in entries]
