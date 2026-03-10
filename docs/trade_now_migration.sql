-- ============================================================
-- IFX AI Trading Portal — "Trade Now" Column Migration
-- Adds trade_now_active to trading_setups.
-- Run in Supabase SQL Editor (idempotent — safe to re-run)
-- ============================================================

-- Add trade_now_active column to trading_setups if it doesn't exist.
-- When true: setup_manager will fire a 0.01-lot market order the moment
-- state == STALKING AND a matching structure break (CHOCH/BOS) is detected.
-- After trade is fired, setup_manager resets this to false (one-shot).

do $$ begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'trading_setups'
  ) then
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name   = 'trading_setups'
        and column_name  = 'trade_now_active'
    ) then
      alter table public.trading_setups
        add column trade_now_active boolean not null default false;
    end if;
  end if;
end $$;

-- Index for fast lookup of armed setups
create index if not exists idx_trading_setups_trade_now
  on public.trading_setups(trade_now_active)
  where trade_now_active = true;
