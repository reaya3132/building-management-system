"""Documents of legal proceedings — on the shared ``documents`` table.

Where a document belongs:
- general document of a proceeding   entity_type='legal_proceeding',       entity_id=proceeding, context_key NULL
- a stage component (stages 2-5)     entity_type='legal_proceeding',       entity_id=proceeding,
                                     context_key="<stage_key>.<component_key>"
- attached to an entry (note / communication)
                                     entity_type='legal_proceeding_entry', entity_id=entry

Isolation: documents are only reachable through ``/legal/proceedings/{id}/...``;
every lookup is filtered by entity_type AND the proceeding (or one of its entries),
after the IAM + visibility check of :class:`LegalAccess`.

Storage goes through the shared :class:`DocumentStorageService` (upload rules,
S3 or local disk, compensation, shared-path check); this module keeps permissions,
document placement, audit and the commit. Consistency rules:
- a ``file_path`` is never reused (uuid keys) and never updated;
- upload: files are stored first, then rows + audit are committed explicitly; if
  anything fails (including a cancelled request) the transaction is rolled back
  and the stored files are removed (compensation), so no row points at a missing
  file;
- delete: rows + audit are committed first, the stored files removed only then; a
  failed removal leaves an unreachable file and writes a
  ``document_storage_delete_failed`` audit entry, the to-do list of
  ``scripts/legal_storage_cleanup.py``.
The upload audit entry (document_id, entry, context, file) is written in the same
transaction as the row: it is the record of who uploaded what and when.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

from fastapi import HTTPException, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from backend.configurations.legal.stages import document_context_key, get_stage, parse_document_context_key
from backend.iam.enums import Action
from backend.models.document import Document
from backend.models.legal_proceeding import (
    LEGAL_ENTRY_DOCUMENT_ENTITY,
    LEGAL_PROCEEDING_AUDIT_ENTITY,
    LEGAL_PROCEEDING_DOCUMENT_ENTITY,
    EntryType,
    LegalEvent,
)
from backend.models.user import User
from backend.repositories.legal_proceeding_repository import DocumentUpload, LegalProceedingRepository
from backend.services.audit_service import AuditService
from backend.services.document_storage import DocumentStorageService, StoredFile
from backend.services.legal_access import LegalAccess, legal_error

logger = logging.getLogger(__name__)

MAX_FILES_PER_REQUEST = 10


def storage_prefix(proceeding_id: int) -> str:
    return f"legal/{proceeding_id}"


def document_snapshot(doc: Document) -> dict:
    return {"document_id": doc.id, "file_name": doc.file_name, "file_path": doc.file_path,
            "context_key": doc.context_key, "entity_type": doc.entity_type, "entity_id": doc.entity_id,
            "uploaded_at": doc.uploaded_at.isoformat() if doc.uploaded_at else None}


@dataclass
class DocumentView:
    document: Document
    uploaded_by: User | None
    uploaded_at: object
    stage_key: str | None = None       # component documents
    component_key: str | None = None
    entry_id: int | None = None        # entry attachments

    @property
    def download_url(self) -> str:
        return DocumentStorageService.url(self.document.file_path, download_filename=self.document.file_name)


class LegalDocumentService:
    def __init__(self, db: AsyncSession, user):
        self.db = db
        self.user = user
        self.repo = LegalProceedingRepository(db)
        self.access = LegalAccess(db, user)
        self.audit = AuditService(db)
        self.storage = DocumentStorageService(db)

    async def _log(self, proceeding_id: int, event: str, details: dict) -> None:
        await self.audit.log_action(self.user.id, event, LEGAL_PROCEEDING_AUDIT_ENTITY, str(proceeding_id), details)

    # ── storage transaction helpers (also used by the entry service) ─────────

    async def store_files(self, proceeding_id: int, files: list[UploadFile]) -> list[StoredFile]:
        """Store every file; on any failure the ones already stored are removed."""
        if len(files) > MAX_FILES_PER_REQUEST:
            raise legal_error(422, "too_many_files", f"At most {MAX_FILES_PER_REQUEST} files per request")
        return await self.storage.upload(files, prefix=storage_prefix(proceeding_id))

    async def undo_upload(self, stored: list[StoredFile]) -> None:
        """Compensation after a failure: roll back (a rollback error is logged and
        never replaces the original exception), then remove the stored files."""
        try:
            await self.db.rollback()
        except Exception:  # noqa: BLE001
            logger.error("Rollback failed while undoing a legal upload", exc_info=True)
        await self.storage.discard([s.path for s in stored])

    async def add_document_rows(self, proceeding_id: int, stored: list[StoredFile], *,
                                entity_type: str, entity_id: int, context_key: str | None = None,
                                entry_id: int | None = None) -> list[Document]:
        docs = await self.storage.add_documents(stored, entity_type=entity_type, entity_id=entity_id,
                                                context_key=context_key, source_table="", source_id=0)
        for doc in docs:
            await self._log(proceeding_id, LegalEvent.DOCUMENT_UPLOADED, {
                "document_id": doc.id, "file_name": doc.file_name, "file_path": doc.file_path,
                "context_key": context_key, "entry_id": entry_id,
            })
        return docs

    async def commit_upload(self, stored: list[StoredFile]) -> None:
        """Commit now (not at the end of the request) so a failure can still
        remove the files of rows that were never written."""
        try:
            await self.db.commit()
        except (Exception, asyncio.CancelledError):
            await self.undo_upload(stored)
            raise

    async def delete_rows(self, docs: list[Document], owners: set[tuple[str, int]]) -> list[dict]:
        """Delete the rows (flush); returns the snapshots whose files are free to remove."""
        snaps = {d.file_path: document_snapshot(d) for d in docs}
        free = await self.storage.delete_documents(docs, owners=owners)
        return [snaps[p] for p in free]

    async def remove_after_commit(self, proceeding_id: int, documents: list[dict]) -> None:
        """Rows are already committed: remove the files; record any failure."""
        failures = dict(await self.storage.remove_files([s["file_path"] for s in documents]))
        if not failures:
            return
        for snap in documents:
            if snap["file_path"] in failures:
                await self._log(proceeding_id, LegalEvent.DOCUMENT_STORAGE_DELETE_FAILED,
                                {"document_id": snap["document_id"], "file_path": snap["file_path"]})
        try:
            await self.db.commit()
        except Exception:
            logger.error("Could not record storage delete failures: %s", failures, exc_info=True)

    # ── uploads ──────────────────────────────────────────────────────────────

    def _component_context(self, stage_key: str | None, component_key: str | None) -> str | None:
        if stage_key is None and component_key is None:
            return None
        stage = get_stage(stage_key) if stage_key else None
        if stage is None or component_key is None or not stage.has_component(component_key):
            raise legal_error(422, "invalid_component", "Unknown documentation component for this stage",
                              stage_key=stage_key, component_key=component_key)
        return document_context_key(stage_key, component_key)

    async def upload_to_proceeding(self, proceeding_id: int, files: list[UploadFile], *,
                                   stage_key: str | None = None, component_key: str | None = None) -> list[Document]:
        """General document (no stage) or a stage component document."""
        if not files:
            raise legal_error(422, "file_required", "At least one file is required")
        context_key = self._component_context(stage_key, component_key)
        await self.access.load(proceeding_id, Action.UPDATE.value, require_open=True)
        stored = await self.store_files(proceeding_id, files)
        try:
            docs = await self.add_document_rows(proceeding_id, stored, entity_type=LEGAL_PROCEEDING_DOCUMENT_ENTITY,
                                                entity_id=proceeding_id, context_key=context_key)
        except (Exception, asyncio.CancelledError):
            await self.undo_upload(stored)
            raise
        await self.commit_upload(stored)
        return docs

    async def upload_to_entry(self, proceeding_id: int, entry_id: int, files: list[UploadFile]) -> list[Document]:
        if not files:
            raise legal_error(422, "file_required", "At least one file is required")
        await self.access.load(proceeding_id, Action.UPDATE.value, require_open=True)
        entry = await self.repo.get_entry(proceeding_id, entry_id, for_update=True)
        if entry is None:
            raise HTTPException(status_code=404, detail="Entry not found")
        await self.access.require_change_authored(entry.created_by_user_id)
        stored = await self.store_files(proceeding_id, files)
        try:
            docs = await self.add_document_rows(proceeding_id, stored, entity_type=LEGAL_ENTRY_DOCUMENT_ENTITY,
                                                entity_id=entry.id, entry_id=entry.id)
        except (Exception, asyncio.CancelledError):
            await self.undo_upload(stored)
            raise
        await self.commit_upload(stored)
        return docs

    # ── deletes ──────────────────────────────────────────────────────────────

    async def _require_can_delete(self, proceeding_id: int, doc: Document) -> None:
        uploads = await self.repo.document_uploads(proceeding_id)
        upload = uploads.get(doc.id)
        await self.access.require_change_authored(upload.user_id if upload else None)

    async def _delete(self, proceeding_id: int, doc: Document, owner: tuple[str, int],
                      extra: dict | None = None) -> None:
        snap = document_snapshot(doc)
        free = await self.delete_rows([doc], {owner})
        await self._log(proceeding_id, LegalEvent.DOCUMENT_DELETED, {**snap, **(extra or {})})
        await self.db.commit()
        await self.remove_after_commit(proceeding_id, free)

    async def delete_proceeding_document(self, proceeding_id: int, document_id: int) -> None:
        await self.access.load(proceeding_id, Action.UPDATE.value, for_update=True, require_open=True)
        doc = await self.repo.get_proceeding_document(proceeding_id, document_id)
        if doc is None:
            raise HTTPException(status_code=404, detail="Document not found")
        await self._require_can_delete(proceeding_id, doc)
        await self._delete(proceeding_id, doc, (LEGAL_PROCEEDING_DOCUMENT_ENTITY, proceeding_id))

    async def delete_entry_document(self, proceeding_id: int, entry_id: int, document_id: int) -> None:
        await self.access.load(proceeding_id, Action.UPDATE.value, require_open=True)
        entry = await self.repo.get_entry(proceeding_id, entry_id, for_update=True)  # serialises the last-file rule
        if entry is None:
            raise HTTPException(status_code=404, detail="Entry not found")
        doc = await self.repo.get_entry_document(entry.id, document_id)
        if doc is None:
            raise HTTPException(status_code=404, detail="Document not found")
        await self._require_can_delete(proceeding_id, doc)
        if (entry.entry_type == EntryType.COMMUNICATION and entry.content is None
                and await self.repo.count_entry_documents(entry.id) <= 1):
            raise legal_error(409, "last_file_of_communication",
                              "This communication has no description: add a description or delete the whole record")
        await self._delete(proceeding_id, doc, (LEGAL_ENTRY_DOCUMENT_ENTITY, entry.id), {"entry_id": entry.id})

    # ── reads ────────────────────────────────────────────────────────────────

    async def list_for_proceeding(self, proceeding_id: int) -> list[DocumentView]:
        """Every document of the proceeding, classified, with uploader (3 queries)."""
        await self.access.load(proceeding_id)
        return await self.views(proceeding_id, await self.repo.documents_for_proceeding(proceeding_id))

    async def views(self, proceeding_id: int, docs: list[Document]) -> list[DocumentView]:
        uploads = await self.repo.document_uploads(proceeding_id)
        users = await self.repo.users_by_id(u.user_id for u in uploads.values())
        result = []
        for doc in docs:
            upload = uploads.get(doc.id) or DocumentUpload(None, doc.uploaded_at)
            view = DocumentView(doc, users.get(upload.user_id), upload.uploaded_at)
            if doc.entity_type == LEGAL_ENTRY_DOCUMENT_ENTITY:
                view.entry_id = doc.entity_id
            elif doc.context_key:
                parsed = parse_document_context_key(doc.context_key)
                if parsed:
                    view.stage_key, view.component_key = parsed
            result.append(view)
        return result

    async def get_view(self, proceeding_id: int, document_id: int) -> DocumentView:
        """One document of the proceeding (general / component / entry attachment)."""
        await self.access.load(proceeding_id)
        doc = next((d for d in await self.repo.documents_for_proceeding(proceeding_id) if d.id == document_id), None)
        if doc is None:
            raise HTTPException(status_code=404, detail="Document not found")
        return (await self.views(proceeding_id, [doc]))[0]
