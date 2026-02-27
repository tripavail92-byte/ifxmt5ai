"""
supervisor.py
IFX MT5 Runtime — Watchdog Supervisor.

Responsibilities:
  - Fetch all active connections from Supabase
  - Ensure exactly one worker process per connection_id
  - Kill stale workers (heartbeat older than HEARTBEAT_STALE_SEC)
  - Respect 60s startup grace period (based on started_at in heartbeat)
  - Enforce flap protection: max 5 restarts in 10 minutes
  - Mark connection 'error' and stop if flapping

Usage:
  python supervisor.py

Environment:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  MT5_CREDENTIALS_MASTER_KEY_B64
"""

import json
import logging
import os
import signal
import subprocess
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path

import psutil

import db_client as db

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

LOG_DIR = Path(__file__).parent / "logs"
LOG_DIR.mkdir(exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_DIR / "supervisor.log", encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger("supervisor")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

cfg_path = Path(__file__).parent.parent / "config" / "settings.json"
with open(cfg_path) as f:
    CFG = json.load(f)

POLL_SEC = CFG["SUPERVISOR_POLL_SEC"]
STALE_SEC = CFG["HEARTBEAT_STALE_SEC"]
GRACE_SEC = CFG["SUPERVISOR_GRACE_SEC"]
FLAP_MAX = CFG["FLAP_MAX_RESTARTS"]
FLAP_WINDOW = CFG["FLAP_WINDOW_SEC"]

WORKER_SCRIPT = Path(__file__).parent / "job_worker.py"
PYTHON_EXE = sys.executable  # same venv


# ---------------------------------------------------------------------------
# Flap tracker
# ---------------------------------------------------------------------------

# { connection_id: [restart_timestamp, ...] }
restart_history: dict[str, list[float]] = defaultdict(list)


def record_restart(connection_id: str) -> None:
    now = time.time()
    history = restart_history[connection_id]
    history.append(now)
    # Prune outside window
    restart_history[connection_id] = [t for t in history if now - t <= FLAP_WINDOW]


def is_flapping(connection_id: str) -> bool:
    now = time.time()
    history = [t for t in restart_history[connection_id] if now - t <= FLAP_WINDOW]
    restart_history[connection_id] = history
    return len(history) >= FLAP_MAX


# ---------------------------------------------------------------------------
# Process helpers
# ---------------------------------------------------------------------------

def kill_worker(pid: int, connection_id: str) -> None:
    """Kill worker process and all its children."""
    try:
        parent = psutil.Process(pid)
        children = parent.children(recursive=True)
        for child in children:
            try:
                child.terminate()
            except psutil.NoSuchProcess:
                pass
        parent.terminate()

        # Wait up to 5s then force kill
        gone, alive = psutil.wait_procs([parent] + children, timeout=5)
        for p in alive:
            try:
                p.kill()
            except psutil.NoSuchProcess:
                pass

        logger.info("[%s] Killed PID %d (+ %d children).", connection_id[:8], pid, len(children))
    except psutil.NoSuchProcess:
        logger.info("[%s] PID %d already gone.", connection_id[:8], pid)
    except Exception as exc:
        logger.error("[%s] Error killing PID %d: %s", connection_id[:8], pid, exc)


def is_process_alive(pid: int) -> bool:
    try:
        proc = psutil.Process(pid)
        return proc.is_running() and proc.status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False


def spawn_worker(connection_id: str) -> subprocess.Popen:
    """Start job_worker.py as a child process."""
    log_file = LOG_DIR / f"worker_{connection_id[:8]}.log"
    with open(log_file, "a", encoding="utf-8") as log_fh:
        proc = subprocess.Popen(
            [PYTHON_EXE, str(WORKER_SCRIPT), connection_id],
            stdout=log_fh,
            stderr=log_fh,
            cwd=str(Path(__file__).parent),
            env=os.environ.copy(),
        )
    logger.info("[%s] Spawned worker PID %d.", connection_id[:8], proc.pid)
    return proc


# ---------------------------------------------------------------------------
# Supervisor cycle
# ---------------------------------------------------------------------------

# Track spawned processes in memory (supervisor lifetime only)
# { connection_id: Popen }
running_workers: dict[str, subprocess.Popen] = {}


def supervisor_cycle():
    # 1. Fetch active connections
    try:
        connections = db.get_active_connections()
    except Exception as exc:
        logger.error("Failed to fetch active connections: %s", exc)
        return

    active_ids = {c["id"] for c in connections}

    # 2. Fetch all current heartbeats
    try:
        heartbeats = {hb["connection_id"]: hb for hb in db.get_all_heartbeats()}
    except Exception as exc:
        logger.error("Failed to fetch heartbeats: %s", exc)
        heartbeats = {}

    now_utc = datetime.now(timezone.utc)

    # 3. Kill workers whose connection is no longer active
    stale_ids = set(running_workers.keys()) - active_ids
    for conn_id in stale_ids:
        logger.info("[%s] Connection deactivated — killing worker.", conn_id[:8])
        proc = running_workers.pop(conn_id)
        if proc and proc.pid:
            kill_worker(proc.pid, conn_id)
        # Clean up heartbeat row
        try:
            db.delete_heartbeat(conn_id)
        except Exception:
            pass

    # 4. Process each active connection
    for conn in connections:
        conn_id = conn["id"]
        hb = heartbeats.get(conn_id)

        # Check if in-memory process is alive
        proc = running_workers.get(conn_id)
        proc_alive = proc is not None and is_process_alive(proc.pid)

        # If heartbeat says a different PID is running (survived supervisor restart)
        if hb and not proc_alive:
            hb_pid = hb.get("pid")
            if hb_pid and is_process_alive(hb_pid):
                # Adopt the orphan worker (supervisor restarted but worker survived)
                logger.info("[%s] Adopting existing worker PID %d.", conn_id[:8], hb_pid)
                running_workers[conn_id] = None  # Sentinel — we track via heartbeat
                proc_alive = True

        # ---- No worker running at all ----
        if not proc_alive and not (hb and is_process_alive(hb.get("pid", 0))):
            if is_flapping(conn_id):
                logger.warning(
                    "[%s] Flapping detected (%d restarts in %ds) — marking error, stopping.",
                    conn_id[:8], FLAP_MAX, FLAP_WINDOW,
                )
                db.update_connection_status(conn_id, "error", "Worker flapping — too many restarts")
                db.log_event(
                    "error", "supervisor",
                    f"Flapping: {FLAP_MAX} restarts in {FLAP_WINDOW}s — stopped",
                    conn_id,
                )
                continue

            logger.info("[%s] No worker running — spawning.", conn_id[:8])
            new_proc = spawn_worker(conn_id)
            running_workers[conn_id] = new_proc
            record_restart(conn_id)
            continue

        # ---- Worker is running — check heartbeat staleness ----
        if hb:
            last_seen = datetime.fromisoformat(hb["last_seen_at"].replace("Z", "+00:00"))
            started_at_raw = hb.get("started_at")
            started_at = (
                datetime.fromisoformat(started_at_raw.replace("Z", "+00:00"))
                if started_at_raw
                else now_utc
            )

            age_sec = (now_utc - last_seen).total_seconds()
            running_for = (now_utc - started_at).total_seconds()

            if age_sec > STALE_SEC:
                if running_for < GRACE_SEC:
                    logger.info(
                        "[%s] Heartbeat stale (%ds) but within grace period (%ds running) — waiting.",
                        conn_id[:8], int(age_sec), int(running_for),
                    )
                    continue

                # Outside grace — kill and restart
                hb_pid = hb.get("pid")
                logger.warning(
                    "[%s] Heartbeat stale %ds (> %ds) — killing PID %d.",
                    conn_id[:8], int(age_sec), STALE_SEC, hb_pid,
                )
                db.log_event(
                    "warn", "supervisor",
                    f"Stale heartbeat ({int(age_sec)}s) — killing worker",
                    conn_id, {"pid": hb_pid},
                )

                if hb_pid:
                    kill_worker(hb_pid, conn_id)

                proc = running_workers.get(conn_id)
                if proc and proc.pid and proc.pid != hb_pid:
                    kill_worker(proc.pid, conn_id)

                running_workers.pop(conn_id, None)

                if is_flapping(conn_id):
                    logger.warning("[%s] Flapping — marking error.", conn_id[:8])
                    db.update_connection_status(conn_id, "error", "Flapping after stale heartbeat")
                    db.log_event("error", "supervisor", "Flapping — stopped restarting", conn_id)
                    continue

                logger.info("[%s] Restarting worker.", conn_id[:8])
                new_proc = spawn_worker(conn_id)
                running_workers[conn_id] = new_proc
                record_restart(conn_id)

        else:
            # No heartbeat row at all but we think process is alive
            # (e.g. worker just started, not heartbeated yet)
            logger.debug("[%s] Worker running but no heartbeat row yet.", conn_id[:8])


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main():
    logger.info("=== IFX MT5 Supervisor starting ===")
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    while True:
        try:
            supervisor_cycle()
        except Exception as exc:
            logger.error("Supervisor cycle error: %s", exc, exc_info=True)
        time.sleep(POLL_SEC)


if __name__ == "__main__":
    main()
