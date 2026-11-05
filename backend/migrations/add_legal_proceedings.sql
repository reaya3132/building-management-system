-- Legal proceedings module (הליכים משפטיים): tables, constraints and documents.context_key.
--
-- What this does (additive only — no existing row is changed or deleted):
--   contacts                     general contact card (person / business)
--   legal_proceedings            one independent proceeding per contact
--   legal_proceeding_stages      status of each fixed stage of a proceeding
--   legal_proceeding_entries     notes + stage-1 communication records
--   legal_proceeding_assignees   operational assignment of employees
--   documents.context_key        nullable column on the EXISTING documents table
--                                (metadata-only ALTER: no default, no rewrite)
-- Every FK into legal_proceedings and to users is ON DELETE RESTRICT: proceedings
-- are closed, never hard-deleted. The definitions mirror backend/models/contact.py
-- and backend/models/legal_proceeding.py exactly; the stage-1 key in
-- ck_lpe_communication equals STAGE1_KEY in backend/configurations/legal/stages.py
-- (both enforced by backend/tests/test_legal_migration_sync.py).
--
-- DEPLOY ORDER (mandatory): run this file, then add_legal_proceedings_indexes_concurrently.sql,
-- and only then deploy the code. The new code reads documents.context_key in every
-- documents query; without the column every existing documents feature fails.
--
-- Re-run safety does not rely on IF NOT EXISTS alone. The DDL is defined once
-- (pg_temp.legal_ddl) and executed twice:
--   1. into a throw-away reference schema (legal_migration_ref), always from scratch;
--   2. into public, creating only what is missing (fresh DB, or tables that the
--      application's create_all already provisioned from the models).
-- Then every column, constraint and index of the five tables in public is compared
-- with the reference. Any difference (e.g. a constraint created by an older model,
-- a missing index, a different CHECK) raises and the whole transaction rolls back.
-- documents.context_key, when already present, must be VARCHAR(50) NULL.
--
-- Ownership markers (used by rollback_legal_proceedings.sql, which drops only what
-- carries one): COMMENT 'owner:add_legal_proceedings' on each of the five tables and
-- on documents.context_key — the column only when THIS file added it.
--
-- Adoption of tables that already exist: if the application's create_all provisioned
-- the five module tables before this file ran (code deployed first), they are ADOPTED
-- — marked as owned — only AFTER the full comparison of step 4 proved them identical
-- to the expected definition. Anything that differs stops the file and nothing is
-- marked. An adopted table may later be dropped by the rollback, which does so only
-- after verifying it holds no rows and that nothing outside the module depends on it.
-- documents.context_key is never adopted: a pre-existing column stays unmarked.
--
-- Run (single transaction, stops on first error, safe to re-run):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/migrations/add_legal_proceedings.sql

BEGIN;

-- Fail fast instead of queueing behind a long transaction on documents.
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION pg_temp.legal_ddl() RETURNS void LANGUAGE plpgsql AS $ddl$
BEGIN
    -- Unqualified names: the caller's search_path picks the target schema.

    CREATE TABLE IF NOT EXISTS contacts (
        id          SERIAL        NOT NULL,
        kind        VARCHAR(20)   NOT NULL,
        name        VARCHAR(255)  NOT NULL,
        email       VARCHAR(255)  NULL,
        phone       VARCHAR(50)   NULL,
        phone_2     VARCHAR(50)   NULL,
        address     VARCHAR(500)  NULL,
        notes       TEXT          NULL,
        is_active   BOOLEAN       NOT NULL DEFAULT true,
        created_by  INTEGER       NULL,
        created_at  TIMESTAMP     NOT NULL,
        updated_at  TIMESTAMP     NULL,
        PRIMARY KEY (id),
        FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
        CONSTRAINT ck_contacts_kind CHECK (kind IN ('person', 'business')),
        CONSTRAINT ck_contacts_name CHECK (trim(name) <> '')
    );
    CREATE INDEX IF NOT EXISTS ix_contacts_name ON contacts (name);
    CREATE INDEX IF NOT EXISTS ix_contacts_phone ON contacts (phone);
    CREATE INDEX IF NOT EXISTS ix_contacts_email ON contacts (email);

    CREATE TABLE IF NOT EXISTS legal_proceedings (
        id             SERIAL         NOT NULL,
        contact_id     INTEGER        NOT NULL,
        project_id     INTEGER        NULL,
        party_role     VARCHAR(20)    NOT NULL,
        unit_label     VARCHAR(100)   NULL,
        title          VARCHAR(255)   NOT NULL,
        claim_details  TEXT           NULL,
        claim_amount   NUMERIC(14, 2) NULL,
        status         VARCHAR(20)    NOT NULL,
        opened_at      TIMESTAMP      NOT NULL,
        closed_at      TIMESTAMP      NULL,
        closed_by      INTEGER        NULL,
        close_reason   TEXT           NULL,
        created_by     INTEGER        NOT NULL,
        created_at     TIMESTAMP      NOT NULL,
        updated_at     TIMESTAMP      NULL,
        PRIMARY KEY (id),
        FOREIGN KEY (contact_id) REFERENCES contacts (id) ON DELETE RESTRICT,
        FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
        FOREIGN KEY (closed_by) REFERENCES users (id) ON DELETE RESTRICT,
        FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT ck_lp_party_role CHECK (party_role IN ('owner', 'tenant', 'other')),
        CONSTRAINT ck_lp_title CHECK (trim(title) <> ''),
        CONSTRAINT ck_lp_amount CHECK (claim_amount IS NULL OR claim_amount > 0),
        CONSTRAINT ck_lp_status CHECK (status IN ('open', 'closed')),
        CONSTRAINT ck_lp_closed CHECK (
            (status = 'open' AND closed_at IS NULL AND closed_by IS NULL AND close_reason IS NULL)
            OR (status = 'closed' AND closed_at IS NOT NULL AND closed_by IS NOT NULL
                AND close_reason IS NOT NULL AND trim(close_reason) <> ''))
    );
    CREATE INDEX IF NOT EXISTS ix_lp_project_status ON legal_proceedings (project_id, status);
    CREATE INDEX IF NOT EXISTS ix_lp_contact_status ON legal_proceedings (contact_id, status);
    CREATE INDEX IF NOT EXISTS ix_lp_created_by_status ON legal_proceedings (created_by, status);

    CREATE TABLE IF NOT EXISTS legal_proceeding_stages (
        id             SERIAL       NOT NULL,
        proceeding_id  INTEGER      NOT NULL,
        stage_key      VARCHAR(50)  NOT NULL,
        status         VARCHAR(20)  NOT NULL,
        resolved_at    TIMESTAMP    NULL,
        resolved_by    INTEGER      NULL,
        updated_at     TIMESTAMP    NULL,
        PRIMARY KEY (id),
        FOREIGN KEY (proceeding_id) REFERENCES legal_proceedings (id) ON DELETE RESTRICT,
        FOREIGN KEY (resolved_by) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT uq_lps_proceeding_stage UNIQUE (proceeding_id, stage_key),
        CONSTRAINT ck_lps_status CHECK (status IN ('pending', 'completed', 'skipped')),
        CONSTRAINT ck_lps_resolved CHECK (
            (status = 'pending' AND resolved_at IS NULL AND resolved_by IS NULL)
            OR (status IN ('completed', 'skipped') AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS ix_lps_proceeding_status ON legal_proceeding_stages (proceeding_id, status);

    CREATE TABLE IF NOT EXISTS legal_proceeding_entries (
        id                  SERIAL       NOT NULL,
        proceeding_id       INTEGER      NOT NULL,
        entry_type          VARCHAR(20)  NOT NULL,
        stage_key           VARCHAR(50)  NULL,
        context_key         VARCHAR(50)  NULL,
        content             TEXT         NULL,
        channel             VARCHAR(20)  NULL,
        occurred_at         TIMESTAMP    NULL,
        created_by_user_id  INTEGER      NOT NULL,
        created_at          TIMESTAMP    NOT NULL,
        updated_by_user_id  INTEGER      NULL,
        updated_at          TIMESTAMP    NULL,
        PRIMARY KEY (id),
        CONSTRAINT fk_lpe_stage FOREIGN KEY (proceeding_id, stage_key)
            REFERENCES legal_proceeding_stages (proceeding_id, stage_key) ON DELETE RESTRICT,
        FOREIGN KEY (proceeding_id) REFERENCES legal_proceedings (id) ON DELETE RESTRICT,
        FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
        FOREIGN KEY (updated_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT ck_lpe_type CHECK (entry_type IN ('note', 'communication')),
        CONSTRAINT ck_lpe_channel CHECK (channel IS NULL OR channel IN ('email', 'whatsapp', 'other')),
        CONSTRAINT ck_lpe_context_needs_stage CHECK (context_key IS NULL OR stage_key IS NOT NULL),
        CONSTRAINT ck_lpe_content_not_blank CHECK (content IS NULL OR trim(content) <> ''),
        CONSTRAINT ck_lpe_note CHECK (entry_type <> 'note' OR content IS NOT NULL),
        CONSTRAINT ck_lpe_communication CHECK (
            entry_type <> 'communication' OR (stage_key IS NOT NULL AND stage_key = 'collection_messages'
            AND context_key IS NULL AND channel IS NOT NULL AND occurred_at IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS ix_lpe_proceeding_stage_context_id
        ON legal_proceeding_entries (proceeding_id, stage_key, context_key, id);
    CREATE INDEX IF NOT EXISTS ix_lpe_proceeding_type_occurred
        ON legal_proceeding_entries (proceeding_id, entry_type, occurred_at);

    CREATE TABLE IF NOT EXISTS legal_proceeding_assignees (
        proceeding_id  INTEGER    NOT NULL,
        user_id        INTEGER    NOT NULL,
        assigned_by    INTEGER    NOT NULL,
        assigned_at    TIMESTAMP  NOT NULL,
        PRIMARY KEY (proceeding_id, user_id),
        FOREIGN KEY (proceeding_id) REFERENCES legal_proceedings (id) ON DELETE RESTRICT,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
        FOREIGN KEY (assigned_by) REFERENCES users (id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS ix_lpa_user_id ON legal_proceeding_assignees (user_id);
END
$ddl$;

-- 1. Reference copy, always built from scratch ----------------------------------
CREATE SCHEMA legal_migration_ref;  -- fails (safe stop) if a stale copy exists
SET LOCAL search_path = legal_migration_ref, public;
SELECT pg_temp.legal_ddl();

-- 2. Target: create only what is missing ----------------------------------------
SET LOCAL search_path = public;
SELECT pg_temp.legal_ddl();

-- 3. documents.context_key -------------------------------------------------------
DO $$
DECLARE
    col record;
BEGIN
    SELECT format_type(a.atttypid, a.atttypmod) AS col_type, a.attnotnull, d.adbin IS NOT NULL AS has_default
      INTO col
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = 'public.documents'::regclass AND a.attname = 'context_key' AND NOT a.attisdropped;

    IF NOT FOUND THEN
        ALTER TABLE public.documents ADD COLUMN context_key VARCHAR(50) NULL;
        COMMENT ON COLUMN public.documents.context_key IS 'owner:add_legal_proceedings';
    ELSIF col.col_type <> 'character varying(50)' OR col.attnotnull OR col.has_default THEN
        RAISE EXCEPTION 'documents.context_key exists with an unexpected definition (% , not null=%, default=%); expected VARCHAR(50) NULL without default',
            col.col_type, col.attnotnull, col.has_default;
    END IF;
END $$;

-- 4. Compare public with the reference -------------------------------------------
DO $$
DECLARE
    tables CONSTANT text[] := ARRAY['contacts', 'legal_proceedings', 'legal_proceeding_stages',
                                    'legal_proceeding_entries', 'legal_proceeding_assignees'];
    diff text;
BEGIN
    WITH cols AS (
        SELECT n.nspname AS sch, c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
               || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE ' NULL' END
               || coalesce(' DEFAULT ' || replace(pg_get_expr(d.adbin, d.adrelid), 'legal_migration_ref.', ''), '') AS item
          FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         WHERE n.nspname IN ('public', 'legal_migration_ref') AND c.relname = ANY (tables)
           AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
    ), cons AS (
        SELECT n.nspname AS sch, c.relname || ' ' || k.conname || ' '
               || replace(pg_get_constraintdef(k.oid), 'legal_migration_ref.', '') AS item
          FROM pg_constraint k
          JOIN pg_class c ON c.oid = k.conrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname IN ('public', 'legal_migration_ref') AND c.relname = ANY (tables)
    ), idx AS (
        SELECT schemaname AS sch, replace(replace(indexdef, 'legal_migration_ref.', ''), 'public.', '') AS item
          FROM pg_indexes
         WHERE schemaname IN ('public', 'legal_migration_ref') AND tablename = ANY (tables)
    ), allitems AS (
        SELECT sch, 'column ' || item AS item FROM cols
        UNION ALL SELECT sch, 'constraint ' || item FROM cons
        UNION ALL SELECT sch, 'index ' || item FROM idx
    ), missing AS (
        (SELECT 'missing in public: ' || item AS d FROM allitems WHERE sch = 'legal_migration_ref'
         EXCEPT SELECT 'missing in public: ' || item FROM allitems WHERE sch = 'public')
        UNION ALL
        (SELECT 'unexpected in public: ' || item FROM allitems WHERE sch = 'public'
         EXCEPT SELECT 'unexpected in public: ' || item FROM allitems WHERE sch = 'legal_migration_ref')
    )
    SELECT string_agg(d, E'\n' ORDER BY d) INTO diff FROM missing;

    IF diff IS NOT NULL THEN
        RAISE EXCEPTION E'Legal proceedings schema in public does not match the expected definition:\n%', diff;
    END IF;
END $$;

-- 5. Ownership markers, cleanup ---------------------------------------------------
COMMENT ON TABLE public.contacts IS 'owner:add_legal_proceedings';
COMMENT ON TABLE public.legal_proceedings IS 'owner:add_legal_proceedings';
COMMENT ON TABLE public.legal_proceeding_stages IS 'owner:add_legal_proceedings';
COMMENT ON TABLE public.legal_proceeding_entries IS 'owner:add_legal_proceedings';
COMMENT ON TABLE public.legal_proceeding_assignees IS 'owner:add_legal_proceedings';

DROP SCHEMA legal_migration_ref CASCADE;

COMMIT;
