-- ==========================================================================
-- Phase 6: AutoRR columns on trading_setups
-- Run idempotently in Supabase SQL Editor
-- ==========================================================================
-- These columns support the AutoRR feature added in Phase 6:
--   use_auto_rr  — when true, the EA computes TP1/TP2 from RR multiples
--   auto_rr1     — R:R multiple for TP1 (e.g. 1.0 = 1:1)
--   auto_rr2     — R:R multiple for TP2 (e.g. 2.0 = 1:2)

-- use_auto_rr — boolean flag
alter table public.trading_setups
  add column if not exists use_auto_rr boolean not null default false;

-- auto_rr1 — R:R multiple for TP1 (default 1.0)
alter table public.trading_setups
  add column if not exists auto_rr1 numeric not null default 1.0;

-- auto_rr2 — R:R multiple for TP2 (default 2.0)
alter table public.trading_setups
  add column if not exists auto_rr2 numeric not null default 2.0;
