# Known issues: document and file storage

Found during the document storage review (November 2026). **Not fixed.** The
shared `backend/services/document_storage.py` (`DocumentStorageService`) was
introduced and is currently used only by the legal proceedings module. The
modules below keep their own upload / delete code until they are moved onto it.

Severity: **real** = happens with today's code and data; **limited** = real but
low impact; **theoretical** = no current code path triggers it.

## Real

### 1. `S3Service.copy_file` is not a method
`backend/services/s3_service.py`: `copy_file` is defined at module level (no
indentation), so `S3Service().copy_file(...)` raises `AttributeError`. Callers also
pass `source_url=`, while the signature is `source_key=`.
- Broken: attaching a draft document to a transaction
  (`transactions.py` `/documents/from-draft`) and to an unforeseen-transaction line
  (`unforeseen_transactions.py` `.../document/from-draft`).
- Fix: indent it into the class; accept a key (and map legacy URLs to a key).

### 2. Delete code still expects full S3 URLs
Since commit `cd07a40`, `S3Service.upload_file` returns a plain key
(`transactions/<uuid>.pdf`), but delete code still detects S3 by the path:
- `"s3" in path` / `"amazonaws.com" in path`: `transactions.py`
  (`delete_transaction_document`), `projects.py` (`delete_project_document`),
  `apartment_shared_document_service.py` and `document_service.py`
  (`_looks_like_s3_url`);
- `startswith("http")`: `tasks.py` (`_delete_stored_file`), `cems_documents.py`
  (delete), `cems_photo_storage.py` (replacing a photo).
- Effect: for every file uploaded since then, the S3 object is **never deleted**,
  so orphaned objects build up.
- Likely related (to confirm with a test): `cems_documents.py` download serves a
  non-http path from local disk, so an S3-key document may return 404 instead of
  redirecting to a signed URL.
- Fix: move these modules onto `DocumentStorageService.remove_files`, which
  recognises local paths and current S3 keys. (The `documents` table was checked
  in November 2026 and holds no legacy full AWS URLs, so the service doesn't
  support them.)

### 3. Uploaded file without a DB row
Every module except legal uploads first and then saves the row
(`DocumentRepository.create`, `BaseRepository.create`, `db.commit()`), without
compensation. If saving the row fails, the file stays in S3. Impact: an orphaned
file, no data corruption.

### 4. Repository commits inside a larger operation
`DocumentRepository.create/update/delete` and `BaseRepository.create/update/delete`
commit on their own, which also saves any other pending change in the session.
- Concrete case: `ApartmentSharedDocumentService.delete_all_for_apartment` deletes
  and commits per document, and removes the S3 file, while the apartment itself is
  being deleted (`apartment_service.py`). If the apartment delete then fails, its
  documents are already gone (rows and files).

### 5. `DocumentService` (transactions) is dead code that would crash
`backend/services/document_service.py` calls `insert_document`, `update_document`
and `delete_document`, which do not exist on `DocumentRepository`. Nothing imports
the class today.

## Limited

### 6. Storage delete failures are swallowed
Most modules delete the row, commit, then remove the file (the right order) but
swallow the error with `pass` or a warning, with no record. Orphans can't be
found later. (Legal records them in `audit_logs` and has a cleanup script.)

### 7. Multi-file task-message uploads
Task-message attachments upload several files in one request; I didn't check
whether files already stored are removed when a later one fails.

### 8. Duplicated upload rules
`tasks.py` (`ALLOWED_ATTACHMENT_EXTENSIONS`, `MAX_ATTACHMENT_SIZE_MB`, the disk
fallback) and `document_storage.py` each define the rules.
`tests/test_document_storage_service.py::test_upload_rules_match_task_attachments`
fails if they diverge. Remove the tasks copy when tasks moves onto the service.

### 9. Synchronous S3 calls on the event loop
`projects.py` (document / image / contract upload), `users.py` (avatar) and
`cems_photo_storage.py` call boto3 directly from async endpoints, which blocks the
event loop for the duration of the upload.

## Theoretical

### 10. One file shared by several rows
Every upload and copy creates a new uuid key, so no file is referenced twice
today. `DocumentStorageService.delete_documents` already skips paths still in use.

### 11. A row whose file doesn't exist
Not possible with the current order (upload before row). Only manual data
changes could cause it.

## Suggested migration order
1. Fix #1 (small, isolated).
2. Move shared apartment documents and transaction documents onto
   `DocumentStorageService` (fixes #2–#4 for them).
3. Then projects, unforeseen transactions, personal area, tasks (#8), CEMS.
4. Remove `DocumentService` (#5).
