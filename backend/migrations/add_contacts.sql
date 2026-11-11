-- General contacts table (אנשי קשר). System-wide: not owned by any feature module,
-- and never marked or dropped by a module's migration or rollback.
--
-- Detects the state of public.contacts and acts accordingly, in one transaction:
--   missing              -> created in the current structure;
--   previous structure   -> phone becomes NOT NULL, ck_contacts_phone and
--                           ix_contacts_phone_2 are added, after checking the data;
--                           no row is changed and the file stops if any contact has
--                           no phone;
--   without apartment_number -> the column is added (nullable, no row changes);
--   current structure    -> nothing is changed;
--   anything else        -> stops without changing anything.
-- The definition mirrors backend/models/contact.py and the expected definition used
-- by the final schema comparison of add_legal_proceedings.sql (both enforced by
-- backend/tests/test_legal_migration_sync.py).
--
-- Run BEFORE add_legal_proceedings.sql (single transaction, safe to re-run):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/migrations/add_contacts.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
    phone_nullable boolean;
    has_ck_phone boolean;
    has_ix_phone_2 boolean;
    n_no_phone bigint;
    has_apartment boolean;
BEGIN
    IF to_regclass('public.users') IS NULL THEN
        RAISE EXCEPTION 'Required table public.users is missing: cannot apply the contacts migration';
    END IF;

    IF to_regclass('public.contacts') IS NULL THEN
        RAISE NOTICE 'Contacts state: absent; creating the table';
        CREATE TABLE IF NOT EXISTS contacts (
        id          SERIAL        NOT NULL,
        kind        VARCHAR(20)   NOT NULL,
        name        VARCHAR(255)  NOT NULL,
        email       VARCHAR(255)  NULL,
        phone       VARCHAR(50)   NOT NULL,
        phone_2     VARCHAR(50)   NULL,
        address     VARCHAR(500)  NULL,
        apartment_number VARCHAR(32) NULL,
        notes       TEXT          NULL,
        is_active   BOOLEAN       NOT NULL DEFAULT true,
        created_by  INTEGER       NULL,
        created_at  TIMESTAMP     NOT NULL,
        updated_at  TIMESTAMP     NULL,
        PRIMARY KEY (id),
        FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
        CONSTRAINT ck_contacts_kind CHECK (kind IN ('person', 'business')),
        CONSTRAINT ck_contacts_name CHECK (trim(name) <> ''),
        CONSTRAINT ck_contacts_phone CHECK (trim(phone) <> '')
    );
    CREATE INDEX IF NOT EXISTS ix_contacts_name ON contacts (name);
    CREATE INDEX IF NOT EXISTS ix_contacts_phone ON contacts (phone);
    CREATE INDEX IF NOT EXISTS ix_contacts_phone_2 ON contacts (phone_2);
    CREATE INDEX IF NOT EXISTS ix_contacts_email ON contacts (email);
        RETURN;
    END IF;

    SELECT is_nullable = 'YES' INTO phone_nullable FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'contacts' AND column_name = 'phone';
    has_ck_phone := EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.contacts'::regclass
                             AND conname = 'ck_contacts_phone');
    has_ix_phone_2 := to_regclass('public.ix_contacts_phone_2') IS NOT NULL;
    has_apartment := EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                              AND table_name = 'contacts' AND column_name = 'apartment_number');

    IF phone_nullable IS FALSE AND has_ck_phone AND has_ix_phone_2 THEN
        IF has_apartment THEN
            RAISE NOTICE 'Contacts state: current; nothing to do';
        ELSE
            RAISE NOTICE 'Contacts state: without apartment_number; adding it';
            ALTER TABLE public.contacts ADD COLUMN apartment_number VARCHAR(32) NULL;
        END IF;
        RETURN;
    END IF;
    IF phone_nullable IS NOT TRUE OR has_ck_phone OR has_ix_phone_2 THEN
        RAISE EXCEPTION 'public.contacts is in an unrecognised state: phone_nullable=%, ck_contacts_phone=%, ix_contacts_phone_2=%. Nothing was changed.',
            coalesce(phone_nullable::text, 'column missing'), has_ck_phone, has_ix_phone_2;
    END IF;

    LOCK TABLE public.contacts IN ACCESS EXCLUSIVE MODE;
    SELECT count(*) INTO n_no_phone FROM public.contacts WHERE phone IS NULL OR trim(phone) = '';
    IF n_no_phone > 0 THEN
        RAISE EXCEPTION 'Cannot apply contacts.phone NOT NULL: contacts without a phone=%. Complete the data first; nothing was changed.',
            n_no_phone;
    END IF;

    RAISE NOTICE 'Contacts state: previous; upgrading';
    ALTER TABLE public.contacts
        ALTER COLUMN phone SET NOT NULL,
        ADD CONSTRAINT ck_contacts_phone CHECK (trim(phone) <> '');
    CREATE INDEX ix_contacts_phone_2 ON public.contacts (phone_2);
    IF NOT has_apartment THEN
        ALTER TABLE public.contacts ADD COLUMN apartment_number VARCHAR(32) NULL;
    END IF;
END $$;

COMMIT;
