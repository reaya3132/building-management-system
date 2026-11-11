"""DocumentStorageService: upload + compensation, rows without commit, scoped
deletes, shared paths, file removal on local disk / S3 (current keys and legacy URLs)."""
from __future__ import annotations

import asyncio
import io
import logging
import os

import pytest
from fastapi import HTTPException, UploadFile
from sqlalchemy import func, select

from backend.core.config import settings
from backend.models.document import Document
from backend.services import document_storage
from backend.services.document_storage import DocumentStorageService, StoredFile

pytestmark = pytest.mark.asyncio


class FakeS3:
    def __init__(self):
        self.objects: dict[str, bytes] = {}
        self.deleted: list[str] = []
        self.fail_delete: set[str] = set()

    def upload_file(self, *, prefix, file_obj, filename=None, content_type=None):
        key = f"{prefix}/k{len(self.objects)}{os.path.splitext(filename or '')[1]}"
        self.objects[key] = file_obj.read()
        return key

    def delete_file(self, key, *, raise_errors=False):
        if key in self.fail_delete:
            raise RuntimeError("s3 down")
        self.deleted.append(key)
        self.objects.pop(key, None)


@pytest.fixture
def local(monkeypatch, tmp_path):
    """Local-disk mode: no bucket, uploads under tmp_path."""
    monkeypatch.setattr(settings, "AWS_S3_BUCKET", "")
    monkeypatch.setattr(settings, "FILE_UPLOAD_DIR", str(tmp_path))
    return tmp_path


@pytest.fixture
def s3(monkeypatch, tmp_path):
    fake = FakeS3()
    monkeypatch.setattr(settings, "AWS_S3_BUCKET", "bucket")
    monkeypatch.setattr(settings, "FILE_UPLOAD_DIR", str(tmp_path))
    monkeypatch.setattr(document_storage, "get_s3_service", lambda: fake)
    return fake


def upload(name="a.pdf", data=b"%PDF") -> UploadFile:
    return UploadFile(filename=name, file=io.BytesIO(data))


async def count_docs(db) -> int:
    return (await db.execute(select(func.count(Document.id)))).scalar()


# ── upload ───────────────────────────────────────────────────────────────────

async def test_upload_several_files_to_local_disk(test_db, local):
    stored = await DocumentStorageService(test_db).upload([upload("a.pdf"), upload("b.png", b"P")], prefix="mod/7")
    assert [s.original_name for s in stored] == ["a.pdf", "b.png"]
    for s in stored:
        assert s.path.startswith("mod/7/") and (local / s.path).is_file()
    assert DocumentStorageService.url(stored[0].path) == f"/uploads/{stored[0].path}"


async def test_upload_to_s3_uses_s3service_keys(test_db, s3):
    stored = await DocumentStorageService(test_db).upload([upload("a.pdf")], prefix="mod/7")
    assert stored == [StoredFile("mod/7/k0.pdf", "a.pdf")] and "mod/7/k0.pdf" in s3.objects


async def test_invalid_file_midway_removes_files_already_stored(test_db, local):
    with pytest.raises(HTTPException) as err:
        await DocumentStorageService(test_db).upload([upload("a.pdf"), upload("evil.exe")], prefix="mod")
    assert err.value.status_code == 400
    assert not any(p.is_file() for p in local.rglob("*"))


async def test_oversized_file_is_rejected_before_storing(test_db, local, monkeypatch):
    monkeypatch.setattr(document_storage, "MAX_SIZE_MB", 0)
    with pytest.raises(HTTPException):
        await DocumentStorageService(test_db).upload([upload()], prefix="mod")
    assert not any(p.is_file() for p in local.rglob("*"))


async def test_cancelled_upload_removes_files_already_stored(test_db, local, monkeypatch):
    real = document_storage._store_file
    calls = {"n": 0}

    async def cancel_second(file, prefix):
        calls["n"] += 1
        if calls["n"] == 2:
            raise asyncio.CancelledError()
        return await real(file, prefix)

    monkeypatch.setattr(document_storage, "_store_file", cancel_second)
    with pytest.raises(asyncio.CancelledError):
        await DocumentStorageService(test_db).upload([upload("a.pdf"), upload("b.pdf")], prefix="mod")
    assert not any(p.is_file() for p in local.rglob("*"))


async def test_failed_compensation_is_logged_and_never_raises(test_db, s3, caplog):
    s3.fail_delete = {"mod/x.pdf", "mod/y.pdf"}
    with caplog.at_level(logging.ERROR, logger=document_storage.logger.name):
        await DocumentStorageService(test_db).discard(["mod/x.pdf", "mod/ok.pdf", "mod/y.pdf"])
    errors = [r.getMessage() for r in caplog.records if r.levelno == logging.ERROR]
    assert len(errors) == 2 and "path=mod/x.pdf" in errors[0] and "s3 down" in errors[0]
    assert s3.deleted == ["mod/ok.pdf"]  # the others were still tried


# ── rows: no commit, scoped deletes, shared paths ────────────────────────────

async def test_rows_are_flushed_never_committed(test_db, monkeypatch):
    storage = DocumentStorageService(test_db)

    async def no_commit():
        raise AssertionError("the storage service must not commit")

    monkeypatch.setattr(test_db, "commit", no_commit)
    docs = await storage.add_documents([StoredFile("m/1.pdf", "1.pdf"), StoredFile("m/2.pdf", "2.pdf")],
                                       entity_type="mod", entity_id=1, context_key="c")
    assert all(d.id for d in docs) and docs[0].file_name == "1.pdf" and docs[0].context_key == "c"
    await storage.delete_documents(docs[:1], owners={("mod", 1)})
    monkeypatch.undo()
    await test_db.rollback()  # the caller decides: nothing was saved
    assert await count_docs(test_db) == 0


async def test_delete_is_limited_to_the_requesting_owner(test_db):
    storage = DocumentStorageService(test_db)
    mine = await storage.add_documents([StoredFile("m/1.pdf", "1")], entity_type="mod", entity_id=1)
    other = await storage.add_documents([StoredFile("m/2.pdf", "2")], entity_type="mod", entity_id=2)
    foreign = await storage.add_documents([StoredFile("m/3.pdf", "3")], entity_type="other", entity_id=1)
    for docs in (other, foreign, mine + other):
        with pytest.raises(ValueError):
            await storage.delete_documents(docs, owners={("mod", 1)})
    assert await count_docs(test_db) == 3  # nothing deleted
    assert await storage.delete_documents(mine, owners={("mod", 1)}) == ["m/1.pdf"]
    assert await count_docs(test_db) == 2


async def test_path_still_referenced_by_another_row_is_not_returned(test_db):
    storage = DocumentStorageService(test_db)
    a = await storage.add_documents([StoredFile("m/shared.pdf", "s"), StoredFile("m/own.pdf", "o")],
                                    entity_type="mod", entity_id=1)
    await storage.add_documents([StoredFile("m/shared.pdf", "s")], entity_type="mod", entity_id=2)
    assert await storage.delete_documents(a, owners={("mod", 1)}) == ["m/own.pdf"]


# ── remove_files: where a stored path lives ──────────────────────────────────

async def test_remove_files_tries_every_path_and_reports_failures(test_db, s3):
    s3.fail_delete = {"m/2.pdf"}
    failures = await DocumentStorageService(test_db).remove_files(["m/1.pdf", "m/2.pdf", "m/3.pdf"])
    assert [p for p, _ in failures] == ["m/2.pdf"] and "s3 down" in failures[0][1]
    assert s3.deleted == ["m/1.pdf", "m/3.pdf"]


async def test_remove_s3_file(test_db, s3):
    s3.objects["projects/1/k.pdf"] = b"x"
    assert await DocumentStorageService(test_db).remove_files(["projects/1/k.pdf"]) == []
    assert s3.deleted == ["projects/1/k.pdf"] and not s3.objects


async def test_remove_local_file(test_db, local):
    stored = await DocumentStorageService(test_db).upload([upload()], prefix="mod")
    assert await DocumentStorageService(test_db).remove_files([stored[0].path]) == []
    assert not (local / stored[0].path).exists()


async def test_existing_local_file_wins_over_s3_even_with_a_bucket(test_db, s3):
    root = settings.FILE_UPLOAD_DIR
    os.makedirs(os.path.join(root, "dev"), exist_ok=True)
    open(os.path.join(root, "dev", "a.pdf"), "wb").close()
    assert await DocumentStorageService(test_db).remove_files(["dev/a.pdf", "/uploads/dev/missing.pdf"]) == []
    assert not os.path.exists(os.path.join(root, "dev", "a.pdf"))
    assert s3.deleted == []  # a local-only path is never sent to S3


async def test_missing_local_file_is_a_no_op_and_never_an_s3_key(test_db, local, monkeypatch):
    called = []
    monkeypatch.setattr(document_storage, "get_s3_service", lambda: called.append(1))
    assert await DocumentStorageService(test_db).remove_files(
        ["mod/gone.pdf", "/uploads/mod/gone.pdf", "/abs/gone.pdf"]) == []
    assert called == []


async def test_one_failure_does_not_stop_the_other_files(test_db, s3):
    root = settings.FILE_UPLOAD_DIR
    os.makedirs(os.path.join(root, "dev"), exist_ok=True)
    open(os.path.join(root, "dev", "local.pdf"), "wb").close()
    s3.fail_delete = {"m/2.pdf"}
    failures = await DocumentStorageService(test_db).remove_files(
        ["m/1.pdf", "m/2.pdf", "dev/local.pdf", "m/3.pdf"])
    assert [p for p, _ in failures] == ["m/2.pdf"] and "s3 down" in failures[0][1]
    assert s3.deleted == ["m/1.pdf", "m/3.pdf"]
    assert not os.path.exists(os.path.join(root, "dev", "local.pdf"))


async def test_paths_outside_uploads_are_refused(test_db, s3, tmp_path_factory):
    outside = tmp_path_factory.mktemp("outside") / "keep.txt"
    outside.write_text("x")
    relative = os.path.relpath(outside, settings.FILE_UPLOAD_DIR).replace(os.sep, "/")
    failures = await DocumentStorageService(test_db).remove_files([relative, "a/../../keep.txt", "m/ok.pdf"])
    assert [p for p, _ in failures] == [relative, "a/../../keep.txt"]
    assert all("outside the uploads directory" in reason for _, reason in failures)
    assert outside.is_file() and s3.deleted == ["m/ok.pdf"]


def test_upload_rules_match_task_attachments():
    """Until tasks move onto this service, both must enforce the same rules."""
    from backend.api.v1.endpoints import tasks
    assert document_storage.ALLOWED_EXTENSIONS == frozenset(tasks.ALLOWED_ATTACHMENT_EXTENSIONS)
    assert document_storage.MAX_SIZE_MB == tasks.MAX_ATTACHMENT_SIZE_MB
