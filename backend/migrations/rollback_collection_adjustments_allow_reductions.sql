-- Undo of collection_adjustments_allow_reductions.sql: restores
-- ck_caa_amount_positive (amount > 0).
--
-- It never removes data: if any reduction (amount < 0) exists, the file stops
-- and changes nothing. Run it together with code that no longer sends reductions.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/migrations/rollback_collection_adjustments_allow_reductions.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
    reductions bigint;
BEGIN
    SELECT count(*) INTO reductions FROM collection_amount_adjustments WHERE amount < 0;
    IF reductions > 0 THEN
        RAISE EXCEPTION 'rollback aborted: % reduction row(s) exist in collection_amount_adjustments', reductions;
    END IF;
END $$;

ALTER TABLE collection_amount_adjustments DROP CONSTRAINT IF EXISTS ck_caa_amount_nonzero;
ALTER TABLE collection_amount_adjustments DROP CONSTRAINT IF EXISTS ck_caa_amount_positive;
ALTER TABLE collection_amount_adjustments
    ADD CONSTRAINT ck_caa_amount_positive CHECK (amount > 0);

COMMIT;
