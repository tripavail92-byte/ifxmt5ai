-- ==========================================================================
-- Phase 5: ea_trade_audit table
-- Run idempotently in Supabase SQL Editor
-- ==========================================================================
-- The EA POSTs to POST /api/ea/trade-audit after each order open and close.
-- The dashboard reads from this table via GET /api/ea/trade-audit.

create table if not exists public.ea_trade_audit (
  id              uuid        primary key default gen_random_uuid(),
  connection_id   uuid        not null references public.mt5_user_connections(id) on delete cascade,
  symbol          text        not null,
  side            text        not null,    -- buy | sell | buy_close | sell_close
  entry           numeric,
  sl              numeric,
  tp              numeric,
  volume          numeric,
  decision_reason text,
  broker_ticket   text,
  status          text        not null default 'unknown',  -- open | closed | failed
  payload         jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists idx_ea_trade_audit_connection_created
  on public.ea_trade_audit (connection_id, created_at desc);

-- ── Row-level security ──────────────────────────────────────────────────────
alter table public.ea_trade_audit enable row level security;

drop policy if exists "ea_trade_audit: owner read"   on public.ea_trade_audit;
drop policy if exists "ea_trade_audit: owner insert" on public.ea_trade_audit;

create policy "ea_trade_audit: owner read"
  on public.ea_trade_audit
  for select
  to authenticated
  using (
    connection_id in (
      select id from public.mt5_user_connections where user_id = auth.uid()
    )
  );

create policy "ea_trade_audit: owner insert"
  on public.ea_trade_audit
  for insert
  to authenticated
  with check (
    connection_id in (
      select id from public.mt5_user_connections where user_id = auth.uid()
    )
  );
