-- Hardening before the first deploy (final fix wave of stage 1).
--
-- F4: one set of field rules everywhere. The Repo validator (src/data/validate-fields.ts), the backup validator
-- (src/backup/validate.ts), push_change and these CHECKs accept exactly the same values; tests/db/field-rules.test.ts
-- feeds the same values through all of them. The rules for a live row (purged_at is null):
--   title       string, not blank after trimming whitespace, no U+0000 (text cannot hold it anyway)
--   done        JSON boolean
--   kind        'todo' | 'goal' (JSON string)      priority  'high' | 'normal' | 'low' (JSON string)
--   note        string
--   due_date    null or a real YYYY-MM-DD in the years 0001-9999
--   steps       JSON array of { id: non-empty string, text: string, done: boolean }, no other keys
--   created_at  ISO 8601 timestamp with a zone, finite, in the UTC years 2000-9999
-- The table is empty before the first deploy, so the constraints need no data cleanup.

alter table todos
  add constraint todos_steps_array check (jsonb_typeof(steps) = 'array'),
  -- Trims the characters JavaScript's String.prototype.trim removes, so "blank" means the same on both sides.
  add constraint todos_title_not_blank check (purged_at is not null or btrim(title,
    E' \t\n\f\r\u000B\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF') <> ''),
  add constraint todos_created_at_range
    check (created_at >= '2000-01-01 00:00:00+00' and created_at < '10000-01-01 00:00:00+00'),
  add constraint todos_due_date_range check (due_date between '0001-01-01' and '9999-12-31');

-- Why a set of fields cannot be written, or null when it can. `p_cols` are the columns that will be written; any
-- other key of p_fields is ignored by the caller. Types follow the column: text a JSON string, boolean a JSON
-- boolean, date a string YYYY-MM-DD, timestamptz an RFC 3339 string with seconds and a zone, numbers a JSON number;
-- a JSON null only where the column allows NULL. Range and calendar checks are left to the casts and CHECKs.
-- Called by push_change only (it runs as the owner), so nobody else may execute it.
create function public.push_fields_problem(p_table text, p_fields jsonb, p_cols text[]) returns text
language plpgsql stable
set search_path = public, pg_temp
as $$
declare
  v_col      text;
  v_type     text;
  v_nullable boolean;
  v_jt       text;
  v_str      text;
  v_ok       boolean;
begin
  for v_col, v_type, v_nullable in
    select c.column_name::text, c.data_type::text, c.is_nullable = 'YES'
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = p_table and c.column_name::text = any (p_cols)
     order by c.ordinal_position
  loop
    v_jt := jsonb_typeof(p_fields -> v_col);
    if v_jt = 'null' then
      if not v_nullable then
        return format('%s must not be null', v_col);
      end if;
      continue;
    end if;
    v_str := case when v_jt = 'string' then p_fields ->> v_col end;
    v_ok := case v_type
      when 'text' then v_jt = 'string'
      when 'uuid' then v_jt = 'string'
      when 'boolean' then v_jt = 'boolean'
      when 'date' then v_jt = 'string' and v_str ~ '^\d{4}-\d{2}-\d{2}$'
      when 'timestamp with time zone' then v_jt = 'string'
        and v_str ~ '^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$'
      when 'smallint' then v_jt = 'number'
      when 'integer' then v_jt = 'number'
      when 'bigint' then v_jt = 'number'
      when 'numeric' then v_jt = 'number'
      else true
    end;
    if not v_ok then
      return format('%s has the wrong type or form', v_col);
    end if;
  end loop;

  -- Shapes inside JSON columns.
  if p_table = 'todos' and 'steps' = any (p_cols) then
    if jsonb_typeof(p_fields -> 'steps') <> 'array' then
      return 'steps must be an array';
    end if;
    if exists (
      select 1 from jsonb_array_elements(p_fields -> 'steps') e
       where case
               when jsonb_typeof(e) <> 'object' then true
               else (select count(*) from jsonb_object_keys(e)) <> 3
                 or jsonb_typeof(e -> 'id') is distinct from 'string' or e ->> 'id' = ''
                 or jsonb_typeof(e -> 'text') is distinct from 'string'
                 or jsonb_typeof(e -> 'done') is distinct from 'boolean'
             end) then
      return 'every step must be { id: non-empty string, text: string, done: boolean }';
    end if;
  end if;
  return null;
end
$$;
revoke execute on function public.push_fields_problem(text, jsonb, text[]) from public, anon, authenticated;

-- push_change, as in 000200, with two changes (F4):
--   * the fields an op will write are type-checked first (push_fields_problem): a wrong JSON type is `invalid`
--     instead of being coerced by jsonb_populate_record ('yes' -> true, 5 -> '5');
--   * the record is populated from the written keys only, so garbage in keys that are not written (rev, user_id,
--     purged_at, updated_at, deleted_at, id, unknown keys; created_at on an update) is ignored instead of aborting.
-- Everything else (result shape, idempotency, conflicts, tombstones, the trash) is unchanged.
create or replace function push_change(p_table text, p_op jsonb) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid      uuid := auth.uid();
  v_op_id    uuid;
  v_id       uuid;
  v_kind     text;
  v_base_rev bigint;
  v_fields   jsonb;
  v_cols     text[];
  v_ins_cols text[];
  v_row      jsonb;
  v_new      jsonb;
  v_conflict boolean := false;
  v_dropped  text;
  v_result   jsonb;
  v_problem  text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if not exists (select 1 from public.sync_tables where name = p_table) then
    raise exception 'unknown_table' using errcode = '42P01';
  end if;

  begin
    if jsonb_typeof(p_op) is distinct from 'object' then
      return jsonb_build_object('status', 'invalid', 'conflict', false, 'rev', null, 'record', null,
                                'message', 'operation must be a JSON object');
    end if;
    if (p_op ->> 'op_id') is null or (p_op ->> 'id') is null then
      return jsonb_build_object('status', 'invalid', 'conflict', false, 'rev', null, 'record', null,
                                'message', 'op_id and id are required');
    end if;
    v_op_id    := (p_op ->> 'op_id')::uuid;
    v_id       := (p_op ->> 'id')::uuid;
    v_kind     := p_op ->> 'kind';
    v_base_rev := (p_op ->> 'base_rev')::bigint;
    v_fields   := coalesce(p_op -> 'fields', '{}'::jsonb);

    if v_kind is null or v_kind not in ('insert', 'update', 'delete', 'restore') then
      return jsonb_build_object('status', 'invalid', 'conflict', false, 'rev', null, 'record', null,
                                'message', 'unknown kind');
    end if;
    if jsonb_typeof(v_fields) <> 'object' then
      return jsonb_build_object('status', 'invalid', 'conflict', false, 'rev', null, 'record', null,
                                'message', 'fields must be a JSON object');
    end if;

    perform pg_advisory_xact_lock(hashtextextended(v_uid::text || ':' || v_op_id::text, 0));

    select a.result into v_result from public.applied_ops a where a.user_id = v_uid and a.op_id = v_op_id;
    if found then
      return v_result;
    end if;

    execute format('select to_jsonb(t) from public.%I t where t.id = $1 and t.user_id = $2 for update', p_table)
      into v_row using v_id, v_uid;

    select coalesce(array_agg(c.column_name::text order by c.ordinal_position)
                    filter (where v_fields ? c.column_name::text), '{}')
      into v_ins_cols
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = p_table
       and c.column_name not in ('user_id', 'updated_at', 'rev', 'deleted_at', 'purged_at', 'id');
    select coalesce(array_agg(x), '{}') into v_cols from unnest(v_ins_cols) x where x <> 'created_at';

    if v_row is null then
      if v_kind <> 'insert' then
        return jsonb_build_object('status', 'invalid', 'conflict', false, 'rev', null, 'record', null,
                                  'message', 'record not found');
      end if;
      v_problem := public.push_fields_problem(p_table, v_fields, v_ins_cols);
      if v_problem is not null then
        return jsonb_build_object('status', 'invalid', 'conflict', false, 'rev', null, 'record', null,
                                  'message', v_problem);
      end if;
      select coalesce(jsonb_object_agg(x, v_fields -> x), '{}') into v_fields from unnest(v_ins_cols) x;
      execute format(
        'insert into public.%1$I as t (id, user_id%2$s) '
        'select $1, $2%3$s from jsonb_populate_record(null::public.%1$I, $3) r returning to_jsonb(t)',
        p_table,
        coalesce((select string_agg(format(', %I', x), '') from unnest(v_ins_cols) x), ''),
        coalesce((select string_agg(format(', r.%I', x), '') from unnest(v_ins_cols) x), ''))
        into v_new using v_id, v_uid, v_fields;
    elsif v_row ->> 'purged_at' is not null then
      v_dropped := 'dropped_purged';
    elsif v_kind in ('insert', 'update') and v_row ->> 'deleted_at' is not null then
      v_dropped := 'dropped_trashed';
    else
      if v_kind in ('insert', 'update') then
        v_problem := public.push_fields_problem(p_table, v_fields, v_cols);
        if v_problem is not null then
          return jsonb_build_object('status', 'invalid', 'conflict', false, 'rev', null, 'record', null,
                                    'message', v_problem);
        end if;
        select coalesce(jsonb_object_agg(x, v_fields -> x), '{}') into v_fields from unnest(v_cols) x;
        v_conflict := v_kind = 'update' and v_base_rev is distinct from (v_row ->> 'rev')::bigint;
        if cardinality(v_cols) > 0 then
          execute format(
            'update public.%1$I as t set %2$s from jsonb_populate_record(null::public.%1$I, $3) r '
            'where t.id = $1 and t.user_id = $2 returning to_jsonb(t)',
            p_table,
            (select string_agg(format('%1$I = r.%1$I', x), ', ') from unnest(v_cols) x))
            into v_new using v_id, v_uid, v_fields;
        end if;
      elsif v_kind = 'delete' then
        if v_row ->> 'deleted_at' is null then
          execute format('update public.%I as t set deleted_at = now() where t.id = $1 and t.user_id = $2 returning to_jsonb(t)', p_table)
            into v_new using v_id, v_uid;
        end if;
      else -- restore
        if v_row ->> 'deleted_at' is not null then
          execute format('update public.%I as t set deleted_at = null where t.id = $1 and t.user_id = $2 returning to_jsonb(t)', p_table)
            into v_new using v_id, v_uid;
        end if;
      end if;
    end if;

    v_new := coalesce(v_new, v_row);
    v_result := jsonb_build_object(
      'status', coalesce(v_dropped, 'applied'),
      'conflict', v_conflict,
      'rev', (v_new ->> 'rev')::bigint,
      'record', v_new,
      'message', null);

    insert into public.applied_ops (user_id, op_id, result) values (v_uid, v_op_id, v_result);
    return v_result;
  exception
    when check_violation or not_null_violation or unique_violation or invalid_text_representation
      or datetime_field_overflow or invalid_datetime_format or numeric_value_out_of_range
      or string_data_right_truncation then
      return jsonb_build_object('status', 'invalid', 'conflict', false, 'rev', null, 'record', null,
                                'message', sqlerrm);
  end;
end
$$;

revoke execute on function push_change(text, jsonb) from public, anon, authenticated;
grant execute on function push_change(text, jsonb) to authenticated;

-- F5: no direct writes to synced tables. With INSERT/UPDATE, a signed-in user's own token could write any row
-- straight through PostgREST and skip every push_change rule (a direct update could clear purged_at and bring a
-- tombstone back). The app only writes through push_change and import_backup, which are security definer; SELECT
-- stays for pull_changes (security invoker). The RLS policies stay as well (spec 3.3), as a second line of defence.
revoke insert, update on todos from authenticated;

-- F7: import_backup, as in 000400, with two changes: user_id, rev and purged_at are removed from every file row before
-- jsonb_populate_record, so garbage in them is ignored instead of aborting the import (they were never written);
-- and app.keep_updated_at is reset before returning, so later writes in the caller's transaction get a fresh
-- updated_at. Everything else is unchanged.
create or replace function import_backup(p_payload jsonb, p_restore_purged boolean) returns jsonb
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
      -- Server-managed keys are never read from the file, whatever they hold (F7).
      v_rec := v_rec - 'user_id' - 'rev' - 'purged_at';

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

  -- The setting is for this function's writes only, not for the rest of the caller's transaction (F7).
  perform set_config('app.keep_updated_at', '', true);

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
