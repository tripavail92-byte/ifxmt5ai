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
import time
from datetime import datetime, timezone
from pathlib import Path

import MetaTrader5 as mt5

import db_client as db
from crypto_utils import decrypt_mt5_password
from provision_terminal import verify_or_provision

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

def mt5_init_headless(terminal_path: str, login: int, password: str, server: str, timeout: int) -> bool:
    """
    Enterprise-grade MT5 initialization.
    Generates a temporary startup.ini file to feed to terminal64.exe on boot.
    This entirely suppresses the 'Open an Account' wizard that causes IPC timeouts
    on brand new portable installations.
    """
    base_folder = Path(terminal_path).parent
    ini_path = base_folder / "startup.ini"
    
    # Write the temporary credentials configuration file
    ini_content = f"""[Common]
Login={login}
Password={password}
Server={server}
"""
    with open(ini_path, "w", encoding="utf-8") as f:
        f.write(ini_content)

    deadline = time.time() + timeout
    
    try:
        # Launch terminal explicitly with the config file
        subprocess.Popen([
            str(terminal_path), 
            "/portable", 
            f"/config:{ini_path}"
        ])
        time.sleep(5)  # Let MT5 process the config and bind the IPC port
    except Exception as e:
        print(f"Failed to start terminal: {e}")

    try:
        def try_init():
            return mt5.initialize(
                path=str(terminal_path),
                portable=True,
                server=server,
                login=login,
                password=password,
                timeout=10000
            )

        result = try_init()
        if result:
            return True
        
        while not result and time.time() < deadline:
            time.sleep(2)
            result = try_init()
            
        return result
    finally:
        # Security: Destroy the plaintext config file immediately
        try:
            if ini_path.exists():
                ini_path.unlink()
        except Exception:
            pass


def login_with_timeout(login: int, password: str, server: str, timeout: int) -> bool:
    """Attempt mt5.login() and wait up to timeout seconds."""
    deadline = time.time() + timeout
    result = mt5.login(login, password=password, server=server)
    while not result and time.time() < deadline:
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

def ensure_symbol_selected(symbol: str, logger: logging.Logger) -> bool:
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


# ---------------------------------------------------------------------------
# Idempotency: check if trade already placed
# ---------------------------------------------------------------------------

def find_existing_order_by_job_id(job_id: str) -> dict | None:
    """
    Search open positions and pending orders for a comment containing job_id.
    Returns the first match or None.
    """
    comment_marker = f"IFX:{job_id}"

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

    order_type = mt5.ORDER_TYPE_BUY if side == "buy" else mt5.ORDER_TYPE_SELL

    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        raise RuntimeError(f"Cannot get tick for {symbol}: {mt5.last_error()}")

    price = tick.ask if side == "buy" else tick.bid
    filling = mt5.symbol_info(symbol).filling_mode

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": volume,
        "type": order_type,
        "price": price,
        "sl": sl,
        "tp": tp,
        "comment": f"IFX:{job_id}",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": filling,
    }

    result = mt5.order_send(request)

    if result is None:
        raise RuntimeError(f"order_send returned None: {mt5.last_error()}")

    return {
        "order_id": result.order,
        "retcode": result.retcode,
        "message": result.comment,
        "request_id": result.request_id,
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
    last_heartbeat = 0.0

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

    while init_attempt < INIT_RETRIES and not mt5_ready:
        init_attempt += 1
        logger.info("MT5 init attempt %d/%d ...", init_attempt, INIT_RETRIES)

        if not mt5_init_headless(str(terminal_path / "terminal64.exe"), account_login, password, broker_server, INIT_TIMEOUT):
            logger.warning("mt5.initialize() failed: %s", mt5.last_error())
            mt5.shutdown()
            time.sleep(3)
            continue

        if not login_with_timeout(account_login, password, broker_server, LOGIN_TIMEOUT):
            logger.warning("mt5.login() failed: %s", mt5.last_error())
            mt5.shutdown()
            time.sleep(3)
            continue

        mt5_ready = True

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
                    "margin_free": acc.margin_free,
                }
            db.upsert_heartbeat(
                connection_id, pid, "online",
                terminal_path=str(terminal_path),
                mt5_initialized=True,
                account_login=str(account_login),
                last_metrics=metrics,
                started_at=started_at,
            )
            last_heartbeat = now

        # --- Terminal health check ---
        if not check_terminal_health(logger):
            logger.warning("Terminal health check failed. Attempting reinitialize...")
            db.update_connection_status(connection_id, "degraded", "Health check failed")
            db.upsert_heartbeat(connection_id, pid, "degraded", started_at=started_at)
            db.log_event("warn", "worker", "Health check failed — reinitializing", connection_id)
            mt5.shutdown()
            time.sleep(5)

            if not mt5_init_headless(str(terminal_path / "terminal64.exe"), account_login, password, broker_server, INIT_TIMEOUT):
                logger.error("Reinitialize failed. Exiting for supervisor restart.")
                db.update_connection_status(connection_id, "error", "Reinitialize failed")
                db.log_event("error", "worker", "Reinitialize failed — worker exiting", connection_id)
                db.delete_heartbeat(connection_id)
                sys.exit(2)
                
            if not login_with_timeout(account_login, password, broker_server, LOGIN_TIMEOUT):
                logger.error("Relogin failed after reinitialize. Exiting.")
                db.update_connection_status(connection_id, "error", "Relogin failed")
                sys.exit(2)

            backoff.sleep()
            continue

        # --- Claim job ---
        job = db.claim_trade_job(connection_id, cb_label, CLAIM_TIMEOUT)
        if job is None:
            time.sleep(2)
            continue

        job_id = job["id"]
        logger.info("Claimed job %s (symbol=%s side=%s vol=%s)",
                    job_id, job["symbol"], job["side"], job["volume"])

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

        # --- Symbol validation ---
        if not ensure_symbol_selected(job["symbol"], logger):
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
