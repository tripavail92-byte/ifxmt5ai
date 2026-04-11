-- ============================================================
-- IFX EA Terminal Bootstrap / Control Plane Migration
-- Creates terminal host, assignment, installation, config, release,
-- event, and audit tables for the EA-first runtime model.
-- ============================================================

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create table if not exists public.terminal_hosts (
  id            uuid primary key default gen_random_uuid(),
  host_name     text not null unique,
  host_type     text not null check (host_type in ('local','vps','customer-agent')),
  status        text not null default 'offline',
  capacity      int not null default 1 check (capacity > 0),
  metadata      jsonb not null default '{}'::jsonb,
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

drop trigger if exists trg_terminal_hosts_updated_at on public.terminal_hosts;
create trigger trg_terminal_hosts_updated_at
before update on public.terminal_hosts
for each row execute function public.set_updated_at();

create table if not exists public.ea_releases (
  id            uuid primary key default gen_random_uuid(),
  version       text not null,
  channel       text not null default 'stable',
  artifact_url  text,
  sha256        text,
  metadata_json jsonb not null default '{}'::jsonb,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (version, channel)
);

drop trigger if exists trg_ea_releases_updated_at on public.ea_releases;
create trigger trg_ea_releases_updated_at
before update on public.ea_releases
for each row execute function public.set_updated_at();

create table if not exists public.ea_user_configs (
  id            uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.mt5_user_connections(id) on delete cascade,
  version       int not null,
  config_json   jsonb not null default '{}'::jsonb,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (connection_id, version)
);

create unique index if not exists uq_ea_user_configs_active_connection
  on public.ea_user_configs(connection_id)
  where is_active = true;

drop trigger if exists trg_ea_user_configs_updated_at on public.ea_user_configs;
create trigger trg_ea_user_configs_updated_at
before update on public.ea_user_configs
for each row execute function public.set_updated_at();

create table if not exists public.terminal_assignments (
  id                 uuid primary key default gen_random_uuid(),
  connection_id      uuid not null references public.mt5_user_connections(id) on delete cascade,
  host_id            uuid not null references public.terminal_hosts(id) on delete cascade,
  status             text not null default 'pending',
  install_token      text not null unique,
  release_channel    text not null default 'stable',
  terminal_path      text,
  activation_details jsonb not null default '{}'::jsonb,
  last_error         text,
  assigned_at        timestamptz not null default now(),
  activated_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_terminal_assignments_host_status
  on public.terminal_assignments(host_id, status, assigned_at);

drop trigger if exists trg_terminal_assignments_updated_at on public.terminal_assignments;
create trigger trg_terminal_assignments_updated_at
before update on public.terminal_assignments
for each row execute function public.set_updated_at();

create table if not exists public.ea_installations (
  id            uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.mt5_user_connections(id) on delete cascade,
  host_id       uuid references public.terminal_hosts(id) on delete set null,
  terminal_path text,
  ea_version    text,
  config_version int,
  status        text not null default 'starting',
  install_token text not null unique,
  metadata_json jsonb not null default '{}'::jsonb,
  last_metrics  jsonb not null default '{}'::jsonb,
  last_error    text,
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (connection_id)
);

drop trigger if exists trg_ea_installations_updated_at on public.ea_installations;
create trigger trg_ea_installations_updated_at
before update on public.ea_installations
for each row execute function public.set_updated_at();

create table if not exists public.ea_runtime_events (
  id            bigserial primary key,
  connection_id uuid not null references public.mt5_user_connections(id) on delete cascade,
  event_type    text not null,
  payload       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists idx_ea_runtime_events_connection_created
  on public.ea_runtime_events(connection_id, created_at desc);

create table if not exists public.ea_trade_audit (
  id              uuid primary key default gen_random_uuid(),
  connection_id   uuid not null references public.mt5_user_connections(id) on delete cascade,
  symbol          text not null,
  side            text not null,
  entry           numeric,
  sl              numeric,
  tp              numeric,
  volume          numeric,
  decision_reason text,
  broker_ticket   text,
  status          text not null default 'unknown',
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists idx_ea_trade_audit_connection_created
  on public.ea_trade_audit(connection_id, created_at desc);