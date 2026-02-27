-- ============================================================
-- IFX MT5 — QUICK PATCH for existing mt5_user_connections
-- Run in Supabase SQL Editor
-- Uses IF NOT EXISTS — safe to run even if column already exists
-- ============================================================

-- Runtime status fields
alter table public.mt5_user_connections
  add column if not exists is_active              boolean not null default true,
  add column if not exists status                 text not null default 'offline',
  add column if not exists last_seen_at           timestamptz,
  add column if not exists last_error             text,
  add column if not exists last_ok_at             timestamptz;

-- Encrypted credential fields (if not already there)
alter table public.mt5_user_connections
  add column if not exists password_ciphertext_b64 text,
  add column if not exists password_nonce_b64      text;

-- Poller / connection test fields
alter table public.mt5_user_connections
  add column if not exists test_request_id         uuid,
  add column if not exists last_test_ok            boolean,
  add column if not exists last_test_error         text,
  add column if not exists last_test_latency_ms    int,
  add column if not exists last_test_result        jsonb,
  add column if not exists last_test_at            timestamptz;

-- Confirm
select column_name
from information_schema.columns
where table_name = 'mt5_user_connections'
order by ordinal_position;
