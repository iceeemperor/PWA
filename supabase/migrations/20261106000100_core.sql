-- Core schema: the shared revision sequence, the todos table, row-level security,
-- and the two bookkeeping tables used by the sync functions (added in later migrations).

-- One sequence for every synced table. Each insert or update takes the next value as the
-- row's rev, so clients can pull "everything after rev N" across all tables.
create sequence rev_seq;
-- The trigger below runs as the calling user, so that user needs the sequence.
grant usage on sequence rev_seq to authenticated;

create table todos (
  id         uuid primary key,
  user_id    uuid not null references auth.users (id) on delete cascade default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  rev        bigint not null default 0,
  deleted_at timestamptz,
  purged_at  timestamptz,
  -- Content columns. Every one has a DEFAULT because purging resets them to it.
  kind       text not null default 'todo' check (kind in ('todo', 'goal')),
  title      text not null default '',
  done       boolean not null default false,
  priority   text not null default 'normal' check (priority in ('high', 'normal', 'low')),
  due_date   date,
  note       text not null default '',
  steps      jsonb not null default '[]',
  -- A tombstone (purged_at set) has an empty title; every live row needs one.
  check (purged_at is not null or title <> '')
);

create index todos_user_id_rev_idx on todos (user_id, rev);

-- rev and updated_at are written by the server only: whatever the client sends is replaced.
-- updated_at can be kept for one transaction by setting app.keep_updated_at to 'on'
-- (used by the import function, which restores original timestamps).
-- created_at is set once by the client on insert and never changes afterwards.
create function set_rev_and_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.rev := nextval('public.rev_seq');
  if coalesce(current_setting('app.keep_updated_at', true), '') <> 'on' then
    new.updated_at := now();
  end if;
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
  end if;
  return new;
end
$$;

create trigger todos_set_rev_and_updated_at
  before insert or update on todos
  for each row execute function set_rev_and_updated_at();

-- Row-level security: one policy per command, each user sees and writes only their own rows.
alter table todos enable row level security;

create policy todos_select on todos for select to authenticated
  using (user_id = auth.uid());
create policy todos_insert on todos for insert to authenticated
  with check (user_id = auth.uid());
create policy todos_update on todos for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
create policy todos_delete on todos for delete to authenticated
  using (user_id = auth.uid());

-- Results of already-applied client operations, for idempotent retries.
-- RLS is on and there is deliberately no policy: only security definer functions can touch it.
create table applied_ops (
  user_id    uuid,
  op_id      uuid,
  result     jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, op_id)
);

alter table applied_ops enable row level security;

-- Which tables take part in sync, and which fields are copied when a conflict is resolved.
-- Signed-in users may read it and nothing else; the default grants are revoked first.
create table sync_tables (
  name        text primary key,
  copy_fields text[] not null default '{}'
);

alter table sync_tables enable row level security;

create policy sync_tables_select on sync_tables for select to authenticated
  using (true);

revoke all on sync_tables from anon, authenticated;
grant select on sync_tables to authenticated;

insert into sync_tables (name, copy_fields) values ('todos', '{}');
