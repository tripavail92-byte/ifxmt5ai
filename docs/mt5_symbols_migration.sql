-- ============================================================
-- mt5_symbols — stores live symbol list per connection
-- Run in Supabase SQL Editor ONCE
-- ============================================================

CREATE TABLE IF NOT EXISTS public.mt5_symbols (
  connection_id UUID NOT NULL REFERENCES public.mt5_user_connections(id) ON DELETE CASCADE,
  symbol        TEXT NOT NULL,
  description   TEXT,
  currency_base TEXT,
  category      TEXT,
  updated_at    TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (connection_id, symbol)
);

-- RLS: users can only read symbols for their own connections
ALTER TABLE public.mt5_symbols ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own symbols"
  ON public.mt5_symbols FOR SELECT
  USING (
    connection_id IN (
      SELECT id FROM public.mt5_user_connections WHERE user_id = auth.uid()
    )
  );

-- Service role (worker) can write freely (bypasses RLS)
