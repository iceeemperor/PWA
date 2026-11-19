-- Runs purge_expired() every day at 03:00 UTC with pg_cron (the job runs as the owner, with no signed-in user,
-- so it purges every user's expired rows). The PGlite test harness skips *.cron.sql files; this one is checked
-- against a real Supabase project (plan Task 17).
create extension if not exists pg_cron;
select cron.schedule('purge-expired', '0 3 * * *', $$select public.purge_expired()$$);
