"""
new_price_relay_multitenant.py
IFX Multi-Tenant Relay Agent

One instance runs on each VPS.
- Spawns N MT5 connections (one per user)
- Publishes ticks to Redis Streams (per-user isolation)
- Provides HTTP API for user-specific data
- Registers with central Control Plane
- Sends heartbeats every 30s

Runs on: Each VPS server
Port: 8083
"""

import asyncio
import json
import logging
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import suppress
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Thread
from typing import Dict, Optional
from urllib.parse import parse_qs, urlparse

import aiohttp
import redis

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s"
)
logger = logging.getLogger(__name__)

# ============================================================================
# CONFIGURATION
# ============================================================================

AGENT_ID = os.getenv("AGENT_ID", "relay_agent_1")
AGENT_IP = os.getenv("AGENT_IP", "127.0.0.1")
AGENT_PORT = int(os.getenv("AGENT_PORT", 8083))
AGENT_CAPACITY = int(os.getenv("AGENT_CAPACITY", 8))
AGENT_BASE_URL = (os.getenv("AGENT_BASE_URL") or f"http://{AGENT_IP}:{AGENT_PORT}").rstrip("/")

CONTROL_PLANE_URL = os.getenv("CONTROL_PLANE_URL", "http://127.0.0.1:5000")
REDIS_URL = os.getenv("REDIS_URL", "").strip()
REDIS_HOST = os.getenv("REDIS_HOST", "127.0.0.1")
REDIS_PORT = int(os.getenv("REDIS_PORT", 6379))

TERMINALS_DIR = Path(os.getenv("MT5_TERMINALS_DIR", r"C:\mt5system\terminals"))
RELAY_SOURCE_CONNECTION_ID = (os.getenv("RELAY_SOURCE_CONNECTION_ID", "") or "").strip()
DEFAULT_DIRECT_SYMBOLS = [
    "BTCUSDm", "ETHUSDm", "EURUSDm", "GBPUSDm", "USDJPYm", "XAUUSDm",
    "USDCADm", "AUDUSDm", "NZDUSDm", "USDCHFm", "EURGBPm", "USOILm",
]
LOCAL_MARKETDATA_URL = (os.getenv("LOCAL_MARKETDATA_URL", "http://127.0.0.1:8082").rstrip("/"))
BUFFER_FILE = Path(os.getenv("PRICE_RELAY_BUFFER_FILE", str(Path(__file__).resolve().parent / "logs" / "candle_buffer.json")))


def _discover_terminal_connection_ids() -> list[str]:
    ids: list[str] = []
    try:
        for child in TERMINALS_DIR.iterdir():
            if not child.is_dir():
                continue
            if (child / "terminal64.exe").exists():
                ids.append(child.name)
    except Exception:
        return []
    ids.sort()
    return ids


def _default_connection_id() -> str:
    if RELAY_SOURCE_CONNECTION_ID:
        return RELAY_SOURCE_CONNECTION_ID
    ids = _discover_terminal_connection_ids()
    return ids[0] if ids else ""


def _resolve_symbols(raw_symbols: Optional[str]) -> list[str]:
    if raw_symbols:
        out: list[str] = []
        seen: set[str] = set()
        for part in raw_symbols.split(","):
            sym = (part or "").strip()
            if not sym or sym in seen:
                continue
            out.append(sym)
            seen.add(sym)
        if out:
            return out
    return list(DEFAULT_DIRECT_SYMBOLS)


def _load_live_prices(conn_id: str, symbols: list[str]) -> dict:
    if not conn_id:
        return {}
    local_prices = _fetch_local_prices(conn_id)
    if local_prices:
        return local_prices
    buffered_prices = _buffered_prices(conn_id, symbols)
    if buffered_prices:
        return buffered_prices
    try:
        from runtime.mt5_candles import get_live_price_snapshots

        return get_live_price_snapshots(conn_id, symbols)
    except Exception as exc:
        logger.debug("Direct price fetch failed for %s: %r", conn_id, exc)
        return {}


def _load_candles(conn_id: str, symbol: str, tf: str, count: int) -> list[dict]:
    if not conn_id or not symbol:
        return []
    local_bars = _fetch_local_candles(conn_id, symbol, tf, count)
    if local_bars:
        return local_bars
    buffered_bars = _buffered_candles(conn_id, symbol, count)
    if buffered_bars:
        return buffered_bars
    try:
        from runtime.mt5_candles import get_broker_candles

        return get_broker_candles(conn_id, symbol, tf, count=count, include_current=False)
    except Exception as exc:
        logger.debug("Direct candle fetch failed for %s %s/%s: %r", conn_id, symbol, tf, exc)
        return []


def _fetch_local_json(path: str, params: dict[str, str]) -> Optional[dict]:
    if not LOCAL_MARKETDATA_URL:
        return None
    try:
        query = urllib.parse.urlencode({k: v for k, v in params.items() if v})
        url = f"{LOCAL_MARKETDATA_URL}{path}"
        if query:
            url = f"{url}?{query}"
        with urllib.request.urlopen(url, timeout=5) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        logger.debug("Local relay fetch failed for %s: %r", path, exc)
        return None


def _fetch_local_prices(conn_id: str) -> dict:
    payload = _fetch_local_json("/prices", {"conn_id": conn_id})
    if not isinstance(payload, dict):
        return {}
    prices = payload.get("prices")
    return prices if isinstance(prices, dict) else {}


def _fetch_local_candles(conn_id: str, symbol: str, tf: str, count: int) -> list[dict]:
    payload = _fetch_local_json(
        "/candles",
        {
            "conn_id": conn_id,
            "symbol": symbol,
            "tf": tf,
            "count": str(count),
        },
    )
    if not isinstance(payload, dict):
        return []
    bars = payload.get("bars")
    return bars if isinstance(bars, list) else []


def _read_buffer_file() -> dict:
    try:
        if not BUFFER_FILE.exists():
            return {}
        data = json.loads(BUFFER_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception as exc:
        logger.debug("Buffer file read failed: %r", exc)
        return {}


def _buffered_symbol_bars(conn_id: str, symbol: str) -> list[dict]:
    data = _read_buffer_file()
    exact = data.get(conn_id, {}).get(symbol, []) if isinstance(data.get(conn_id), dict) else []
    if isinstance(exact, list) and exact:
        return exact
    for sym_map in data.values():
        if isinstance(sym_map, dict):
            bars = sym_map.get(symbol, [])
            if isinstance(bars, list) and bars:
                return bars
    return []


def _buffered_candles(conn_id: str, symbol: str, count: int) -> list[dict]:
    bars = _buffered_symbol_bars(conn_id, symbol)
    if not bars:
        return []
    trimmed = bars[-count:]
    return trimmed if isinstance(trimmed, list) else []


def _buffered_prices(conn_id: str, symbols: list[str]) -> dict:
    out: dict = {}
    now_ms = int(time.time() * 1000)
    for symbol in symbols:
        bars = _buffered_symbol_bars(conn_id, symbol)
        if not bars:
            continue
        last = bars[-1] or {}
        close = last.get("c")
        ts = last.get("t")
        try:
            close_f = float(close)
            ts_ms = int(ts) * 1000 if ts is not None else now_ms
        except Exception:
            continue
        out[symbol] = {
            "bid": close_f,
            "ask": close_f,
            "ts_ms": ts_ms,
        }
    return out

# ============================================================================
# GLOBALS
# ============================================================================

redis_client = None
mt5_connections: Dict[str, dict] = {}  # user_id → {connection_obj, metadata}
agent_ready = False
main_event_loop: Optional[asyncio.AbstractEventLoop] = None

# ============================================================================
# REDIS STREAMS HELPERS
# ============================================================================

def init_redis():
    """Connect to Redis."""
    global redis_client
    try:
        if REDIS_URL:
            redis_client = redis.Redis.from_url(
                REDIS_URL,
                decode_responses=True,
                socket_connect_timeout=5,
            )
        else:
            redis_client = redis.Redis(
                host=REDIS_HOST,
                port=REDIS_PORT,
                decode_responses=True,
                socket_connect_timeout=5
            )
        redis_client.ping()
        if REDIS_URL:
            parsed = urlparse(REDIS_URL)
            logger.info(f"✓ Connected to Redis at {parsed.hostname}:{parsed.port or 6379}")
        else:
            logger.info(f"✓ Connected to Redis at {REDIS_HOST}:{REDIS_PORT}")
        return True
    except Exception as e:
        logger.error(f"✗ Failed to connect to Redis: {e}")
        return False

def publish_tick(user_id: str, tick: dict):
    """Publish tick to user's Redis Stream."""
    if not redis_client:
        return
    
    try:
        stream_key = f"user:{user_id}:ticks"
        redis_client.xadd(stream_key, {
            "symbol": tick.get("symbol"),
            "bid": str(tick.get("bid")),
            "ask": str(tick.get("ask")),
            "timestamp": str(tick.get("timestamp")),
            "volume": str(tick.get("volume", 0))
        })
        
        # Keep stream size under 10k messages (sliding window)
        redis_client.xtrim(stream_key, maxlen=10000, approximate=False)
    except Exception as e:
        logger.error(f"Failed to publish tick: {e}")

# ============================================================================
# MT5 CONNECTION MANAGEMENT
# ============================================================================

class MT5Connection:
    """Represents one user's MT5 connection."""
    
    def __init__(self, user_id: str, broker: str, login: str, password: str, symbols: list):
        self.user_id = user_id
        self.broker = broker
        self.login = login
        self.password = password
        self.symbols = symbols
        self.connected = False
        self.terminal_path = None
        self.ticks_count = 0
        self.last_tick_time = 0
    
    async def connect(self) -> bool:
        """Spawn MT5 process for this user."""
        logger.info(f"[{self.user_id}] Connecting to {self.broker}...")
        
        # TODO: Implement actual MT5 connection using job_worker pattern
        # For now, mock connection
        self.connected = True
        self.last_tick_time = time.time()
        
        logger.info(f"[{self.user_id}] ✓ Connected (symbols: {', '.join(self.symbols)})")
        return True
    
    async def disconnect(self):
        """Stop MT5 process for this user."""
        self.connected = False
        logger.info(f"[{self.user_id}] Disconnected")
    
    def add_tick(self, symbol: str, bid: float, ask: float):
        """Called when MT5 sends a tick."""
        tick = {
            "symbol": symbol,
            "bid": bid,
            "ask": ask,
            "timestamp": time.time()
        }
        publish_tick(self.user_id, tick)
        self.ticks_count += 1
        self.last_tick_time = time.time()


async def spawn_connection(conn: MT5Connection):
    """Actually spawn and register a user MT5 connection."""
    try:
        ok = await conn.connect()
        if ok:
            mt5_connections[conn.user_id] = {
                "connection": conn,
                "created_at": time.time(),
                "last_tick": None
            }
            logger.info(f"✓ Spawned MT5 for {conn.user_id}")
    except Exception as e:
        logger.error(f"Failed to spawn MT5 for {conn.user_id}: {e}")

# ============================================================================
# HTTP REQUEST HANDLER
# ============================================================================

class RelayHandler(BaseHTTPRequestHandler):
    """HTTP server handling spawn, stream, and health endpoints."""
    
    def do_POST(self):
        """POST endpoints."""
        if self.path == "/spawn-connection":
            self._handle_spawn_connection()
        elif self.path == "/register":
            self._handle_register()
        else:
            self._send_json(404, {"error": "Not found"})
    
    def do_GET(self):
        """GET endpoints."""
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path.startswith("/stream/"):
            self._handle_stream()
        elif path == "/stream":
            self._handle_market_stream(qs)
        elif path == "/prices":
            self._handle_prices(qs)
        elif path == "/candles":
            self._handle_candles(qs)
        elif path == "/health":
            self._handle_health()
        elif path == "/status":
            self._handle_status()
        else:
            self._send_json(404, {"error": "Not found"})
    
    def _handle_spawn_connection(self):
        """REST endpoint: POST /spawn-connection - Create user MT5 connection."""
        try:
            content_len = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(content_len))
            
            user_id = payload.get("user_id")
            broker = payload.get("broker", "exness")
            login = payload.get("login")
            password = payload.get("password")
            symbols = payload.get("symbols", ["EURUSDm", "GBPUSDm"])
            
            if not user_id or not login or not password:
                self._send_json(400, {"error": "Missing required fields"})
                return
            
            if user_id in mt5_connections:
                self._send_json(409, {"error": f"User {user_id} already has connection"})
                return
            
            # Create connection object
            conn = MT5Connection(user_id, broker, login, password, symbols)
            
            # Spawn MT5 on the main asyncio loop from this HTTP server thread
            if main_event_loop is None:
                self._send_json(503, {"error": "relay event loop not ready"})
                return

            asyncio.run_coroutine_threadsafe(spawn_connection(conn), main_event_loop)
            
            self._send_json(200, {
                "status": "spawning",
                "user_id": user_id,
                "stream_url": f"{AGENT_BASE_URL}/stream/{user_id}",
                "message": "MT5 connection spawning, will be ready in 10-15 seconds"
            })
        
        except Exception as e:
            logger.error(f"Error in spawn_connection: {e}")
            self._send_json(500, {"error": str(e)})
    
    def _handle_stream(self):
        """SSE endpoint: GET /stream/{user_id} - Stream ticks for user."""
        path_parts = self.path.split("/")
        if len(path_parts) < 3:
            self._send_json(400, {"error": "user_id required"})
            return
        
        user_id = path_parts[2]
        
        if user_id not in mt5_connections:
            self._send_json(404, {"error": f"User {user_id} not found"})
            return
        
        # Send SSE headers
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        
        # Stream ticks from Redis
        stream_key = f"user:{user_id}:ticks"
        last_id = "$"
        
        try:
            while True:
                # Read from Redis Stream with 5s timeout
                if redis_client:
                    messages = redis_client.xread(
                        {stream_key: last_id},
                        block=5000,
                        count=10
                    )
                    
                    if messages:
                        for _, msg_list in messages:
                            for msg_id, fields in msg_list:
                                # Send as SSE event
                                data = json.dumps(fields)
                                self.wfile.write(f"data: {data}\n\n".encode())
                                last_id = msg_id
                
                # Small heartbeat every 5s (keep connection alive)
                self.wfile.write(b": heartbeat\n\n")
                self.wfile.flush()
        
        except Exception as e:
            logger.debug(f"Stream closed for {user_id}: {e}")
    
    def _handle_health(self):
        """Health check endpoint."""
        active_conn_ids = _discover_terminal_connection_ids()
        status = {
            "status": "healthy",
            "agent_id": AGENT_ID,
            "active_connections": len(mt5_connections),
            "capacity": AGENT_CAPACITY,
            "relay_source_connection_id": RELAY_SOURCE_CONNECTION_ID or None,
            "active_conn_ids": active_conn_ids,
            "timestamp": datetime.now(timezone.utc).isoformat()
        }
        self._send_json(200, status)
    
    def _handle_status(self):
        """Detailed status endpoint."""
        conns_detail = {}
        for user_id, conn_info in mt5_connections.items():
            conn = conn_info["connection"]
            conns_detail[user_id] = {
                "broker": conn.broker,
                "symbols": conn.symbols,
                "connected": conn.connected,
                "ticks_count": conn.ticks_count,
                "last_tick": conn.last_tick_time,
                "created_at": conn_info["created_at"]
            }
        
        status = {
            "agent_id": AGENT_ID,
            "capacity": AGENT_CAPACITY,
            "active_connections": len(mt5_connections),
            "connections": conns_detail,
            "redis_connected": redis_client is not None
        }
        self._send_json(200, status)
    
    def _handle_register(self):
        """Register endpoint (called by control plane)."""
        self._send_json(200, {"status": "registered"})

    def _handle_prices(self, qs: dict):
        conn_id = (qs.get("conn_id", [""])[0] or "").strip() or _default_connection_id()
        symbols = _resolve_symbols((qs.get("symbols", [""])[0] or "").strip())
        prices = _load_live_prices(conn_id, symbols)
        self._send_json(200, {
            "connection_id": conn_id,
            "prices": prices,
        })

    def _handle_candles(self, qs: dict):
        symbol = (qs.get("symbol", [""])[0] or "").strip()
        tf = ((qs.get("tf", [""])[0] or qs.get("timeframe", ["1m"])[0] or "1m").strip().lower())
        if tf in {"m1", "m3", "m5", "m15", "m30"}:
            tf = tf[1:] + "m"
        elif tf in {"h1", "h4"}:
            tf = tf[1:] + "h"
        elif tf == "d1":
            tf = "1d"
        count_raw = (qs.get("count", [""])[0] or qs.get("limit", ["200"])[0] or "200").strip()
        conn_id = (qs.get("conn_id", [""])[0] or "").strip() or _default_connection_id()

        try:
            count = int(count_raw)
        except Exception:
            count = 200
        count = max(1, min(count, 1500))

        if not symbol:
            self._send_json(400, {"error": "symbol required"})
            return
        if not conn_id:
            self._send_json(400, {"error": "conn_id required"})
            return

        bars = _load_candles(conn_id, symbol, tf, count)
        self._send_json(200, {
            "connection_id": conn_id,
            "symbol": symbol,
            "tf": tf,
            "count": len(bars),
            "bars": bars,
        })

    def _handle_market_stream(self, qs: dict):
        conn_id = (qs.get("conn_id", [""])[0] or "").strip() or _default_connection_id()
        symbols = _resolve_symbols((qs.get("symbols", [""])[0] or "").strip())

        if self._proxy_local_market_stream(conn_id):
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        last_prices: dict = {}

        try:
            while True:
                prices = _load_live_prices(conn_id, symbols)
                event_type = "init" if not last_prices else "prices"
                payload = {
                    "type": event_type,
                    "connection_id": conn_id,
                    "symbols": symbols,
                    "prices": prices,
                }
                if prices or not last_prices:
                    self.wfile.write(f"event: {event_type}\ndata: {json.dumps(payload)}\n\n".encode())
                    self.wfile.flush()
                    last_prices = prices

                connected_payload = {
                    "type": "connected",
                    "connection_id": conn_id,
                    "symbols": symbols,
                    "status": "ok",
                }
                self.wfile.write(f"event: connected\ndata: {json.dumps(connected_payload)}\n\n".encode())
                self.wfile.write(f"event: heartbeat\ndata: {json.dumps({'type': 'heartbeat', 'ts': int(time.time() * 1000)})}\n\n".encode())
                self.wfile.flush()
                time.sleep(2.0)
        except Exception as exc:
            logger.debug("Market stream closed for %s: %r", conn_id, exc)

    def _proxy_local_market_stream(self, conn_id: str) -> bool:
        if not LOCAL_MARKETDATA_URL or not conn_id:
            return False

        upstream_url = f"{LOCAL_MARKETDATA_URL}/stream?{urllib.parse.urlencode({'conn_id': conn_id})}"
        try:
            req = urllib.request.Request(upstream_url, headers={"Accept": "text/event-stream"})
            upstream = urllib.request.urlopen(req, timeout=10)
        except Exception as exc:
            logger.debug("Local relay stream proxy failed for %s: %r", conn_id, exc)
            return False

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        try:
            while True:
                chunk = upstream.readline()
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except Exception as exc:
            logger.debug("Local relay stream closed for %s: %r", conn_id, exc)
        finally:
            try:
                upstream.close()
            except Exception:
                pass
        return True
    
    def _send_json(self, status_code: int, data: dict):
        """Send JSON response."""
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())
    
    def log_message(self, format, *args):
        """Suppress default HTTP logging."""
        pass

# ============================================================================
# CONTROL PLANE REGISTRATION
# ============================================================================

async def register_with_control_plane():
    """Tell control plane: I'm alive and ready."""
    try:
        async with aiohttp.ClientSession() as session:
            payload = {
                "agent_id": AGENT_ID,
                "ip": AGENT_IP,
                "port": AGENT_PORT,
                "base_url": AGENT_BASE_URL,
                "capacity": AGENT_CAPACITY,
                "status": "ready"
            }
            
            async with session.post(
                f"{CONTROL_PLANE_URL}/agents/register",
                json=payload,
                timeout=aiohttp.ClientTimeout(total=10)
            ) as resp:
                if resp.status == 200:
                    logger.info(f"✓ Registered with control plane: {AGENT_ID}")
                    return True
                else:
                    logger.error(f"✗ Failed to register: HTTP {resp.status}")
                    return False
    except Exception as e:
        logger.error(f"✗ Failed to register with control plane: {e}")
        return False

async def heartbeat_loop():
    """Send heartbeats to control plane every 30 seconds."""
    while True:
        try:
            await asyncio.sleep(30)
            
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{CONTROL_PLANE_URL}/agents/heartbeat?agent_id={AGENT_ID}",
                    timeout=aiohttp.ClientTimeout(total=5)
                ) as resp:
                    if resp.status == 200:
                        logger.debug(f"✓ Heartbeat sent to control plane")
                    elif resp.status == 404:
                        logger.warning("Control plane forgot this agent; re-registering")
                        await register_with_control_plane()
                    else:
                        logger.debug(f"Heartbeat returned HTTP {resp.status}")
        except Exception as e:
            logger.debug(f"Heartbeat failed: {e}")


async def claim_jobs_loop():
    """Poll the control plane for queued spawn jobs."""
    while True:
        try:
            await asyncio.sleep(5)

            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{CONTROL_PLANE_URL}/agents/jobs/claim?agent_id={AGENT_ID}&limit=10",
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp:
                    if resp.status != 200:
                        logger.debug(f"Job claim returned HTTP {resp.status}")
                        continue

                    payload = await resp.json()
                    for job in payload.get("jobs", []):
                        user_id = job.get("user_id")
                        if not user_id or user_id in mt5_connections:
                            continue

                        conn = MT5Connection(
                            user_id,
                            job.get("broker", "exness"),
                            job.get("login"),
                            job.get("password"),
                            job.get("symbols", ["EURUSDm", "GBPUSDm"]),
                        )
                        await spawn_connection(conn)
        except Exception as e:
            logger.debug(f"Job claim failed: {e}")

# ============================================================================
# MAIN
# ============================================================================

async def start_server():
    """Start HTTP server in background thread."""
    def run_server():
        server = HTTPServer(("0.0.0.0", AGENT_PORT), RelayHandler)
        logger.info(f"✓ Relay agent listening on http://0.0.0.0:{AGENT_PORT}")
        server.serve_forever()
    
    thread = Thread(target=run_server, daemon=True)
    thread.start()
    return thread

async def main():
    """Main entry point."""
    global agent_ready, main_event_loop

    main_event_loop = asyncio.get_running_loop()
    
    logger.info("=" * 70)
    logger.info(f"IFX Multi-Tenant Relay Agent ({AGENT_ID}) starting...")
    logger.info(f"  IP: {AGENT_IP}")
    logger.info(f"  Port: {AGENT_PORT}")
    logger.info(f"  Base URL: {AGENT_BASE_URL}")
    logger.info(f"  Capacity: {AGENT_CAPACITY} users")
    logger.info(f"  Control Plane: {CONTROL_PLANE_URL}")
    logger.info(f"  Redis: {REDIS_URL or (REDIS_HOST + ':' + str(REDIS_PORT))}")
    logger.info("=" * 70)
    
    # Connect to Redis
    if not init_redis():
        logger.warning("⚠ Running without Redis (ticks won't be persisted)")
    
    # Start HTTP server
    await start_server()
    
    # Wait a moment then register
    await asyncio.sleep(1)
    
    # Register with control plane
    registered = await register_with_control_plane()
    
    if registered:
        agent_ready = True
        logger.info(f"✓ Agent {AGENT_ID} ready!")
        
        # Start heartbeat loop
        asyncio.create_task(heartbeat_loop())
        asyncio.create_task(claim_jobs_loop())
        
        # Keep running
        try:
            while True:
                await asyncio.sleep(1)
        except KeyboardInterrupt:
            logger.info("Shutdown signal received")
        finally:
            for conn_info in mt5_connections.values():
                with suppress(Exception):
                    await conn_info["connection"].disconnect()
    else:
        logger.error("✗ Failed to register with control plane, exiting")

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Relay agent stopped")
