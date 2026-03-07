-- ============================================================
-- IFX AI Trading Portal — Setup State Machine Tables
-- Run in Supabase SQL Editor (idempotent — safe to re-run)
-- ============================================================

-- -----------------------------------------------
-- 0) updated_at trigger function (idempotent)
-- -----------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- -----------------------------------------------
-- 1) Enum: setup state
-- -----------------------------------------------
do $$ begin
  if not exists (select 1 from pg_type where typname = 'setup_state') then
    create type setup_state as enum ('IDLE', 'STALKING', 'PURGATORY', 'DEAD');
  end if;
end $$;

-- -----------------------------------------------
-- 2) trading_setups
--    One row per user-defined trading setup.
--    Created via the ManualTradeCard in the frontend.
--    State is updated in real-time by the relay state machine.
-- -----------------------------------------------
create table if not exists public.trading_setups (
  id               uuid primary key default gen_random_uuid(),

  -- Ownership
  user_id          uuid not null references auth.users(id) on delete cascade,
  connection_id    uuid not null,  -- FK added below if mt5_user_connections exists

  -- Instrument + direction
  symbol           text not null,
  side             text not null check (side in ('buy', 'sell')),

  -- Zone definition
  entry_price      numeric not null check (entry_price > 0),
  zone_percent     numeric not null default 0.10 check (zone_percent > 0),

  -- Chart timeframe used for structure / CHOCH-BOS evaluation
  -- Stored in API format (e.g., '5m', '1h')
  timeframe        text not null default '5m'
                 check (timeframe in ('1m','3m','5m','15m','30m','1h','4h','1d')),

  -- AI sensitivity (NI) used for structure pivot_window.
  -- Direct correlation: pivot_window = ai_sensitivity (1–10)
  ai_sensitivity   integer not null default 5
                 constraint trading_setups_ai_sensitivity_check
                 check (ai_sensitivity between 1 and 10),

  -- Derived zone boundaries (computed from entry_price + zone_percent)
  -- BUY:  zone_low  = entry * (1 - zone_percent/100)
  --       zone_high = entry * (1 + zone_percent/100)
  -- SELL: same formula — side determines interpretation
  zone_low         numeric not null,
  zone_high        numeric not null,

  -- Key levels derived from side:
  -- BUY:  loss_edge = zone_low   (below entry band → invalid)
  --       target    = zone_high  (upper edge → profit target)
  -- SELL: loss_edge = zone_high  (above entry band → invalid)
  --       target    = zone_low   (lower edge → profit target)
  loss_edge        numeric not null,
  target           numeric not null,

  -- State machine
  -- IDLE      — awaiting price approach
  -- STALKING  — price inside zone band (alert state)
  -- PURGATORY — intrabar wick broke loss_edge; awaiting H1 close
  -- DEAD      — H1 candle closed beyond loss_edge (invalidated)
  state            setup_state not null default 'IDLE',

  -- Epoch seconds of the H1 candle whose CLOSE caused this setup to become DEAD.
  -- Used by C2 resurrection rule: the *next* H1 candle (candle_time > this) can resurrect.
  dead_trigger_candle_time  bigint,

  -- Lifecycle
  is_active        boolean not null default true,
  notes            text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Indexes
create index if not exists idx_trading_setups_connection
  on public.trading_setups(connection_id);

create index if not exists idx_trading_setups_active_symbol
  on public.trading_setups(symbol, is_active) where is_active = true;

create index if not exists idx_trading_setups_user
  on public.trading_setups(user_id);

-- Add FK to mt5_user_connections only if that table exists
do $$ begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public'
               and table_name   = 'mt5_user_connections')
  and not exists (select 1 from information_schema.table_constraints
                  where constraint_name = 'trading_setups_connection_id_fkey'
                    and table_name      = 'trading_setups') then
    alter table public.trading_setups
      add constraint trading_setups_connection_id_fkey
      foreign key (connection_id)
      references public.mt5_user_connections(id)
      on delete cascade;
  end if;
end $$;

-- Auto-updated_at
drop trigger if exists trg_trading_setups_updated_at on public.trading_setups;
create trigger trg_trading_setups_updated_at
before update on public.trading_setups
for each row execute function public.set_updated_at();

-- Ensure new columns exist even if trading_setups was created previously
do $$ begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'trading_setups'
  ) then
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name   = 'trading_setups'
        and column_name  = 'timeframe'
    ) then
      alter table public.trading_setups
        add column timeframe text not null default '5m';
    end if;

    if not exists (
      select 1 from pg_constraint
      where conname = 'trading_setups_timeframe_check'
    ) then
      alter table public.trading_setups
        add constraint trading_setups_timeframe_check
        check (timeframe in ('1m','3m','5m','15m','30m','1h','4h','1d'));
    end if;

    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name   = 'trading_setups'
        and column_name  = 'ai_sensitivity'
    ) then
      alter table public.trading_setups
        add column ai_sensitivity integer not null default 5;
    end if;

    if not exists (
      select 1 from pg_constraint
      where conname = 'trading_setups_ai_sensitivity_check'
    ) then
      alter table public.trading_setups
        add constraint trading_setups_ai_sensitivity_check
        check (ai_sensitivity between 1 and 10);
    end if;
  end if;
end $$;


-- -----------------------------------------------
-- 2b) setup_structure_events
--     CHOCH/BOS (break) events emitted while a setup is STALKING.
--     Written by setup_manager.py and consumed by risk management.
-- -----------------------------------------------
create table if not exists public.setup_structure_events (
  id           bigserial primary key,
  setup_id     uuid not null references public.trading_setups(id) on delete cascade,

  event_type   text not null check (event_type in ('CHOCH', 'BOS')),
  break_dir    text not null check (break_dir in ('bull', 'bear')),
  timeframe    text not null check (timeframe in ('1m','3m','5m','15m','30m','1h','4h','1d')),

  -- The swing level that was broken
  level        numeric not null,
  -- Close price of the candle that triggered the break
  close_price  numeric not null,
  -- Open-time (epoch_s) of the triggering candle on the event timeframe
  candle_time  bigint not null,

  created_at   timestamptz not null default now()
);

create index if not exists idx_structure_events_setup_created
  on public.setup_structure_events(setup_id, created_at desc);

create index if not exists idx_structure_events_created
  on public.setup_structure_events(created_at desc);


-- -----------------------------------------------
-- 3) setup_state_transitions
--    Full audit trail of every state transition.
--    Written asynchronously by setup_manager.py.
-- -----------------------------------------------
create table if not exists public.setup_state_transitions (
  id           bigserial primary key,
  setup_id     uuid not null references public.trading_setups(id) on delete cascade,

  from_state   text not null,   -- previous state
  to_state     text not null,   -- new state

  -- What triggered this transition
  trigger      text not null check (trigger in ('tick', 'h1_close')),

  -- Price that caused the transition
  --   tick trigger    → current mid price
  --   h1_close trigger → H1 candle close price
  price        numeric not null,

  -- For h1_close triggers: the open-time (epoch_s) of the H1 bar that closed
  candle_time  bigint,

  created_at   timestamptz not null default now()
);

create index if not exists idx_setup_transitions_setup_created
  on public.setup_state_transitions(setup_id, created_at desc);

create index if not exists idx_setup_transitions_created
  on public.setup_state_transitions(created_at desc);

-- Auto-purge transitions older than 90 days
-- (optional — add a pg_cron job if desired):
-- select cron.schedule('purge-setup-transitions', '0 3 * * *',
--   $$delete from public.setup_state_transitions where created_at < now() - interval '90 days'$$);


-- -----------------------------------------------
-- 4) Row Level Security
-- -----------------------------------------------

-- trading_setups
alter table public.trading_setups enable row level security;

drop policy if exists "users can manage own setups"  on public.trading_setups;
create policy "users can manage own setups"
  on public.trading_setups
  for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Service role bypasses RLS (needed by setup_manager / relay)
-- No extra policy needed — service role key skips RLS by default.


-- setup_state_transitions (read-only for users; service role writes)
alter table public.setup_state_transitions enable row level security;

drop policy if exists "users can read own setup transitions" on public.setup_state_transitions;
create policy "users can read own setup transitions"
  on public.setup_state_transitions
  for select
  using (
    exists (
      select 1 from public.trading_setups ts
      where ts.id = setup_id
        and ts.user_id = auth.uid()
    )
  );


-- setup_structure_events (read-only for users; service role writes)
alter table public.setup_structure_events enable row level security;

drop policy if exists "users can read own structure events" on public.setup_structure_events;
create policy "users can read own structure events"
  on public.setup_structure_events
  for select
  using (
    exists (
      select 1 from public.trading_setups ts
      where ts.id = setup_id
        and ts.user_id = auth.uid()
    )
  );


-- -----------------------------------------------
-- 5) RPC: upsert_trading_setup
--    Called by ManualTradeCard submit handler.
--    Computes zone_low, zone_high, loss_edge, target from inputs.
-- -----------------------------------------------
-- NOTE: We DROP first because adding/removing parameters changes the function
-- signature (creates a new overload). Dropping ensures one canonical RPC.
drop function if exists public.upsert_trading_setup(
  uuid, uuid, text, text, numeric, numeric, text, uuid
);
drop function if exists public.upsert_trading_setup(
  uuid, uuid, text, text, numeric, numeric, text, text, uuid
);
drop function if exists public.upsert_trading_setup(
  uuid, uuid, text, text, numeric, numeric, text, integer, text, uuid
);
create or replace function public.upsert_trading_setup(
  p_user_id          uuid,
  p_connection_id    uuid,
  p_symbol           text,
  p_side             text,
  p_entry_price      numeric,
  p_zone_percent     numeric,
  p_timeframe        text default '5m',
  p_ai_sensitivity   integer default 5,
  p_notes            text default null,
  p_setup_id         uuid default null   -- if provided, update existing
)
returns uuid
language plpgsql
security definer
as $$
declare
  v_zone_low    numeric;
  v_zone_high   numeric;
  v_loss_edge   numeric;
  v_target      numeric;
  v_id          uuid;
begin
  -- Compute zone boundaries
  v_zone_low  := p_entry_price * (1 - p_zone_percent / 100.0);
  v_zone_high := p_entry_price * (1 + p_zone_percent / 100.0);

  -- Derive loss_edge and target from side
  if p_side = 'buy' then
    v_loss_edge := v_zone_low;
    v_target    := v_zone_high;
  else
    v_loss_edge := v_zone_high;
    v_target    := v_zone_low;
  end if;

  if p_setup_id is not null then
    -- Update existing setup, reset to IDLE
    update public.trading_setups set
      symbol                   = p_symbol,
      side                     = p_side,
      entry_price              = p_entry_price,
      zone_percent             = p_zone_percent,
      timeframe                = coalesce(p_timeframe, '5m'),
      ai_sensitivity            = coalesce(p_ai_sensitivity, 5),
      zone_low                 = v_zone_low,
      zone_high                = v_zone_high,
      loss_edge                = v_loss_edge,
      target                   = v_target,
      state                    = 'IDLE',
      dead_trigger_candle_time = null,
      notes                    = p_notes,
      is_active                = true
    where id = p_setup_id
      and user_id = p_user_id
    returning id into v_id;
  else
    -- Insert new setup
    insert into public.trading_setups (
      user_id, connection_id, symbol, side,
      entry_price, zone_percent, timeframe, ai_sensitivity,
      zone_low, zone_high, loss_edge, target,
      notes
    ) values (
      p_user_id, p_connection_id, p_symbol, p_side,
      p_entry_price, p_zone_percent, coalesce(p_timeframe, '5m'), coalesce(p_ai_sensitivity, 5),
      v_zone_low, v_zone_high, v_loss_edge, v_target,
      p_notes
    )
    returning id into v_id;
  end if;

  return v_id;
end;
$$;


-- -----------------------------------------------
-- 6) RPC: get_setups_for_connection
--    Used by frontend dashboard to display setup states.
-- -----------------------------------------------
-- NOTE: We DROP first because Postgres cannot change the row type of a
-- RETURNS TABLE function via CREATE OR REPLACE.
drop function if exists public.get_setups_for_connection(uuid);
create or replace function public.get_setups_for_connection(
  p_connection_id uuid
)
returns table (
  id                        uuid,
  symbol                    text,
  side                      text,
  entry_price               numeric,
  zone_percent              numeric,
  timeframe                 text,
  ai_sensitivity            integer,
  zone_low                  numeric,
  zone_high                 numeric,
  loss_edge                 numeric,
  target                    numeric,
  state                     text,
  dead_trigger_candle_time  bigint,
  is_active                 boolean,
  notes                     text,
  created_at                timestamptz,
  updated_at                timestamptz
)
language sql
security definer
stable
as $$
  select
    id, symbol, side, entry_price, zone_percent,
    timeframe,
    ai_sensitivity,
    zone_low, zone_high, loss_edge, target,
    state::text, dead_trigger_candle_time,
    is_active, notes, created_at, updated_at
  from public.trading_setups
  where connection_id = p_connection_id
    and is_active     = true
  order by created_at desc;
$$;


-- -----------------------------------------------
-- 7) RPC: deactivate_setup
--    Soft-delete a setup (sets is_active = false).
-- -----------------------------------------------
create or replace function public.deactivate_setup(
  p_setup_id uuid,
  p_user_id  uuid
)
returns boolean
language plpgsql
security definer
as $$
declare v_found boolean;
begin
  update public.trading_setups
  set is_active = false
  where id      = p_setup_id
    and user_id = p_user_id
  returning true into v_found;

  return coalesce(v_found, false);
end;
$$;


-- -----------------------------------------------
-- 8) PostgREST schema cache reload
--    Makes newly created RPCs available immediately.
-- -----------------------------------------------

-- -----------------------------------------------
-- 8) Permissions
--    Some projects revoke default EXECUTE; make it explicit.
-- -----------------------------------------------
grant execute on function public.upsert_trading_setup(
  uuid, uuid, text, text, numeric, numeric, text, integer, text, uuid
) to authenticated;

grant execute on function public.get_setups_for_connection(uuid)
  to authenticated;

grant execute on function public.deactivate_setup(uuid, uuid)
  to authenticated;

grant select on table public.setup_structure_events to authenticated;


-- -----------------------------------------------
-- 9) Enable Supabase Realtime (optional)
--    Needed for `postgres_changes` subscriptions.
-- -----------------------------------------------
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'trading_setups'
    ) then
      execute 'alter publication supabase_realtime add table public.trading_setups';
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'setup_state_transitions'
    ) then
      execute 'alter publication supabase_realtime add table public.setup_state_transitions';
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'setup_structure_events'
    ) then
      execute 'alter publication supabase_realtime add table public.setup_structure_events';
    end if;
  end if;
end $$;


-- -----------------------------------------------
-- 10) PostgREST schema cache reload
--     Makes newly created RPCs available immediately.
-- -----------------------------------------------
notify pgrst, 'reload schema';
