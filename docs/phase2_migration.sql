-- ============================================================
-- IFX AI Trading Portal — Phase 2 SQL Migration
-- Run in Supabase SQL Editor after Phase 1 migration
-- ============================================================

-- -----------------------------------------------
-- 1) user_strategies
-- -----------------------------------------------
create table if not exists public.user_strategies (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  connection_id     uuid not null references public.mt5_user_connections(id) on delete cascade,
  is_active         boolean not null default true,

  -- Risk parameters
  risk_percent      numeric not null default 1.0 check (risk_percent > 0 and risk_percent <= 100),
  max_daily_trades  int     not null default 5    check (max_daily_trades > 0),
  max_open_trades   int     not null default 3    check (max_open_trades > 0),

  -- Symbol + timeframe
  allowed_symbols   text[]  not null default '{}',
  timeframe         text    not null default 'H1',

  -- Risk:Reward
  rr_min            numeric not null default 1.5,
  rr_max            numeric not null default 5.0,

  -- Session / news / volatility filters
  filters_json      jsonb   not null default '{}'::jsonb,

  last_evaluated_at timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- One active strategy per connection (can have multiple, but only one active)
create unique index if not exists uq_user_strategies_active_connection
  on public.user_strategies(connection_id)
  where is_active = true;

create index if not exists idx_user_strategies_user_id
  on public.user_strategies(user_id);

-- auto-update updated_at (reuses set_updated_at from Phase 1)
drop trigger if exists trg_user_strategies_updated_at on public.user_strategies;
create trigger trg_user_strategies_updated_at
before update on public.user_strategies
for each row execute function public.set_updated_at();

-- -----------------------------------------------
-- 2) ai_trade_decisions
-- -----------------------------------------------
create table if not exists public.ai_trade_decisions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  connection_id    uuid not null references public.mt5_user_connections(id) on delete cascade,
  strategy_id      uuid not null references public.user_strategies(id) on delete cascade,

  symbol           text    not null,
  direction        text    not null check (direction in ('buy','sell')),
  entry_price      numeric,
  sl               numeric,
  tp               numeric,
  volume           numeric,          -- calculated lot size, per user
  rr_actual        numeric,          -- actual risk:reward of this setup
  pip_risk         numeric,          -- sl distance in pips
  balance_snapshot numeric,          -- balance used for lot size calc

  reasoning        jsonb   not null default '{}'::jsonb, -- indicators, signals, metadata
  decision         text    not null check (decision in ('accepted','rejected')),
  rejection_reason text,

  trade_job_id     uuid references public.trade_jobs(id) on delete set null,

  created_at       timestamptz not null default now()
);

create index if not exists idx_ai_decisions_connection_created
  on public.ai_trade_decisions(connection_id, created_at desc);

create index if not exists idx_ai_decisions_user_created
  on public.ai_trade_decisions(user_id, created_at desc);

-- -----------------------------------------------
-- 3) RPC: get_active_strategies_for_eval
-- Returns all active strategies with their connection info,
-- ready for the AI evaluator to loop over.
-- -----------------------------------------------
create or replace function public.get_active_strategies_for_eval()
returns table (
  strategy_id    uuid,
  user_id        uuid,
  connection_id  uuid,
  risk_percent   numeric,
  max_daily_trades int,
  max_open_trades  int,
  allowed_symbols  text[],
  timeframe        text,
  rr_min           numeric,
  rr_max           numeric,
  filters_json     jsonb,
  account_login    text,
  broker_server    text,
  last_metrics     jsonb
)
language sql
security definer
as $$
  select
    s.id           as strategy_id,
    s.user_id,
    s.connection_id,
    s.risk_percent,
    s.max_daily_trades,
    s.max_open_trades,
    s.allowed_symbols,
    s.timeframe,
    s.rr_min,
    s.rr_max,
    s.filters_json,
    c.account_login,
    c.broker_server,
    coalesce(h.last_metrics, '{}'::jsonb) as last_metrics
  from public.user_strategies s
  join public.mt5_user_connections c
    on c.id = s.connection_id
   and c.is_active = true
   and c.status = 'online'
  left join public.mt5_worker_heartbeats h
    on h.connection_id = s.connection_id
   and h.mt5_initialized = true
  where s.is_active = true
$$;

-- -----------------------------------------------
-- 4) RPC: count_daily_trades(connection_id)
-- Used to enforce max_daily_trades.
-- -----------------------------------------------
create or replace function public.count_daily_trades(p_connection_id uuid)
returns int
language sql
security definer
as $$
  select count(*)::int
  from public.trade_jobs
  where connection_id = p_connection_id
    and status in ('queued','claimed','executing','success')
    and created_at >= date_trunc('day', now() at time zone 'UTC')
$$;

-- -----------------------------------------------
-- 5) RPC: count_open_trades(connection_id)
-- Used to enforce max_open_trades.
-- -----------------------------------------------
create or replace function public.count_open_trades(p_connection_id uuid)
returns int
language sql
security definer
as $$
  select count(*)::int
  from public.trade_jobs
  where connection_id = p_connection_id
    and status in ('queued','claimed','executing')
$$;

-- -----------------------------------------------
-- 6) RPC: insert_ai_decision_and_job
-- Atomically inserts an ai_trade_decision and
-- (if accepted) a trade_job in one transaction.
-- -----------------------------------------------
create or replace function public.insert_ai_decision_and_job(
  p_user_id          uuid,
  p_connection_id    uuid,
  p_strategy_id      uuid,
  p_symbol           text,
  p_direction        text,
  p_entry_price      numeric,
  p_sl               numeric,
  p_tp               numeric,
  p_volume           numeric,
  p_rr_actual        numeric,
  p_pip_risk         numeric,
  p_balance_snapshot numeric,
  p_reasoning        jsonb,
  p_decision         text,
  p_rejection_reason text default null
)
returns uuid   -- returns ai_trade_decision id
language plpgsql
security definer
as $$
declare
  v_decision_id uuid;
  v_job_id      uuid;
  v_comment     text;
begin
  -- Insert AI decision record
  insert into public.ai_trade_decisions (
    user_id, connection_id, strategy_id,
    symbol, direction, entry_price, sl, tp,
    volume, rr_actual, pip_risk, balance_snapshot,
    reasoning, decision, rejection_reason
  ) values (
    p_user_id, p_connection_id, p_strategy_id,
    p_symbol, p_direction, p_entry_price, p_sl, p_tp,
    p_volume, p_rr_actual, p_pip_risk, p_balance_snapshot,
    coalesce(p_reasoning, '{}'::jsonb), p_decision, p_rejection_reason
  )
  returning id into v_decision_id;

  -- If accepted → create trade_job
  if p_decision = 'accepted' then
    v_job_id := gen_random_uuid();
    v_comment := 'IFX:' || v_job_id::text;

    insert into public.trade_jobs (
      id, connection_id, symbol, side, volume, sl, tp,
      comment, idempotency_key, status
    ) values (
      v_job_id,
      p_connection_id,
      p_symbol,
      p_direction,
      p_volume,
      p_sl,
      p_tp,
      v_comment,
      v_job_id::text,   -- idempotency_key = job_id
      'queued'
    );

    -- Link trade_job back to decision
    update public.ai_trade_decisions
    set trade_job_id = v_job_id
    where id = v_decision_id;
  end if;

  return v_decision_id;
end $$;

-- -----------------------------------------------
-- 7) RPC: mark_strategy_evaluated(strategy_id)
-- -----------------------------------------------
create or replace function public.mark_strategy_evaluated(p_strategy_id uuid)
returns void
language sql
security definer
as $$
  update public.user_strategies
  set last_evaluated_at = now()
  where id = p_strategy_id
$$;
