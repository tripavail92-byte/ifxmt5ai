-- ==========================================================================
-- Phase 4: EA Commands + Acks tables
-- Run idempotently in Supabase SQL Editor
-- ==========================================================================

-- ── ea_commands ──────────────────────────────────────────────────────────────
-- Commands enqueued by the dashboard for a specific EA connection.
-- The EA polls GET /api/ea/commands?connection_id=...&cursor=...
-- and POSTs an ack to /api/ea/commands/ack after execution.

create sequence if not exists ea_commands_sequence_no_seq start 1 increment 1;

create table if not exists public.ea_commands (
  id                uuid        primary key default gen_random_uuid(),
  connection_id     uuid        not null references public.mt5_user_connections(id) on delete cascade,
  command_type      text        not null,          -- arm_trade | close_position | sync_config | cancel_trade | manual_trade
  payload_json      jsonb       not null default '{}'::jsonb,
  sequence_no       bigint      not null default nextval('ea_commands_sequence_no_seq'),
  idempotency_key   text        not null,
  status            text        not null default 'pending' check (status in ('pending','acknowledged','failed','expired')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  expires_at        timestamptz,

  constraint ea_commands_idempotency_key_uq unique (idempotency_key)
);

-- Fast paging: connection + pending status + cursor advancement
create index if not exists idx_ea_commands_conn_status_seq
  on public.ea_commands (connection_id, status, sequence_no)
  where status = 'pending';

-- ── ea_command_acks ───────────────────────────────────────────────────────────
-- One ack row per command (upserted by ack endpoint).

create table if not exists public.ea_command_acks (
  command_id          uuid        primary key references public.ea_commands(id) on delete cascade,
  connection_id       uuid        not null,
  sequence_no         bigint      not null,
  status              text        not null default 'acknowledged',
  ack_payload_json    jsonb       not null default '{}'::jsonb,
  acknowledged_at     timestamptz not null default now(),
  created_at          timestamptz not null default now()
);

create index if not exists idx_ea_command_acks_conn
  on public.ea_command_acks (connection_id);

-- ── ea_installations: add cursor column if absent ───────────────────────────
alter table public.ea_installations
  add column if not exists last_command_sequence bigint not null default 0;

alter table public.ea_installations
  add column if not exists applied_config_version int;

-- ── Row-level security ───────────────────────────────────────────────────────
alter table public.ea_commands      enable row level security;
alter table public.ea_command_acks  enable row level security;

-- Service role bypasses RLS; restrict authenticated users to their own connections
create policy if not exists "ea_commands: owner read"
  on public.ea_commands
  for select
  to authenticated
  using (
    connection_id in (
      select id from public.mt5_user_connections where user_id = auth.uid()
    )
  );

create policy if not exists "ea_commands: owner insert"
  on public.ea_commands
  for insert
  to authenticated
  with check (
    connection_id in (
      select id from public.mt5_user_connections where user_id = auth.uid()
    )
  );

create policy if not exists "ea_command_acks: owner read"
  on public.ea_command_acks
  for select
  to authenticated
  using (
    connection_id in (
      select id from public.mt5_user_connections where user_id = auth.uid()
    )
  );
