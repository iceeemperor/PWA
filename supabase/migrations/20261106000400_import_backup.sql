-- import_backup: writes a backup file (spec 7.2) into the signed-in user's account. Import is a restore,
-- not a merge: nothing that already exists is overwritten.
--
-- p_payload is the file, or at least { tables: { <table>: [row, ...] } }. Only tables in sync_tables are read
-- (others are ignored: the client validator rejects files with rows in tables that are not supported). For each
-- row, by its id:
--   no row with this id            added: inserted with the file's columns. user_id is always the caller;
--                                  the file's user_id, rev and purged_at are ignored, keys that are not
--                                  columns are ignored, columns the file lacks take their DEFAULT.
--                                  created_at, updated_at and deleted_at are kept as in the file, so a record
--                                  that was in the trash is still in the trash.
--   the id belongs to another user skipped.exists: that row is neither read back nor changed.
--   own row, live or in the trash  skipped.exists: never overwritten.
--   own tombstone (purged_at set)  p_restore_purged false or null: skipped.purged.
--                                  true: restored. Content columns and updated_at come from the file,
--                                  purged_at is cleared, and deleted_at becomes now() if the file's row was in
--                                  the trash (else the next purge would empty it again at once) or null.
--                                  created_at stays the row's own (the trigger keeps it on every update; for a
--                                  real backup of the record it is the file's anyway).
-- rev always comes from the trigger, so every added or restored row reaches the other devices on their next pull.
-- updated_at is kept because this function sets app.keep_updated_at for its own transaction only (the trigger
-- in core.sql checks it); it is the only write path that does.
--
-- Everything runs in the caller's one transaction: a row that breaks a constraint or does not fit its column
-- raises, and nothing of the import is kept. A payload of the wrong shape raises invalid_payload (22023).
-- Tables are processed in name order. (When child tables exist, stage 3, parents must come first and a child of a
-- tombstone that is not restored must be skipped; todos has no children.)
--
-- Result: { added, restored, skipped }, the shape of ImportSummary in src/domain/types.ts. skipped holds a count per
-- reason (exists, purged) and only the reasons that occurred: {} when nothing was skipped.
--
-- Runs as the function owner (security definer), so it can see whether an id is taken by another user; every
-- write is limited to user_id = auth.uid() by hand.
create function import_backup(p_payload jsonb, p_restore_purged boolean) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid      uuid := auth.uid();
  v_restore  boolean := coalesce(p_restore_purged, false);
  v_tables   jsonb;
  v_table    text;
  v_rows     jsonb;
  v_rec      jsonb;
  v_id       uuid;
  v_owner    uuid;
  v_tomb     boolean;
  v_ins_cols text[];
  v_upd_cols text[];
  v_done     int;
  v_added    int := 0;
  v_restored int := 0;
  v_exists   int := 0;
  v_purged   int := 0;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'invalid_payload: the payload must be a JSON object' using errcode = '22023';
  end if;
  v_tables := coalesce(p_payload -> 'tables', '{}'::jsonb);
  if jsonb_typeof(v_tables) <> 'object' then
    raise exception 'invalid_payload: tables must be an object' using errcode = '22023';
  end if;

  -- Only for this transaction: the trigger keeps the updated_at each write brings.
  perform set_config('app.keep_updated_at', 'on', true);

  for v_table in select s.name from public.sync_tables s order by s.name loop
    v_rows := v_tables -> v_table;
    continue when v_rows is null or jsonb_typeof(v_rows) = 'null';
    if jsonb_typeof(v_rows) <> 'array' then
      raise exception 'invalid_payload: tables.% must be an array', v_table using errcode = '22023';
    end if;

    -- Columns a file row may set: every column except the ones the server owns (read from the catalog, so a table
    -- added to sync_tables later is covered). A restore does not set created_at (the trigger would keep the old
    -- one anyway) or deleted_at (decided below).
    select coalesce(array_agg(a.attname::text order by a.attnum), '{}')
      into v_ins_cols
      from pg_catalog.pg_attribute a
     where a.attrelid = format('public.%I', v_table)::regclass
       and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
       and a.attname not in ('id', 'user_id', 'rev', 'purged_at');
    select coalesce(array_agg(x), '{}') into v_upd_cols
      from unnest(v_ins_cols) x where x not in ('created_at', 'deleted_at');

    for v_rec in select r from jsonb_array_elements(v_rows) r loop
      if jsonb_typeof(v_rec) <> 'object' or jsonb_typeof(v_rec -> 'id') is distinct from 'string' then
        raise exception 'invalid_payload: every row of tables.% must be an object with an id', v_table
          using errcode = '22023';
      end if;
      v_id := (v_rec ->> 'id')::uuid;

      v_owner := null;
      execute format('select t.user_id, t.purged_at is not null from public.%I t where t.id = $1', v_table)
        into v_owner, v_tomb using v_id;

      if v_owner is null then
        -- Only the columns the file has are inserted, so the others take their DEFAULT.
        execute format(
          'insert into public.%1$I as t (id, user_id%2$s) '
          'select $1, $2%3$s from jsonb_populate_record(null::public.%1$I, $3) r',
          v_table,
          coalesce((select string_agg(format(', %I', x), '') from unnest(v_ins_cols) x where v_rec ? x), ''),
          coalesce((select string_agg(format(', r.%I', x), '') from unnest(v_ins_cols) x where v_rec ? x), ''))
          using v_id, v_uid, v_rec;
        v_added := v_added + 1;
      elsif v_owner <> v_uid or not v_tomb then
        v_exists := v_exists + 1;
      elsif not v_restore then
        v_purged := v_purged + 1;
      else
        -- Every content column is written: from the file, or its DEFAULT when the file lacks it.
        execute format(
          'update public.%1$I as t set %2$spurged_at = null, '
          'deleted_at = case when $3 ->> ''deleted_at'' is null then null else now() end '
          'from jsonb_populate_record(null::public.%1$I, $3) r '
          'where t.id = $1 and t.user_id = $2 and t.purged_at is not null',
          v_table,
          coalesce((select string_agg(case when v_rec ? x then format('%1$I = r.%1$I, ', x)
                                           else format('%I = default, ', x) end, '')
                      from unnest(v_upd_cols) x), ''))
          using v_id, v_uid, v_rec;
        get diagnostics v_done = row_count;
        if v_done <> 1 then
          -- Changed by someone else since it was read: no longer a tombstone of this user.
          v_exists := v_exists + 1;
        else
          v_restored := v_restored + 1;
        end if;
      end if;
    end loop;
  end loop;

  return jsonb_build_object(
    'added', v_added,
    'restored', v_restored,
    'skipped', jsonb_strip_nulls(jsonb_build_object('exists', nullif(v_exists, 0), 'purged', nullif(v_purged, 0))));
end
$$;

-- Supabase hands every new function to anon and authenticated (and Postgres to PUBLIC): take that away,
-- then give it to signed-in users only.
revoke execute on function import_backup(jsonb, boolean) from public, anon, authenticated;
grant execute on function import_backup(jsonb, boolean) to authenticated;
