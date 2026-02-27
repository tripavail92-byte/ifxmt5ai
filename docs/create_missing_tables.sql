-- ============================================================
-- IFX MT5 — CREATE MISSING TABLES
-- These tables don't exist yet in your Supabase project.
-- Run this in Supabase SQL Editor.
-- It is safe to re-run — uses CREATE TABLE IF NOT EXISTS.
-- ============================================================

-- Required enums (run first)
do $$ begin
  if not exists (select 1 from pg_type where typname = 'mt5_worker_status') then
    create type mt5_worker_status as enum ('starting','online','degraded','error');
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
-- mt5_worker_heartbeats
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
-- trade_jobs
-- -----------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

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
-- mt5_runtime_events
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

-- -----------------------------------------------
-- user_strategies
-- -----------------------------------------------
create table if not exists public.user_strategies (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  connection_id     uuid not null references public.mt5_user_connections(id) on delete cascade,
  is_active         boolean not null default true,
  risk_percent      numeric not null default 1.0 check (risk_percent > 0 and risk_percent <= 100),
  max_daily_trades  int not null default 5 check (max_daily_trades > 0),
  max_open_trades   int not null default 3 check (max_open_trades > 0),
  allowed_symbols   text[] not null default '{}',
  timeframe         text not null default 'H1',
  rr_min            numeric not null default 1.5,
  rr_max            numeric not null default 5.0,
  filters_json      jsonb not null default '{}'::jsonb,
  last_evaluated_at timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index if not exists uq_user_strategies_active_connection
  on public.user_strategies(connection_id) where is_active = true;

-- -----------------------------------------------
-- ai_trade_decisions
-- -----------------------------------------------
create table if not exists public.ai_trade_decisions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  connection_id    uuid not null references public.mt5_user_connections(id) on delete cascade,
  strategy_id      uuid not null references public.user_strategies(id) on delete cascade,
  symbol           text not null,
  direction        text not null check (direction in ('buy','sell')),
  entry_price      numeric,
  sl               numeric,
  tp               numeric,
  volume           numeric,
  rr_actual        numeric,
  pip_risk         numeric,
  balance_snapshot numeric,
  reasoning        jsonb not null default '{}'::jsonb,
  decision         text not null check (decision in ('accepted','rejected')),
  rejection_reason text,
  trade_job_id     uuid references public.trade_jobs(id) on delete set null,
  created_at       timestamptz not null default now()
);

-- -----------------------------------------------
-- RPCs
-- -----------------------------------------------

create or replace function public.claim_trade_job(
  p_connection_id uuid, p_claimed_by text, p_claim_timeout_seconds int default 60
) returns public.trade_jobs language plpgsql security definer as $$
declare v_job public.trade_jobs;
begin
  select * into v_job from public.trade_jobs
  where connection_id = p_connection_id
    and (status in ('queued','retry')
      or (status = 'claimed' and claimed_at < now() - make_interval(secs => p_claim_timeout_seconds)))
  order by created_at asc limit 1 for update skip locked;
  if not found then return null; end if;
  update public.trade_jobs set status='claimed', claimed_by=p_claimed_by, claimed_at=now()
  where id=v_job.id returning * into v_job;
  return v_job;
end $$;

create or replace function public.mark_trade_job_executing(p_job_id uuid)
returns public.trade_jobs language plpgsql security definer as $$
declare v_job public.trade_jobs;
begin
  update public.trade_jobs set status='executing' where id=p_job_id returning * into v_job;
  return v_job;
end $$;

create or replace function public.complete_trade_job(
  p_job_id uuid, p_status trade_job_status,
  p_result jsonb default '{}'::jsonb,
  p_error text default null, p_error_code text default null
) returns public.trade_jobs language plpgsql security definer as $$
declare v_job public.trade_jobs;
begin
  update public.trade_jobs set
    status=p_status,
    executed_at=case when p_status in ('success','failed') then now() else executed_at end,
    result=coalesce(p_result,'{}'::jsonb), error=p_error, error_code=p_error_code
  where id=p_job_id and status!='success' returning * into v_job;
  return v_job;
end $$;

create or replace function public.retry_trade_job(
  p_job_id uuid, p_error text, p_error_code text default null
) returns public.trade_jobs language plpgsql security definer as $$
declare v_job public.trade_jobs;
begin
  update public.trade_jobs set status='retry', retry_count=retry_count+1,
    error=p_error, error_code=p_error_code
  where id=p_job_id returning * into v_job;
  return v_job;
end $$;

create or replace function public.log_mt5_runtime_event(
  p_connection_id uuid, p_level runtime_event_level,
  p_component runtime_component, p_message text, p_details jsonb default '{}'::jsonb
) returns void language plpgsql security definer as $$
begin
  insert into public.mt5_runtime_events(connection_id,level,component,message,details)
  values(p_connection_id,p_level,p_component,p_message,coalesce(p_details,'{}'::jsonb));
end $$;

-- ============================================================
-- Done. Tables created:
--   mt5_worker_heartbeats
--   trade_jobs
--   mt5_runtime_events
--   user_strategies
--   ai_trade_decisions
-- ============================================================
