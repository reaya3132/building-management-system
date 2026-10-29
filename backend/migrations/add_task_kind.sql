-- Stage 1 of the collection-tasks module: add tasks.task_kind.
--
-- Rationale: collection (גבייה) tasks will share the tasks table and are told
-- apart by task_kind ('general' | 'collection'). The regular task code now reads
-- this column and filters on task_kind = 'general', so it must exist before that
-- code is deployed. init_db.py carries the same statement as a startup safety net.
--
-- Backfill: the DEFAULT gives every existing row 'general' (on PostgreSQL 11+ this
-- is a metadata-only change, no table rewrite), so existing tasks are unaffected.
--
-- The CHECK constraint and the index on task_kind belong to stage 2 and are NOT
-- part of this file. Safe to re-run (IF NOT EXISTS).

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_kind VARCHAR(32) NOT NULL DEFAULT 'general';
