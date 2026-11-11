-- Rollback of the legal proceedings module schema
-- (add_legal_proceedings.sql + add_legal_proceedings_indexes_concurrently.sql).
--
-- Drops ONLY objects carrying the 'owner:add_legal_proceedings' marker, i.e. created
-- by those files — or module tables that create_all provisioned first and that the
-- migration ADOPTED after verifying they match the expected definition exactly. Any
-- marked table is dropped only after the data check and the dependency check below:
--   * the four module tables (a table without the marker is kept, with a NOTICE);
--     public.contacts is a general table and is never touched;
--   * ix_documents_entity_context;
--   * documents.context_key — only when add_legal_proceedings.sql added it. A column
--     that already existed (e.g. created by create_all on a fresh database) is kept.
-- Also removes the module's IAM rows (iam_resource_policies.resource_type =
-- 'legal_proceeding'). audit_logs history is kept.
--
-- It STOPS without changing anything when:
--   * any module table holds rows (proceedings, stages, entries, assignees);
--   * documents holds legal documents (entity_type 'legal_proceeding' / 'legal_proceeding_entry')
--     — their S3 files must be removed first (backend/scripts/legal_storage_cleanup.py);
--   * documents.context_key is marked as ours but other modules' rows use it;
--   * ix_documents_entity_context exists without the marker;
--   * an object outside the module (view, FK from another table, index/trigger on
--     documents.context_key, ...) depends on anything it would drop.
-- All checks run before the first drop, so a stop leaves the schema exactly as it was.
--
-- After upgrade_ledger_items_and_legal_fields.sql, run
-- rollback_ledger_items_and_legal_fields.sql first: ledger_items references legal_proceedings.
--
-- Deploy order: roll the CODE back first (the old code does not read context_key),
-- then run:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/migrations/rollback_legal_proceedings.sql
-- Do NOT use -1 / --single-transaction: step 2 drops the index CONCURRENTLY.

-- 1. Checks (shared by both steps) ------------------------------------------------
CREATE FUNCTION pg_temp.legal_rollback_checks() RETURNS void LANGUAGE plpgsql AS $chk$
DECLARE
    marker CONSTANT text := 'owner:add_legal_proceedings';
    t text;
    n bigint;
    col_ours boolean;
BEGIN
    FOREACH t IN ARRAY ARRAY['legal_proceeding_assignees', 'legal_proceeding_entries',
                             'legal_proceeding_stages', 'legal_proceedings'] LOOP
        IF to_regclass('public.' || t) IS NOT NULL THEN
            EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
            IF n > 0 THEN
                RAISE EXCEPTION 'Rollback stopped: public.% holds % row(s)', t, n;
            END IF;
        END IF;
    END LOOP;

    IF EXISTS (SELECT 1 FROM pg_attribute
                WHERE attrelid = 'public.documents'::regclass AND attname = 'context_key' AND NOT attisdropped) THEN
        SELECT count(*) INTO n FROM public.documents
         WHERE entity_type IN ('legal_proceeding', 'legal_proceeding_entry');
        IF n > 0 THEN
            RAISE EXCEPTION 'Rollback stopped: documents holds % legal document(s); remove them and their S3 files first', n;
        END IF;

        col_ours := coalesce(col_description('public.documents'::regclass,
                        (SELECT attnum FROM pg_attribute
                          WHERE attrelid = 'public.documents'::regclass AND attname = 'context_key')) = marker, false);
        IF col_ours THEN
            SELECT count(*) INTO n FROM public.documents WHERE context_key IS NOT NULL;
            IF n > 0 THEN
                RAISE EXCEPTION 'Rollback stopped: % non-legal document(s) use documents.context_key', n;
            END IF;
        END IF;
    END IF;

    IF to_regclass('public.ix_documents_entity_context') IS NOT NULL
       AND coalesce(obj_description(to_regclass('public.ix_documents_entity_context'), 'pg_class'), '') <> marker THEN
        RAISE EXCEPTION 'Rollback stopped: ix_documents_entity_context exists without the ownership marker';
    END IF;

    -- Objects OUTSIDE the module that depend on what this rollback would drop (a view,
    -- an FK from another table, an index / trigger on documents.context_key, ...).
    -- Checked here, before step 2 drops anything: DROP ... RESTRICT would refuse them
    -- anyway, but only after the CONCURRENTLY index drop had already happened.
    WITH owned AS (
        SELECT c.oid FROM pg_class c
         WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
           AND c.relname IN ('legal_proceedings', 'legal_proceeding_stages',
                             'legal_proceeding_entries', 'legal_proceeding_assignees')
           AND coalesce(obj_description(c.oid, 'pg_class'), '') = marker
    ), ctx AS (
        SELECT a.attrelid, a.attnum FROM pg_attribute a
         WHERE a.attrelid = 'public.documents'::regclass AND a.attname = 'context_key' AND NOT a.attisdropped
           AND coalesce(col_description(a.attrelid, a.attnum), '') = marker
    ), deps AS (
        SELECT d.classid, d.objid,
               CASE d.classid
                   WHEN 'pg_rewrite'::regclass    THEN (SELECT ev_class FROM pg_rewrite WHERE oid = d.objid)
                   WHEN 'pg_constraint'::regclass THEN (SELECT conrelid FROM pg_constraint WHERE oid = d.objid)
                   WHEN 'pg_trigger'::regclass    THEN (SELECT tgrelid FROM pg_trigger WHERE oid = d.objid)
                   WHEN 'pg_attrdef'::regclass    THEN (SELECT adrelid FROM pg_attrdef WHERE oid = d.objid)
                   WHEN 'pg_policy'::regclass     THEN (SELECT polrelid FROM pg_policy WHERE oid = d.objid)
                   -- an index belongs to its table; an OWNED BY sequence (SERIAL, deptype 'a') to the table it serves
                   WHEN 'pg_class'::regclass      THEN coalesce((SELECT indrelid FROM pg_index WHERE indexrelid = d.objid),
                                                                CASE WHEN d.deptype = 'a' THEN d.refobjid ELSE d.objid END)
               END AS owner_rel
          FROM pg_depend d
         WHERE d.refclassid = 'pg_class'::regclass AND d.deptype IN ('n', 'a')
           AND (d.refobjid IN (SELECT oid FROM owned)
                OR (d.refobjid, d.refobjsubid) IN (SELECT attrelid, attnum FROM ctx))
    )
    SELECT string_agg(DISTINCT coalesce(pg_describe_object(classid, objid, 0), objid::text), ', ') INTO t
      FROM deps
     WHERE NOT (classid = 'pg_class'::regclass AND objid = to_regclass('public.ix_documents_entity_context'))
       AND (owner_rel IS NULL OR owner_rel NOT IN (SELECT oid FROM owned))
       AND NOT (classid = 'pg_class'::regclass AND objid IN (SELECT oid FROM owned));  -- the tables themselves
    IF t IS NOT NULL THEN
        RAISE EXCEPTION 'Rollback stopped: objects outside the module depend on it: %', t;
    END IF;
END
$chk$;

SELECT pg_temp.legal_rollback_checks();

-- 2. Index (outside a transaction: CONCURRENTLY) -----------------------------------
-- Reached only when the checks passed, so an existing index here carries the marker.
DROP INDEX CONCURRENTLY IF EXISTS public.ix_documents_entity_context;

-- 3. Tables, column, IAM rows (one transaction) ------------------------------------
BEGIN;
SET LOCAL lock_timeout = '5s';

SELECT pg_temp.legal_rollback_checks();  -- re-check inside the transaction

DO $$
DECLARE
    marker CONSTANT text := 'owner:add_legal_proceedings';
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['legal_proceeding_assignees', 'legal_proceeding_entries',
                             'legal_proceeding_stages', 'legal_proceedings'] LOOP
        IF to_regclass('public.' || t) IS NULL THEN
            CONTINUE;
        ELSIF coalesce(obj_description(to_regclass('public.' || t), 'pg_class'), '') = marker THEN
            -- RESTRICT: never cascades into objects this module did not create.
            EXECUTE format('DROP TABLE public.%I RESTRICT', t);
        ELSE
            RAISE NOTICE 'Kept public.%: no ownership marker', t;
        END IF;
    END LOOP;

    IF coalesce(col_description('public.documents'::regclass,
                   (SELECT attnum FROM pg_attribute
                     WHERE attrelid = 'public.documents'::regclass AND attname = 'context_key' AND NOT attisdropped)),
                '') = marker THEN
        ALTER TABLE public.documents DROP COLUMN context_key RESTRICT;
    ELSIF EXISTS (SELECT 1 FROM pg_attribute
                   WHERE attrelid = 'public.documents'::regclass AND attname = 'context_key' AND NOT attisdropped) THEN
        RAISE NOTICE 'Kept documents.context_key: not created by add_legal_proceedings.sql';
    END IF;

    DELETE FROM public.iam_resource_policies WHERE resource_type = 'legal_proceeding';
END $$;

COMMIT;
