-- Undo of add_legal_stage_tenants_committee_approval.sql: removes the stage rows of
-- tenants_committee_approval. DATA ONLY.
--
-- Run it together with code that no longer defines the stage. It never removes
-- work done in the stage: if any proceeding has a non-pending status, a note /
-- record, or a document on this stage, the file stops and changes nothing.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/migrations/rollback_legal_stage_tenants_committee_approval.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
    resolved bigint;
    entries bigint;
    docs bigint;
    removed bigint;
BEGIN
    IF to_regclass('public.legal_proceeding_stages') IS NULL THEN
        RAISE NOTICE 'legal_proceeding_stages does not exist; nothing to do';
        RETURN;
    END IF;

    SELECT count(*) INTO resolved FROM public.legal_proceeding_stages
     WHERE stage_key = 'tenants_committee_approval' AND status <> 'pending';
    SELECT count(*) INTO entries FROM public.legal_proceeding_entries
     WHERE stage_key = 'tenants_committee_approval';
    SELECT count(*) INTO docs FROM public.documents
     WHERE entity_type = 'legal_proceeding' AND context_key LIKE 'tenants\_committee\_approval.%';
    IF resolved > 0 OR entries > 0 OR docs > 0 THEN
        RAISE EXCEPTION 'tenants_committee_approval is in use (resolved stages=%, entries=%, documents=%). Nothing was changed.',
            resolved, entries, docs;
    END IF;

    DELETE FROM public.legal_proceeding_stages WHERE stage_key = 'tenants_committee_approval';
    GET DIAGNOSTICS removed = ROW_COUNT;
    RAISE NOTICE 'tenants_committee_approval: % stage row(s) removed', removed;
END $$;

COMMIT;
