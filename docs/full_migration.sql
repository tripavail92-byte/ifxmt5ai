-- ============================================================
-- IFX AI Trading Portal — FULL DATABASE MIGRATION (v1)
-- New Supabase project — run this ONCE in SQL Editor
-- Creates everything from scratch in dependency order.
-- ============================================================

-- -----------------------------------------------
-- 0) Helper: updated_at trigger function
-- -----------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;


-- -----------------------------------------------
-- 1) Enums
-- -----------------------------------------------
do $$ begin
  if not exists (select 1 from pg_type where typname = 'mt5_connection_status') then
    create type mt5_connection_status as enum (
      'offline','connecting','online','degraded','error','disabled'
    );
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'mt5_worker_status') then
    create type mt5_worker_status as enum (
      'starting','online','degraded','error'
    );
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'trade_job_status') then
    create type trade_job_status as enum (
      'queued','claimed','executing','success','failed','retry','canceled'
    );
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'runtime_event_level') then
    create type runtime_event_level as enum ('info','warn','error');
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'runtime_component') then
    create type runtime_component as enum ('poller','supervisor','worker','scheduler');
  end if;
end $$;


-- -----------------------------------------------
-- 2) mt5_user_connections
--    Core table — every other table FK's into this.
-- -----------------------------------------------
create table if not exists public.mt5_user_connections (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references auth.users(id) on delete cascade,

  -- MT5 credentials (encrypted)
  account_login           text not null,
  broker_server           text not null,
  password_ciphertext_b64 text not null,
  password_nonce_b64      text not null,

  -- Status
  is_active               boolean not null default true,
  status                  mt5_connection_status not null default 'offline',
  last_seen_at            timestamptz,
  last_error              text,
  last_ok_at              timestamptz,

  -- Portal "Test Connection" fields
  test_request_id         uuid,
  last_test_ok            boolean,
  last_test_error         text,
  last_test_latency_ms    int,
  last_test_result        jsonb,
  last_test_at            timestamptz,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index if not exists idx_mt5_user_connections_user_id
  on public.mt5_user_connections(user_id);

create index if not exists idx_mt5_user_connections_active
  on public.mt5_user_connections(is_active) where is_active = true;

drop trigger if exists trg_mt5_user_connections_updated_at on public.mt5_user_connections;
create trigger trg_mt5_user_connections_updated_at
before update on public.mt5_user_connections
for each row execute function public.set_updated_at();


-- -----------------------------------------------
-- 3) mt5_worker_heartbeats
--    One row per connection — upserted by worker every 5s.
-- -----------------------------------------------
create table if not exists public.mt5_worker_heartbeats (
  connection_id    uuid primary key references public.mt5_user_connections(id) on delete cascade,
  pid              int not null,
  host             text not null,
  status           mt5_worker_status not null default 'starting',
  started_at       timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  terminal_path    text,
  mt5_initialized  boolean not null default false,
  account_login    text,
  last_metrics     jsonb not null default '{}'::jsonb
);

create index if not exists idx_mt5_worker_heartbeats_last_seen
  on public.mt5_worker_heartbeats(last_seen_at);


-- -----------------------------------------------
-- 4) trade_jobs
-- -----------------------------------------------
create table if not exists public.trade_jobs (
  id               uuid primary key default gen_random_uuid(),
  connection_id    uuid not null references public.mt5_user_connections(id) on delete cascade,

  symbol           text not null,
  side             text not null check (side in ('buy','sell')),
  volume           numeric not null check (volume > 0),
  sl               numeric,
  tp               numeric,

  comment          text,
  idempotency_key  text not null,

  status           trade_job_status not null default 'queued',
  retry_count      int not null default 0,

  claimed_by       text,
  claimed_at       timestamptz,
  executed_at      timestamptz,

  result           jsonb not null default '{}'::jsonb,
  error            text,
  error_code       text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create unique index if not exists uq_trade_jobs_idempotency
  on public.trade_jobs(connection_id, idempotency_key);

create index if not exists idx_trade_jobs_conn_status_created
  on public.trade_jobs(connection_id, status, created_at);

drop trigger if exists trg_trade_jobs_updated_at on public.trade_jobs;
create trigger trg_trade_jobs_updated_at
before update on public.trade_jobs
for each row execute function public.set_updated_at();


-- -----------------------------------------------
-- 5) mt5_runtime_events
--    WARN/ERROR logged here by workers/supervisor.
-- -----------------------------------------------
create table if not exists public.mt5_runtime_events (
  id            bigserial primary key,
  connection_id uuid references public.mt5_user_connections(id) on delete set null,
  level         runtime_event_level not null,
  component     runtime_component not null,
  message       text not null,
  details       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists idx_mt5_runtime_events_created_at
  on public.mt5_runtime_events(created_at);

create index if not exists idx_mt5_runtime_events_conn_created
  on public.mt5_runtime_events(connection_id, created_at desc);


-- -----------------------------------------------
-- 6) user_strategies
--    Per-user AI trading configuration.
-- -----------------------------------------------
create table if not exists public.user_strategies (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  connection_id     uuid not null references public.mt5_user_connections(id) on delete cascade,
  is_active         boolean not null default true,

  risk_percent      numeric not null default 1.0 check (risk_percent > 0 and risk_percent <= 100),
  max_daily_trades  int     not null default 5   check (max_daily_trades > 0),
  max_open_trades   int     not null default 3   check (max_open_trades > 0),

  allowed_symbols   text[]  not null default '{}',
  timeframe         text    not null default 'H1',

  rr_min            numeric not null default 1.5,
  rr_max            numeric not null default 5.0,

  filters_json      jsonb   not null default '{}'::jsonb,

  last_evaluated_at timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Only ONE active strategy per connection at a time
create unique index if not exists uq_user_strategies_active_connection
  on public.user_strategies(connection_id)
  where is_active = true;

create index if not exists idx_user_strategies_user_id
  on public.user_strategies(user_id);

drop trigger if exists trg_user_strategies_updated_at on public.user_strategies;
create trigger trg_user_strategies_updated_at
before update on public.user_strategies
for each row execute function public.set_updated_at();


-- -----------------------------------------------
-- 7) ai_trade_decisions
--    Full audit log of every AI evaluation.
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
  volume           numeric,
  rr_actual        numeric,
  pip_risk         numeric,
  balance_snapshot numeric,

  reasoning        jsonb   not null default '{}'::jsonb,
  decision         text    not null check (decision in ('accepted','rejected')),
  rejection_reason text,

  trade_job_id     uuid references public.trade_jobs(id) on delete set null,
  created_at       timestamptz not null default now()
);

create index if not exists idx_ai_decisions_connection_created
  on public.ai_trade_decisions(connection_id, created_at desc);

create index if not exists idx_ai_decisions_user_created
  on public.ai_trade_decisions(user_id, created_at desc);


-- ============================================================
-- RPCs
-- ============================================================

-- -----------------------------------------------
-- R1) claim_trade_job
--     Atomic. Also reclaims orphaned 'claimed' jobs.
-- -----------------------------------------------
create or replace function public.claim_trade_job(
  p_connection_id        uuid,
  p_claimed_by           text,
  p_claim_timeout_seconds int default 60
)
returns public.trade_jobs
language plpgsql security definer as $$
declare v_job public.trade_jobs;
begin
  select * into v_job
  from public.trade_jobs
  where connection_id = p_connection_id
    and (
      status in ('queued','retry')
      or (status = 'claimed'
          and claimed_at < now() - make_interval(secs => p_claim_timeout_seconds))
    )
  order by created_at asc
  limit 1
  for update skip locked;

  if not found then return null; end if;

  update public.trade_jobs
  set status = 'claimed', claimed_by = p_claimed_by, claimed_at = now()
  where id = v_job.id
  returning * into v_job;

  return v_job;
end $$;


-- -----------------------------------------------
-- R2) mark_trade_job_executing
-- -----------------------------------------------
create or replace function public.mark_trade_job_executing(p_job_id uuid)
returns public.trade_jobs
language plpgsql security definer as $$
declare v_job public.trade_jobs;
begin
  update public.trade_jobs set status = 'executing'
  where id = p_job_id returning * into v_job;
  return v_job;
end $$;


-- -----------------------------------------------
-- R3) complete_trade_job
--     Guards against overwriting 'success'.
-- -----------------------------------------------
create or replace function public.complete_trade_job(
  p_job_id     uuid,
  p_status     trade_job_status,
  p_result     jsonb   default '{}'::jsonb,
  p_error      text    default null,
  p_error_code text    default null
)
returns public.trade_jobs
language plpgsql security definer as $$
declare v_job public.trade_jobs;
begin
  update public.trade_jobs
  set
    status       = p_status,
    executed_at  = case when p_status in ('success','failed') then now() else executed_at end,
    result       = coalesce(p_result, '{}'::jsonb),
    error        = p_error,
    error_code   = p_error_code
  where id = p_job_id
    and status != 'success'   -- never overwrite a success
  returning * into v_job;
  return v_job;
end $$;


-- -----------------------------------------------
-- R4) retry_trade_job
-- -----------------------------------------------
create or replace function public.retry_trade_job(
  p_job_id     uuid,
  p_error      text,
  p_error_code text default null
)
returns public.trade_jobs
language plpgsql security definer as $$
declare v_job public.trade_jobs;
begin
  update public.trade_jobs
  set status = 'retry', retry_count = retry_count + 1,
      error = p_error, error_code = p_error_code
  where id = p_job_id returning * into v_job;
  return v_job;
end $$;


-- -----------------------------------------------
-- R5) log_mt5_runtime_event
-- -----------------------------------------------
create or replace function public.log_mt5_runtime_event(
  p_connection_id uuid,
  p_level         runtime_event_level,
  p_component     runtime_component,
  p_message       text,
  p_details       jsonb default '{}'::jsonb
)
returns void language plpgsql security definer as $$
begin
  insert into public.mt5_runtime_events(connection_id, level, component, message, details)
  values (p_connection_id, p_level, p_component, p_message, coalesce(p_details, '{}'::jsonb));
end $$;


-- -----------------------------------------------
-- R6) get_active_strategies_for_eval
--     Returns strategies where connection is online + worker initialized.
-- -----------------------------------------------
create or replace function public.get_active_strategies_for_eval()
returns table (
  strategy_id      uuid,
  user_id          uuid,
  connection_id    uuid,
  risk_percent     numeric,
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
language sql security definer as $$
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
    on c.id = s.connection_id and c.is_active = true and c.status = 'online'
  left join public.mt5_worker_heartbeats h
    on h.connection_id = s.connection_id and h.mt5_initialized = true
  where s.is_active = true
$$;


-- -----------------------------------------------
-- R7) count_daily_trades
-- -----------------------------------------------
create or replace function public.count_daily_trades(p_connection_id uuid)
returns int language sql security definer as $$
  select count(*)::int
  from public.trade_jobs
  where connection_id = p_connection_id
    and status in ('queued','claimed','executing','success')
    and created_at >= date_trunc('day', now() at time zone 'UTC')
$$;


-- -----------------------------------------------
-- R8) count_open_trades
-- -----------------------------------------------
create or replace function public.count_open_trades(p_connection_id uuid)
returns int language sql security definer as $$
  select count(*)::int
  from public.trade_jobs
  where connection_id = p_connection_id
    and status in ('queued','claimed','executing')
$$;


-- -----------------------------------------------
-- R9) insert_ai_decision_and_job
--     Atomic: insert ai_trade_decision + trade_job in one TX.
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
returns uuid language plpgsql security definer as $$
declare
  v_decision_id uuid;
  v_job_id      uuid;
begin
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
  ) returning id into v_decision_id;

  if p_decision = 'accepted' then
    v_job_id := gen_random_uuid();

    insert into public.trade_jobs (
      id, connection_id, symbol, side, volume, sl, tp,
      comment, idempotency_key, status
    ) values (
      v_job_id, p_connection_id, p_symbol, p_direction, p_volume, p_sl, p_tp,
      'IFX:' || v_job_id::text,
      v_job_id::text,
      'queued'
    );

    update public.ai_trade_decisions
    set trade_job_id = v_job_id
    where id = v_decision_id;
  end if;

  return v_decision_id;
end $$;


-- -----------------------------------------------
-- R10) mark_strategy_evaluated
-- -----------------------------------------------
create or replace function public.mark_strategy_evaluated(p_strategy_id uuid)
returns void language sql security definer as $$
  update public.user_strategies
  set last_evaluated_at = now()
  where id = p_strategy_id
$$;


-- ============================================================
-- Done. Tables created:
--   mt5_user_connections
--   mt5_worker_heartbeats
--   trade_jobs
--   mt5_runtime_events
--   user_strategies
--   ai_trade_decisions
--
-- RPCs created:
--   claim_trade_job
--   mark_trade_job_executing
--   complete_trade_job
--   retry_trade_job
--   log_mt5_runtime_event
--   get_active_strategies_for_eval
--   count_daily_trades / count_open_trades
--   insert_ai_decision_and_job
--   mark_strategy_evaluated
-- ============================================================
