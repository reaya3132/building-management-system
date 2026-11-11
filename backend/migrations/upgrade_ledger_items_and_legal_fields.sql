-- Shared ledger table + legal proceeding fields, in one transaction:
--   collection_ledger_items -> ledger_items (every existing row is kept);
--   ledger_items: legal_proceeding_id, item_type, task_id becomes NULLable,
--                 ck_li_one_owner, ck_li_item_type, ck_li_base_not_archived, two indexes;
--   contacts:     apartment_number;
--   legal_proceedings: apartment_number and claim_amount are dropped.
--
-- Definitions mirror backend/models/ledger_item.py, contact.py and legal_proceeding.py
-- (enforced by backend/tests/test_legal_migration_sync.py).
--
-- State detection (nothing changes when the file stops):
--   only collection_ledger_items         -> upgraded;
--   only ledger_items, complete          -> nothing to do on it;
--   both, neither, or an incomplete one  -> stops.
--   legal_proceedings with the old columns must be EMPTY, or the file stops: there is
--   no transfer of proceeding data.
--
-- DEPLOY ORDER (mandatory, because the application runs create_all at startup):
--   stop the backend -> back up -> run this file -> start the new code.
-- create_all of the other version fails at startup on the shared index names
-- (ix_cli_*) and rolls back, so no empty table is left, but that backend will not start:
-- the code and this file must go together. Both tables present stops this file.
--
-- Run after add_contacts.sql, add_legal_proceedings.sql and add_collection_tasks.sql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/migrations/upgrade_ledger_items_and_legal_fields.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
    dep text;
    has_old boolean := to_regclass('public.collection_ledger_items') IS NOT NULL;
    has_new boolean := to_regclass('public.ledger_items') IS NOT NULL;
    has_apartment boolean;
    has_claim boolean;
    n_proceedings bigint;
    n_before bigint;
    n_after bigint;
    n_objects int;
BEGIN
    FOREACH dep IN ARRAY ARRAY['users', 'tasks', 'contacts', 'legal_proceedings'] LOOP
        IF to_regclass('public.' || dep) IS NULL THEN
            RAISE EXCEPTION 'Required table public.% is missing: cannot apply the upgrade', dep;
        END IF;
    END LOOP;

    IF has_old AND has_new THEN
        RAISE EXCEPTION 'Both collection_ledger_items and ledger_items exist (was the new code started before this file?). Nothing was changed.';
    END IF;
    IF NOT has_old AND NOT has_new THEN
        RAISE EXCEPTION 'Neither collection_ledger_items nor ledger_items exists: run add_collection_tasks.sql first';
    END IF;

    has_apartment := EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                              AND table_name = 'legal_proceedings' AND column_name = 'apartment_number');
    has_claim := EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                          AND table_name = 'legal_proceedings' AND column_name = 'claim_amount');
    IF has_apartment <> has_claim THEN
        RAISE EXCEPTION 'legal_proceedings is in an unrecognised state: apartment_number=%, claim_amount=%. Nothing was changed.',
            has_apartment, has_claim;
    END IF;

    ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS apartment_number VARCHAR(32) NULL;

    IF has_apartment THEN
        LOCK TABLE public.legal_proceedings IN ACCESS EXCLUSIVE MODE;
        SELECT count(*) INTO n_proceedings FROM public.legal_proceedings;
        IF n_proceedings > 0 THEN
            RAISE EXCEPTION 'legal_proceedings holds % row(s); this upgrade drops apartment_number and claim_amount and does not transfer them. Nothing was changed.',
                n_proceedings;
        END IF;
        ALTER TABLE public.legal_proceedings DROP COLUMN apartment_number, DROP COLUMN claim_amount;
    END IF;

    IF has_new THEN
        SELECT count(*) INTO n_objects FROM pg_constraint WHERE conrelid = 'public.ledger_items'::regclass
           AND conname IN ('ck_cli_amount_positive', 'ck_li_one_owner', 'ck_li_item_type', 'ck_li_base_not_archived');
        IF n_objects <> 4 OR to_regclass('public.ix_li_legal_proceeding_id') IS NULL
           OR to_regclass('public.ix_li_legal_proceeding_active') IS NULL THEN
            RAISE EXCEPTION 'ledger_items exists without the expected constraints or indexes. Nothing was changed.';
        END IF;
        RAISE NOTICE 'ledger_items: current; nothing to do';
        RETURN;
    END IF;

    LOCK TABLE public.collection_ledger_items IN ACCESS EXCLUSIVE MODE;
    SELECT count(*) INTO n_before FROM public.collection_ledger_items;

    ALTER TABLE public.collection_ledger_items RENAME TO ledger_items;
    ALTER TABLE public.ledger_items
        ALTER COLUMN task_id DROP NOT NULL,
        ADD COLUMN legal_proceeding_id INTEGER NULL,
        ADD COLUMN item_type VARCHAR(20) NULL,
        ADD FOREIGN KEY (legal_proceeding_id) REFERENCES public.legal_proceedings (id) ON DELETE RESTRICT,
        ADD CONSTRAINT ck_li_one_owner CHECK (
            (task_id IS NOT NULL AND legal_proceeding_id IS NULL)
            OR (task_id IS NULL AND legal_proceeding_id IS NOT NULL)),
        ADD CONSTRAINT ck_li_item_type CHECK (
            (task_id IS NOT NULL AND item_type IS NULL)
            OR (legal_proceeding_id IS NOT NULL AND item_type IS NOT NULL AND item_type IN ('base_amount', 'addition'))),
        ADD CONSTRAINT ck_li_base_not_archived CHECK (
            item_type IS NULL OR item_type <> 'base_amount' OR archived_at IS NULL);
    CREATE INDEX ix_li_legal_proceeding_id ON public.ledger_items (legal_proceeding_id);
    CREATE INDEX ix_li_legal_proceeding_active ON public.ledger_items (legal_proceeding_id) WHERE archived_at IS NULL;

    SELECT count(*) INTO n_after FROM public.ledger_items;
    IF n_after <> n_before THEN
        RAISE EXCEPTION 'ledger_items holds % row(s) after the rename, expected %', n_after, n_before;
    END IF;
    RAISE NOTICE 'ledger_items: upgraded; % existing row(s) kept', n_after;
END $$;

COMMIT;
