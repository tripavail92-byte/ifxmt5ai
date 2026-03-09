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


def _resolve_base(broker_server: str) -> str:
    """Return the MT5 base installation path for the given broker server."""
    key = broker_server.lower()
    for prefix, path in BROKER_BASE_MAP.items():
        if prefix in key:
            return path
    return DEFAULT_BASE


def get_terminal_path(connection_id: str) -> Path:
    return Path(TERMINALS_DIR) / connection_id


def is_provisioned(connection_id: str) -> bool:
    """Check that the terminal folder exists and has terminal64.exe."""
    path = get_terminal_path(connection_id)
    return (path / "terminal64.exe").exists()


def _backup_existing_terminal_folder(dest: Path) -> Path | None:
    if not dest.exists():
        return None

    # Best-effort: terminate any running terminal from this folder.
    # Reprovisioning while terminal64.exe is alive can fail on Windows.
    try:
        import psutil  # type: ignore

        target_exe = dest / "terminal64.exe"
        if target_exe.exists():
            target = str(target_exe.resolve())
            for proc in psutil.process_iter(attrs=["pid", "exe"]):
                try:
                    exe = proc.info.get("exe") or ""
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue
                if not exe:
                    continue
                try:
                    if str(Path(exe).resolve()) == target:
                        proc.terminate()
                except Exception:
                    continue

            # Give it a moment to die.
            time.sleep(1)
    except Exception:
        pass

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
    Copy MT5 binary into terminals/<connection_id>/ if not already present.
    Selects broker-specific MT5 installation based on broker_server name.
    """
    base = Path(_resolve_base(broker_server))
    if not base.exists():
        raise FileNotFoundError(
            f"MT5 base directory not found: {base}\n"
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
        try:
            _backup_existing_terminal_folder(dest)
        except Exception as exc:
            raise RuntimeError(f"Failed to backup existing terminal folder {dest}: {exc}") from exc

    logger.info("[provisioner] Copying %s → %s", base, dest)
    shutil.copytree(str(base), str(dest), dirs_exist_ok=True)

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
    """Force a clean reprovision, backing up any existing folder."""
    logger.warning("[provisioner] Forcing terminal reprovision for %s", connection_id)
    return provision(connection_id, broker_server=broker_server, force=True)
