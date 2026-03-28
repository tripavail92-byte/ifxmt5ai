-- ============================================================
-- IFX Manual Terminal — User Terminal Settings Migration
-- Adds server-backed persistence for terminal preferences and terms gate.
-- Run in Supabase SQL Editor (idempotent — safe to re-run)
-- ============================================================

create table if not exists public.user_terminal_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  preferences_json jsonb not null default '{}'::jsonb,
  terms_version text null,
  terms_accepted_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_user_terminal_settings_updated_at
  on public.user_terminal_settings(updated_at desc);

alter table public.user_terminal_settings enable row level security;

-- Owner can read/write their own settings.
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'user_terminal_settings'
      and policyname = 'user_terminal_settings_select_own'
  ) then
    create policy user_terminal_settings_select_own
      on public.user_terminal_settings
      for select
      to authenticated
      using (auth.uid() = user_id);
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'user_terminal_settings'
      and policyname = 'user_terminal_settings_insert_own'
  ) then
    create policy user_terminal_settings_insert_own
      on public.user_terminal_settings
      for insert
      to authenticated
      with check (auth.uid() = user_id);
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'user_terminal_settings'
      and policyname = 'user_terminal_settings_update_own'
  ) then
    create policy user_terminal_settings_update_own
      on public.user_terminal_settings
      for update
      to authenticated
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end $$;

-- Keep updated_at fresh without requiring clients to remember every time.
create or replace function public.set_user_terminal_settings_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_user_terminal_settings_updated_at on public.user_terminal_settings;
create trigger trg_user_terminal_settings_updated_at
before update on public.user_terminal_settings
for each row
execute function public.set_user_terminal_settings_updated_at();
