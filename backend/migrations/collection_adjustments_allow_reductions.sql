-- Collection tasks ('single'): allow reductions (negative adjustments).
--
-- Replaces ck_caa_amount_positive (amount > 0) with ck_caa_amount_nonzero
-- (amount <> 0) on collection_amount_adjustments. The rule "the total
-- (initial_amount + SUM(adjustments)) is never negative" spans tables and is
-- enforced by the application under a row lock on collection_task_details.
-- Mirrors backend/models/collection_task.py.
--
-- Safe to re-run. Every existing row (amount > 0) satisfies the new check.
--
-- DEPLOY ORDER: run together with the code that sends reductions.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/migrations/collection_adjustments_allow_reductions.sql
-- Undo: rollback_collection_adjustments_allow_reductions.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE collection_amount_adjustments DROP CONSTRAINT IF EXISTS ck_caa_amount_positive;
ALTER TABLE collection_amount_adjustments DROP CONSTRAINT IF EXISTS ck_caa_amount_nonzero;
ALTER TABLE collection_amount_adjustments
    ADD CONSTRAINT ck_caa_amount_nonzero CHECK (amount <> 0);

COMMIT;
