-- ============================================================
-- IFX MT5 — Row Level Security Migration
-- Run this ONCE in Supabase SQL Editor.
-- Enables per-user data isolation across all user-facing tables.
-- The service_role key (used by the Python backend) bypasses RLS.
-- ============================================================

-- -----------------------------------------------
-- mt5_user_connections — users see only their own
-- -----------------------------------------------
ALTER TABLE public.mt5_user_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own connections"
  ON public.mt5_user_connections FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own connections"
  ON public.mt5_user_connections FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own connections"
  ON public.mt5_user_connections FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own connections"
  ON public.mt5_user_connections FOR DELETE
  USING (auth.uid() = user_id);


-- -----------------------------------------------
-- user_strategies — users see only their own
-- -----------------------------------------------
ALTER TABLE public.user_strategies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own strategies"
  ON public.user_strategies FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own strategies"
  ON public.user_strategies FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own strategies"
  ON public.user_strategies FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own strategies"
  ON public.user_strategies FOR DELETE
  USING (auth.uid() = user_id);


-- -----------------------------------------------
-- ai_trade_decisions — users see only their own
-- -----------------------------------------------
ALTER TABLE public.ai_trade_decisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own decisions"
  ON public.ai_trade_decisions FOR SELECT
  USING (auth.uid() = user_id);


-- -----------------------------------------------
-- trade_jobs — users see jobs from their connections
-- -----------------------------------------------
ALTER TABLE public.trade_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own trade jobs"
  ON public.trade_jobs FOR SELECT
  USING (
    connection_id IN (
      SELECT id FROM public.mt5_user_connections WHERE user_id = auth.uid()
    )
  );


-- -----------------------------------------------
-- mt5_worker_heartbeats — users see heartbeats of their connections
-- -----------------------------------------------
ALTER TABLE public.mt5_worker_heartbeats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own heartbeats"
  ON public.mt5_worker_heartbeats FOR SELECT
  USING (
    connection_id IN (
      SELECT id FROM public.mt5_user_connections WHERE user_id = auth.uid()
    )
  );


-- -----------------------------------------------
-- mt5_runtime_events — users see events from their connections
-- -----------------------------------------------
ALTER TABLE public.mt5_runtime_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own runtime events"
  ON public.mt5_runtime_events FOR SELECT
  USING (
    connection_id IN (
      SELECT id FROM public.mt5_user_connections WHERE user_id = auth.uid()
    )
  );

-- ============================================================
-- Done. Each user is now fully isolated.
-- The Python backend uses service_role key which bypasses RLS.
-- ============================================================
