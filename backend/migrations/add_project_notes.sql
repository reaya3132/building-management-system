-- Project documentation boards (תיעוד הפרויקט): one table for both boards.
--
-- What this does (additive only — no existing table or row is changed):
--   project_notes  one row per note; ``board`` = 'general' (project documentation)
--                  or 'fund' (fund documentation). Notes belong to the project,
--                  not to the fund, so they survive a fund being deleted.
--   The index is created on the NEW, empty table, so a plain CREATE INDEX does
--   not block anything.
--
-- History (create / edit / delete with a full snapshot) goes to the existing
-- audit_logs table (entity = 'project_note') and uses its existing
-- ix_audit_logs_entity_entity_id_created_at index — no change needed there.
--
-- Run (single transaction, stops on first error, safe to re-run):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/migrations/add_project_notes.sql

BEGIN;

CREATE TABLE IF NOT EXISTS project_notes (
    id                  SERIAL PRIMARY KEY,
    project_id          INTEGER      NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    board               VARCHAR(16)  NOT NULL,
    title               VARCHAR(255) NOT NULL,
    content             TEXT         NOT NULL,
    created_by_user_id  INTEGER      NOT NULL REFERENCES users(id),
    created_at          TIMESTAMP    NOT NULL,
    updated_by_user_id  INTEGER      REFERENCES users(id),
    updated_at          TIMESTAMP,
    CONSTRAINT ck_project_notes_board CHECK (board IN ('general', 'fund'))
);

-- One board of one project, newest first (ids rise with creation time), also
-- serving the keyset pagination ``id < :before_id``.
CREATE INDEX IF NOT EXISTS ix_project_notes_project_board_id
    ON project_notes (project_id, board, id);

COMMIT;
