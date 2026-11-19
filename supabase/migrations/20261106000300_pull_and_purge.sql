-- pull_changes: one page of "everything after rev N" for the signed-in user, across every table in sync_tables.
-- purge_expired: turns rows that have been in the trash for more than 30 days into tombstones and
-- deletes applied_ops older than 30 days.

-- pull_changes runs as the caller (security invoker), so the row-level security policies decide which
-- rows are visible: there is deliberately no user_id filter of its own, and nothing but SELECT on the
-- synced tables and on sync_tables is needed. Trashed rows and tombstones are included.
--
-- Result: { rows: [{ table, row }], has_more }, the shape of PullPage in src/domain/types.ts. `row` is the
-- whole row as to_jsonb. Rows have rev > p_since (strictly: the client rewinds its cursor itself), sorted by rev,
-- at most p_limit of them; one more is fetched to tell whether another page follows.
--
-- Odd input is made harmless instead of rejected, because a paging loop must always advance:
--   p_since null            counts as 0 (a negative one simply returns everything: every rev is positive)
--   p_limit null            uses 500
--   p_limit below 1         is raised to 1 (a limit of 0 would give an empty page with has_more true, forever)
--   p_limit above 1000      is lowered to 1000
-- Without a signed-in user it raises not_authenticated (like push_change) instead of returning an empty
-- page, so an expired session shows up as an error and not as "nothing new".
create function pull_changes(p_since bigint, p_limit int) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_since bigint := coalesce(p_since, 0);
  v_limit int    := least(greatest(coalesce(p_limit, 500), 1), 1000);
  v_union text;
  v_rows  jsonb;
  v_more  boolean;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  -- One sub-select per synced table, each cut to its own lowest v_limit + 1 revs: the lowest v_limit + 1 of all
  -- tables together cannot need more from any single one.
  select string_agg(
           format('(select %L::text as tbl, to_jsonb(t) as rec, t.rev from public.%I t where t.rev > $1 order by t.rev limit $2::bigint + 1)',
                  s.name, s.name),
           ' union all ' order by s.name)
    into v_union
    from public.sync_tables s;

  if v_union is null then
    return jsonb_build_object('rows', '[]'::jsonb, 'has_more', false);
  end if;

  execute format(
    'select coalesce(jsonb_agg(jsonb_build_object(''table'', x.tbl, ''row'', x.rec) order by x.n) filter (where x.n <= $2::bigint), ''[]''::jsonb), '
    '       coalesce(max(x.n), 0) > $2::bigint '
    '  from (select u.tbl, u.rec, row_number() over (order by u.rev, u.tbl) as n from (%s) u) x',
    v_union)
    into v_rows, v_more using v_since, v_limit;

  return jsonb_build_object('rows', v_rows, 'has_more', v_more);
end
$$;

-- Supabase hands every new function to anon and authenticated (and Postgres to PUBLIC): take that away,
-- then give it to signed-in users only.
revoke execute on function pull_changes(bigint, int) from public, anon, authenticated;
grant execute on function pull_changes(bigint, int) to authenticated;

-- purge_expired: for every table in sync_tables, rows trashed more than 30 days ago (deleted_at) and not yet
-- purged become tombstones: purged_at is set and every content column goes back to its DEFAULT. Content columns are
-- all columns except the bookkeeping ones named below; they are read from the catalog, so a table added to
-- sync_tables later is covered without touching this function. The row is never deleted (a tombstone stays
-- forever, so a device that was offline for months learns of the deletion by pulling it) and deleted_at is kept.
-- The trigger gives every purged row a new rev, which is how the tombstones reach the devices; rev is not set here.
-- A run only looks at rows with purged_at null, so running it again changes nothing.
-- Also deletes applied_ops older than 30 days (a replay after that is processed as a fresh op).
-- (Records that belong to a parent, such as the repeat exceptions of an event, will be purged with their
-- parent when the first such table exists; todos has none.)
--
-- Who it acts on: a signed-in user (auth.uid() not null) only purges their own rows and their own applied_ops.
-- With no signed-in user it purges everyone's; that is the daily pg_cron job (it runs as the owner) and a
-- service role. A caller that holds the authenticated or anon role but has no subject must never get that
-- "everyone" behaviour, so it raises not_authenticated. The role is read from the `role` setting
-- (current_user is the owner inside a security definer function).
--
-- Runs as the function owner (security definer), because applied_ops has no grants for callers, and
-- every row it touches is limited by hand as described above.
create function purge_expired() returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_table text;
  v_reset text;
begin
  if v_uid is null and coalesce(current_setting('role', true), '') in ('authenticated', 'anon') then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  for v_table in select s.name from public.sync_tables s order by s.name loop
    select coalesce(string_agg(format(', %I = default', a.attname), '' order by a.attnum), '')
      into v_reset
      from pg_catalog.pg_attribute a
     where a.attrelid = format('public.%I', v_table)::regclass
       and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
       and a.attname not in ('id', 'user_id', 'created_at', 'updated_at', 'rev', 'deleted_at', 'purged_at');

    execute format(
      'update public.%I as t set purged_at = now()%s '
      'where t.deleted_at < now() - interval ''30 days'' and t.purged_at is null and ($1 is null or t.user_id = $1)',
      v_table, v_reset)
      using v_uid;
  end loop;

  delete from public.applied_ops a
   where a.created_at < now() - interval '30 days' and (v_uid is null or a.user_id = v_uid);
end
$$;

revoke execute on function purge_expired() from public, anon, authenticated;
grant execute on function purge_expired() to authenticated;
