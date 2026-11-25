-- Collection tasks ('single'): VAT (מע״מ) per amount adjustment.
--
-- Adds, without touching any existing row:
--   collection_amount_adjustments: vat_included (boolean), vat_rate (numeric(5,4))
--                                  + ck_caa_vat, ck_caa_vat_rate.
-- Both columns are NULLable with NO default: every existing adjustment stays NULL,
-- which means "saved before VAT support" — its amount counts exactly as stored, so no
-- total changes.
--
-- A separate file from collection_vat.sql (already applied): run it AFTER that one.
-- Definitions mirror backend/models/collection_task.py
-- (enforced by backend/tests/test_legal_migration_sync.py and the PostgreSQL tests).
--
-- Safe to re-run.
--
-- DEPLOY ORDER (mandatory): run this file BEFORE starting the code that reads the new
-- columns (create_all at startup never adds columns to an existing table):
--   stop the backend -> back up -> run this file -> start the new code.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/migrations/collection_adjustments_vat.sql
-- Undo: rollback_collection_adjustments_vat.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
    IF to_regclass('public.collection_amount_adjustments') IS NULL THEN
        RAISE EXCEPTION 'collection_amount_adjustments not found: run add_collection_tasks.sql first. Nothing was changed.';
    END IF;
END $$;

ALTER TABLE collection_amount_adjustments
    ADD COLUMN IF NOT EXISTS vat_included boolean,
    ADD COLUMN IF NOT EXISTS vat_rate numeric(5,4);

ALTER TABLE collection_amount_adjustments DROP CONSTRAINT IF EXISTS ck_caa_vat;
ALTER TABLE collection_amount_adjustments
    ADD CONSTRAINT ck_caa_vat CHECK ((vat_included IS NULL AND vat_rate IS NULL) OR (vat_included IS NOT NULL AND vat_rate IS NOT NULL));
ALTER TABLE collection_amount_adjustments DROP CONSTRAINT IF EXISTS ck_caa_vat_rate;
ALTER TABLE collection_amount_adjustments
    ADD CONSTRAINT ck_caa_vat_rate CHECK (vat_rate IS NULL OR (vat_rate >= 0 AND vat_rate < 1));

COMMIT;
