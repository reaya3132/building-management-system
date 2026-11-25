-- Collection tasks: VAT (מע״מ) per amount.
--
-- Adds, without touching any existing row:
--   collection_task_details: initial_vat_included (boolean), initial_vat_rate (numeric(5,4))
--                            + ck_ctd_initial_vat, ck_ctd_initial_vat_rate;
--   ledger_items:            vat_included (boolean), vat_rate (numeric(5,4))
--                            + ck_li_vat, ck_li_vat_rate.
-- All four columns are NULLable with NO default: every existing row stays NULL, which
-- means "saved before VAT support" — its amount is the amount to pay, so no total
-- changes. ck_li_vat keeps the columns NULL on every legal proceeding's item.
-- Collection amount adjustments are unchanged (they never carry VAT).
--
-- Definitions mirror backend/models/collection_task.py and backend/models/ledger_item.py
-- (enforced by backend/tests/test_legal_migration_sync.py and the PostgreSQL tests).
--
-- Safe to re-run. Requires ledger_items (upgrade_ledger_items_and_legal_fields.sql).
--
-- DEPLOY ORDER (mandatory): run this file BEFORE starting the code that reads the new
-- columns (create_all at startup never adds columns to an existing table):
--   stop the backend -> back up -> run this file -> set VAT_RATE -> start the new code.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/migrations/collection_vat.sql
-- Undo: rollback_collection_vat.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
    IF to_regclass('public.collection_task_details') IS NULL OR to_regclass('public.ledger_items') IS NULL THEN
        RAISE EXCEPTION 'collection_task_details / ledger_items not found: run add_collection_tasks.sql and upgrade_ledger_items_and_legal_fields.sql first. Nothing was changed.';
    END IF;
END $$;

ALTER TABLE collection_task_details
    ADD COLUMN IF NOT EXISTS initial_vat_included boolean,
    ADD COLUMN IF NOT EXISTS initial_vat_rate numeric(5,4);

ALTER TABLE collection_task_details DROP CONSTRAINT IF EXISTS ck_ctd_initial_vat;
ALTER TABLE collection_task_details
    ADD CONSTRAINT ck_ctd_initial_vat CHECK ((initial_vat_included IS NULL AND initial_vat_rate IS NULL) OR (collection_type = 'single' AND initial_vat_included IS NOT NULL AND initial_vat_rate IS NOT NULL));
ALTER TABLE collection_task_details DROP CONSTRAINT IF EXISTS ck_ctd_initial_vat_rate;
ALTER TABLE collection_task_details
    ADD CONSTRAINT ck_ctd_initial_vat_rate CHECK (initial_vat_rate IS NULL OR (initial_vat_rate >= 0 AND initial_vat_rate < 1));

ALTER TABLE ledger_items
    ADD COLUMN IF NOT EXISTS vat_included boolean,
    ADD COLUMN IF NOT EXISTS vat_rate numeric(5,4);

ALTER TABLE ledger_items DROP CONSTRAINT IF EXISTS ck_li_vat;
ALTER TABLE ledger_items
    ADD CONSTRAINT ck_li_vat CHECK ((vat_included IS NULL AND vat_rate IS NULL) OR (task_id IS NOT NULL AND vat_included IS NOT NULL AND vat_rate IS NOT NULL));
ALTER TABLE ledger_items DROP CONSTRAINT IF EXISTS ck_li_vat_rate;
ALTER TABLE ledger_items
    ADD CONSTRAINT ck_li_vat_rate CHECK (vat_rate IS NULL OR (vat_rate >= 0 AND vat_rate < 1));

COMMIT;
