-- ============================================================
-- IFX MT5 — Phase 1: EA v9.30 Schema Migration
-- Migrates trading_setups and ea_user_configs to support the
-- IFX_6Gate_Sniper_Turbo v9.30 config model.
-- Also creates ea_live_state for real-time HUD mirroring.
--
-- Safe to re-run (idempotent).
-- Run in Supabase SQL Editor AFTER ea_terminal_bootstrap_migration.sql.
-- ============================================================


-- -----------------------------------------------
-- 1) trading_setups: add v9.30 zone fields
--    Old fields (entry_price, zone_percent, etc.) are retained
--    as nullable for backward compatibility with existing rows.
-- -----------------------------------------------

-- Make entry_price nullable (old rows keep their value; new rows use pivot instead)
do $$ begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'trading_setups'
      and column_name  = 'entry_price'
      and is_nullable  = 'NO'
  ) then
    alter table public.trading_setups alter column entry_price drop not null;
  end if;
end $$;

-- pivot — zone anchor price (replaces entry_price as primary level)
alter table public.trading_setups
  add column if not exists pivot numeric;

-- tp1 / tp2 — explicit target levels (v9.30 replaces single derived TP)
alter table public.trading_setups
  add column if not exists tp1 numeric;

alter table public.trading_setups
  add column if not exists tp2 numeric;

-- atr_zone_pct — zone thickness as % of daily ATR (i_atrPct, default 10)
alter table public.trading_setups
  add column if not exists atr_zone_pct numeric not null default 10.0;

-- sl_pad_mult — SL spread multiplier (i_slPadMult, default 2.0)
alter table public.trading_setups
  add column if not exists sl_pad_mult numeric not null default 2.0;

-- bias column — explicit typed bias stored alongside side
-- ('buy', 'sell', 'neutral') — maps to ENUM_TRADE_BIAS in the EA
alter table public.trading_setups
  add column if not exists bias text not null default 'neutral'
  check (bias in ('buy', 'sell', 'neutral'));


-- -----------------------------------------------
-- 2) trading_setups: add arm / TRADE NOW columns
--    (trade_now_active already added by trade_now_migration.sql)
-- -----------------------------------------------

-- ai_text — raw AI brain text pasted by the user (parsed on the front end)
alter table public.trading_setups
  add column if not exists ai_text text;

-- config_snapshot — JSON snapshot of the full EA config used when setup was armed
alter table public.trading_setups
  add column if not exists config_snapshot jsonb not null default '{}'::jsonb;


-- -----------------------------------------------
-- 3) ea_live_state
--    One row per connection — upserted from ea_runtime_events
--    "hud_state" payloads so the dashboard can show the live HUD
--    without replaying the event log.
-- -----------------------------------------------
create table if not exists public.ea_live_state (
  connection_id    uuid primary key
                   references public.mt5_user_connections(id) on delete cascade,

  -- HUD status mirror: ASLEEP / STALKING / PURGATORY / DEAD / IN_TRADE / BLEEDING / MAX_TRADES
  hud_status       text not null default 'ASLEEP',

  -- Active setup values echoed back from the EA
  sys_bias         text,
  sys_pivot        numeric,
  sys_tp1          numeric,
  sys_tp2          numeric,
  invalidation_lvl numeric,

  -- Live position snapshot
  live_sl          numeric,
  live_lots        numeric,
  is_inside_zone   boolean not null default false,
  is_be_secured    boolean not null default false,
  unrealised_pnl   numeric,

  -- Daily counters
  daily_trades_count  int not null default 0,
  daily_pnl_usd       numeric not null default 0,

  -- Top ledger — last 4 closed trades cached as JSON array
  -- Format: [{ ticket, symbol, side, entry, exit, pnl, close_time }]
  top_ledger       jsonb not null default '[]'::jsonb,

  -- Meta
  raw_hud_payload  jsonb not null default '{}'::jsonb,
  updated_at       timestamptz not null default now()
);

create index if not exists idx_ea_live_state_updated_at
  on public.ea_live_state(updated_at);

-- RLS: only the connection owner can read their live state
alter table public.ea_live_state enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'ea_live_state'
      and policyname = 'ea_live_state_owner_read'
  ) then
    execute $pol$
      create policy "ea_live_state_owner_read"
        on public.ea_live_state for select
        using (
          connection_id in (
            select id from public.mt5_user_connections
            where user_id = auth.uid()
          )
        )
    $pol$;
  end if;
end $$;


-- -----------------------------------------------
-- 4) Upsert helper RPC for ea_live_state
--    Called by the relay agent / control plane when a
--    hud_state event is received from the EA.
-- -----------------------------------------------
create or replace function public.upsert_ea_live_state(
  p_connection_id    uuid,
  p_hud_status       text,
  p_sys_bias         text         default null,
  p_sys_pivot        numeric      default null,
  p_sys_tp1          numeric      default null,
  p_sys_tp2          numeric      default null,
  p_invalidation_lvl numeric      default null,
  p_live_sl          numeric      default null,
  p_live_lots        numeric      default null,
  p_is_inside_zone   boolean      default false,
  p_is_be_secured    boolean      default false,
  p_unrealised_pnl   numeric      default null,
  p_daily_trades     int          default 0,
  p_daily_pnl_usd    numeric      default 0,
  p_top_ledger       jsonb        default '[]'::jsonb,
  p_raw_payload      jsonb        default '{}'::jsonb
) returns void language plpgsql security definer as $$
begin
  insert into public.ea_live_state (
    connection_id, hud_status,
    sys_bias, sys_pivot, sys_tp1, sys_tp2, invalidation_lvl,
    live_sl, live_lots, is_inside_zone, is_be_secured, unrealised_pnl,
    daily_trades_count, daily_pnl_usd,
    top_ledger, raw_hud_payload, updated_at
  ) values (
    p_connection_id, p_hud_status,
    p_sys_bias, p_sys_pivot, p_sys_tp1, p_sys_tp2, p_invalidation_lvl,
    p_live_sl, p_live_lots, p_is_inside_zone, p_is_be_secured, p_unrealised_pnl,
    p_daily_trades, p_daily_pnl_usd,
    p_top_ledger, p_raw_payload, now()
  )
  on conflict (connection_id) do update set
    hud_status         = excluded.hud_status,
    sys_bias           = excluded.sys_bias,
    sys_pivot          = excluded.sys_pivot,
    sys_tp1            = excluded.sys_tp1,
    sys_tp2            = excluded.sys_tp2,
    invalidation_lvl   = excluded.invalidation_lvl,
    live_sl            = excluded.live_sl,
    live_lots          = excluded.live_lots,
    is_inside_zone     = excluded.is_inside_zone,
    is_be_secured      = excluded.is_be_secured,
    unrealised_pnl     = excluded.unrealised_pnl,
    daily_trades_count = excluded.daily_trades_count,
    daily_pnl_usd      = excluded.daily_pnl_usd,
    top_ledger         = excluded.top_ledger,
    raw_hud_payload    = excluded.raw_hud_payload,
    updated_at         = now();
end $$;


-- -----------------------------------------------
-- 5) ea_user_configs: bump active config to schema v3
--    (Only needed commentary — the config_json column is
--     already jsonb; the frontend will write v3 payloads from
--     this migration onwards. No column change required.)
-- -----------------------------------------------
-- NOTE: Existing active configs will be re-published as v3 payloads
-- the next time the UI saves or the backend repopulates them.
-- Old v2 rows are kept for audit; only one row has is_active = true.


-- ============================================================
-- Done. Changes applied:
--   trading_setups:  pivot, tp1, tp2, atr_zone_pct, sl_pad_mult,
--                    bias, ai_text, config_snapshot columns added.
--                    entry_price made nullable.
--   ea_live_state:   new table + upsert_ea_live_state() RPC
--   (ea_user_configs config_json already jsonb — no DDL change)
-- ============================================================
