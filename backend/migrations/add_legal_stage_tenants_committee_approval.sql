-- Legal proceedings: the stage "אישור נציגות דיירים" (tenants_committee_approval),
-- added between stage 1 and stage 2 in backend/configurations/legal/stages.py.
--
-- DATA ONLY — no table, column, constraint or index changes. A proceeding gets one
-- legal_proceeding_stages row per stage when it is opened; this adds the new
-- stage's row ('pending') to every proceeding opened before it existed. Stage
-- order is not stored in the DB (it is the position in STAGES), so no other row
-- changes. New proceedings get the row from the application itself.
--
-- Safe to re-run: existing rows are left as they are (ON CONFLICT DO NOTHING on
-- uq_lps_proceeding_stage); a second run adds nothing.
--
-- DEPLOY ORDER: run together with the code that defines the stage (same window).
-- The previous code ignores the row for display but counts it in progress.
--
-- Run (single transaction, stops on first error):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/migrations/add_legal_stage_tenants_committee_approval.sql
-- Undo: rollback_legal_stage_tenants_committee_approval.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
    added bigint;
    proceedings bigint;
BEGIN
    IF to_regclass('public.legal_proceeding_stages') IS NULL OR to_regclass('public.legal_proceedings') IS NULL THEN
        RAISE EXCEPTION 'The legal proceedings tables are missing: run add_legal_proceedings.sql first';
    END IF;

    INSERT INTO public.legal_proceeding_stages (proceeding_id, stage_key, status)
    SELECT p.id, 'tenants_committee_approval', 'pending'
      FROM public.legal_proceedings p
    ON CONFLICT (proceeding_id, stage_key) DO NOTHING;
    GET DIAGNOSTICS added = ROW_COUNT;

    SELECT count(*) INTO proceedings FROM public.legal_proceedings p
     WHERE NOT EXISTS (SELECT 1 FROM public.legal_proceeding_stages s
                        WHERE s.proceeding_id = p.id AND s.stage_key = 'tenants_committee_approval');
    IF proceedings > 0 THEN
        RAISE EXCEPTION '% proceeding(s) still have no tenants_committee_approval stage', proceedings;
    END IF;

    RAISE NOTICE 'tenants_committee_approval: % stage row(s) added', added;
END $$;

COMMIT;
