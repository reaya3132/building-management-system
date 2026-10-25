-- Stage 2 of the collection-tasks module: tables and constraints.
--
-- Prerequisite: add_task_kind.sql (stage 1) has already added tasks.task_kind.
--
-- What this does (additive only — no existing row is changed or deleted):
--   1. ck_tasks_task_kind on tasks, added NOT VALID then VALIDATEd, so the table
--      is not locked for a full scan while the constraint is being added.
--   2. collection_task_details        1:1 with tasks (type, project, billing month,
--                                      immutable initial amount for 'single').
--   3. collection_amount_adjustments  append-only positive additions ('single').
--   4. collection_ledger_items        subject + amount lines ('ledger'), archived
--                                      instead of deleted.
--   Indexes on the three NEW tables are created here: the tables are empty, so a
--   plain CREATE INDEX does not block anything.
--
-- Indexes on the EXISTING large tables (tasks, audit_logs) need CONCURRENTLY and
-- live in add_collection_tasks_indexes_concurrently.sql — run that file AFTER this
-- one, outside a transaction.
--
-- All FKs to tasks/users/projects are ON DELETE RESTRICT: a task or user holding
-- collection financial data can never be hard-deleted.
--
-- Run (single transaction, stops on first error, safe to re-run):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/migrations/add_collection_tasks.sql

BEGIN;

-- 1. tasks.task_kind CHECK -----------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_tasks_task_kind') THEN
        ALTER TABLE tasks
            ADD CONSTRAINT ck_tasks_task_kind
            CHECK (task_kind IN ('general', 'collection')) NOT VALID;
    END IF;
END $$;

ALTER TABLE tasks VALIDATE CONSTRAINT ck_tasks_task_kind;

-- 2. collection_task_details ---------------------------------------------------
CREATE TABLE IF NOT EXISTS collection_task_details (
    task_id          INTEGER       NOT NULL,
    collection_type  VARCHAR(16)   NOT NULL,
    project_id       INTEGER       NOT NULL,
    billing_month    DATE          NOT NULL,
    initial_amount   NUMERIC(12,2) NULL,
    created_at       TIMESTAMP     NOT NULL,
    updated_at       TIMESTAMP     NOT NULL,
    CONSTRAINT collection_task_details_pkey PRIMARY KEY (task_id),
    CONSTRAINT collection_task_details_task_id_fkey
        FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE RESTRICT,
    CONSTRAINT collection_task_details_project_id_fkey
        FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
    CONSTRAINT ck_ctd_type
        CHECK (collection_type IN ('single', 'ledger')),
    CONSTRAINT ck_ctd_initial_amount
        CHECK ((collection_type = 'single' AND initial_amount IS NOT NULL AND initial_amount > 0)
            OR (collection_type = 'ledger' AND initial_amount IS NULL)),
    CONSTRAINT ck_ctd_month_first_day
        CHECK (EXTRACT(DAY FROM billing_month) = 1)
);

CREATE INDEX IF NOT EXISTS ix_ctd_billing_month_project_id ON collection_task_details (billing_month, project_id);
CREATE INDEX IF NOT EXISTS ix_ctd_billing_month ON collection_task_details (billing_month);
CREATE INDEX IF NOT EXISTS ix_ctd_project_id ON collection_task_details (project_id);

-- 3. collection_amount_adjustments ---------------------------------------------
CREATE TABLE IF NOT EXISTS collection_amount_adjustments (
    id                  SERIAL        NOT NULL,
    task_id             INTEGER       NOT NULL,
    amount              NUMERIC(12,2) NOT NULL,
    note                TEXT          NULL,
    created_by_user_id  INTEGER       NOT NULL,
    created_at          TIMESTAMP     NOT NULL,
    CONSTRAINT collection_amount_adjustments_pkey PRIMARY KEY (id),
    CONSTRAINT collection_amount_adjustments_task_id_fkey
        FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE RESTRICT,
    CONSTRAINT collection_amount_adjustments_created_by_user_id_fkey
        FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT ck_caa_amount_positive CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS ix_caa_task_id ON collection_amount_adjustments (task_id);

-- 4. collection_ledger_items ---------------------------------------------------
CREATE TABLE IF NOT EXISTS collection_ledger_items (
    id                   SERIAL        NOT NULL,
    task_id              INTEGER       NOT NULL,
    subject              VARCHAR(255)  NOT NULL,
    amount               NUMERIC(12,2) NOT NULL,
    sort_order           INTEGER       NOT NULL DEFAULT 0,
    created_by_user_id   INTEGER       NOT NULL,
    updated_by_user_id   INTEGER       NULL,
    created_at           TIMESTAMP     NOT NULL,
    updated_at           TIMESTAMP     NOT NULL,
    archived_at          TIMESTAMP     NULL,
    archived_by_user_id  INTEGER       NULL,
    CONSTRAINT collection_ledger_items_pkey PRIMARY KEY (id),
    CONSTRAINT collection_ledger_items_task_id_fkey
        FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE RESTRICT,
    CONSTRAINT collection_ledger_items_created_by_user_id_fkey
        FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT collection_ledger_items_updated_by_user_id_fkey
        FOREIGN KEY (updated_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT collection_ledger_items_archived_by_user_id_fkey
        FOREIGN KEY (archived_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT ck_cli_amount_positive CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS ix_cli_task_id ON collection_ledger_items (task_id);
CREATE INDEX IF NOT EXISTS ix_cli_task_id_active ON collection_ledger_items (task_id) WHERE archived_at IS NULL;

COMMIT;
