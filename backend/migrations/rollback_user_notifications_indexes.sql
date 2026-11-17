-- Undo of add_user_notifications_indexes_concurrently.sql: drops ONLY the two
-- notification-center indexes. No table, column, data or other index is touched.
--
-- DROP INDEX CONCURRENTLY does not block reads or writes but cannot run inside a
-- transaction block: NO BEGIN/COMMIT, run with psql WITHOUT -1 / --single-transaction:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/migrations/rollback_user_notifications_indexes.sql
-- Safe to re-run (IF EXISTS).

DROP INDEX CONCURRENTLY IF EXISTS public.ix_user_notifications_user_unread;
DROP INDEX CONCURRENTLY IF EXISTS public.ix_user_notifications_user_created;

DO $$
BEGIN
    IF to_regclass('public.ix_user_notifications_user_created') IS NOT NULL
       OR to_regclass('public.ix_user_notifications_user_unread') IS NOT NULL THEN
        RAISE EXCEPTION 'A notification-center index is still present after the rollback';
    END IF;
    RAISE NOTICE 'user_notifications: notification-center indexes removed';
END $$;
