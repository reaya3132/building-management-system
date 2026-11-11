"""Shared storage of uploaded documents: files (S3 or local disk) + ``documents`` rows.

Infrastructure only. Permissions, audit, which entity a document belongs to and
every business rule stay in the calling module. The service NEVER commits or rolls
back: the calling service owns the transaction. Six operations:

    upload            store files; if one fails, the ones already stored are removed
    add_documents     ``documents`` rows for stored files (add + flush)
    discard           compensation: remove files whose rows were never saved
    delete_documents  delete rows (flush) owned by the caller; returns the paths
                      no other row still references
    remove_files      after the caller's commit: remove files, one failure never
                      stops the others; failures are returned, never raised
    url               browser URL through ``resolve_stored_file_url``

Typical use by a business service::

    stored = await storage.upload(files, prefix="legal/12")
    try:
        docs = await storage.add_documents(stored, entity_type="legal_proceeding", entity_id=12)
        ...                                   # the module's audit
        await db.commit()                     # the module's decision
    except (Exception, asyncio.CancelledError):
        ...                                   # rollback (guarded), then
        await storage.discard([s.path for s in stored])
        raise

    paths = await storage.delete_documents(docs, owners={("legal_proceeding", 12)})
    await db.commit()
    failures = await storage.remove_files(paths)   # the module records them

Where a stored path lives:
- a relative path whose file exists under the uploads directory -> local disk;
- a path that can only be local (``/...``, a backslash, or a ``..`` segment) -> local
  disk only: it is never sent to S3, and one resolving outside the uploads
  directory is refused (reported as a failure, nothing is deleted);
- any other relative path -> an S3 key (the format ``S3Service`` stores today)
  when ``AWS_S3_BUCKET`` is configured; without a bucket it is a local file that
  is already gone (nothing to remove).
New files go to S3 when ``AWS_S3_BUCKET`` is configured, otherwise to local disk —
the same rule ``resolve_stored_file_url`` uses to build their URL.

The upload rules (extension whitelist, 25 MB) are the ones task attachments use;
``tests/test_document_storage_service.py`` keeps the two definitions identical
until the tasks module is moved onto this service.
"""
from __future__ import annotations

import asyncio
import io
import logging
import os
import uuid
from dataclasses import dataclass

from fastapi import HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.config import settings
from backend.models.document import Document
from backend.services.file_url_resolver import get_s3_service, resolve_stored_file_url

logger = logging.getLogger(__name__)

ALLOWED_EXTENSIONS = frozenset({
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg",
    ".mp4", ".mov", ".m4v", ".avi", ".mkv", ".ogv", ".3gp",
    ".webm", ".ogg", ".oga", ".mp3", ".m4a", ".wav", ".aac",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".txt", ".csv", ".zip",
})
MAX_SIZE_MB = 25

_COMPENSATION = (Exception, asyncio.CancelledError)  # a cancelled request must not leave files behind


@dataclass(frozen=True)
class StoredFile:
    path: str            # the value for ``documents.file_path``
    original_name: str


def uploads_dir() -> str:
    """The local uploads directory (same resolution as main.py's /uploads mount)."""
    if os.path.isabs(settings.FILE_UPLOAD_DIR):
        return settings.FILE_UPLOAD_DIR
    backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.abspath(os.path.join(backend_dir, settings.FILE_UPLOAD_DIR))


def _local_only(path: str) -> bool:
    """A path that can never be an S3 key written by ``S3Service``."""
    return path.startswith("/") or "\\" in path or ".." in path.split("/")


def _local_target(path: str) -> str:
    """The absolute local file for a stored path; raises if it leaves the uploads directory."""
    relative = path[len("/uploads/"):] if path.startswith("/uploads/") else path.lstrip("/")
    root = os.path.realpath(uploads_dir())
    full = os.path.realpath(os.path.join(root, relative))
    if not full.startswith(root + os.sep):
        raise ValueError("path is outside the uploads directory")
    return full


# ── the two storage primitives (tests replace these) ─────────────────────────

async def _store_file(file: UploadFile, prefix: str) -> StoredFile:
    name = file.filename or "file"
    ext = os.path.splitext(name)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400,
                            detail=f"סוג קובץ לא נתמך. מותרים: {', '.join(sorted(ALLOWED_EXTENSIONS))}")
    content = await file.read()
    if len(content) > MAX_SIZE_MB * 1024 * 1024:
        raise HTTPException(status_code=400, detail=f"גודל קובץ מקסימלי: {MAX_SIZE_MB} MB")
    if settings.AWS_S3_BUCKET:
        key = await asyncio.to_thread(get_s3_service().upload_file, prefix=prefix, file_obj=io.BytesIO(content),
                                      filename=name, content_type=getattr(file, "content_type", None))
        return StoredFile(key, name)
    safe = name.strip() or "file"
    for char in ("/", "\\", "\0", ".."):
        safe = safe.replace(char, "_")
    relative = f"{prefix.strip('/')}/{uuid.uuid4().hex[:12]}_{safe}"
    full = os.path.join(uploads_dir(), relative)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "wb") as out:
        out.write(content)
    return StoredFile(relative, name)


async def _remove_file(path: str) -> None:
    """Remove one stored file wherever it lives; RAISES on failure."""
    local = _local_target(path)
    if os.path.isfile(local):
        os.remove(local)
        return
    if _local_only(path) or not settings.AWS_S3_BUCKET:
        return  # a local file that is already gone: nothing left to remove
    await asyncio.to_thread(get_s3_service().delete_file, path, raise_errors=True)


class DocumentStorageService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def upload(self, files: list[UploadFile], *, prefix: str) -> list[StoredFile]:
        """Store every file under ``prefix``. If one fails (invalid, storage error,
        cancelled), the files already stored are removed and the error re-raised."""
        stored: list[StoredFile] = []
        try:
            for file in files:
                stored.append(await _store_file(file, prefix))
        except _COMPENSATION:
            await self.discard([s.path for s in stored])
            raise
        return stored

    async def add_documents(self, stored: list[StoredFile], **columns) -> list[Document]:
        """One ``documents`` row per stored file with the caller's columns
        (entity_type, entity_id, context_key, transaction_id, ...). Flush only."""
        docs = [Document(file_path=s.path, file_name=s.original_name, **columns) for s in stored]
        self.db.add_all(docs)
        await self.db.flush()
        return docs

    async def discard(self, paths: list[str]) -> None:
        """Compensation for files whose rows were never saved. Never raises, so the
        caller's original exception is the one propagated; each failure is logged
        at ERROR with the path and the reason. Shielded so a second cancellation
        does not interrupt the cleanup."""
        if paths:
            await asyncio.shield(self._discard(list(paths)))

    async def _discard(self, paths: list[str]) -> None:
        for path, reason in await self.remove_files(paths):
            logger.error("Upload compensation failed, orphan file left in storage: path=%s reason=%s", path, reason)

    async def delete_documents(self, docs: list[Document], *, owners: set[tuple[str, int]]) -> list[str]:
        """Delete rows the caller owns (flush only). Every document must belong to
        one of ``owners`` = {(entity_type, entity_id)}, otherwise nothing is deleted.
        Returns the file paths that no remaining ``documents`` row references."""
        foreign = [d.id for d in docs if (d.entity_type, d.entity_id) not in owners]
        if foreign:
            raise ValueError(f"Documents {foreign} do not belong to the requesting entity")
        if not docs:
            return []
        paths = list(dict.fromkeys(d.file_path for d in docs if d.file_path))
        for doc in docs:
            await self.db.delete(doc)
        await self.db.flush()
        if not paths:
            return []
        still_used = set((await self.db.execute(
            select(Document.file_path).where(Document.file_path.in_(paths))
        )).scalars())
        return [p for p in paths if p not in still_used]

    async def remove_files(self, paths: list[str]) -> list[tuple[str, str]]:
        """Remove stored files (after the caller's commit). Every path is tried even
        if an earlier one fails. Returns [(path, reason)] for the failures."""
        failures: list[tuple[str, str]] = []
        for path in paths:
            try:
                await _remove_file(path)
            except Exception as exc:  # noqa: BLE001 — reported to the caller
                logger.warning("Removing stored file failed: path=%s", path, exc_info=True)
                failures.append((path, f"{type(exc).__name__}: {exc}"))
        return failures

    @staticmethod
    def url(path: str | None, *, download_filename: str | None = None) -> str:
        return resolve_stored_file_url(path, download_filename=download_filename)
