-- Legal proceedings module: index on the EXISTING documents table.
--
-- Serves every document lookup of a proceeding / entry / stage component
-- (entity_type, entity_id, context_key). documents is a large shared table, so the
-- index is built CONCURRENTLY, which PostgreSQL refuses inside a transaction block:
--   * this file has NO BEGIN/COMMIT — each statement runs in its own autocommit;
--   * run it with psql WITHOUT -1 / --single-transaction:
--       psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/migrations/add_legal_proceedings_indexes_concurrently.sql
--   * it is NOT in init_db.py, which runs inside a single transaction.
-- Run it AFTER add_legal_proceedings.sql (it needs documents.context_key).
--
-- Partial builds: a failed/cancelled CONCURRENTLY build leaves an INVALID index that
-- IF NOT EXISTS would silently keep. Step 1 stops on an invalid index (or one with
-- a different definition) and prints the fix; step 3 verifies the result. Safe to
-- re-run once the index is valid.
--
-- The index name is owned by this module; it gets the ownership marker that
-- rollback_legal_proceedings.sql requires before dropping it.

-- 1. Pre-check --------------------------------------------------------------------
DO $$
DECLARE
    ix record;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_attribute
                    WHERE attrelid = 'public.documents'::regclass AND attname = 'context_key' AND NOT attisdropped) THEN
        RAISE EXCEPTION 'documents.context_key is missing: run add_legal_proceedings.sql first';
    END IF;

    SELECT i.indisvalid, pg_get_indexdef(i.indexrelid) AS def INTO ix
      FROM pg_index i
     WHERE i.indexrelid = to_regclass('public.ix_documents_entity_context');

    IF FOUND THEN
        IF NOT ix.indisvalid THEN
            RAISE EXCEPTION 'ix_documents_entity_context exists but is INVALID (interrupted CONCURRENTLY build). Run: DROP INDEX CONCURRENTLY public.ix_documents_entity_context; then re-run this file.';
        END IF;
        IF ix.def <> 'CREATE INDEX ix_documents_entity_context ON public.documents USING btree (entity_type, entity_id, context_key)' THEN
            RAISE EXCEPTION 'ix_documents_entity_context exists with an unexpected definition: %', ix.def;
        END IF;
    END IF;
END $$;

-- 2. Build ------------------------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_documents_entity_context
    ON public.documents (entity_type, entity_id, context_key);

-- 3. Verify + ownership marker ----------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_index
                    WHERE indexrelid = to_regclass('public.ix_documents_entity_context') AND indisvalid) THEN
        RAISE EXCEPTION 'ix_documents_entity_context was not built as a valid index';
    END IF;
END $$;

COMMENT ON INDEX public.ix_documents_entity_context IS 'owner:add_legal_proceedings';
