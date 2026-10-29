-- Stage 2 of the collection-tasks module: indexes on EXISTING large tables.
--
-- CREATE INDEX CONCURRENTLY builds the index without blocking writes, but
-- PostgreSQL refuses to run it inside a transaction block. Therefore:
--   * this file has NO BEGIN/COMMIT — each statement runs in its own autocommit;
--   * run it with psql WITHOUT -1 / --single-transaction:
--       psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/migrations/add_collection_tasks_indexes_concurrently.sql
--   * in DBeaver, Auto-Commit must be ON and each statement executed on its own
--     (Ctrl+Enter), not via "Execute script" inside a manual transaction;
--   * it is NOT in init_db.py, which runs inside a single transaction.
--
-- Run it AFTER add_collection_tasks.sql. Safe to re-run (IF NOT EXISTS).
--
-- If a CONCURRENTLY build fails midway it leaves an INVALID index behind, and
-- IF NOT EXISTS would then silently skip it. Always verify afterwards:
--
--   SELECT indexrelid::regclass AS index_name, indisvalid
--   FROM pg_index
--   WHERE indexrelid::regclass::text IN (
--       'ix_tasks_task_kind', 'ix_audit_logs_entity_entity_id_created_at');
--
-- Both rows must show indisvalid = true. If one is false:
--   DROP INDEX CONCURRENTLY IF EXISTS <index_name>;
-- and re-run this file.

CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_tasks_task_kind
    ON tasks (task_kind);

CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_audit_logs_entity_entity_id_created_at
    ON audit_logs (entity, entity_id, created_at);
