-- Rollback of upgrade_ledger_items_and_legal_fields.sql, in one transaction.
--
-- Returns ledger_items to collection_ledger_items (collection rows are kept) and
-- restores the two legal_proceedings columns. It STOPS without changing anything when
-- it would lose data: legal ledger items, any proceeding, or any contact apartment number.
--
-- Order: stop the backend -> run this file -> start the old code. Run this before
-- rollback_legal_proceedings.sql, whose dependency check stops on the ledger_items FK.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/migrations/rollback_ledger_items_and_legal_fields.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
    n bigint;
BEGIN
    IF to_regclass('public.ledger_items') IS NULL THEN
        IF to_regclass('public.collection_ledger_items') IS NOT NULL THEN
            RAISE NOTICE 'ledger_items: already rolled back; nothing to do';
            RETURN;
        END IF;
        RAISE EXCEPTION 'Neither ledger_items nor collection_ledger_items exists. Nothing was changed.';
    END IF;
    IF to_regclass('public.collection_ledger_items') IS NOT NULL THEN
        RAISE EXCEPTION 'Both ledger_items and collection_ledger_items exist. Nothing was changed.';
    END IF;

    LOCK TABLE public.ledger_items, public.legal_proceedings, public.contacts IN ACCESS EXCLUSIVE MODE;

    SELECT count(*) INTO n FROM public.ledger_items WHERE task_id IS NULL OR legal_proceeding_id IS NOT NULL;
    IF n > 0 THEN
        RAISE EXCEPTION 'Rollback stopped: ledger_items holds % legal item(s)', n;
    END IF;
    SELECT count(*) INTO n FROM public.legal_proceedings;
    IF n > 0 THEN
        RAISE EXCEPTION 'Rollback stopped: legal_proceedings holds % row(s)', n;
    END IF;
    SELECT count(*) INTO n FROM public.contacts WHERE apartment_number IS NOT NULL;
    IF n > 0 THEN
        RAISE EXCEPTION 'Rollback stopped: % contact(s) hold an apartment number', n;
    END IF;

    DROP INDEX public.ix_li_legal_proceeding_active;
    DROP INDEX public.ix_li_legal_proceeding_id;
    ALTER TABLE public.ledger_items
        DROP CONSTRAINT ck_li_one_owner,
        DROP CONSTRAINT ck_li_item_type,
        DROP CONSTRAINT ck_li_base_not_archived,
        DROP COLUMN legal_proceeding_id,
        DROP COLUMN item_type,
        ALTER COLUMN task_id SET NOT NULL;
    ALTER TABLE public.ledger_items RENAME TO collection_ledger_items;

    ALTER TABLE public.legal_proceedings
        ADD COLUMN apartment_number VARCHAR(32) NOT NULL,
        ADD COLUMN claim_amount NUMERIC(14, 2) NULL,
        ADD CONSTRAINT ck_lp_apartment_number CHECK (trim(apartment_number) <> ''),
        ADD CONSTRAINT ck_lp_amount CHECK (claim_amount IS NULL OR claim_amount > 0);
    ALTER TABLE public.contacts DROP COLUMN apartment_number;
END $$;

COMMIT;
