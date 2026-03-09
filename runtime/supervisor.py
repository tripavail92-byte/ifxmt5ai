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


def _acquire_single_instance_lock() -> None:
    """Prevent multiple supervisors from running at once (Windows-friendly).

    Uses a Windows named mutex when available (more reliable than file locking).
    """

    if os.name == "nt":
        try:
            import ctypes
            import ctypes.wintypes as wt

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            create_mutex = kernel32.CreateMutexW
            create_mutex.argtypes = [wt.LPVOID, wt.BOOL, wt.LPCWSTR]
            create_mutex.restype = wt.HANDLE

            wait_for_single_object = kernel32.WaitForSingleObject
            wait_for_single_object.argtypes = [wt.HANDLE, wt.DWORD]
            wait_for_single_object.restype = wt.DWORD

            # Create + acquire ownership immediately to avoid a startup race.
            # NOTE: In this environment, the OS-reported executable path can be
            # misleading due to hardlinks/launcher behavior; use a named mutex
            # to enforce a single active supervisor.
            mutex_name = "Global\\IFX_MT5_SUPERVISOR"
            handle = create_mutex(None, True, mutex_name)
            if not handle:
                raise OSError(f"CreateMutexW failed: {ctypes.get_last_error()}")

            WAIT_OBJECT_0 = 0x00000000
            WAIT_ABANDONED = 0x00000080
            WAIT_TIMEOUT = 0x00000102

            res = wait_for_single_object(handle, 0)
            if res == WAIT_TIMEOUT:
                print("Another supervisor instance is already running; exiting.")
                raise SystemExit(0)
            if res not in (WAIT_OBJECT_0, WAIT_ABANDONED):
                raise OSError(f"WaitForSingleObject failed: {res}")

            # Keep handle alive for the lifetime of the process.
            globals()["_SUPERVISOR_MUTEX_HANDLE"] = handle
            return
        except SystemExit:
            raise
        except Exception:
            # Fall back to file lock below.
            pass

    lock_path = Path(__file__).parent.parent / ".supervisor.lock"
    try:
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        fh = open(lock_path, "a+", encoding="utf-8")
    except Exception:
        return

    # Keep the handle alive for the lifetime of the process.
    globals()["_SUPERVISOR_LOCK_FH"] = fh

    if os.name != "nt":
        return

    try:
        import msvcrt

        # Lock byte 0 (must seek before locking; Windows locks are relative
        # to the current file pointer).
        fh.seek(0)
        msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)

        # Best-effort: record PID for debugging.
        fh.seek(0)
        fh.truncate(0)
        fh.write(str(os.getpid()))
        fh.flush()
    except Exception:
        print("Another supervisor instance is already running; exiting.")
        raise SystemExit(0)


def _enforce_venv() -> None:
    root = Path(__file__).parent.parent
    venv_root = root / ".venv"
    expected = venv_root / "Scripts" / "python.exe"
    if not expected.exists():
        return

    expected_exe = os.path.normcase(os.path.abspath(str(expected)))
    actual_exe = os.path.normcase(os.path.abspath(str(getattr(sys, "executable", ""))))
    if expected_exe and actual_exe and actual_exe != expected_exe:
        print(
            "Refusing to run supervisor with non-venv Python executable. "
            f"Expected sys.executable={expected_exe} | Got sys.executable={actual_exe}"
        )
        raise SystemExit(2)

    expected_prefix = os.path.normcase(os.path.abspath(str(venv_root)))
    actual_prefix = os.path.normcase(os.path.abspath(str(getattr(sys, "prefix", ""))))
    if expected_prefix and actual_prefix and actual_prefix != expected_prefix:
        print(
            "Refusing to run supervisor outside the workspace venv. "
            f"Expected sys.prefix={expected_prefix} | Got sys.prefix={actual_prefix}"
        )
        raise SystemExit(2)


_enforce_venv()
_acquire_single_instance_lock()

import psutil

import db_client as db


def _kill_non_venv_duplicates() -> None:
    """Kill duplicate worker/supervisor processes not running in the venv.

    Sometimes older runs started before the venv existed, or external launchers
    keep starting system-Python copies. Those copies can spawn duplicate workers
    and trip flap protection.
    """
    # IMPORTANT:
    # On this Windows host, a venv-launched python process can show up (via OS
    # process APIs) as the *base* python executable, even though it is running
    # inside the venv at runtime. Therefore, exe-path based classification will
    # incorrectly kill legitimate worker/supervisor processes and cause flapping.
    #
    # Instead, only treat a process as rogue if it appears to be running our
    # scripts but its working directory is NOT inside this workspace.
    root = Path(__file__).parent.parent
    root_norm = os.path.normcase(os.path.abspath(str(root)))

    worker_script = (root / "runtime" / "job_worker.py")
    worker_script_str = str(worker_script)

    rogue_worker_pids: set[int] = set()
    rogue_supervisor_pids: set[int] = set()

    this_pid = os.getpid()

    def _cwd_in_workspace(proc: psutil.Process) -> bool:
        try:
            cwd = proc.cwd() or ""
        except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
            return False
        if not cwd:
            return False
        cwd_norm = os.path.normcase(os.path.abspath(cwd))
        return cwd_norm.startswith(root_norm)

    for proc in psutil.process_iter(attrs=["pid", "cmdline"]):
        try:
            cmdline = proc.info.get("cmdline") or []
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue

        if proc.pid == this_pid:
            continue

        if not cmdline:
            continue

        cmd_joined = " ".join(cmdline)

        # Rogue worker (system python) running our worker script.
        if worker_script_str in cmd_joined:
            if not _cwd_in_workspace(proc):
                rogue_worker_pids.add(proc.pid)
            continue

        # Rogue supervisor (system python) that can spawn duplicates.
        if "main.py" in cmd_joined and "supervisor" in cmd_joined:
            if not _cwd_in_workspace(proc):
                rogue_supervisor_pids.add(proc.pid)
            continue

    for pid in sorted(rogue_worker_pids):
        try:
            psutil.Process(pid).terminate()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass

    for pid in sorted(rogue_supervisor_pids):
        try:
            psutil.Process(pid).terminate()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass

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

# When a connection is marked `error`, avoid immediate respawn thrash.
# Use an explicit supervisor key if present; otherwise reuse worker cooldown.
ERROR_COOLDOWN_SEC = int(
    CFG.get(
        "SUPERVISOR_ERROR_COOLDOWN_SEC",
        CFG.get("MT5_INIT_COOLDOWN_SEC", 300),
    )
)

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

    # Seed/reset heartbeat immediately so the supervisor doesn't thrash due to a
    # stale heartbeat row from a previous worker PID.
    try:
        db.upsert_heartbeat(
            connection_id=connection_id,
            pid=proc.pid,
            status="starting",
            started_at=datetime.now(timezone.utc).isoformat(),
        )
    except Exception as exc:
        logger.warning("[%s] Failed to seed heartbeat for new worker PID %d: %s", connection_id[:8], proc.pid, exc)

    return proc


# ---------------------------------------------------------------------------
# Supervisor cycle
# ---------------------------------------------------------------------------

# Track spawned processes in memory (supervisor lifetime only)
# { connection_id: Popen | None }
# None sentinel means: worker was adopted (tracked via heartbeat PID), not spawned
# by this supervisor instance.
running_workers: dict[str, subprocess.Popen | None] = {}


def supervisor_cycle():
    _kill_non_venv_duplicates()

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

        conn_status = (conn.get("status") or "").lower()
        if conn_status == "disabled":
            # Explicitly disabled by user/admin — never spawn.
            continue

        if conn_status == "error":
            updated_at_raw = conn.get("updated_at")
            if updated_at_raw:
                try:
                    updated_at = datetime.fromisoformat(updated_at_raw.replace("Z", "+00:00"))
                    age = (now_utc - updated_at).total_seconds()
                    if age < ERROR_COOLDOWN_SEC:
                        # Cooldown window after error (including flapping).
                        continue
                except Exception:
                    # If parsing fails, fall through and manage via flap logic.
                    pass

        # Check if in-memory process is alive
        proc = running_workers.get(conn_id)

        # If we previously adopted a worker (None sentinel), consider it alive
        # as long as the heartbeat PID is still alive.
        if conn_id in running_workers and proc is None:
            proc_alive = bool(hb and is_process_alive(hb.get("pid", 0)))
        else:
            proc_alive = proc is not None and is_process_alive(proc.pid)

        # If heartbeat says a worker PID is running (survived supervisor restart)
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

                # Only kill processes that are actually alive. A stale heartbeat
                # PID from an old run should not cause us to kill a freshly
                # spawned worker.
                pids_to_kill: set[int] = set()
                if hb_pid and is_process_alive(hb_pid):
                    pids_to_kill.add(hb_pid)

                proc = running_workers.get(conn_id)
                if proc and proc.pid and is_process_alive(proc.pid):
                    pids_to_kill.add(proc.pid)

                for pid in sorted(pids_to_kill):
                    kill_worker(pid, conn_id)

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
    logger.info(
        "Supervisor identity: pid=%s exe=%s cwd=%s file=%s",
        os.getpid(),
        sys.executable,
        os.getcwd(),
        __file__,
    )
    logger.info(
        "Supervisor thresholds: HEARTBEAT_STALE_SEC=%s SUPERVISOR_GRACE_SEC=%s SUPERVISOR_POLL_SEC=%s",
        STALE_SEC,
        GRACE_SEC,
        POLL_SEC,
    )
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    while True:
        try:
            supervisor_cycle()
        except Exception as exc:
            logger.error("Supervisor cycle error: %s", exc, exc_info=True)
        time.sleep(POLL_SEC)


if __name__ == "__main__":
    main()
