-- Undo of collection_adjustments_vat.sql: drops the VAT columns and constraints of
-- collection_amount_adjustments (collection_vat.sql is not touched).
--
-- It never changes an amount to pay: if any adjustment was saved WITHOUT VAT
-- (vat_included = false), dropping the columns would make it count without its VAT,
-- so the file stops and changes nothing. Adjustments saved with VAT included lose only
-- their frozen VAT facts (their amount to pay is unchanged).
-- Run it together with code that no longer reads these columns.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/migrations/rollback_collection_adjustments_vat.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
    n_adjustments bigint := 0;
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
               AND table_name = 'collection_amount_adjustments' AND column_name = 'vat_included') THEN
        EXECUTE 'SELECT count(*) FROM public.collection_amount_adjustments WHERE vat_included IS FALSE' INTO n_adjustments;
    END IF;
    IF n_adjustments > 0 THEN
        RAISE EXCEPTION 'rollback aborted: % adjustment(s) were saved without VAT; dropping the VAT columns would change their amount to pay. Nothing was changed.', n_adjustments;
    END IF;
END $$;

ALTER TABLE collection_amount_adjustments DROP CONSTRAINT IF EXISTS ck_caa_vat;
ALTER TABLE collection_amount_adjustments DROP CONSTRAINT IF EXISTS ck_caa_vat_rate;
ALTER TABLE collection_amount_adjustments
    DROP COLUMN IF EXISTS vat_included,
    DROP COLUMN IF EXISTS vat_rate;

COMMIT;
