-- ============================================================
-- IFX MT5 — Economic Events Table Migration
-- Stores cached economic calendar events for frontend display.
-- Populated by runtime/news_refresh.py (run periodically).
-- Run in Supabase SQL Editor (idempotent — safe to re-run)
-- ============================================================

create table if not exists public.economic_events (
  id                  text primary key,             -- e.g. "ecb-ecb_rate-2026-04-02"
  provider            text not null,                -- ecb/ons/boj/fred/etc.
  currency            text not null,                -- USD, EUR, GBP, JPY, etc.
  country             text not null,
  title               text not null,                -- display name
  impact              text not null                 -- high / medium / low
                      check (impact in ('high', 'medium', 'low', 'unknown')),
  scheduled_at_utc    timestamptz not null,         -- UTC event time
  category            text not null default 'macro', -- inflation/labor/central_bank/growth/etc.
  event_json          jsonb not null default '{}'::jsonb,
  synced_at           timestamptz not null default now()
);

-- Speed up the terminal's "upcoming events next 24h" query
create index if not exists idx_economic_events_scheduled
  on public.economic_events(scheduled_at_utc asc);

create index if not exists idx_economic_events_currency_impact
  on public.economic_events(currency, impact);

-- Anyone authenticated can read (news data is not sensitive)
alter table public.economic_events enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'economic_events'
      and policyname = 'economic_events_public_read'
  ) then
    create policy economic_events_public_read
      on public.economic_events
      for select
      to authenticated
      using (true);
  end if;
end $$;

-- Service role can insert/update (used by news_refresh.py via service key)
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'economic_events'
      and policyname = 'economic_events_service_write'
  ) then
    create policy economic_events_service_write
      on public.economic_events
      for all
      to service_role
      using (true)
      with check (true);
  end if;
end $$;
