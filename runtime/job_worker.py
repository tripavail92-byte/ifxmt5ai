"""
job_worker.py
IFX MT5 Runtime — Trade Worker.

One process per connection_id.
Responsibilities:
  - Provision terminal
  - Initialize MT5 (portable, with timeout + retries)
  - Send heartbeats every 5s
  - Claim jobs atomically
  - Enforce idempotency (DB check + MT5 comment check)
  - Execute trades and write results back
  - Exponential backoff on errors

Usage:
  python job_worker.py <connection_id>

Environment:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  MT5_CREDENTIALS_MASTER_KEY_B64
  IFX_CRASH_AFTER_ORDER=1  (debug: crash after order, before DB write)
"""

import json
import logging
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable


def _enforce_venv() -> None:
    root = Path(__file__).parent.parent
    expected = root / ".venv" / "Scripts" / "python.exe"
    if not expected.exists():
        return

    try:
        exe_path = Path(sys.executable).resolve()
        expected_path = expected.resolve()
    except Exception:
        exe_path = Path(sys.executable)
        expected_path = expected

    if exe_path != expected_path:
        print(
            "Refusing to run worker with non-venv Python. "
            f"Expected: {expected_path} | Got: {exe_path}"
        )
        raise SystemExit(2)


_enforce_venv()

import MetaTrader5 as mt5

import db_client as db
from crypto_utils import decrypt_mt5_password
from provision_terminal import verify_or_provision, verify_or_reprovision

# ---------------------------------------------------------------------------
# Bootstrap logging
# ---------------------------------------------------------------------------

LOG_DIR = Path(__file__).parent.parent / "logs"
LOG_DIR.mkdir(exist_ok=True)


def setup_logging(connection_id: str) -> logging.Logger:
    prefix = connection_id[:8]
    log_file = LOG_DIR / f"worker_{prefix}.log"
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        handlers=[
            logging.FileHandler(log_file, encoding="utf-8"),
            logging.StreamHandler(sys.stdout),
        ],
    )
    return logging.getLogger(f"worker.{prefix}")


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

cfg_path = Path(__file__).parent.parent / "config" / "settings.json"
with open(cfg_path) as f:
    CFG = json.load(f)

HEARTBEAT_INTERVAL = CFG["HEARTBEAT_INTERVAL_SEC"]
INIT_TIMEOUT = CFG["MT5_INIT_TIMEOUT_SEC"]
LOGIN_TIMEOUT = CFG["MT5_LOGIN_TIMEOUT_SEC"]
INIT_RETRIES = CFG["MT5_INIT_RETRIES"]
COOLDOWN_SEC = CFG["MT5_INIT_COOLDOWN_SEC"]
CLAIM_TIMEOUT = CFG["CLAIM_TIMEOUT_SEC"]
MAX_RETRIES = CFG["MAX_RETRIES"]
BACKOFF_START = CFG["BACKOFF_START_SEC"]
BACKOFF_MAX = CFG["BACKOFF_MAX_SEC"]
SYMBOL_SELECT_RETRIES = CFG["SYMBOL_SELECT_RETRIES"]

CRASH_AFTER_ORDER = os.environ.get("IFX_CRASH_AFTER_ORDER", "0") == "1"


# ---------------------------------------------------------------------------
# Claimed-by label (globally unique)
# ---------------------------------------------------------------------------

def claimed_by_label() -> str:
    return f"{socket.gethostname()}:{os.getpid()}:{int(time.time())}"


# ---------------------------------------------------------------------------
# MT5 headless initialize (Enterprise Config Injection)
# ---------------------------------------------------------------------------

def mt5_init_headless(
    terminal_path: str,
    login: int,
    password: str,
    server: str,
    timeout: int,
    progress_cb: Callable[[], None] | None = None,
) -> bool:
    """
    MT5 initialization with timeout + retries.

    Important: avoid manually launching terminal64.exe here.
    When `mt5.initialize(path=...)` is given a path, the MetaTrader5 Python API
    may start/connect to the terminal itself; double-launching can cause
    "terminal process already started" and clean exits (code 0), preventing IPC.
    """
    deadline = time.time() + timeout

    def _progress() -> None:
        if progress_cb is None:
            return
        try:
            progress_cb()
        except Exception:
            return

    # Best-effort: terminate a stuck terminal for this exact portable path.
    try:
        import psutil  # type: ignore

        target = str(Path(terminal_path))
        for proc in psutil.process_iter(attrs=["pid", "exe"]):
            try:
                exe = proc.info.get("exe") or ""
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
            if not exe:
                continue
            try:
                if Path(exe).resolve() == Path(target).resolve():
                    proc.terminate()
            except Exception:
                continue
        time.sleep(1)
    except Exception:
        pass

    # Repeatedly attempt initialization within the overall timeout window.
    # Short per-call timeout keeps retries responsive.
    per_call_timeout_ms = 15000
    while time.time() < deadline:
        _progress()
        ok = mt5.initialize(
            path=str(terminal_path),
            portable=True,
            server=server,
            login=login,
            password=password,
            timeout=per_call_timeout_ms,
        )
        if ok:
            return True

        # Reset state between attempts.
        try:
            mt5.shutdown()
        except Exception:
            pass

        time.sleep(2)

    return False


def login_with_timeout(
    login: int,
    password: str,
    server: str,
    timeout: int,
    progress_cb: Callable[[], None] | None = None,
) -> bool:
    """Attempt mt5.login() and wait up to timeout seconds."""
    deadline = time.time() + timeout
    if progress_cb is not None:
        try:
            progress_cb()
        except Exception:
            pass
    result = mt5.login(login, password=password, server=server)
    while not result and time.time() < deadline:
        if progress_cb is not None:
            try:
                progress_cb()
            except Exception:
                pass
        time.sleep(2)
        result = mt5.login(login, password=password, server=server)
    return result


# ---------------------------------------------------------------------------
# Terminal health check
# ---------------------------------------------------------------------------

def check_terminal_health(logger: logging.Logger) -> bool:
    """
    Verify that the terminal is ready to trade.
    Returns True if all checks pass.
    """
    acc = mt5.account_info()
    if acc is None:
        logger.warning("Health check: account_info() returned None — %s", mt5.last_error())
        return False

    term = mt5.terminal_info()
    if term is None:
        logger.warning("Health check: terminal_info() returned None — %s", mt5.last_error())
        return False

    if not term.connected:
        logger.warning("Health check: terminal not connected to broker.")
        return False

    # trade_allowed can be False during off-hours/weekends — log it but don't restart
    if not term.trade_allowed:
        logger.info("Health check: trade_allowed is False (market likely closed or off-hours). Terminal still connected OK.")

    return True


# ---------------------------------------------------------------------------
# Symbol validation
# ---------------------------------------------------------------------------

def _try_symbol_select_with_retries(symbol: str, logger: logging.Logger) -> bool:
    """Try mt5.symbol_select() up to SYMBOL_SELECT_RETRIES times."""
    for attempt in range(1, SYMBOL_SELECT_RETRIES + 1):
        if mt5.symbol_select(symbol, True):
            return True
        logger.warning(
            "symbol_select(%s) failed (attempt %d/%d): %s",
            symbol, attempt, SYMBOL_SELECT_RETRIES, mt5.last_error(),
        )
        time.sleep(1)
    return False


def ensure_symbol_selected(symbol: str, logger: logging.Logger) -> str | None:
    """
    Ensure a tradable symbol is selected.
    Returns the actual selected symbol name (may differ by case/suffix), or None.
    """
    requested = (symbol or "").strip()
    if not requested:
        return None

    if _try_symbol_select_with_retries(requested, logger):
        return requested

    try:
        all_symbols = mt5.symbols_get() or []
    except Exception:
        all_symbols = []

    names = [s.name for s in all_symbols if getattr(s, "name", None)]
    if not names:
        return None

    # 1) Case-insensitive exact match (handles BTCUSDM -> BTCUSDm)
    lower_map = {name.lower(): name for name in names}
    ci_exact = lower_map.get(requested.lower())
    if ci_exact and ci_exact != requested:
        logger.info("Resolved symbol %s -> %s (case-insensitive match)", requested, ci_exact)
        if _try_symbol_select_with_retries(ci_exact, logger):
            return ci_exact

    # 2) Normalized matching for broker-specific wrappers:
    #    - Prefixes: mBTCUSD, cBTCUSD, tBTCUSD
    #    - Suffixes: BTCUSDm, BTCUSD.c, BTCUSDpro
    #    - Separators: BTCUSD.r, BTCUSD_i, XAUUSD-ecn
    def normalize(name: str) -> str:
        return "".join(ch for ch in (name or "").upper() if ch.isalnum())

    requested_norm = normalize(requested)
    if not requested_norm:
        return None

    scored: list[tuple[int, int, str]] = []
    for name in names:
        candidate_norm = normalize(name)
        if not candidate_norm:
            continue

        score = 0
        if candidate_norm == requested_norm:
            score = 100
        elif candidate_norm.startswith(requested_norm):
            score = 92
        elif candidate_norm.endswith(requested_norm):
            score = 90
        elif requested_norm in candidate_norm:
            score = 84
        elif candidate_norm in requested_norm:
            score = 78

        if score > 0:
            # Prefer shorter/closer names among same class of match.
            score -= min(abs(len(candidate_norm) - len(requested_norm)), 8)
            scored.append((score, len(candidate_norm), name))

    if scored:
        # Highest score first, then closest length.
        scored.sort(key=lambda item: (-item[0], item[1], item[2]))
        best_score, _, resolved = scored[0]

        # Guardrail: avoid weak accidental matches.
        if best_score >= 76:
            if resolved != requested:
                logger.info(
                    "Resolved symbol %s -> %s (normalized match score=%s)",
                    requested,
                    resolved,
                    best_score,
                )
            if _try_symbol_select_with_retries(resolved, logger):
                return resolved

    return None


def build_job_comment_marker(job_id: str) -> str:
    """
    Build an MT5-safe comment marker for a job.
    MT5 comment length is broker-dependent and often capped near 31 chars,
    so we keep this short and deterministic.
    """
    compact = "".join(ch for ch in (job_id or "") if ch.isalnum())
    return f"IFX{compact[:20]}"


# ---------------------------------------------------------------------------
# Idempotency: check if trade already placed
# ---------------------------------------------------------------------------

def find_existing_order_by_job_id(job_id: str) -> dict | None:
    """
    Search open positions and pending orders for a comment containing job_id.
    Returns the first match or None.
    """
    comment_marker = build_job_comment_marker(job_id)

    positions = mt5.positions_get() or []
    for p in positions:
        if comment_marker in (p.comment or ""):
            return {"type": "position", "ticket": p.ticket, "comment": p.comment}

    orders = mt5.orders_get() or []
    for o in orders:
        if comment_marker in (o.comment or ""):
            return {"type": "order", "ticket": o.ticket, "comment": o.comment}

    # Also check history (closed today)
    from datetime import timedelta
    history = mt5.history_deals_get(
        datetime.now(timezone.utc) - timedelta(days=7),
        datetime.now(timezone.utc),
    ) or []
    for d in history:
        if comment_marker in (d.comment or ""):
            return {"type": "deal", "ticket": d.ticket, "comment": d.comment}

    return None


# ---------------------------------------------------------------------------
# Order execution
# ---------------------------------------------------------------------------

def close_position_by_ticket(ticket: int, logger: logging.Logger) -> dict:
    """
    Close an open MT5 position identified by its ticket number.
    Returns result dict with order_id, retcode, message.
    Raises RuntimeError on failure.
    """
    positions = mt5.positions_get(ticket=ticket)
    if not positions:
        raise RuntimeError(f"Position ticket {ticket} not found in MT5")

    pos = positions[0]
    symbol = pos.symbol
    volume = pos.volume
    # Opposite order type to close
    close_type = mt5.ORDER_TYPE_SELL if pos.type == 0 else mt5.ORDER_TYPE_BUY

    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        raise RuntimeError(f"Cannot get tick for {symbol}: {mt5.last_error()}")

    close_price = tick.bid if pos.type == 0 else tick.ask

    symbol_info = mt5.symbol_info(symbol)
    filling_modes = [mt5.ORDER_FILLING_IOC, mt5.ORDER_FILLING_FOK, mt5.ORDER_FILLING_RETURN]
    if symbol_info:
        filling_modes = [symbol_info.filling_mode] + filling_modes

    last_result = None
    for mode in dict.fromkeys(filling_modes):  # deduplicate preserving order
        request = {
            "action":       mt5.TRADE_ACTION_DEAL,
            "position":     ticket,
            "symbol":       symbol,
            "volume":       volume,
            "type":         close_type,
            "price":        close_price,
            "comment":      "ifx_close",
            "type_time":    mt5.ORDER_TIME_GTC,
            "type_filling": mode,
        }
        result = mt5.order_send(request)
        if result is None:
            raise RuntimeError(f"order_send returned None: {mt5.last_error()}")
        last_result = result
        if result.retcode == 10030:
            logger.warning("close_position ticket=%s unsupported filling mode=%s; trying next", ticket, mode)
            continue
        return {
            "order_id":   result.order,
            "retcode":    result.retcode,
            "message":    result.comment,
            "request_id": result.request_id,
            "ticket":     ticket,
        }

    return {
        "order_id":   last_result.order if last_result else 0,
        "retcode":    last_result.retcode if last_result else 10030,
        "message":    last_result.comment if last_result else "Unsupported filling mode",
        "request_id": last_result.request_id if last_result else 0,
        "ticket":     ticket,
    }


# ---------------------------------------------------------------------------

def execute_order(job: dict, logger: logging.Logger) -> dict:
    """
    Place an MT5 market order for the given job.
    Returns result dict with order_id, retcode, message.

    Raises RuntimeError if order fails.
    """
    job_id = job["id"]
    symbol = job["symbol"]
    side = job["side"]
    volume = float(job["volume"])
    sl = float(job["sl"]) if job.get("sl") else 0.0
    tp = float(job["tp"]) if job.get("tp") else 0.0
    comment_field = (job.get("comment") or "").strip()

    # ------------------------------------------------------------------ #
    # Detect pending order type from comment prefix                        #
    # __limit__:<price>  → BUY_LIMIT / SELL_LIMIT                         #
    # __stop__:<price>   → BUY_STOP  / SELL_STOP                          #
    # ------------------------------------------------------------------ #
    pending_price: float | None = None
    is_limit_type = False  # True=limit, False=stop (only used when pending)

    if comment_field.startswith("__limit__:"):
        try:
            pending_price = float(comment_field.split(":", 1)[1])
            is_limit_type = True
        except (ValueError, IndexError):
            logger.warning("Malformed __limit__ comment '%s'; falling back to market", comment_field)
    elif comment_field.startswith("__stop__:"):
        try:
            pending_price = float(comment_field.split(":", 1)[1])
            is_limit_type = False
        except (ValueError, IndexError):
            logger.warning("Malformed __stop__ comment '%s'; falling back to market", comment_field)

    # ------------------------------------------------------------------ #
    # Pending order branch                                                 #
    # ------------------------------------------------------------------ #
    if pending_price is not None:
        if side == "buy":
            pend_type = mt5.ORDER_TYPE_BUY_LIMIT if is_limit_type else mt5.ORDER_TYPE_BUY_STOP
        else:
            pend_type = mt5.ORDER_TYPE_SELL_LIMIT if is_limit_type else mt5.ORDER_TYPE_SELL_STOP

        request = {
            "action": mt5.TRADE_ACTION_PENDING,
            "symbol": symbol,
            "volume": volume,
            "type": pend_type,
            "price": pending_price,
            "sl": sl,
            "tp": tp,
            "comment": build_job_comment_marker(job_id),
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": mt5.ORDER_FILLING_RETURN,
        }
        result = mt5.order_send(request)
        if result is None:
            raise RuntimeError(f"order_send returned None (pending): {mt5.last_error()}")
        if result.retcode not in (10008, 10009):  # ORDER_PLACED or DONE
            raise RuntimeError(
                f"Pending order failed: retcode={result.retcode} comment='{result.comment}'"
            )
        return {
            "order_id": result.order,
            "retcode": result.retcode,
            "message": result.comment,
            "request_id": result.request_id,
        }

    # ------------------------------------------------------------------ #
    # Market order branch (original path)                                 #
    # ------------------------------------------------------------------ #
    order_type = mt5.ORDER_TYPE_BUY if side == "buy" else mt5.ORDER_TYPE_SELL

    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        raise RuntimeError(f"Cannot get tick for {symbol}: {mt5.last_error()}")

    price = tick.ask if side == "buy" else tick.bid
    symbol_info = mt5.symbol_info(symbol)
    if symbol_info is None:
        raise RuntimeError(f"Cannot get symbol info for {symbol}: {mt5.last_error()}")

    preferred_filling = symbol_info.filling_mode
    filling_modes = [
        preferred_filling,
        mt5.ORDER_FILLING_IOC,
        mt5.ORDER_FILLING_FOK,
        mt5.ORDER_FILLING_RETURN,
    ]
    # preserve order while removing duplicates
    deduped_filling_modes: list[int] = []
    for mode in filling_modes:
        if mode not in deduped_filling_modes:
            deduped_filling_modes.append(mode)

    last_result = None
    for mode in deduped_filling_modes:
        request = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": symbol,
            "volume": volume,
            "type": order_type,
            "price": price,
            "sl": sl,
            "tp": tp,
            "comment": build_job_comment_marker(job_id),
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": mode,
        }

        result = mt5.order_send(request)
        if result is None:
            raise RuntimeError(f"order_send returned None: {mt5.last_error()}")

        last_result = result
        # 10030 => unsupported filling mode; try next mode.
        if result.retcode == 10030:
            logger.warning("order_send unsupported filling mode=%s for %s; trying next mode", mode, symbol)
            continue

        return {
            "order_id": result.order,
            "retcode": result.retcode,
            "message": result.comment,
            "request_id": result.request_id,
        }

    # All tested modes rejected with unsupported filling mode.
    return {
        "order_id": last_result.order if last_result else 0,
        "retcode": last_result.retcode if last_result else 10030,
        "message": last_result.comment if last_result else "Unsupported filling mode",
        "request_id": last_result.request_id if last_result else 0,
    }


# ---------------------------------------------------------------------------
# Backoff helper
# ---------------------------------------------------------------------------

class ExponentialBackoff:
    def __init__(self, start: float = BACKOFF_START, max_sleep: float = BACKOFF_MAX):
        self.start = start
        self.max = max_sleep
        self._current = start

    def sleep(self):
        time.sleep(self._current)
        self._current = min(self._current * 2, self.max)

    def reset(self):
        self._current = self.start


# ---------------------------------------------------------------------------
# Main worker loop
# ---------------------------------------------------------------------------

def run_worker(connection_id: str):
    logger = setup_logging(connection_id)
    logger.info("=== Worker starting for connection %s ===", connection_id)

    started_at = datetime.now(timezone.utc).isoformat()
    pid = os.getpid()
    cb_label = claimed_by_label()
    backoff = ExponentialBackoff()
    last_heartbeat    = 0.0
    last_status_sync  = 0.0   # tracks when we last pushed 'online' to connections table
    STATUS_SYNC_INTERVAL = 60  # seconds between connection-status refreshes

    # ------------------------------------------------------------------ #
    # Step 1: Get connection credentials
    # ------------------------------------------------------------------ #
    connections = db.get_active_connections()
    conn = next((c for c in connections if c["id"] == connection_id), None)
    if conn is None:
        logger.error("Connection %s not found or not active. Exiting.", connection_id)
        sys.exit(1)

    broker_server = conn.get("broker_server", "")

    # ------------------------------------------------------------------ #
    # Step 2: Provision terminal (uses right MT5 binary for this broker)
    # ------------------------------------------------------------------ #
    try:
        terminal_path = verify_or_provision(connection_id, broker_server=broker_server)
    except Exception as exc:
        logger.error("Provisioning failed: %s", exc)
        db.log_event("error", "worker", f"Provisioning failed: {exc}", connection_id)
        db.update_connection_status(connection_id, "error", str(exc))
        sys.exit(1)

    master_key = os.environ["MT5_CREDENTIALS_MASTER_KEY_B64"]
    try:
        password = decrypt_mt5_password(
            conn["password_ciphertext_b64"],
            conn["password_nonce_b64"],
            master_key,
        )
    except Exception as exc:
        logger.error("Credential decryption failed: %s", exc)
        db.log_event("error", "worker", "Credential decryption failed", connection_id)
        db.update_connection_status(connection_id, "error", "Decryption failed")
        sys.exit(1)

    account_login = int(conn["account_login"])
    broker_server = conn["broker_server"]

    # ------------------------------------------------------------------ #
    # Step 3: Initialize MT5 with retries
    # ------------------------------------------------------------------ #
    db.upsert_heartbeat(
        connection_id, pid, "starting",
        terminal_path=str(terminal_path),
        started_at=started_at,
    )
    db.update_connection_status(connection_id, "connecting")

    init_attempt = 0
    mt5_ready = False

    reprovisioned = False

    last_init_heartbeat = 0.0

    def touch_starting_heartbeat() -> None:
        nonlocal last_init_heartbeat
        now = time.time()
        if now - last_init_heartbeat < HEARTBEAT_INTERVAL:
            return
        last_init_heartbeat = now
        try:
            db.upsert_heartbeat(
                connection_id,
                pid,
                "starting",
                terminal_path=str(terminal_path),
                started_at=started_at,
            )
        except Exception:
            return

    def start_keepalive(status: str) -> threading.Event:
        """Keep the heartbeat fresh while blocking calls (e.g., mt5.initialize)."""
        stop_event = threading.Event()

        def _loop() -> None:
            # Fire immediately, then every HEARTBEAT_INTERVAL.
            while not stop_event.is_set():
                try:
                    db.upsert_heartbeat(
                        connection_id,
                        pid,
                        status,
                        terminal_path=str(terminal_path),
                        started_at=started_at,
                    )
                except Exception:
                    pass
                # Wait with early-exit support.
                stop_event.wait(HEARTBEAT_INTERVAL)

        threading.Thread(
            target=_loop,
            name=f"hb_keepalive_{connection_id[:8]}",
            daemon=True,
        ).start()
        return stop_event

    keepalive_stop = start_keepalive("starting")

    try:
        while init_attempt < INIT_RETRIES and not mt5_ready:
            init_attempt += 1
            logger.info("MT5 init attempt %d/%d ...", init_attempt, INIT_RETRIES)

            if not mt5_init_headless(
                str(terminal_path / "terminal64.exe"),
                account_login,
                password,
                broker_server,
                INIT_TIMEOUT,
                progress_cb=touch_starting_heartbeat,
            ):
                err = mt5.last_error()
                logger.warning("mt5.initialize() failed: %s", err)

                # Auto-repair path: when MT5 IPC never answers, the portable folder
                # is often in a bad state (partial LiveUpdate, corrupted config, etc).
                # Re-provision once per worker start to avoid infinite loops.
                if (
                    (not reprovisioned)
                    and isinstance(err, tuple)
                    and len(err) >= 1
                    and err[0] == -10003
                ):
                    reprovisioned = True
                    logger.warning(
                        "IPC init timeout (-10003). Forcing terminal reprovision for %s...",
                        connection_id,
                    )
                    try:
                        terminal_path = verify_or_reprovision(
                            connection_id,
                            broker_server=broker_server,
                        )
                        db.upsert_heartbeat(
                            connection_id,
                            pid,
                            "starting",
                            terminal_path=str(terminal_path),
                            started_at=started_at,
                        )
                    except Exception as exc:
                        logger.error("Forced reprovision failed: %s", exc)

                mt5.shutdown()
                time.sleep(3)
                continue

            if not login_with_timeout(
                account_login,
                password,
                broker_server,
                LOGIN_TIMEOUT,
                progress_cb=touch_starting_heartbeat,
            ):
                logger.warning("mt5.login() failed: %s", mt5.last_error())
                mt5.shutdown()
                time.sleep(3)
                continue

            mt5_ready = True

    finally:
        keepalive_stop.set()

    if not mt5_ready:
        logger.error("MT5 failed to initialize after %d attempts. Cooling down.", INIT_RETRIES)
        db.log_event("error", "worker", f"MT5 init failed after {INIT_RETRIES} attempts", connection_id)
        db.update_connection_status(connection_id, "error", "MT5 init failed")
        db.upsert_heartbeat(connection_id, pid, "error", started_at=started_at)
        time.sleep(COOLDOWN_SEC)
        sys.exit(1)

    logger.info("MT5 initialized and logged in as %s on %s", account_login, broker_server)
    db.upsert_heartbeat(
        connection_id, pid, "online",
        terminal_path=str(terminal_path),
        mt5_initialized=True,
        account_login=str(account_login),
        started_at=started_at,
    )
    db.update_connection_status(connection_id, "online")

    # Sync live symbol list from broker to Supabase (for frontend dropdown)
    try:
        all_symbols = mt5.symbols_get()

        # On some terminals, symbols_get() can return only a small MarketWatch
        # subset. Attempt a broader fetch (group '*') when the list is tiny.
        try:
            total = mt5.symbols_total()
        except Exception:
            total = None

        if (not all_symbols) or (len(all_symbols) < 20 and (total is None or total > len(all_symbols))):
            expanded = None
            # MetaTrader5 Python API supports symbols_get(group="*") on most builds.
            for attempt in (
                ("group", "*"),
                (None, "*"),
            ):
                try:
                    if attempt[0] == "group":
                        expanded = mt5.symbols_get(group=attempt[1])
                    else:
                        expanded = mt5.symbols_get(attempt[1])
                except TypeError:
                    expanded = None
                except Exception:
                    expanded = None

                if expanded and len(expanded) > (len(all_symbols) if all_symbols else 0):
                    all_symbols = expanded
                    break

        if all_symbols:
            rows = [
                {
                    "connection_id": connection_id,
                    "symbol": s.name,
                    "description": s.description,
                    "currency_base": s.currency_base,
                    "category": s.path.split("\\")[0] if s.path else "",
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
                for s in all_symbols
            ]
            # Batch upsert in chunks of 500
            for i in range(0, len(rows), 500):
                db.get_client().table("mt5_symbols").upsert(
                    rows[i:i+500], on_conflict="connection_id,symbol"
                ).execute()
            logger.info("Synced %d symbols to Supabase.", len(rows))
    except Exception as exc:
        logger.warning("Symbol sync failed (non-fatal): %s", exc)

    # ------------------------------------------------------------------ #
    # Step 4: Main execution loop
    # ------------------------------------------------------------------ #
    logger.info("Entering main loop...")

    while True:
        now = time.time()

        # --- Heartbeat ---
        if now - last_heartbeat >= HEARTBEAT_INTERVAL:
            acc = mt5.account_info()
            metrics = {}
            if acc:
                metrics = {
                    "balance": acc.balance,
                    "equity": acc.equity,
                    "margin": acc.margin,
                    "free_margin": acc.margin_free,
                    "margin_level": acc.margin_level if acc.margin > 0 else 0,
                    "profit": acc.profit,
                }
            # Attach live open positions so the frontend can render them
            # directly from the heartbeat row without a separate table.
            raw_positions = mt5.positions_get() or []
            metrics["open_positions"] = [
                {
                    "ticket":      int(p.ticket),
                    "symbol":      p.symbol,
                    "type":        "buy" if p.type == 0 else "sell",
                    "volume":      float(p.volume),
                    "open_price":  float(p.price_open),
                    "current_price": float(p.price_current),
                    "sl":          float(p.sl) if p.sl else None,
                    "tp":          float(p.tp) if p.tp else None,
                    "profit":      float(p.profit),
                    "swap":        float(p.swap),
                    "open_time":   p.time,
                    "comment":     p.comment,
                }
                for p in raw_positions
            ]
            db.upsert_heartbeat(
                connection_id, pid, "online",
                terminal_path=str(terminal_path),
                mt5_initialized=True,
                account_login=str(account_login),
                last_metrics=metrics,
                started_at=started_at,
            )
            last_heartbeat = now

            # Periodically sync connection status to 'online' so stale
            # 'degraded' / 'error' statuses self-heal when the terminal is healthy.
            if now - last_status_sync >= STATUS_SYNC_INTERVAL:
                db.update_connection_status(connection_id, "online")
                last_status_sync = now

        # --- Terminal health check ---
        if not check_terminal_health(logger):
            logger.warning("Terminal health check failed. Attempting reinitialize...")
            db.update_connection_status(connection_id, "degraded", "Health check failed")
            db.upsert_heartbeat(connection_id, pid, "degraded", started_at=started_at)
            db.log_event("warn", "worker", "Health check failed — reinitializing", connection_id)
            mt5.shutdown()
            time.sleep(5)

            reinit_keepalive_stop = start_keepalive("degraded")
            try:
                if not mt5_init_headless(
                    str(terminal_path / "terminal64.exe"),
                    account_login,
                    password,
                    broker_server,
                    INIT_TIMEOUT,
                    progress_cb=lambda: db.upsert_heartbeat(connection_id, pid, "degraded", started_at=started_at),
                ):
                    logger.error("Reinitialize failed. Exiting for supervisor restart.")
                    db.update_connection_status(connection_id, "error", "Reinitialize failed")
                    db.log_event("error", "worker", "Reinitialize failed — worker exiting", connection_id)
                    db.delete_heartbeat(connection_id)
                    sys.exit(2)

                if not login_with_timeout(
                    account_login,
                    password,
                    broker_server,
                    LOGIN_TIMEOUT,
                    progress_cb=lambda: db.upsert_heartbeat(connection_id, pid, "degraded", started_at=started_at),
                ):
                    logger.error("Relogin failed after reinitialize. Exiting.")
                    db.update_connection_status(connection_id, "error", "Relogin failed")
                    sys.exit(2)

            finally:
                reinit_keepalive_stop.set()

            # Reinit succeeded — reset connection status so UI shows recovery.
            db.update_connection_status(connection_id, "online")
            last_status_sync = time.time()
            backoff.sleep()
            continue

        # --- Claim job ---
        job = db.claim_trade_job(connection_id, cb_label, CLAIM_TIMEOUT)
        if job is None:
            time.sleep(2)
            continue

        job_id = job.get("id")
        if not job_id:
            logger.warning("Claimed job has no id — skipping phantom row.")
            time.sleep(2)
            backoff.reset()
            continue

        symbol = job.get("symbol")
        if not symbol:
            logger.warning("Job %s has no symbol — marking failed.", job_id)
            db.complete_trade_job(
                job_id, "failed",
                error="Symbol is null — invalid job",
                error_code="symbol_unavailable",
            )
            backoff.reset()
            continue

        logger.info("Claimed job %s (symbol=%s side=%s vol=%s)",
                    job_id, symbol, job.get("side"), job.get("volume"))

        # --- Idempotency: DB check ---
        if job.get("status") == "success":
            logger.info("Job %s already success in DB — skipping.", job_id)
            backoff.reset()
            continue

        # --- Idempotency: MT5 comment check ---
        existing = find_existing_order_by_job_id(job_id)
        if existing:
            logger.info("Job %s already placed in MT5 (%s ticket=%s) — marking success.",
                        job_id, existing["type"], existing["ticket"])
            db.complete_trade_job(
                job_id, "success",
                result=existing,
                error=None,
            )
            backoff.reset()
            continue

        # --- Close-position shortcut ---
        # Frontend encodes close requests as comment = "__close__:<ticket>"
        job_comment = job.get("comment") or ""
        if job_comment.startswith("__close__:"):
            try:
                ticket = int(job_comment.split(":", 1)[1].strip())
            except (ValueError, IndexError):
                db.complete_trade_job(job_id, "failed", error="Invalid close comment format", error_code="invalid_close")
                backoff.reset()
                continue

            db.mark_trade_job_executing(job_id)
            try:
                result = close_position_by_ticket(ticket, logger)
                logger.info("Close job %s ticket=%s retcode=%s", job_id, ticket, result.get("retcode"))
                if result["retcode"] == mt5.TRADE_RETCODE_DONE:
                    db.complete_trade_job(job_id, "success", result=result)
                    logger.info("Job %s → CLOSE SUCCESS (ticket %s)", job_id, ticket)
                else:
                    err_msg = f"retcode={result['retcode']} msg={result['message']}"
                    db.complete_trade_job(job_id, "failed", result=result, error=err_msg, error_code=f"retcode_{result['retcode']}")
                    logger.warning("Job %s → CLOSE FAILED: %s", job_id, err_msg)
            except Exception as exc:
                logger.error("Close job %s ticket=%s error: %s", job_id, ticket, exc, exc_info=True)
                db.complete_trade_job(job_id, "failed", error=str(exc), error_code="close_exception")
                backoff.sleep()
            backoff.reset()
            continue

        # --- Symbol validation ---
        selected_symbol = ensure_symbol_selected(job["symbol"], logger)
        if not selected_symbol:
            logger.error("Symbol %s unavailable for job %s", job["symbol"], job_id)
            db.log_event("error", "worker", f"Symbol {job['symbol']} unavailable",
                         connection_id, {"job_id": job_id})
            db.complete_trade_job(
                job_id, "failed",
                error=f"Symbol {job['symbol']} not available",
                error_code="symbol_unavailable",
            )
            backoff.reset()
            continue

        # Use broker-resolved symbol for tick lookup and order_send.
        if selected_symbol != job["symbol"]:
            logger.info("Job %s symbol mapped %s -> %s", job_id, job["symbol"], selected_symbol)
            job = {**job, "symbol": selected_symbol}

        # --- News filter check ---
        # Lazily load prefs once per session (reset on connection re-init).
        # news_filter / newsBeforeMin / newsAfterMin come from user_terminal_settings.
        try:
            import news_calendar as _nc  # type: ignore
            _prefs = db.get_terminal_prefs_for_connection(connection_id)
            if _prefs.get("newsFilter"):
                _before = int(_prefs.get("newsBeforeMin", 30))
                _after  = int(_prefs.get("newsAfterMin", 30))
                _blocked, _reason = _nc.is_news_blocked(job["symbol"], _before, _after)
                if _blocked:
                    logger.warning("Job %s BLOCKED by news filter: %s", job_id, _reason)
                    db.complete_trade_job(
                        job_id, "failed",
                        error=_reason or "News blackout window",
                        error_code="news_blackout",
                    )
                    backoff.reset()
                    continue
        except Exception as _news_exc:
            # Never block a trade because of a calendar error — fail-open
            logger.debug("News filter check skipped (error): %s", _news_exc)

        # --- Mark executing ---
        db.mark_trade_job_executing(job_id)

        # --- Execute order ---
        try:
            result = execute_order(job, logger)
            logger.info("Order placed: job=%s order_id=%s retcode=%s",
                        job_id, result.get("order_id"), result.get("retcode"))

            # DEBUG CRASH HOOK (acceptance test #4)
            if CRASH_AFTER_ORDER:
                logger.critical("IFX_CRASH_AFTER_ORDER=1 — crashing intentionally BEFORE DB write.")
                os.abort()

            if result["retcode"] == mt5.TRADE_RETCODE_DONE:
                db.complete_trade_job(job_id, "success", result=result)
                db.update_connection_status(connection_id, "online")
                logger.info("Job %s → SUCCESS (order %s)", job_id, result["order_id"])
            else:
                err_msg = f"retcode={result['retcode']} msg={result['message']}"
                if result["retcode"] == 10027:
                    logger.error("Job %s → non-retryable failure: %s", job_id, err_msg)
                    db.complete_trade_job(
                        job_id,
                        "failed",
                        result=result,
                        error=err_msg,
                        error_code="autotrading_disabled",
                    )
                    db.update_connection_status(
                        connection_id,
                        "degraded",
                        "MT5 AutoTrading disabled by client terminal",
                    )
                    db.log_event(
                        "error",
                        "worker",
                        "MT5 AutoTrading disabled by client terminal",
                        connection_id,
                        {"job_id": job_id, **result},
                    )
                    backoff.reset()
                    continue

                logger.warning("Job %s → retryable failure: %s", job_id, err_msg)

                current_retries = job.get("retry_count", 0)
                if current_retries >= MAX_RETRIES:
                    db.complete_trade_job(job_id, "failed", result=result,
                                          error=err_msg, error_code=f"retcode_{result['retcode']}")
                    logger.error("Job %s max retries exceeded → FAILED.", job_id)
                    db.log_event("error", "worker",
                                 f"Job {job_id} failed after {MAX_RETRIES} retries",
                                 connection_id, result)
                else:
                    db.retry_trade_job(job_id, err_msg, f"retcode_{result['retcode']}")

            backoff.reset()

        except Exception as exc:
            logger.error("Unexpected error executing job %s: %s", job_id, exc, exc_info=True)
            current_retries = job.get("retry_count", 0)
            if current_retries >= MAX_RETRIES:
                db.complete_trade_job(job_id, "failed", error=str(exc), error_code="exception")
                db.log_event("error", "worker",
                             f"Job {job_id} exception after max retries: {exc}",
                             connection_id, {"job_id": job_id})
            else:
                db.retry_trade_job(job_id, str(exc), "exception")
            backoff.sleep()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python job_worker.py <connection_id>")
        sys.exit(1)

    # Graceful shutdown on SIGTERM
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    run_worker(sys.argv[1])
