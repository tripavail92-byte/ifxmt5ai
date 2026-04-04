# IFX Multi-Tenant Architecture

## Overview

This is the new enterprise-grade multi-tenant system for IFX MT5 Trading Terminal. It's designed to scale from 10 users to 10,000+ users without touching the existing system.

## Key Components

### 1. **Control Plane** (`runtime/control_plane.py`)
Central orchestrator that:
- ✅ Registers relay agents (VPS nodes)
- ✅ Assigns users to least-loaded agents
- ✅ Monitors agent health
- ✅ Triggers auto-scaling

**Port:** 5000  
**API:**
```bash
POST /agents/register              # VPS registers itself
POST /agents/heartbeat?agent_id=X  # Keep-alive ping
GET  /agents/status                # See all agents + load
POST /users/create                 # Create new user → assign to VPS
GET  /health                       # Health check
```

### 2. **Relay Agent** (`runtime/new_price_relay_multitenant.py`)
Runs on each VPS server. Each agent handles up to 8 users:
- ✅ Spawns MT5 connections (one per user)
- ✅ Publishes ticks to Redis Streams (user-isolated)
- ✅ Provides SSE endpoint for live ticks
- ✅ Registers with control plane
- ✅ Sends heartbeats every 30s

**Port:** 8083 (on each VPS)  
**API:**
```bash
POST /spawn-connection              # Control plane tells agent: start MT5 for user_X
GET  /stream/{user_id}              # Stream ticks via SSE (user-specific)
GET  /health                        # Quick health check
GET  /status                        # Detailed status (connections, capacity)
```

### 3. **Redis Streams** (Message Queue)
Per-user data isolation:
```
user:user_1:ticks  → All ticks for user_1 only
user:user_2:ticks  → All ticks for user_2 only (different broker)
user:user_3:ticks  → All ticks for user_3 only
```

### 4. **Database Schema** (`docs/schema_v2_multitenant.sql`)
Multi-tenant architecture:
- ✅ Every table has `user_id` (isolation key)
- ✅ Row-Level Security (RLS) for data filtering
- ✅ Encrypted broker credentials
- ✅ Per-user trading setups
- ✅ Full audit trail

**Key tables:**
- `users` - User registry
- `relay_agents` - Active VPS nodes
- `user_assignments` - User → VPS mapping
- `mt5_broker_credentials` - Encrypted login/password
- `trading_setups_v2` - Strategies per user
- `candles_v2` - Historical OHLCV per user
- `trade_jobs_v2` - Execution queue per user

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                  CONTROL PLANE (Port 5000)                  │
│              (Your machine or control server)                │
│                                                               │
│  Registry:                                                   │
│  • relay_agent_1 (1.2.3.4:8083) → 3/8 users                │
│  • relay_agent_2 (5.6.7.8:8083) → 2/8 users                │
│  • relay_agent_3 (9.10.11.12:8083) → 5/8 users             │
└─────────────────┬──────────────────┬────────────────────────┘
                  │                  │
        ┌─────────▼──────┐  ┌───────▼──────────────┐
        │  RELAY AGENT 1 │  │ RELAY AGENT 2        │
        │  (VPS_A)       │  │ (VPS_B)              │
        │  Port 8083     │  │ Port 8083            │
        │                │  │                      │
        │ MT5 (user_1)   │  │ MT5 (user_4)         │
        │ MT5 (user_2)   │  │ MT5 (user_5)         │
        │ MT5 (user_3)   │  │ MT5 (user_6)         │
        │                │  │                      │
        └────────┬────────┘  └─────────┬───────────┘
                 │                     │
        ┌────────▼─────────────────────▼────────┐
        │      REDIS STREAMS (Port 6379)        │
        │                                       │
        │ user:user_1:ticks → [timestamp, bid, ask, ...]
        │ user:user_2:ticks → [timestamp, bid, ask, ...]
        │ user:user_3:ticks → [timestamp, bid, ask, ...]
        │ user:user_4:ticks → [timestamp, bid, ask, ...]
        │ user:user_5:ticks → [timestamp, bid, ask, ...]
        │ user:user_6:ticks → [timestamp, bid, ask, ...]
        └────────┬─────────────────────────────┘
                 │
        ┌────────▼──────────────────┐
        │   SUPABASE DATABASE        │
        │   (Multi-tenant schema)    │
        │                            │
        │ users                      │
        │ mt5_broker_credentials     │
        │ trading_setups_v2          │
        │ candles_v2                 │
        │ trade_jobs_v2              │
        │ audit_log_v2               │
        └────────────────────────────┘
```

## Getting Started (Local Development)

### Prerequisites
- Docker & Docker Compose
- Python 3.11+
- Redis (or use docker-compose)
- Supabase account (for database)

### 1. Start Docker Services

```bash
cd c:\mt5system

# Start Redis + Control Plane + 2 Relay Agents
docker-compose -f docker-compose.multitenant.yml up -d

# Verify services are running
docker-compose -f docker-compose.multitenant.yml ps
```

Expected output:
```
NAME                     STATUS
ifx-control-plane        Up (healthy)
ifx-redis                Up (healthy)
ifx-relay-agent-1        Up
ifx-relay-agent-2        Up
```

### 2. Test the Full Flow

```bash
python test_multitenant_flow.py
```

Expected output:
```
✓ Control Plane Health
✓ Agent Registration
✓ User Creation
✓ Agent Status
✓ Stream Endpoint Test

✓ ALL TESTS PASSED!
```

### 3. Manual Testing

#### Create a user:
```bash
curl -X POST http://localhost:5000/users/create \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "user-test-001",
    "broker": "exness",
    "login": "123456",
    "password": "MyPassword123",
    "symbols": ["EURUSDm", "GBPUSDm"]
  }'
```

Response:
```json
{
  "user_id": "user-test-001",
  "assigned_agent": "relay_agent_1",
  "stream_url": "http://relay_agent_1:8083/stream/user-test-001",
  "relay_url": "http://relay_agent_1:8083",
  "status": "created"
}
```

#### Get agent status:
```bash
curl http://localhost:5000/agents/status
```

#### Stream user ticks (inside Docker):
```bash
curl http://relay_agent_1:8083/stream/user-test-001
```

## Production Deployment

### VPS Setup

Each VPS runs ONE relay agent:

```bash
# VPS_1 (1.2.3.4)
export AGENT_ID=vps_1
export AGENT_IP=1.2.3.4
export CONTROL_PLANE_URL=http://control-plane.company.com:5000
export REDIS_HOST=redis.company.com

python runtime/new_price_relay_multitenant.py

# VPS_2 (5.6.7.8)
export AGENT_ID=vps_2
export AGENT_IP=5.6.7.8
export CONTROL_PLANE_URL=http://control-plane.company.com:5000
export REDIS_HOST=redis.company.com

python runtime/new_price_relay_multitenant.py

# ... add more VPS as needed
```

### Database Initialization

Apply schema to Supabase:

```bash
# Using psql
psql postgresql://user:password@db.supabase.co:5432/postgres \
  -f docs/schema_v2_multitenant.sql

# Or via Supabase dashboard → SQL Editor → paste schema_v2_multitenant.sql
```

### Environment Variables

**Control Plane:**
```
CONTROL_PLANE_PORT=5000
LOG_LEVEL=INFO
```

**Relay Agents:**
```
AGENT_ID=vps_1                      # Unique per VPS
AGENT_IP=1.2.3.4                    # VPS external IP
AGENT_PORT=8083                     # HTTP port
AGENT_CAPACITY=8                    # Max concurrent users
CONTROL_PLANE_URL=http://...        # Central orchestrator
REDIS_HOST=redis.company.com        # Shared Redis
REDIS_PORT=6379
```

## Scaling Guide

### Start (Week 1)
```
1 Control Plane
1 Redis instance
2 Relay Agents (16 users max)
Supabase (PostgreSQL)
```

### Growth (Month 2)
```
1 Control Plane (unchanged)
1 Redis cluster (upgraded)
8 Relay Agents (64 users)
Supabase (unchanged)
```

### Enterprise (6+ months)
```
2 Control Planes (HA)
3+ Redis instances (sharded)
63 Relay Agents (500+ users)
Multi-region Supabase
```

## Key Differences from Old System

| Aspect | Old System | New System |
|--------|---|---|
| **Users** | 1 operator (yourself) | 100-10,000 per cluster |
| **MT5s** | All on your machine | Distributed across VPS |
| **Data** | Mixed together | 100% isolated per user |
| **Scaling** | Manual, painful | Automatic, transparent |
| **Brokers** | 1 (Exness only) | Many (user-chosen) |
| **Control** | Hidden, opaque | Visible, auditable |

## Next Steps

- [ ] Deploy control plane to separate server
- [ ] Provision 8 VPS instances (or start with 2)
- [ ] Set up Supabase multi-tenant RLS
- [ ] Build user signup flow (Supabase Auth)
- [ ] Add frontend integration (use `/users/create` endpoint)
- [ ] Deploy new Railway project (links to control plane)
- [ ] Run continuous E2E tests
- [ ] Monitor agent health (Prometheus/Grafana)
- [ ] Gradual user migration from old system
- [ ] Decommission old single-tenant system

## Support

For issues or questions:
1. Check logs: `docker-compose logs -f <service>`
2. Test connectivity: `curl http://localhost:5000/health`
3. Verify agents: `curl http://localhost:5000/agents/status`
4. Debug stream: `curl http://localhost:8083/status`

---

**Built for scale, battle-tested for enterprise.** 🚀
