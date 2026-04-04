# KAFKA ALTERNATIVES FOR MULTI-TENANT TRADING PLATFORM

**Use Case:** Stream 1000s of users' trading ticks in real-time, isolated per user

---

## ALTERNATIVES COMPARISON TABLE

| Feature | Kafka | Redis Streams | NATS | Pulsar | Google Pub/Sub | AWS Kinesis |
|---------|-------|---------------|------|--------|----------------|-------------|
| **Setup Complexity** | High | Very Low | Low | High | Very Low | Low |
| **Persistence** | ✅ Yes (disk) | ✅ Yes (memory+disk) | ❌ No | ✅ Yes | ✅ Yes (cloud) | ✅ Yes (cloud) |
| **Per-User Topics** | ✅ Yes (1000s) | ✅ Yes (streams) | ✅ Yes (subjects) | ✅ Yes | ✅ Yes (topics) | ⚠️ Yes (shards) |
| **Latency** | 10-50ms | <5ms | <1ms | 10-50ms | 50-100ms | 100-200ms |
| **Throughput** | 1M+ msg/sec | 100K-500K/sec | 500K msg/sec | 1M+ msg/sec | 100K+ msg/sec | Real-time scaling |
| **Cost (1000 users)** | $200 | $50-100 | Free | $300 | $100-200 | $200-300 |
| **Learning Curve** | Steep | Easy | Easy | Steep | Easy | Medium |
| **Cloud-Native** | ❌ Self-hosted | ❌ Self-hosted | ❌ Self-hosted | ❌ Self-hosted | ✅ Fully managed | ✅ Fully managed |
| **Best For** | Large scale | Quick MVP | Low latency | Enterprise | Low ops burden | AWS-native apps |

---

## TOP 3 RECOMMENDATIONS

### 1️⃣ REDIS STREAMS (BEST FOR MVP)

**Use this if:** You want to launch fast and keep it simple

```python
# Simple Python API
import redis

r = redis.Redis(host='localhost', port=6379)

# Producer: Relay agent publishes tick for user_1
r.xadd(
    f'user:user_1:ticks',  # Stream name (user-specific)
    {
        'symbol': 'EURUSDm',
        'bid': 1.15382,
        'ask': 1.15402,
        'timestamp': 1775163693352
    }
)

# Consumer: WebSocket gateway subscribes to user_1's ticks
stream = r.xread(
    streams={'user:user_1:ticks': '0'},  # From beginning
    block=0  # Block until data available
)

for message in stream:
    symbol, data = message['data']
    ws.send(json.dumps(data))
```

**Pros:**
- ✅ Already using Redis for cache layer
- ✅ Zero new infrastructure (add module to existing Redis)
- ✅ 5-10ms latency (good for trading)
- ✅ Perfect for 1000-10000 users
- ✅ Easy to learn (simple API)

**Cons:**
- ❌ Data must fit in memory (not unlimited history)
- ❌ No deep ops tooling (like Kafka)
- ⚠️ Persistence is secondary (not disk-first)

**Cost to Scale from 1000 to 10,000 users:**
- Redis cluster upgrade: $50 → $200/month
- Total cost: Still <$500/month

**Recommended for:** MVP launch (Week 1-4 focus)

---

### 2️⃣ NATS JETSTREAM (BEST FOR PERFORMANCE)

**Use this if:** You need ultra-low latency (<5ms) and modern architecture

```python
# NATS JetStream (Python asyncio)
import nats

async def publish_tick(user_id: str, tick: dict):
    nc = await nats.connect("nats://localhost:4222")
    
    # Publish to user-specific subject
    await nc.publish(
        f"user.{user_id}.ticks",
        json.dumps(tick).encode()
    )

async def subscribe_to_ticks(user_id: str):
    nc = await nats.connect("nats://localhost:4222")
    
    # Subscribe to user's stream
    await nc.subscribe(
        f"user.{user_id}.ticks",
        cb=lambda msg: ws.send(json.dumps(msg.data))
    )
```

**Pros:**
- ✅ <1ms latency (best-in-class)
- ✅ Huge throughput (500K+ msg/sec)
- ✅ Cloud-native, modern design
- ✅ Built-in persistence (JetStream)
- ✅ Easier ops than Kafka

**Cons:**
- ❌ Slightly steeper learning curve than Redis Streams
- ❌ Less mature ecosystem than Kafka
- ⚠️ Fewer tools/dashboards

**Cost to Scale:**
- NATS itself: $0 (open source)
- Infrastructure: Same as Redis (~$200/month)

**Recommended for:** Performance-critical (microsecond trading)

---

### 3️⃣ GOOGLE PUB/SUB (BEST FOR MANAGED/SERVERLESS)

**Use this if:** You want "set and forget" with no ops burden

```python
# Google Cloud Pub/Sub
from google.cloud import pubsub_v1
import json

publisher = pubsub_v1.PublisherClient()
project_id = "my-trading-project"

def publish_tick(user_id: str, tick: dict):
    topic_path = publisher.topic_path(
        project_id, 
        f"user-{user_id}-ticks"  # Auto-create topics
    )
    
    future = publisher.publish(
        topic_path, 
        json.dumps(tick).encode()
    )
    return future.result()

# Subscriber
subscriber = pubsub_v1.SubscriberClient()
subscription_path = subscriber.subscription_path(
    project_id,
    f"user-{user_id}-sub"
)

def callback(message):
    tick = json.loads(message.data)
    ws.send(json.dumps(tick))
    message.ack()

subscriber.subscribe(subscription_path, callback=callback)
```

**Pros:**
- ✅ Fully managed (Google handles everything)
- ✅ Auto-scales to any volume
- ✅ Per-topic isolation (exactly what you need)
- ✅ Integrated with Google Cloud ecosystem
- ✅ Pay-per-use (no fixed costs)

**Cons:**
- ❌ Vendor lock-in (Google only)
- ❌ Higher latency (50-100ms)
- ⚠️ More expensive at scale (pay per message)

**Cost Analysis:**
```
1000 users × 1000 ticks/user/day
= 1 million ticks/day
= $5-10/month with Pub/Sub

At 100 million ticks/day:
= $500-1000/month
(Kafka would be cheaper at this scale)
```

**Recommended for:** Low-ops, cloud-native, <100K messages/day

---

## MY RECOMMENDATION FOR YOU

### SHORT TERM (Weeks 1-4): Use Redis Streams

```yaml
# docker-compose.yml
redis:
  image: redis:7-alpine
  command: redis-server
  volumes:
    - redis_data:/data
  # Add JetStream-like persistence
  
# That's it! No new services needed.
```

**Why:**
- ✅ You already have Redis
- ✅ Add Redis Streams module (built-in)
- ✅ No operational overhead
- ✅ 5-10ms latency is good enough
- ✅ Scales to 10,000 users easily

**Code change: 20 lines**
```python
# Replace Kafka imports with Redis
from rabbitmq_client import KafkaProducer
↓
from redis import Redis

# Producer
kafka_producer.send(topic, value)
↓
redis_client.xadd(stream_name, {'data': value})

# Consumer
for msg in kafka_consumer:
    process(msg)
↓
for msg_id, data in redis_client.xread(streams):
    process(data)
```

---

### LONG TERM (After product-market fit): Migrate to NATS

```bash
# Week 12+ when you have 1000+ paid users

# Step 1: Deploy NATS alongside Redis
docker run -d nats:latest

# Step 2: Dual-write (write to both Redis + NATS for 2 weeks)
async def dual_publish(user_id, tick):
    await redis_client.xadd(f"user:{user_id}:ticks", tick)
    await nats.publish(f"user.{user_id}.ticks", tick)

# Step 3: Switch consumers from Redis → NATS
# (No producer changes needed during switchover)

# Step 4: Decommission Redis Streams consumer
# (keep Redis for cache layer only)

# Result: Ultra-low latency without rewriting everything
```

**Why this timeline:**
- MVP needs to launch fast (Redis)
- After product validation, optimize performance (NATS)
- Parallel run for 2 weeks = zero downtime

---

## COMPARISON: KAFKA vs ALTERNATIVES IN YOUR USE CASE

```
Your Requirements:
  ├─ 1000+ concurrent users
  ├─ Per-user data isolation (critical!)
  ├─ <50ms latency acceptable
  ├─ Persistent event log preferred
  └─ Startup speed: ASAP (Week 1)

Redis Streams:
  ├─ ✅ Per-user streams: YES
  ├─ ✅ Isolation: Great
  ├─ ✅ Latency: 5-10ms
  ├─ ✅ Persistence: Yes (RDB + AOF)
  ├─ ✅ Setup time: 30 minutes
  └─ Cost: $50-100/month

NATS JetStream:
  ├─ ✅ Per-user subjects: YES
  ├─ ✅ Isolation: Perfect
  ├─ ✅ Latency: <1ms (best)
  ├─ ✅ Persistence: Yes (built-in)
  ├─ ⚠️ Setup time: 2 hours
  └─ Cost: $0 (open source) + $200 infra

Kafka:
  ├─ ✅ Per-user topics: YES (but heavy)
  ├─ ⚠️ Isolation: Possible but complex
  ├─ ✅ Latency: 10-50ms
  ├─ ✅ Persistence: Excellent
  ├─ ❌ Setup time: 8-16 hours
  └─ Cost: $200/month

Google Pub/Sub:
  ├─ ✅ Per-topic isolation: YES
  ├─ ✅ Isolation: Perfect
  ├─ ⚠️ Latency: 50-100ms
  ├─ ✅ Persistence: Yes
  ├─ ✅ Setup time: 10 minutes
  └─ Cost: $100-500/month (variable)
```

---

## DECISION MATRIX

**Pick Redis Streams IF:**
- ✅ Launching in weeks 1-4
- ✅ Want simplicity and speed
- ✅ Happy with 5-10ms latency
- ✅ Don't want new infrastructure
- ✅ < 50,000 users planned Year 1

**Pick NATS IF:**
- ✅ Need <5ms latency
- ✅ Building trading algo execution (millisecond-critical)
- ✅ Want modern architecture from day 1
- ✅ Plan to scale to 10,000+ users

**Pick Kafka IF:**
- ✅ Need complex event streaming (multiple consumers, replay, etc.)
- ✅ Building data warehouse/analytics on top
- ✅ Have dedicated ops team
- ✅ Multi-company deployments (SaaS with SaaS clients)

**Pick Google Pub/Sub IF:**
- ✅ Using Google Cloud for everything anyway
- ✅ Want zero ops burden
- ✅ Don't mind vendor lock-in
- ✅ Message volume <100M/month

---

## QUICK IMPLEMENTATION PATH

### Week 1: Redis Streams (30 minutes to implement)

```bash
# 1. Use existing Redis container (no new infra)
docker-compose exec redis redis-cli INFO

# 2. Add Redis Streams to relay agent
cat > services/relay-agent/redis_streams.py << 'EOF'
import json
from redis import Redis

class RedisStreamQueue:
    def __init__(self, redis_url: str):
        self.redis = Redis.from_url(redis_url)
    
    async def publish_tick(self, user_id: str, symbol: str, bid: float, ask: float):
        """Publish tick for specific user"""
        await self.redis.xadd(
            f"user:{user_id}:ticks",
            {
                'symbol': symbol,
                'bid': bid,
                'ask': ask,
                'timestamp': int(time.time() * 1000)
            }
        )
    
    async def subscribe_to_user_ticks(self, user_id: str, callback):
        """Subscribe to user's ticks"""
        last_id = '0'
        while True:
            result = await self.redis.xread(
                streams={f"user:{user_id}:ticks": last_id}
            )
            
            for message_id, data in result:
                last_id = message_id
                await callback(data)
EOF

# 3. Use in relay agent
relay_queue = RedisStreamQueue("redis://localhost:6379")

# On tick from MT5
await relay_queue.publish_tick(
    user_id="user_123",
    symbol="EURUSDm",
    bid=1.15382,
    ask=1.15402
)

# WebSocket subscribes
async def stream_ticks(ws, user_id):
    async def on_tick(data):
        await ws.send(json.dumps(data))
    
    await relay_queue.subscribe_to_user_ticks(user_id, on_tick)
```

**Done! Now running on Redis Streams.**

---

## FINAL RECOMMENDATION

```
┌─────────────────────────────────────────┐
│  ROADMAP: Event Streaming Technology    │
├─────────────────────────────────────────┤
│                                         │
│  Week 1-4 (MVP):                       │
│  └─ Redis Streams                      │
│     └─ Simple, fast to implement       │
│     └─ Good enough for 1000 users      │
│                                         │
│  Week 5-12 (Growth):                   │
│  └─ Redis Streams (keep for cache)    │
│  └─ Add NATS JetStream (streaming)    │
│     └─ Parallel run 2 weeks            │
│     └─ Cutover when confident          │
│                                         │
│  Week 13+ (Scale):                     │
│  └─ NATS JetStream (primary)           │
│  └─ Redis (cache + sessions only)      │
│     └─ <1ms latency achieved           │
│     └─ 100,000+ users supported        │
│                                         │
└─────────────────────────────────────────┘
```

**Bottom Line:** Start with Redis Streams (Week 1), upgrade to NATS (Week 5) if performance needed, never need Kafka.
