"""Remove stored files of legal documents whose deletion from storage failed.

When a legal document (or an entry with files) is deleted, its rows are committed
first and the stored file is removed afterwards. If that removal fails, the file is
left unreachable and an ``audit_logs`` entry ``document_storage_delete_failed``
(entity='legal_proceeding', details: document_id, file_path) is written. This
script works through those entries:

- only the module's own files: the path must be under the proceeding's storage
  prefix (``legal/<proceeding_id>/``); anything else is reported, never removed;
- a file is removed only if NO row in ``documents`` still references its path;
- storage operations go through :class:`DocumentStorageService`;
- each successful removal writes ``document_storage_cleaned`` (same entity), so a
  path is never processed twice;
- DRY RUN by default — nothing is removed without ``--apply``.

Usage (from the repository root, with the application's environment):
    python -m backend.scripts.legal_storage_cleanup            # report only
    python -m backend.scripts.legal_storage_cleanup --apply    # remove the files
"""
from __future__ import annotations

import argparse
import asyncio
import json

from sqlalchemy import select

from backend.models.audit_log import AuditLog
from backend.models.document import Document
from backend.models.legal_proceeding import LEGAL_PROCEEDING_AUDIT_ENTITY, LegalEvent
from backend.services.audit_service import AuditService
from backend.services.document_storage import DocumentStorageService
from backend.services.legal_document_service import storage_prefix

CLEANED = "document_storage_cleaned"


def _path_of(details: str | None) -> str | None:
    try:
        return json.loads(details or "{}").get("file_path") or None
    except ValueError:
        return None


def _is_module_path(proceeding_id: str, path: str) -> bool:
    return proceeding_id.isdigit() and path.startswith(storage_prefix(int(proceeding_id)) + "/")


async def pending_removals(db) -> list[tuple[str, str]]:
    """[(proceeding_id, file_path)] still to remove, oldest failure first."""
    rows = (await db.execute(
        select(AuditLog.entity_id, AuditLog.action, AuditLog.details)
        .where(AuditLog.entity == LEGAL_PROCEEDING_AUDIT_ENTITY,
               AuditLog.action.in_([LegalEvent.DOCUMENT_STORAGE_DELETE_FAILED, CLEANED]))
        .order_by(AuditLog.id)
    )).all()
    cleaned = {_path_of(d) for _, action, d in rows if action == CLEANED}
    pending: dict[str, str] = {}
    for proceeding_id, action, details in rows:
        path = _path_of(details)
        if (action == LegalEvent.DOCUMENT_STORAGE_DELETE_FAILED and path and path not in cleaned
                and _is_module_path(proceeding_id, path)):
            pending.setdefault(path, proceeding_id)
    if not pending:
        return []
    still_referenced = set((await db.execute(
        select(Document.file_path).where(Document.file_path.in_(list(pending)))
    )).scalars())
    return [(pid, path) for path, pid in pending.items() if path not in still_referenced]


async def foreign_paths(db) -> list[str]:
    """Recorded failures whose path is not a legal file — skipped, listed for review."""
    rows = (await db.execute(
        select(AuditLog.entity_id, AuditLog.details)
        .where(AuditLog.entity == LEGAL_PROCEEDING_AUDIT_ENTITY,
               AuditLog.action == LegalEvent.DOCUMENT_STORAGE_DELETE_FAILED)
    )).all()
    return sorted({p for pid, d in rows if (p := _path_of(d)) and not _is_module_path(pid, p)})


async def run(db, *, apply: bool) -> dict:
    """Returns {"pending", "removed", "failed", "skipped"}; commits only with apply."""
    todo = await pending_removals(db)
    report = {"pending": [p for _, p in todo], "removed": [], "failed": [], "skipped": await foreign_paths(db)}
    if not apply:
        return report
    audit = AuditService(db)
    storage = DocumentStorageService(db)
    for proceeding_id, path in todo:
        failures = await storage.remove_files([path])
        if failures:  # stays pending for the next run
            report["failed"].append({"file_path": path, "error": failures[0][1]})
            continue
        await audit.log_action(None, CLEANED, LEGAL_PROCEEDING_AUDIT_ENTITY, proceeding_id, {"file_path": path})
        await db.commit()
        report["removed"].append(path)
    return report


async def _main(apply: bool) -> None:
    from backend.db.session import AsyncSessionLocal
    async with AsyncSessionLocal() as db:
        report = await run(db, apply=apply)
    mode = "APPLY" if apply else "DRY RUN"
    print(f"[{mode}] pending: {len(report['pending'])}, removed: {len(report['removed'])}, "
          f"failed: {len(report['failed'])}, skipped (not legal files): {len(report['skipped'])}")
    for path in report["pending"] if not apply else report["removed"]:
        print(("  would remove " if not apply else "  removed ") + path)
    for path in report["skipped"]:
        print("  SKIPPED (outside legal storage) " + path)
    for failure in report["failed"]:
        print(f"  FAILED {failure['file_path']}: {failure['error']}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="remove the files (default: dry run)")
    asyncio.run(_main(parser.parse_args().apply))
