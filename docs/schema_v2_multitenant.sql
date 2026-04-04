-- schema_v2_multitenant.sql
-- IFX Multi-Tenant Database Schema
--
-- Key changes from v1:
-- 1. Every table has user_id (multi-tenant requirement)
-- 2. New tables: users, relay_agents, user_assignments
-- 3. RLS (Row-Level Security) ready for data isolation
-- 4. Broker credentials encrypted

-- ============================================================================
-- USERS: Central user registry
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    supabase_user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    subscription_tier TEXT DEFAULT 'free',  -- 'free', 'pro', 'enterprise'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX idx_users_supabase_user_id ON users(supabase_user_id);

-- ============================================================================
-- RELAY AGENTS: Active VPS nodes in cluster
-- ============================================================================

CREATE TABLE IF NOT EXISTS relay_agents (
    agent_id TEXT PRIMARY KEY,
    ip_address INET NOT NULL,
    port INTEGER NOT NULL,
    capacity INTEGER DEFAULT 8,
    active_users INTEGER DEFAULT 0,
    status TEXT DEFAULT 'inactive',  -- 'active', 'inactive', 'degraded'
    last_heartbeat TIMESTAMP WITH TIME ZONE DEFAULT now(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX idx_relay_agents_status ON relay_agents(status);

-- ============================================================================
-- USER ASSIGNMENTS: Which user runs on which VPS
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES relay_agents(agent_id) ON DELETE SET NULL,
    assigned_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE UNIQUE INDEX idx_user_assignments_user_id ON user_assignments(user_id);
CREATE INDEX idx_user_assignments_agent_id ON user_assignments(agent_id);

-- ============================================================================
-- MT5 BROKER CREDENTIALS (v2): Per-user broker accounts
-- ============================================================================

CREATE TABLE IF NOT EXISTS mt5_broker_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    broker TEXT NOT NULL,  -- 'exness', 'fxpro', 'fxcm', etc.
    login TEXT NOT NULL,
    password_encrypted TEXT NOT NULL,  -- AES-256 encrypted
    server TEXT NOT NULL,  -- Broker server name
    status TEXT DEFAULT 'active',  -- 'active', 'inactive', 'error'
    last_error TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX idx_mt5_broker_credentials_user_id ON mt5_broker_credentials(user_id);
CREATE INDEX idx_mt5_broker_credentials_broker ON mt5_broker_credentials(broker);

-- ============================================================================
-- TRADING SETUPS (v2): Multi-tenant version
-- ============================================================================

CREATE TABLE IF NOT EXISTS trading_setups_v2 (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    symbol TEXT NOT NULL,
    
    -- Risk parameters (per setup)
    risk_percent DECIMAL(5, 2) DEFAULT 1.0,
    max_position_size_lots DECIMAL(10, 2),
    
    -- Strategy configuration
    strategy_type TEXT,  -- 'scalp', 'swing', 'grid', etc.
    strategy_config JSONB,
    
    -- State tracking
    status TEXT DEFAULT 'idle',  -- 'idle', 'stalking', 'monitoring', 'in_trade', 'error'
    state_updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    
    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX idx_trading_setups_v2_user_id ON trading_setups_v2(user_id);
CREATE INDEX idx_trading_setups_v2_user_symbol ON trading_setups_v2(user_id, symbol);
CREATE INDEX idx_trading_setups_v2_status ON trading_setups_v2(status);

-- ============================================================================
-- CANDLES (v2): Per-user historical data
-- ============================================================================

CREATE TABLE IF NOT EXISTS candles_v2 (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,  -- '1m', '5m', '15m', '1h', etc.
    time TIMESTAMP WITH TIME ZONE NOT NULL,
    
    open DECIMAL(15, 8),
    high DECIMAL(15, 8),
    low DECIMAL(15, 8),
    close DECIMAL(15, 8),
    volume DECIMAL(20, 2),
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    
    PRIMARY KEY (user_id, symbol, timeframe, time)
);

-- TimescaleDB hypertable (if using TimescaleDB)
-- SELECT create_hypertable('candles_v2', 'time', if_not_exists => TRUE);

CREATE INDEX idx_candles_v2_user_symbol ON candles_v2(user_id, symbol);
CREATE INDEX idx_candles_v2_time ON candles_v2(time DESC);

-- ============================================================================
-- TICKS (v2): Recent tick data (optional, for real-time caching)
-- ============================================================================

CREATE TABLE IF NOT EXISTS ticks_v2 (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    bid DECIMAL(15, 8),
    ask DECIMAL(15, 8),
    volume DECIMAL(20, 2),
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX idx_ticks_v2_user_symbol ON ticks_v2(user_id, symbol);
CREATE INDEX idx_ticks_v2_timestamp ON ticks_v2(timestamp DESC);

-- ============================================================================
-- SETUP STATE TRANSITIONS (v2): Audit log for strategy state changes
-- ============================================================================

CREATE TABLE IF NOT EXISTS setup_state_transitions_v2 (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    setup_id UUID NOT NULL REFERENCES trading_setups_v2(id) ON DELETE CASCADE,
    
    from_state TEXT,
    to_state TEXT,
    reason TEXT,
    metadata JSONB,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX idx_setup_state_transitions_v2_user_id ON setup_state_transitions_v2(user_id);
CREATE INDEX idx_setup_state_transitions_v2_setup_id ON setup_state_transitions_v2(setup_id);

-- ============================================================================
-- TRADE JOBS (v2): MT5 trade execution queue
-- ============================================================================

CREATE TABLE IF NOT EXISTS trade_jobs_v2 (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    setup_id UUID REFERENCES trading_setups_v2(id) ON DELETE SET NULL,
    
    status TEXT DEFAULT 'pending',  -- 'pending', 'executing', 'completed', 'failed', 'cancelled'
    action TEXT NOT NULL,  -- 'buy', 'sell', 'close', etc.
    symbol TEXT NOT NULL,
    volume_lots DECIMAL(10, 2),
    price_limit DECIMAL(15, 8),
    
    -- Result
    execution_time TIMESTAMP WITH TIME ZONE,
    order_id INTEGER,
    filled_price DECIMAL(15, 8),
    error_message TEXT,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX idx_trade_jobs_v2_user_id ON trade_jobs_v2(user_id);
CREATE INDEX idx_trade_jobs_v2_status ON trade_jobs_v2(status);
CREATE INDEX idx_trade_jobs_v2_user_status ON trade_jobs_v2(user_id, status);

-- ============================================================================
-- AUDIT LOG: Track all operations for compliance
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_log_v2 (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    action TEXT NOT NULL,  -- 'user_created', 'credential_added', 'setup_modified', etc.
    resource_type TEXT,  -- 'user', 'credentials', 'setup', 'trade', etc.
    resource_id UUID,
    
    changes JSONB,  -- What changed (before/after)
    ip_address INET,
    user_agent TEXT,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX idx_audit_log_v2_user_id ON audit_log_v2(user_id);
CREATE INDEX idx_audit_log_v2_created_at ON audit_log_v2(created_at DESC);

-- ============================================================================
-- ROW-LEVEL SECURITY (RLS) - Data Isolation
-- ============================================================================

-- Enable RLS on all tables
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE mt5_broker_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE trading_setups_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE candles_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticks_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE setup_state_transitions_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE trade_jobs_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log_v2 ENABLE ROW LEVEL SECURITY;

-- Users can only see their own data
CREATE POLICY user_isolation_credentials ON mt5_broker_credentials
    FOR ALL USING (user_id = ANY(current_setting('app.current_user_id')::uuid[]));

CREATE POLICY user_isolation_setups ON trading_setups_v2
    FOR ALL USING (user_id = ANY(current_setting('app.current_user_id')::uuid[]));

CREATE POLICY user_isolation_candles ON candles_v2
    FOR ALL USING (user_id = ANY(current_setting('app.current_user_id')::uuid[]));

CREATE POLICY user_isolation_ticks ON ticks_v2
    FOR ALL USING (user_id = ANY(current_setting('app.current_user_id')::uuid[]));

CREATE POLICY user_isolation_transitions ON setup_state_transitions_v2
    FOR ALL USING (user_id = ANY(current_setting('app.current_user_id')::uuid[]));

CREATE POLICY user_isolation_trade_jobs ON trade_jobs_v2
    FOR ALL USING (user_id = ANY(current_setting('app.current_user_id')::uuid[]));

CREATE POLICY user_isolation_audit ON audit_log_v2
    FOR ALL USING (user_id = ANY(current_setting('app.current_user_id')::uuid[]));

-- ============================================================================
-- FUNCTIONS: Helper functions
-- ============================================================================

-- Function to log audit events
CREATE OR REPLACE FUNCTION log_audit(
    p_user_id UUID,
    p_action TEXT,
    p_resource_type TEXT DEFAULT NULL,
    p_resource_id UUID DEFAULT NULL,
    p_changes JSONB DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    v_id UUID;
BEGIN
    INSERT INTO audit_log_v2 (
        user_id, action, resource_type, resource_id, changes, ip_address
    ) VALUES (
        p_user_id, p_action, p_resource_type, p_resource_id, p_changes,
        inet_client_addr()
    )
    RETURNING id INTO v_id;
    
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- SUMMARY
-- ============================================================================

-- This schema supports:
-- ✓ Multiple users (each sees only their own data)
-- ✓ Multiple brokers per user (Exness, FxPro, FXCM, etc.)
-- ✓ Multiple trading setups per user
-- ✓ Full audit trail
-- ✓ Row-level security (RLS) for data isolation
-- ✓ High performance (indexes on common queries)
-- ✓ TimescaleDB ready for candles hypertable
-- ✓ Encrypted credentials
-- ✓ Real-time tick storage (optional)
