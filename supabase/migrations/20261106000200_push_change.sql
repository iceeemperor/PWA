-- push_change: applies one client operation (insert, update, delete or restore) to a synced table.
--
-- Runs as the function owner (security definer), so callers need no table privileges; in exchange
-- every lookup and write below is limited to user_id = auth.uid() by hand. It never hard-deletes:
-- "delete" only sets deleted_at. rev, updated_at and created_at are left to the trigger.
--
-- Result: { status, conflict, rev, record, message }, the shape of PushResult in src/domain/types.ts.
--   applied          the operation took effect (or was a harmless no-op such as restore on a live row);
--                    conflict is true when an update's base_rev was not the row's current rev
--   dropped_trashed  update on a trashed row: nothing written; rev and record are the row as it is now
--   dropped_purged   any op on a tombstone: nothing written; rev and record are the tombstone
--   invalid          bad input or a failed write: nothing written, rev and record are null, message says why.
--                    Not stored in applied_ops, so a corrected op may reuse its op_id.
-- Every other outcome is stored in applied_ops, and a retry with the same op_id gets that result back.
create function push_change(p_table text, p_op jsonb) returns jsonb
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
  v_status   text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if not exists (select 1 from public.sync_tables where name = p_table) then
    raise exception 'unknown_table' using errcode = '42P01';
  end if;

  -- Everything that reads the operation or writes a row sits in one block: if it fails with a data
  -- error, the block's implicit subtransaction undoes the write and the outcome becomes 'invalid'.
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

    -- Two requests with the same op_id wait for each other here, so the second one finds the first's result.
    perform pg_advisory_xact_lock(hashtextextended(v_uid::text || ':' || v_op_id::text, 0));

    select a.result into v_result from public.applied_ops a where a.user_id = v_uid and a.op_id = v_op_id;
    if found then
      return v_result;
    end if;

    execute format('select to_jsonb(t) from public.%I t where t.id = $1 and t.user_id = $2 for update', p_table)
      into v_row using v_id, v_uid;

    -- Columns the client may set: all table columns except the server-managed ones; on update also not created_at.
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
      -- Only the sent columns are inserted, so the others take their DEFAULT.
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
        -- An insert of an existing id is an update that never counts as a conflict.
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
      -- Raised by the write or by a value that does not fit its column; the write is already undone.
      -- Nothing is stored, so the client can fix the op and retry it under the same op_id.
      return jsonb_build_object('status', 'invalid', 'conflict', false, 'rev', null, 'record', null,
                                'message', sqlerrm);
  end;
end
$$;

-- Supabase hands every new function to anon and authenticated (and Postgres to PUBLIC): take that away,
-- then give it to signed-in users only.
revoke execute on function push_change(text, jsonb) from public, anon, authenticated;
grant execute on function push_change(text, jsonb) to authenticated;
