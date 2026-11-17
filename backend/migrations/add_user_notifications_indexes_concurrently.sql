-- Notification center, stage 1: two indexes on the EXISTING user_notifications table.
-- Indexes only: no column, no data change, no existing index is touched.
--
--   ix_user_notifications_user_created  (user_id, created_at DESC, id DESC)
--       A user's notifications newest first, with keyset paging on (created_at, id).
--   ix_user_notifications_user_unread   (user_id, created_at DESC, id DESC) WHERE read_at IS NULL
--       The user's unread notifications and their count. Partial: only unread rows,
--       so it stays small however many read notifications are kept.
--
-- The definitions mirror backend/models/user_notification.py.
--
-- CREATE INDEX CONCURRENTLY builds without blocking writes, but PostgreSQL refuses it
-- inside a transaction block. Therefore:
--   * this file has NO BEGIN/COMMIT — each statement runs in its own autocommit;
--   * run it with psql WITHOUT -1 / --single-transaction:
--       psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/migrations/add_user_notifications_indexes_concurrently.sql
--   * it is NOT in init_db.py, which runs inside a single transaction.
--
-- Partial builds: a failed/cancelled CONCURRENTLY build leaves an INVALID index that
-- IF NOT EXISTS would silently keep. Step 1 stops on an invalid index (or one with a
-- different definition) and prints the fix; step 3 verifies the result. Safe to
-- re-run once the indexes are valid.
--
-- Undo: rollback_user_notifications_indexes.sql

-- 1. Pre-check ---------------------------------------------------------------------
DO $$
DECLARE
    expected CONSTANT text[][] := ARRAY[
        ['ix_user_notifications_user_created',
         'CREATE INDEX ix_user_notifications_user_created ON public.user_notifications USING btree (user_id, created_at DESC, id DESC)'],
        ['ix_user_notifications_user_unread',
         'CREATE INDEX ix_user_notifications_user_unread ON public.user_notifications USING btree (user_id, created_at DESC, id DESC) WHERE (read_at IS NULL)']
    ];
    ix record;
BEGIN
    IF to_regclass('public.user_notifications') IS NULL THEN
        RAISE EXCEPTION 'Required table public.user_notifications is missing';
    END IF;
    FOR i IN 1 .. array_length(expected, 1) LOOP
        SELECT x.indisvalid, pg_get_indexdef(x.indexrelid) AS def INTO ix
          FROM pg_index x WHERE x.indexrelid = to_regclass('public.' || expected[i][1]);
        IF FOUND THEN
            IF NOT ix.indisvalid THEN
                RAISE EXCEPTION '% exists but is INVALID (interrupted CONCURRENTLY build). Run: DROP INDEX CONCURRENTLY public.%; then re-run this file.',
                    expected[i][1], expected[i][1];
            END IF;
            IF ix.def <> expected[i][2] THEN
                RAISE EXCEPTION '% exists with an unexpected definition: %', expected[i][1], ix.def;
            END IF;
        END IF;
    END LOOP;
END $$;

-- 2. Build -------------------------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_user_notifications_user_created
    ON public.user_notifications (user_id, created_at DESC, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_user_notifications_user_unread
    ON public.user_notifications (user_id, created_at DESC, id DESC)
    WHERE read_at IS NULL;

-- 3. Verify ------------------------------------------------------------------------
DO $$
DECLARE
    name text;
BEGIN
    FOREACH name IN ARRAY ARRAY['ix_user_notifications_user_created', 'ix_user_notifications_user_unread'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = to_regclass('public.' || name) AND indisvalid) THEN
            RAISE EXCEPTION '% was not built as a valid index', name;
        END IF;
    END LOOP;
    RAISE NOTICE 'user_notifications: both notification-center indexes are valid';
END $$;
