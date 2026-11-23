-- Stage 2: the events table (calendar), and an explicit user filter in pull_changes.
--
-- events follows todos exactly for the common columns, the trigger, row-level security and privileges (as hardened
-- in 000600): signed-in users may only SELECT their rows; every write goes through the security definer functions
-- push_change and import_backup (F5), which are table-generic and pick events up from sync_tables. anon gets nothing.
--
-- Content columns. Every one has a DEFAULT and none is UNIQUE, because purge_expired resets them to their DEFAULT,
-- and the defaults equal TABLE_DEFAULTS.events in src/domain/tables.ts. Every content CHECK lets a tombstone
-- (purged_at set) pass. The rules for a live row:
--   title      string, not blank after trimming whitespace (the same set as todos_title_not_blank in 000600)
--   all_day    boolean
--   starts_at  all-day: YYYY-MM-DD; timed: YYYY-MM-DDTHH:MM (local time in tz, no seconds, no offset)
--   ends_at    null, or the same form as starts_at and not before it
--   tz         all-day: null; timed: an IANA-style zone name such as Asia/Shanghai
--   note       string        important, done  booleans
--   rrule      null for now (repeats arrive in stage 3, which drops events_no_rrule_yet)
-- Local times in one zone, written in one fixed form, sort as strings in the order they happen, so ends_at >= starts_at
-- is a plain string comparison (in the "C" collation, so a database collation cannot change it).

create table events (
  id         uuid primary key,
  user_id    uuid not null references auth.users (id) on delete cascade default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  rev        bigint not null default 0,
  deleted_at timestamptz,
  purged_at  timestamptz,
  -- Content columns.
  title      text not null default '',
  all_day    boolean not null default true,
  starts_at  text not null default '',
  ends_at    text,
  tz         text,
  note       text not null default '',
  important  boolean not null default false,
  done       boolean not null default false,
  rrule      text,

  constraint events_created_at_range
    check (created_at >= '2000-01-01 00:00:00+00' and created_at < '10000-01-01 00:00:00+00'),
  -- Trims the characters JavaScript's String.prototype.trim removes, so "blank" means the same on both sides.
  constraint events_title_not_blank check (purged_at is not null or btrim(title,
    E' \t\n\f\r\u000B                 　﻿') <> ''),
  -- coalesce(..., false) everywhere a NULL could appear: a CHECK that evaluates to NULL passes, so a NULL must fail here.
  constraint events_all_day_form check (purged_at is not null or not all_day or coalesce(
    starts_at ~ '^\d{4}-\d{2}-\d{2}$'
    and tz is null
    and (ends_at is null or (ends_at ~ '^\d{4}-\d{2}-\d{2}$' and ends_at collate "C" >= starts_at collate "C")),
    false)),
  constraint events_timed_form check (purged_at is not null or all_day or coalesce(
    starts_at ~ '^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$'
    and tz ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$'
    and (ends_at is null or (ends_at ~ '^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$' and ends_at collate "C" >= starts_at collate "C")),
    false)),
  constraint events_no_rrule_yet check (rrule is null)
);

create index events_user_id_rev_idx on events (user_id, rev);

-- rev, updated_at and created_at are kept by the same trigger function as todos.
create trigger events_set_rev_and_updated_at
  before insert or update on events
  for each row execute function set_rev_and_updated_at();

-- Row-level security: one policy per command, each user sees only their own rows. The delete policy matches nothing:
-- tombstones stay forever. The insert and update policies back up the missing grants (a mistaken grant still could not
-- write someone else's row).
alter table events enable row level security;

create policy events_select on events for select to authenticated
  using (user_id = auth.uid());
create policy events_insert on events for insert to authenticated
  with check (user_id = auth.uid());
create policy events_update on events for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
create policy events_delete on events for delete to authenticated
  using (false);

-- SELECT only, for pull_changes (security invoker). Whatever a project hands out by default is revoked first.
revoke all on events from anon, authenticated;
grant select on events to authenticated;

insert into sync_tables (name, copy_fields) values ('events', '{}');

-- pull_changes, as in 000300 (000600 did not change it), with one change: every table's query also requires
-- t.user_id = auth.uid(). RLS already hides other users' rows, but the function no longer depends on it alone: a table
-- whose RLS was turned off or given a wider SELECT policy by mistake still cannot leak another user's rows through
-- the pull. It stays security invoker, so it still needs SELECT on every synced table and RLS still applies on top.
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
create or replace function pull_changes(p_since bigint, p_limit int) returns jsonb
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
           format('(select %L::text as tbl, to_jsonb(t) as rec, t.rev from public.%I t where t.rev > $1 and t.user_id = auth.uid() order by t.rev limit $2::bigint + 1)',
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
-- then give it to signed-in users only. Written again after the create or replace.
revoke execute on function pull_changes(bigint, int) from public, anon, authenticated;
grant execute on function pull_changes(bigint, int) to authenticated;
