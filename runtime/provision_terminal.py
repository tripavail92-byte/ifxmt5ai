"""
provision_terminal.py
IFX MT5 Runtime — Terminal provisioner.

Creates an isolated, portable MT5 terminal folder per connection_id.
Never shares any MT5 data folder across connections.
"""

import logging
import os
import shutil
import time
from pathlib import Path

logger = logging.getLogger(__name__)

# Where all isolated terminal folders are stored
TERMINALS_DIR = os.environ.get(
    "MT5_TERMINALS_DIR",
    r"C:\mt5system\terminals"
)

# Broker prefix → installed MT5 base directory
# The Python worker uses the binary from here to provision new portable folders.
BROKER_BASE_MAP: dict[str, str] = {
    "exness": r"C:\Program Files\MetaTrader 5 EXNESS",
    "metaquotes": r"C:\Program Files\MetaTrader 5",
}

# Default fallback if broker not matched
DEFAULT_BASE = r"C:\Program Files\MetaTrader 5"


def _truthy_env(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def _allow_existing_instance_reprovision() -> bool:
    return _truthy_env("MT5_ALLOW_EXISTING_INSTANCE_REPROVISION", False)


def _configured_template_dir() -> Path | None:
    raw = (os.environ.get("MT5_TEMPLATE_DIR") or "").strip()
    if not raw:
        return None

    template_dir = Path(raw)
    if not template_dir.exists() or not (template_dir / "terminal64.exe").exists():
        logger.warning("[provisioner] Ignoring MT5_TEMPLATE_DIR without terminal64.exe: %s", template_dir)
        return None

    return template_dir


def _resolve_base(broker_server: str) -> str:
    """Return the MT5 base installation path for the given broker server."""
    key = broker_server.lower()
    for prefix, path in BROKER_BASE_MAP.items():
        if prefix in key:
            return path
    return DEFAULT_BASE


def _request_window_close(pid: int) -> bool:
    if os.name != "nt":
        return False

    try:
        import ctypes

        user32 = ctypes.WinDLL("user32", use_last_error=True)
        WM_CLOSE = 0x0010
        windows: list[int] = []

        @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
        def enum_proc(hwnd, lparam):
            owner_pid = ctypes.c_ulong()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner_pid))
            if int(owner_pid.value) == int(pid) and user32.IsWindowVisible(hwnd):
                windows.append(int(hwnd))
            return True

        user32.EnumWindows(enum_proc, 0)
        for hwnd in windows:
            user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
        return bool(windows)
    except Exception:
        return False


def _graceful_stop_terminal(target_exe: Path) -> None:
    try:
        import psutil  # type: ignore
    except Exception:
        return

    if not target_exe.exists():
        return

    target = str(target_exe.resolve())
    matching = []
    for proc in psutil.process_iter(attrs=["pid", "exe"]):
        try:
            exe = proc.info.get("exe") or ""
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
        if not exe:
            continue
        try:
            if str(Path(exe).resolve()) == target:
                matching.append(proc)
        except Exception:
            continue

    if not matching:
        return

    logger.warning("[provisioner] Requesting graceful MT5 shutdown for %s", target_exe)
    sent_close = False
    for proc in matching:
        sent_close = _request_window_close(int(proc.pid)) or sent_close

    if not sent_close:
        for proc in matching:
            try:
                proc.terminate()
            except Exception:
                continue

    deadline = time.time() + float((os.environ.get("MT5_GRACEFUL_SHUTDOWN_TIMEOUT_SEC") or "15").strip() or "15")
    while time.time() < deadline:
        alive = []
        for proc in matching:
            try:
                if proc.is_running():
                    alive.append(proc)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        if not alive:
            return
        time.sleep(0.5)

    if not _truthy_env("MT5_FORCE_KILL_ON_BACKUP", False):
        raise RuntimeError(
            "MT5 terminal is still running; refusing to wipe a persistent portable instance. "
            "Close the terminal cleanly or set MT5_FORCE_KILL_ON_BACKUP=1 for an explicit destructive override."
        )

    logger.warning("[provisioner] Forcing MT5 shutdown after graceful timeout: %s", target_exe)
    for proc in matching:
        try:
            proc.kill()
        except Exception:
            continue
    time.sleep(1)


def get_terminal_path(connection_id: str) -> Path:
    return Path(TERMINALS_DIR) / connection_id


def is_provisioned(connection_id: str) -> bool:
    """Check that the terminal folder exists and has terminal64.exe."""
    path = get_terminal_path(connection_id)
    return (path / "terminal64.exe").exists()


def _backup_existing_terminal_folder(dest: Path) -> Path | None:
    if not dest.exists():
        return None

    target_exe = dest / "terminal64.exe"
    _graceful_stop_terminal(target_exe)

    stamp = time.strftime("%Y%m%d_%H%M%S")
    backup = dest.parent / f"{dest.name}_backup_{stamp}"

    # Best-effort: avoid collisions.
    if backup.exists():
        try:
            shutil.rmtree(str(backup), ignore_errors=True)
        except Exception:
            pass

    shutil.move(str(dest), str(backup))
    logger.warning("[provisioner] Moved existing terminal folder to backup: %s", backup)
    return backup


def provision(connection_id: str, broker_server: str = "", force: bool = False) -> Path:
    """
    Copy a preconfigured MT5 template into terminals/<connection_id>/ when available,
    otherwise fall back to the broker-specific MT5 installation.
    """
    source_dir = _configured_template_dir()
    if source_dir is None:
        source_dir = Path(_resolve_base(broker_server))

    if not source_dir.exists():
        raise FileNotFoundError(
            f"MT5 source directory not found: {source_dir}\n"
            f"Install MetaTrader 5 for broker '{broker_server}' and update BROKER_BASE_MAP."
        )

    dest = get_terminal_path(connection_id)

    if dest.exists() and not force:
        if is_provisioned(connection_id):
            logger.info("[provisioner] Terminal already exists: %s", dest)
            return dest
        logger.warning(
            "[provisioner] Terminal folder exists but corrupted — re-provisioning."
        )

    # If forcing or the folder looks corrupted, prefer a clean reprovision.
    # Copy-over can leave behind broken state (Config/*.dat, partial updates, etc).
    if dest.exists():
        if not _allow_existing_instance_reprovision():
            raise RuntimeError(
                "Refusing to reprovision an existing MT5 portable instance at "
                f"{dest}. This folder contains persisted terminal state such as the WebRequest allow-list. "
                "Reuse the existing folder, or set MT5_ALLOW_EXISTING_INSTANCE_REPROVISION=1 for an explicit reset."
            )
        try:
            _backup_existing_terminal_folder(dest)
        except Exception as exc:
            raise RuntimeError(f"Failed to backup existing terminal folder {dest}: {exc}") from exc

    logger.info("[provisioner] Copying %s → %s", source_dir, dest)
    shutil.copytree(str(source_dir), str(dest), dirs_exist_ok=True)

    # Portable mode marker
    (dest / "portable").touch()
    logger.info("[provisioner] Portable mode marker created: %s", dest / "portable")

    if not (dest / "terminal64.exe").exists():
        raise RuntimeError(
            f"terminal64.exe not found in provisioned folder: {dest}"
        )

    logger.info("[provisioner] Terminal provisioned successfully: %s", dest)
    return dest


def verify_or_provision(connection_id: str, broker_server: str = "") -> Path:
    """
    Called by worker on startup.
    Provisions if missing using the correct broker binary, returns path if healthy.
    """
    if is_provisioned(connection_id):
        return get_terminal_path(connection_id)
    logger.warning("[provisioner] Terminal missing for %s — provisioning now.", connection_id)
    return provision(connection_id, broker_server=broker_server)


def verify_or_reprovision(connection_id: str, broker_server: str = "") -> Path:
    """Force a clean reprovision, backing up any existing folder when explicitly allowed."""
    logger.warning("[provisioner] Forcing terminal reprovision for %s", connection_id)
    return provision(connection_id, broker_server=broker_server, force=True)
