-- Undo of collection_vat.sql: drops the VAT columns and constraints of
-- collection_task_details and ledger_items.
--
-- It never changes an amount to pay: if any amount was saved WITHOUT VAT
-- (initial_vat_included = false or vat_included = false), dropping the columns would
-- make it count without its VAT, so the file stops and changes nothing. Amounts saved
-- with VAT included lose only their frozen VAT facts (their amount to pay is unchanged).
-- Run it together with code that no longer reads the VAT columns.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/migrations/rollback_collection_vat.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
    n_details bigint := 0;
    n_items bigint := 0;
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
               AND table_name = 'collection_task_details' AND column_name = 'initial_vat_included') THEN
        EXECUTE 'SELECT count(*) FROM public.collection_task_details WHERE initial_vat_included IS FALSE' INTO n_details;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
               AND table_name = 'ledger_items' AND column_name = 'vat_included') THEN
        EXECUTE 'SELECT count(*) FROM public.ledger_items WHERE vat_included IS FALSE' INTO n_items;
    END IF;
    IF n_details > 0 OR n_items > 0 THEN
        RAISE EXCEPTION 'rollback aborted: % initial amount(s) and % ledger item(s) were saved without VAT; dropping the VAT columns would change their amount to pay. Nothing was changed.', n_details, n_items;
    END IF;
END $$;

ALTER TABLE collection_task_details DROP CONSTRAINT IF EXISTS ck_ctd_initial_vat;
ALTER TABLE collection_task_details DROP CONSTRAINT IF EXISTS ck_ctd_initial_vat_rate;
ALTER TABLE collection_task_details
    DROP COLUMN IF EXISTS initial_vat_included,
    DROP COLUMN IF EXISTS initial_vat_rate;

ALTER TABLE ledger_items DROP CONSTRAINT IF EXISTS ck_li_vat;
ALTER TABLE ledger_items DROP CONSTRAINT IF EXISTS ck_li_vat_rate;
ALTER TABLE ledger_items
    DROP COLUMN IF EXISTS vat_included,
    DROP COLUMN IF EXISTS vat_rate;

COMMIT;
