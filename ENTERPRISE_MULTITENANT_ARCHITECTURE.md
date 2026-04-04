# ENTERPRISE REDESIGN - REVISED FOR MULTI-TENANT SAAS

**Previous Assumption:** Single operator with 4 MT5 terminals
**Actual Model:** 100s-1000s users, each with their own Exness/Broker account

This is a fundamentally different architecture problem.

---

## NEW ARCHITECTURE: MULTI-TENANT RELAY GRID

```
┌─────────────────────────────────────────────────────────────┐
│                    SAAS PLATFORM (You)                       │
│                                                               │
│  ┌──────────────────────┐        ┌──────────────────────┐   │
│  │   Supabase Auth      │        │  User Credentials    │   │
│  │  (Central)           │        │  (Encrypted)         │   │
│  │                      │        │                      │   │
│  │ ✓ Login user_1       │        │ user_1:              │   │
│  │ ✓ Login user_2       │        │  broker: Exness      │   │
│  │ ✓ Login user_3000    │        │  login: xxx          │   │
│  │                      │        │  password: yyy       │   │
│  └──────────┬───────────┘        └──────────┬───────────┘   │
│             │                                │                │
│  ┌──────────▼──────────────────────────────▼───────────┐    │
│  │     Relay Agent Manager (Control Plane)             │    │
│  │                                                      │    │
│  │  Job: Decide which agent runs each user's MT5       │    │
│  │  • User_1 → Agent_A (server-1)                      │    │
│  │  • User_2 → Agent_B (server-2)                      │    │
│  │  • User_3 → Agent_A (server-1) [reuse]             │    │
│  │  • User_1000 → Agent_F (server-6)                   │    │
│  │                                                      │    │
│  │  Scaling: Add servers as needed                      │    │
│  └──────────┬──────────────────────────────────────────┘    │
│             │                                                 │
│  ┌──────────▼──────────────────────────────────────────┐    │
│  │     Relay Agent Grid (Data Plane)                   │    │
│  │                                                      │    │
│  │  ┌─────────────────┐  ┌─────────────────┐          │    │
│  │  │  Agent_A        │  │  Agent_B        │  ... N  │    │
│  │  │  (Server-1)     │  │  (Server-2)     │        │    │
│  │  │                 │  │                 │          │    │
│  │  │ ┌─────────────┐ │  │ ┌─────────────┐ │          │    │
│  │  │ │ User_1-MT5  │ │  │ │ User_2-MT5  │ │          │    │
│  │  │ │ (Private)   │ │  │ │ (Private)   │ │          │    │
│  │  │ └─────────────┘ │  │ └─────────────┘ │          │    │
│  │  │ ┌─────────────┐ │  │ ┌─────────────┐ │          │    │
│  │  │ │ User_3-MT5  │ │  │ │ User_4-MT5  │ │          │    │
│  │  │ │ (Private)   │ │  │ │ (Private)   │ │          │    │
│  │  │ └─────────────┘ │  │ └─────────────┘ │          │    │
│  │  └─────────────────┘  │ ...more users... │          │    │
│  │                        └─────────────────┘          │    │
│  └──────────┬──────────────────────────────────────────┘    │
│             │                                                 │
│  ┌──────────▼──────────────────────────────────────────┐    │
│  │     Message Queue (Redis Streams)                   │    │
│  │                                                      │    │
│  │  Streams:                                           │    │
│  │  • user:user_1:ticks   → prices for user_1         │    │
│  │  • user:user_2:ticks   → prices for user_2         │    │
│  │  • user:user_3:ticks   → prices for user_3         │    │
│  │  • (one stream per user)                           │    │
│  └──────────┬──────────────────────────────────────────┘    │
│             │                                                 │
│  ┌──────────▼──────────────────────────────────────────┐    │
│  │     User-Specific Caches & Databases                │    │
│  │                                                      │    │
│  │  Redis:                                             │    │
│  │  • prices:user_1 → only user_1's prices            │    │
│  │  • prices:user_2 → only user_2's prices            │    │
│  │                                                      │    │
│  │  TimescaleDB:                                       │    │
│  │  • candles_user_1 → hypertable for user_1          │    │
│  │  • candles_user_2 → hypertable for user_2          │    │
│  └──────────┬──────────────────────────────────────────┘    │
│             │                                                 │
│  ┌──────────▼──────────────────────────────────────────┐    │
│  │     WebSocket Gateway (Frontend)                    │    │
│  │                                                      │    │
│  │  • User_1 sees only User_1's prices                │    │
│  │  • User_2 sees only User_2's prices                │    │
│  │  • No cross-contamination of data                  │    │
│  └──────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

---

## KEY ARCHITECTURAL CHANGES

### 1. USER-SPECIFIC DATA ISOLATION

**Current (Wrong):**
```
Global prices: [EURUSDm, GBPUSDm, ...] ← Everyone sees same data
```

**New (Correct):**
```
User_1 prices: [EURUSDm, GBPUSDm, ...] (User_1's broker rates)
User_2 prices: [EURUSDm, GBPUSDm, ...] (User_2's broker rates)
  ↑ DIFFERENT BROKERS = DIFFERENT PRICES
  ↑ USER_1 must only see USER_1's data
```

### 2. RELAY AGENT DISTRIBUTION

**Current (Single Server - Won't Scale):**
```
Server-1:
  └─ Relay Process (handles 4 MT5s max)
     └─ Max 4 users
```

**New (Multiple Servers - Scales to 1000s):**
```
Server-1:
  └─ Relay Agent (handles 50-100 MT5 connections)
     ├─ User_1's MT5 connection
     ├─ User_2's MT5 connection
     ├─ User_3's MT5 connection
     └─ ...

Server-2:
  └─ Relay Agent (handles 50-100 MT5 connections)
     ├─ User_50's MT5 connection
     ├─ User_51's MT5 connection
     └─ ...

Server-N:
  └─ Relay Agent (handles 50-100 MT5 connections)
     └─ ...

Control Plane: Decides which agent runs which user
```

### 3. DATABASE SCHEMA (MULTI-TENANT)

**Current:**
```sql
SELECT * FROM trading_setups;  -- Global setups
```

**New:**
```sql
-- Every table must have user_id for isolation
CREATE TABLE trading_setups (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,  -- ← CRITICAL: filter by user
    symbol TEXT,
    entry_price NUMERIC,
    ...
);

-- Query must filter by user
SELECT * FROM trading_setups WHERE user_id = $1;
```

### 4. MESSAGE QUEUE (PER-USER TOPICS)

**Current:**
```
Topic: mt5.ticks
  └─ All users' ticks mixed
```

**New:**
```
Topic: user:user_1:ticks
  └─ Only user_1's ticks

Topic: user:user_2:ticks
  └─ Only user_2's ticks

...1000+ topics (one per user)
```

---

## REVISED ENTERPRISE ARCHITECTURE (4 WEEKS)

### Phase 1: Foundation (Days 1-5)

**1.1 Multi-Tenant Database Schema**
```sql
-- Base tables with user_id
CREATE TABLE users (
    id UUID PRIMARY KEY,
    email TEXT UNIQUE,
    supabase_user_id UUID,
    created_at TIMESTAMPTZ
);

CREATE TABLE user_broker_credentials (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id),
    broker TEXT,  -- "Exness", "FxPro", etc.
    account_number TEXT,
    login_username TEXT ENCRYPTED,  -- Use Supabase encryption
    login_password TEXT ENCRYPTED,
    encrypted WITH master_key,
    is_active BOOLEAN,
    created_at TIMESTAMPTZ
);

CREATE TABLE relay_agents (
    id UUID PRIMARY KEY,
    server_hostname TEXT,
    capacity INT DEFAULT 100,  -- Max connections per agent
    current_connections INT,
    status TEXT,  -- "healthy", "degraded", "offline"
    last_heartbeat TIMESTAMPTZ
);

CREATE TABLE relay_assignments (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id),
    credential_id UUID NOT NULL REFERENCES user_broker_credentials(id),
    agent_id UUID NOT NULL REFERENCES relay_agents(id),
    status TEXT,  -- "connecting", "connected", "disconnected"
    mt5_connection_id TEXT,  -- Internal ID in relay agent
    created_at TIMESTAMPTZ
);

CREATE TABLE trading_setups (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id),  -- ← USER ISOLATION
    symbol TEXT,
    entry_price NUMERIC,
    ... (other fields)
    INDEX idx_user_id (user_id)
);

CREATE TABLE candles (
    time TIMESTAMPTZ NOT NULL,
    user_id UUID NOT NULL,  -- ← USER ISOLATION
    symbol TEXT NOT NULL,
    open NUMERIC, high NUMERIC, low NUMERIC, close NUMERIC,
    PRIMARY KEY (user_id, symbol, time)
);
SELECT create_hypertable('candles', 'time');
```

**1.2 Relay Agent Architecture (Control Plane)**

```python
# services/relay-control-plane/main.py

class RelayControlPlane:
    """Decides which agent runs which user's MT5"""
    
    async def on_user_connected(self, user_id: str, broker_creds):
        # 1. Find agent with capacity
        agent = await self.find_agent_with_capacity()
        
        if not agent:
            # No capacity: launch new agent
            agent = await self.provision_new_agent()
        
        # 2. Send job to agent
        await agent.spawn_mt5_connection(
            user_id=user_id,
            broker=broker_creds.broker,
            login=broker_creds.login_username,
            password=decrypt(broker_creds.login_password)
        )
        
        # 3. Record assignment in DB
        await db.relay_assignments.create(
            user_id=user_id,
            agent_id=agent.id,
            status="connecting"
        )
        
        # 4. Monitor connection
        async for status_update in agent.stream_status():
            if status_update == "connected":
                await db.relay_assignments.update(
                    status="connected",
                    mt5_connection_id=status_update.connection_id
                )
                await redis_cache.set(f"user:{user_id}:status", "connected")
    
    async def find_agent_with_capacity(self):
        agents = await db.relay_agents.list_all()
        for agent in agents:
            if agent.current_connections < agent.capacity:
                return agent
        return None
    
    async def provision_new_agent(self):
        # Launch new server (via Kubernetes or cloud API)
        new_server = await cloud.provision_instance(
            type="relay-agent",
            region="auto",  # Load balance globally
            capacity=100
        )
        
        # Register in DB
        agent = await db.relay_agents.create(
            server_hostname=new_server.ip,
            capacity=100,
            status="initializing"
        )
        
        return RelayAgentClient(agent.server_hostname)
```

---

### Phase 2: Relay Agents (Days 6-10)

**2.1 Relay Agent (Data Plane)**

```python
# services/relay-agent/main.py

class RelayAgent:
    """Runs on each server, manages N user MT5 connections"""
    
    async def spawn_mt5_connection(self, user_id: str, broker: str, login: str, password: str):
        # Create MT5 connection for this specific user
        connection = await self.mt5_pool.create_connection(
            user_id=user_id,
            broker=broker,
            login=login,
            password=password
        )
        
        # Stream ticks for this user only
        async for tick in connection.stream_ticks():
            # Publish to user-specific Redis Stream
            await redis.xadd(
                f"user:{user_id}:ticks",
                {
                    "symbol": tick.symbol,
                    "bid": tick.bid,
                    "ask": tick.ask,
                    "timestamp": tick.timestamp,
                    "user_id": user_id  # ← Traceability
                }
            )
            
            # Cache in user-specific Redis key
            await redis.set(
                f"prices:user:{user_id}:{tick.symbol}",
                json.dumps({"bid": tick.bid, "ask": tick.ask}),
                ex=300  # TTL 5 minutes
            )
    
    async def health_check(self):
        """Periodic health report to control plane"""
        return {
            "agent_id": self.id,
            "current_connections": len(self.mt5_connections),
            "capacity": 100,
            "status": "healthy" if len(self.mt5_connections) < 100 else "full",
            "timestamp": time.time()
        }
```

**2.2 Per-User Data Isolation**

```python
# Redis Streams: Separate stream per user
redis_stream = f"user:{user_id}:ticks"  # 1000s of streams

# Redis: Separate keys per user
redis_key = f"prices:user:{user_id}:{symbol}"

# Database: All queries include user_id filter
SELECT * FROM candles 
WHERE user_id = $1  -- ← MUST HAVE THIS
  AND symbol = $2
  AND time > now() - '1 month'

# TimescaleDB: Per-user hypertables (optional optimization)
CREATE TABLE candles_user_12345 (...)
SELECT create_hypertable('candles_user_12345', 'time', if_not_exists => TRUE)
```

---

### Phase 3: Frontend API (Days 11-15)

**3.1 User-Specific API Endpoints**

```typescript
// Frontend requests: /api/user/{user_id}/...

app.get("/api/user/:user_id/prices", auth_required, async (req, res) => {
    // Verify requesting user == user_id (no data leakage)
    if (req.user.id !== req.params.user_id) {
        return res.status(403).json({ error: "Unauthorized" });
    }
    
    const user_id = req.params.user_id;
    const prices = await redis.get(`prices:user:${user_id}:*`);
    
    res.json(prices);  // Only this user's prices
});

app.get("/api/user/:user_id/setups", auth_required, async (req, res) => {
    const user_id = req.params.user_id;
    
    // Database query MUST filter by user_id
    const setups = await db
        .from("trading_setups")
        .select("*")
        .eq("user_id", user_id);  // ← CRITICAL
    
    res.json(setups);
});

app.ws("/ws/user/:user_id/stream", async (ws, req) => {
    const user_id = req.params.user_id;
    
    // User-specific WebSocket subscription
    const stream = `user:${user_id}:ticks`;
    let lastId = "0";  // Start from beginning
    
    // Read user's Redis Stream and forward via WebSocket
    while (ws.readyState === ws.OPEN) {
        const messages = await redis.xread(
            "BLOCK", 1000,  // Block 1s, poll every second
            "STREAMS", stream, lastId
        );
        
        if (messages) {
            for (const [id, fields] of messages[0][1]) {
                ws.send(JSON.stringify({id, ...fields}));
                lastId = id;
            }
        }
    }
});
```

---

### Phase 4: Scaling & Load Balancing (Days 16-20)

**4.1 Auto-Scaling Strategy**

```yaml
# Kubernetes HPA: Scale relay agents based on load

apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: relay-agent-autoscaler
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: relay-agent
  minReplicas: 1
  maxReplicas: 100  # Support 5000-10000 users
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
  - type: Pods
    pods:
      metric:
        name: relay_mt5_connections
      target:
        type: AverageValue
        averageValue: "80"  # Target 80 connections per agent
```

**4.2 Geographic Distribution**

```
Control Plane: us-east-1 (central)
  └─ Database: Multi-master (all regions)
  └─ Control logic: Single controller

Relay Agents: Distributed globally
  us-east-1: 10 agents × 100 users = 1000 users
  eu-west-1: 10 agents × 100 users = 1000 users
  ap-southeast-1: 5 agents × 100 users = 500 users
  
  Total: ~2500 users on $300/month infrastructure
```

---

## SECURITY CONSIDERATIONS

### 1. Credential Encryption (Critical!)

```python
# User MT5 credentials must be encrypted

class CredentialManager:
    # Use Supabase's encryption
    async def store_credential(self, user_id: str, broker: str, login: str, password: str):
        # Supabase auto-encrypts with master key
        await db.user_broker_credentials.create(
            user_id=user_id,
            broker=broker,
            login_username=login,
            login_password=password,  # Auto-encrypted by Supabase
            encrypted_with="supabase_master_key"
        )
    
    async def get_credential_for_relay_only(self, credential_id: str):
        # Credentials only sent to relay agents over HTTPS
        cred = await db.user_broker_credentials.get(credential_id)
        
        # Decrypt in memory
        password = decrypt(cred.login_password, key=MASTER_KEY)
        
        # Send to agent via TLS
        return {
            "login": cred.login_username,
            "password": password  # Decrypted here, never logged
        }
```

### 2. Data Isolation (Mandatory)

**Every API must verify user_id:**
```python
@auth_required
async def get_user_prices(user_id: str):
    # Check: requesting user == user_id
    if current_user.id != user_id:
        raise Forbidden("Cannot access other user's data")
    
    return await db.prices.query(user_id=user_id)
```

### 3. Audit Trail

```sql
CREATE TABLE audit_log (
    id UUID PRIMARY KEY,
    user_id UUID,
    action TEXT,  -- "login", "setup_created", "trade_placed"
    details JSONB,
    timestamp TIMESTAMPTZ,
    INDEX idx_user_id (user_id)
);

-- Every action logged
INSERT INTO audit_log (user_id, action, details)
VALUES ($1, 'trade_placed', jsonb_build_object('symbol', $2, 'side', $3));
```

---

## REVISED COST MODEL

### Infrastructure (1000 users)

```
Relay Agents: 10 servers × $50/month = $500
Database: Multi-master TimescaleDB = $400
Cache: Redis cluster (unified for cache + streams) = $150
Monitoring: Prometheus + Grafana = $50
DNS/SSL: $20
────────────────────────────
Total: ~$1120/month for 1000 users (no separate Kafka cost!)
Cost per user: $1.12/month

Revenue model (typical SaaS):
- Free tier: $0/month
- Pro tier: $29/month (100 users at 30% conversion)
- Enterprise: $500+/month (10 users)

Breakeven: ~100 paid users
Margin at 1000 users: 99%+ if pricing is $10-30/user
```

---

## DATABASE DESIGN (MULTI-TENANT)

### Critical Rules

```
1. EVERY table must have user_id
   ✓ trading_setups (user_id)
   ✓ candles (user_id)
   ✓ setup_state_transitions (user_id)
   ✓ audit_log (user_id)

2. EVERY query must filter by user_id
   ✗ SELECT * FROM trading_setups;  -- WRONG
   ✓ SELECT * FROM trading_setups WHERE user_id = $1;

3. EVERY API must authorize user_id
   ✗ GET /api/setups  -- Could return wrong user's data
   ✓ GET /api/user/{user_id}/setups  -- With auth check

4. EVERY webhook must be user-specific
   ✗ Publish to: mt5.ticks  -- All users' ticks
   ✓ Publish to: user:{user_id}:ticks  -- User-isolated
```

---

## REVISED 4-WEEK TIMELINE

```
Week 1: Architecture + Database
├─ Day 1-2: Multi-tenant schema design
├─ Day 3: Control plane skeleton
├─ Day 4: User credential encryption
└─ Day 5: Data isolation testing

Week 2: Relay Agent Grid
├─ Day 6: Relay agent service (spawn N MT5s)
├─ Day 7: User-specific Redis Streams
├─ Day 8: Per-user Redis caching (same cluster)
├─ Day 9: Control plane auto-scaling logic
└─ Day 10: Agent registration + health checks

Week 3: Deployment & Scaling
├─ Day 11: Docker compose (full multi-tenant stack)
├─ Day 12: Kubernetes manifests (auto-scaling)
├─ Day 13: Terraform (cloud provisioning)
├─ Day 14: Geographic distribution (multi-region)
└─ Day 15: Monitoring + alerting (per-user metrics)

Week 4: Testing & Go-Live
├─ Day 16: Security audit (credential isolation)
├─ Day 17: Load testing (1000 concurrent users)
├─ Day 18: Chaos engineering (agent failures)
├─ Day 19: Blue-green deployment
└─ Day 20: Switchover + post-mortems
```

---

## NEW SCALABILITY TARGETS

```
Current (Single Server):
  └─ 4 MT5 terminals
  └─ 12-30 symbols
  └─ 1 user max (you)
  └─ 18-19 ticks/sec
  └─ <$50/month infra

After Enterprise Redesign (Multi-Server):
  └─ 100+ relay agents
  └─ 1000+ concurrent MT5 connections
  └─ 500+ symbols per user
  └─ 100-1000 users (paying)
  └─ 1,000,000+ ticks/sec aggregate
  └─ ~$1-3/month per user cost
  └─ $500-3000/month revenue potential
```

---

## QUESTIONS FOR YOU

1. **Brokers:** Which brokers will you support initially?
   - Exness only?
   - FxPro, FXCM, also?
   - Binary options brokers?

2. **Data Privacy:** Do you need to comply with regulations?
   - GDPR (EU users)?
   - CFTC (US users)?
   - MAS (Singapore)?

3. **Pricing Model:**
   - Free tier + paid premium?
   - Flat fee per user?
   - Revenue share (% of profits)?

4. **User Base Target:**
   - 10 users initially?
   - 100 users in year 1?
   - 1000+ users in year 2?

5. **Feature Priority:**
   - Multi-broker support?
   - Backtesting?
   - Risk management tools?
   - Mobile app?

