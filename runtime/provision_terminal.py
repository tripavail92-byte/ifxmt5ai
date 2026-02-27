"""
provision_terminal.py
IFX MT5 Runtime — Terminal provisioner.

Creates an isolated, portable MT5 terminal folder per connection_id.
Never shares any MT5 data folder across connections.
"""

import logging
import os
import shutil
from pathlib import Path

logger = logging.getLogger(__name__)

TEMPLATE_DIR = os.environ.get("MT5_TERMINAL_TEMPLATE_DIR", r"C:\mt5-runtime\mt5-terminal-template")
BASE_DIR = os.environ.get("MT5_TERMINAL_BASE_DIR", r"C:\mt5-runtime\mt5-runtime-vps\terminals")


def get_terminal_path(connection_id: str) -> Path:
    return Path(BASE_DIR) / connection_id


def is_provisioned(connection_id: str) -> bool:
    """Check that the terminal folder exists and has terminal64.exe."""
    path = get_terminal_path(connection_id)
    return (path / "terminal64.exe").exists()


def provision(connection_id: str, force: bool = False) -> Path:
    """
    Copy template into terminals/<connection_id>/ if not already present.
    Set the portable env marker so MT5 uses this folder exclusively.

    Args:
        connection_id: The UUID of the MT5 connection.
        force:         If True, re-copy even if already provisioned (preserves logs/).

    Returns:
        Path to the provisioned terminal folder.

    Raises:
        FileNotFoundError: If template directory is missing.
        RuntimeError:      If terminal64.exe not found after copy.
    """
    template = Path(TEMPLATE_DIR)
    if not template.exists():
        raise FileNotFoundError(
            f"MT5 template directory not found: {TEMPLATE_DIR}\n"
            "Set MT5_TERMINAL_TEMPLATE_DIR env var to a valid portable MT5 folder."
        )

    dest = get_terminal_path(connection_id)

    if dest.exists() and not force:
        if is_provisioned(connection_id):
            logger.info("[provisioner] Terminal already exists: %s", dest)
            return dest
        else:
            logger.warning(
                "[provisioner] Terminal folder exists but is corrupted (no terminal64.exe). Re-provisioning."
            )

    # Preserve logs if they exist
    logs_backup = None
    if (dest / "logs").exists():
        logs_backup = dest / "logs"
        tmp_logs = Path(BASE_DIR) / f"{connection_id}_logs_backup"
        shutil.copytree(logs_backup, tmp_logs, dirs_exist_ok=True)
        logger.info("[provisioner] Backed up logs to %s", tmp_logs)

    logger.info("[provisioner] Copying template → %s", dest)
    shutil.copytree(str(template), str(dest), dirs_exist_ok=True)

    # Restore logs
    if logs_backup and (Path(BASE_DIR) / f"{connection_id}_logs_backup").exists():
        shutil.copytree(
            str(Path(BASE_DIR) / f"{connection_id}_logs_backup"),
            str(dest / "logs"),
            dirs_exist_ok=True,
        )
        shutil.rmtree(str(Path(BASE_DIR) / f"{connection_id}_logs_backup"), ignore_errors=True)
        logger.info("[provisioner] Restored logs.")

    # Portable mode marker — MT5 looks for this file to isolate data
    portable_marker = dest / "portable"
    portable_marker.touch()
    logger.info("[provisioner] Portable mode marker created: %s", portable_marker)

    # Sanity check
    if not (dest / "terminal64.exe").exists():
        raise RuntimeError(
            f"terminal64.exe not found in provisioned folder: {dest}\n"
            "Ensure the template contains a full portable MT5 installation."
        )

    logger.info("[provisioner] Terminal provisioned successfully: %s", dest)
    return dest


def verify_or_provision(connection_id: str) -> Path:
    """
    Called by worker on startup.
    Provisions if missing, returns path if healthy.
    """
    if is_provisioned(connection_id):
        return get_terminal_path(connection_id)
    logger.warning("[provisioner] Terminal missing for %s — provisioning now.", connection_id)
    return provision(connection_id)
