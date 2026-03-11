-- runtime_hardening_migration.sql
-- Adds immutable snapshot columns to structure events for audit / analytics.

alter table public.setup_structure_events
  add column if not exists connection_id uuid references public.mt5_user_connections(id) on delete set null,
  add column if not exists symbol text,
  add column if not exists side text check (side in ('buy','sell')),
  add column if not exists entry_price_snapshot numeric,
  add column if not exists sl_snapshot numeric,
  add column if not exists tp_snapshot numeric,
  add column if not exists zone_low_snapshot numeric,
  add column if not exists zone_high_snapshot numeric,
  add column if not exists ai_sensitivity_snapshot int;

create index if not exists idx_structure_events_conn_created
  on public.setup_structure_events(connection_id, created_at desc);
