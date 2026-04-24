"""
terminal_manager.py
IFX local terminal manager.

Owns terminal provisioning, EA asset install, startup bootstrap files, and
portable MT5 launch for locally assigned connections.

This service talks to the Next.js control-plane routes added under /api.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import requests

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from runtime.crypto_utils import decrypt_mt5_password
from runtime.provision_terminal import verify_or_provision, verify_or_reprovision


def _load_simple_dotenv(path: Path) -> None:
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and ((value[0] == '"' and value[-1] == '"') or (value[0] == "'" and value[-1] == "'")):
            value = value[1:-1]

        if key and key not in os.environ:
            os.environ[key] = value


def _maybe_load_dotenv() -> None:
    dotenv_path = ROOT / ".env"
    try:
        from dotenv import load_dotenv  # type: ignore

        load_dotenv(dotenv_path)
    except Exception:
        _load_simple_dotenv(dotenv_path)
        return


_maybe_load_dotenv()


LOG_DIR = ROOT / "runtime" / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [TERMINAL_MANAGER] %(levelname)s %(message)s",
    handlers=[
        logging.FileHandler(LOG_DIR / "terminal_manager.log", encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger("terminal_manager")

DEFAULT_EA_VERSION = "local-dev"


def _require_env(name: str) -> str:
    value = (os.getenv(name) or "").strip()
    if not value:
        raise RuntimeError(f"Missing required env var: {name}")
    return value


def _truthy(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def _sanitize_filename(name: str) -> str:
    cleaned = "".join(ch for ch in name if ch.isalnum() or ch in ("-", "_", "."))
    return cleaned or "IFX_Railway_Bridge_v1.ex5"


def _startup_symbol() -> str:
    explicit = (os.getenv("MT5_STARTUP_SYMBOL") or "").strip()
    if explicit:
        return explicit
    # EURUSD is universally available on all MT5 brokers (Exness, Vantage, XM, etc.)
    # The EA resolves all other symbols dynamically via ResolveBrokerSymbol().
    return "EURUSD"


def _startup_period() -> str:
    explicit = (os.getenv("MT5_STARTUP_PERIOD") or "").strip().upper()
    if explicit:
        return explicit
    return "M1"


def _read_existing_startup_setting(terminal_dir: Path, key: str) -> str:
    startup_ini = terminal_dir / "startup.ini"
    if not startup_ini.exists():
        return ""

    try:
        for raw_line in startup_ini.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or line.startswith(";"):
                continue
            if line.lower().startswith(f"{key.lower()}="):
                return line.split("=", 1)[1].strip()
    except Exception:
        return ""

    return ""


def _resolve_startup_symbol(terminal_dir: Path) -> str:
    existing = _read_existing_startup_setting(terminal_dir, "Symbol")
    if existing:
        return existing
    return _startup_symbol()


def _resolve_startup_period(terminal_dir: Path) -> str:
    existing = _read_existing_startup_setting(terminal_dir, "Period")
    if existing:
        return existing.upper()
    return _startup_period()


def _prefer_compiled_artifact(path_value: str) -> str:
    source_path = Path(path_value)
    if source_path.suffix.lower() != ".mq5":
        return path_value

    compiled_path = source_path.with_suffix(".ex5")
    if compiled_path.exists():
        return str(compiled_path)

    return path_value


def _candidate_metaeditor_paths() -> list[Path]:
    configured = (os.getenv("METAEDITOR_PATH") or "").strip()
    candidates: list[Path] = []
    if configured:
        candidates.append(Path(configured))

    candidates.extend(
        [
            Path(r"C:\Program Files\MetaTrader 5\metaeditor64.exe"),
            Path(r"C:\Program Files\MetaTrader 5\MetaEditor64.exe"),
            Path(r"C:\Program Files\MetaTrader 5\metaeditor.exe"),
            Path(r"C:\Program Files\MetaTrader 5\MetaEditor.exe"),
        ]
    )
    return candidates


def _resolve_metaeditor_exe() -> Path:
    for candidate in _candidate_metaeditor_paths():
        if candidate.exists():
            return candidate
    raise RuntimeError(
        "MetaEditor executable not found. Set METAEDITOR_PATH or install MetaTrader 5 MetaEditor."
    )


def _decode_compile_log(log_path: Path) -> str:
    if not log_path.exists():
        return ""

    raw = log_path.read_bytes()
    for encoding in ("utf-16", "utf-8", "latin-1"):
        try:
            return raw.decode(encoding, errors="replace")
        except Exception:
            continue
    return ""


def _compile_mq5_source(source_path: Path) -> Path:
    if source_path.suffix.lower() != ".mq5":
        return source_path
    if not source_path.exists():
        raise RuntimeError(f"EA source path not found: {source_path}")

    compiled_path = source_path.with_suffix(".ex5")
    auto_compile = _truthy("IFX_EA_AUTO_COMPILE", True)
    if compiled_path.exists() and compiled_path.stat().st_mtime >= source_path.stat().st_mtime and not auto_compile:
        return compiled_path
    if compiled_path.exists() and compiled_path.stat().st_mtime >= source_path.stat().st_mtime and auto_compile:
        return compiled_path

    metaeditor = _resolve_metaeditor_exe()
    compile_timeout = int((os.getenv("IFX_EA_COMPILE_TIMEOUT_SEC") or "120").strip() or "120")
    log_path = LOG_DIR / f"{source_path.stem}_compile.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)

    logger.info("Compiling EA source %s with %s", source_path, metaeditor)
    completed = subprocess.run(
        [
            str(metaeditor),
            f"/compile:{source_path}",
            f"/log:{log_path}",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=max(30, compile_timeout),
        check=False,
    )

    log_text = _decode_compile_log(log_path)
    if completed.returncode != 0:
        raise RuntimeError(
            f"MetaEditor compile failed for {source_path} (exit={completed.returncode})\n{log_text[-1200:]}"
        )
    if not compiled_path.exists():
        raise RuntimeError(
            f"MetaEditor reported success but no compiled artifact was produced for {source_path}\n{log_text[-1200:]}"
        )
    if "0 errors, 0 warnings" not in log_text and "Result:" in log_text:
        logger.warning("MetaEditor compile completed with non-clean log for %s: %s", source_path, log_text.strip())

    logger.info("Compiled EA artifact %s", compiled_path)
    return compiled_path


def _resolve_local_ea_candidate(path_value: str) -> str:
    if not path_value:
        return ""
    source_path = Path(path_value)
    if not source_path.exists():
        raise RuntimeError(f"EA source path not found: {source_path}")
    return str(_compile_mq5_source(source_path))


def _api_base_url() -> str:
    base = (os.getenv("CONTROL_PLANE_URL") or "https://ifx-mt5-portal-production.up.railway.app").strip()
    return base.rstrip("/")


def _relay_base_url() -> str:
    explicit = (os.getenv("EA_BACKEND_RELAY_URL") or "").strip()
    if explicit:
        return explicit.rstrip("/")
    return _api_base_url() + "/api/mt5"


def _manager_headers() -> dict[str, str]:
    token = _require_env("TERMINAL_MANAGER_TOKEN")
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }


def _control_plane_url(path: str) -> str:
    return urljoin(_api_base_url() + "/", path.lstrip("/"))


def _requests_timeout() -> tuple[float, float]:
    connect = float((os.getenv("TERMINAL_MANAGER_HTTP_CONNECT_TIMEOUT_SEC") or "5").strip() or "5")
    read = float((os.getenv("TERMINAL_MANAGER_HTTP_READ_TIMEOUT_SEC") or "20").strip() or "20")
    return connect, read


class ControlPlaneClient:
    def __init__(self) -> None:
        self.session = requests.Session()
        self.timeout = _requests_timeout()

    def _request(self, method: str, path: str, **kwargs) -> requests.Response:
        url = _control_plane_url(path)
        headers = kwargs.pop("headers", {})
        merged_headers = {**_manager_headers(), **headers}
        resp = self.session.request(method, url, headers=merged_headers, timeout=self.timeout, **kwargs)
        if resp.status_code >= 400:
            raise RuntimeError(f"{method} {url} failed: HTTP {resp.status_code}: {resp.text[:300]}")
        return resp

    def register_host(self, host_name: str, host_type: str, capacity: int, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
        resp = self._request(
            "POST",
            "/api/terminal-host/register",
            json={
                "host_name": host_name,
                "host_type": host_type,
                "capacity": capacity,
                "metadata": metadata or {},
            },
        )
        return resp.json()["host"]

    def heartbeat_host(self, host_id: str, status: str = "online", metadata: dict[str, Any] | None = None) -> dict[str, Any]:
        resp = self._request(
            "POST",
            "/api/terminal-host/heartbeat",
            json={
                "host_id": host_id,
                "status": status,
                "metadata": metadata or {},
            },
        )
        return resp.json()

    def fetch_assignments(self, host_id: str, limit: int = 10) -> list[dict[str, Any]]:
        resp = self._request(
            "GET",
            f"/api/terminal-host/assignments?host_id={host_id}&limit={limit}",
        )
        return resp.json().get("assignments", [])

    def ack_assignment(self, assignment_id: str, status: str, terminal_path: str | None = None, details: dict[str, Any] | None = None) -> dict[str, Any]:
        resp = self._request(
            "POST",
            f"/api/terminal-host/assignment/{assignment_id}/ack",
            json={
                "status": status,
                "terminal_path": terminal_path,
                "details": details or {},
            },
        )
        return resp.json()

    def fail_assignment(self, assignment_id: str, status: str, error: str, details: dict[str, Any] | None = None) -> dict[str, Any]:
        resp = self._request(
            "POST",
            f"/api/terminal-host/assignment/{assignment_id}/fail",
            json={
                "status": status,
                "error": error,
                "details": details or {},
            },
        )
        return resp.json()

    def bootstrap_connection(self, connection_id: str, host_id: str, release_channel: str | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "connection_id": connection_id,
            "host_id": host_id,
        }
        if release_channel:
            payload["release_channel"] = release_channel
        resp = self._request("POST", "/api/ea/bootstrap", json=payload)
        return resp.json()

    def get_release_manifest(self, channel: str | None = None) -> dict[str, Any]:
        query = f"?channel={channel}" if channel else ""
        resp = self._request("GET", f"/api/ea/release-manifest{query}")
        return resp.json().get("release", {})

    def verify_assignment_launch(self, assignment_id: str) -> dict[str, Any]:
        resp = self._request("GET", f"/api/terminal-host/assignment/{assignment_id}/verify")
        return resp.json()


def _running_terminal_process(executable_path: Path) -> bool:
    try:
        import psutil  # type: ignore
    except Exception:
        return False

    target = str(executable_path.resolve())
    for proc in psutil.process_iter(attrs=["exe"]):
        try:
            exe = proc.info.get("exe") or ""
        except Exception:
            continue
        if not exe:
            continue
        try:
            if str(Path(exe).resolve()) == target:
                return True
        except Exception:
            continue
    return False


def _running_terminal_pids(executable_path: Path) -> list[int]:
    try:
        import psutil  # type: ignore
    except Exception:
        return []

    target = str(executable_path.resolve())
    matches: list[int] = []
    for proc in psutil.process_iter(attrs=["exe", "pid"]):
        try:
            exe = proc.info.get("exe") or ""
            pid = int(proc.info.get("pid") or 0)
        except Exception:
            continue
        if not exe or pid <= 0:
            continue
        try:
            if str(Path(exe).resolve()) == target:
                matches.append(pid)
        except Exception:
            continue
    return matches


def _stop_terminal_processes(executable_path: Path) -> None:
    pids = _running_terminal_pids(executable_path)
    if not pids:
        return

    for pid in pids:
        try:
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/F", "/T"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=15,
            )
        except Exception:
            continue


def _latest_terminal_log_path(logs_dir: Path) -> Path | None:
    if not logs_dir.exists():
        return None
    candidates = [path for path in logs_dir.glob("*.log") if path.is_file()]
    if not candidates:
        return None
    return max(candidates, key=lambda path: path.stat().st_mtime)


def _read_text_file(path: Path) -> str:
    raw = path.read_bytes()
    for encoding in ("utf-16", "utf-8", "latin-1"):
        try:
            return raw.decode(encoding, errors="replace")
        except Exception:
            continue
    return ""


def _tail_from_offset(path: Path, offset: int) -> str:
    if not path.exists():
        return ""
    with open(path, "rb") as fh:
        fh.seek(max(0, offset))
        raw = fh.read()
    for encoding in ("utf-16", "utf-8", "latin-1"):
        try:
            return raw.decode(encoding, errors="replace")
        except Exception:
            continue
    return ""


def _startup_log_offset(log_path: Path | None) -> int:
    if not log_path or not log_path.exists():
        return 0
    try:
        return int(log_path.stat().st_size)
    except Exception:
        return 0


def _terminal_launch_has_expert_loaded(terminal_dir: Path, startup_ini: Path, log_path: Path | None, offset: int) -> bool:
    startup_text = startup_ini.read_text(encoding="utf-8")
    expert_path = ""
    for raw_line in startup_text.splitlines():
        line = raw_line.strip()
        if line.lower().startswith("expert="):
            expert_path = line.split("=", 1)[1].strip()
            break

    if not expert_path:
        return False

    expert_name = Path(expert_path).name
    markers = [
        f"inputs read from expert '{expert_path}'",
        f"Experts expert {expert_name}",
    ]

    candidate_logs: list[Path] = []
    if log_path and log_path.exists():
        candidate_logs.append(log_path)
    latest = _latest_terminal_log_path(terminal_dir / "Logs")
    if latest and latest not in candidate_logs:
        candidate_logs.append(latest)

    for candidate in candidate_logs:
        text = _tail_from_offset(candidate, offset if candidate == log_path else 0)
        if not text:
            continue
        if all(marker in text for marker in markers):
            return True
    return False


class TerminalManager:
    def __init__(self, host_name: str, host_type: str, capacity: int, poll_seconds: float, once: bool = False) -> None:
        self.host_name = host_name
        self.host_type = host_type
        self.capacity = capacity
        self.poll_seconds = max(2.0, poll_seconds)
        self.once = once
        self.client = ControlPlaneClient()
        self.host: dict[str, Any] | None = None

    def register(self) -> dict[str, Any]:
        self.host = self.client.register_host(
            self.host_name,
            self.host_type,
            self.capacity,
            metadata={
                "cwd": str(ROOT),
                "relay_base_url": _relay_base_url(),
            },
        )
        logger.info("Registered terminal host %s (%s)", self.host.get("id"), self.host_name)
        return self.host

    def _ensure_host_id(self) -> str:
        if not self.host:
            self.register()
        assert self.host is not None
        return str(self.host["id"])

    def heartbeat(self) -> None:
        host_id = self._ensure_host_id()
        self.client.heartbeat_host(host_id, metadata={"host_name": self.host_name})

    def _wait_for_assignment_verification(self, assignment_id: str) -> dict[str, Any]:
        timeout_sec = float((os.getenv("TERMINAL_MANAGER_VERIFY_TIMEOUT_SEC") or "90").strip() or "90")
        poll_sec = float((os.getenv("TERMINAL_MANAGER_VERIFY_POLL_SEC") or "3").strip() or "3")
        deadline = time.time() + max(15.0, timeout_sec)
        last_result: dict[str, Any] | None = None

        while time.time() < deadline:
            result = self.client.verify_assignment_launch(assignment_id)
            last_result = result
            if bool(result.get("ok")):
                return result
            time.sleep(max(1.0, poll_sec))

        raise RuntimeError(f"Launch verification timed out: {json.dumps(last_result or {}, ensure_ascii=True)[:1200]}")

    def bootstrap_connection(self, connection_id: str, release_channel: str | None = None) -> dict[str, Any]:
        host_id = self._ensure_host_id()
        result = self.client.bootstrap_connection(connection_id, host_id, release_channel=release_channel)
        logger.info("Bootstrapped connection %s on host %s", connection_id, host_id)
        return result

    def run(self) -> None:
        host_id = self._ensure_host_id()
        logger.info("Terminal manager started for host %s", host_id)
        while True:
            try:
                self.heartbeat()
                assignments = self.client.fetch_assignments(host_id)
                for assignment in assignments:
                    self.process_assignment(assignment)
            except Exception as exc:
                logger.error("Manager loop error: %s", exc, exc_info=True)

            if self.once:
                return
            time.sleep(self.poll_seconds)

    def process_assignment(self, assignment: dict[str, Any]) -> None:
        assignment_id = str(assignment.get("id") or "")
        connection = assignment.get("connection") or {}
        connection_id = str(assignment.get("connection_id") or connection.get("id") or "")
        if not assignment_id or not connection_id:
            logger.warning("Skipping malformed assignment payload: %s", assignment)
            return

        logger.info("Processing assignment %s for connection %s", assignment_id, connection_id)
        self.client.ack_assignment(assignment_id, "provisioning", details={"stage": "provisioning"})

        try:
            broker_server = str(connection.get("broker_server") or "")
            password = self._decrypt_connection_password(connection)
            terminal_dir, assets, preset_path, startup_ini, bootstrap_path = self._prepare_terminal_launch(
                connection_id=connection_id,
                broker_server=broker_server,
                password=password,
                assignment=assignment,
                force_reprovision=False,
            )

            try:
                self._launch_terminal(terminal_dir, startup_ini)
            except RuntimeError as exc:
                if "expert was not attached automatically" not in str(exc).lower():
                    raise

                logger.warning(
                    "Launch drift detected for %s. Reprovisioning terminal and retrying once.",
                    connection_id,
                )
                terminal_dir, assets, preset_path, startup_ini, bootstrap_path = self._prepare_terminal_launch(
                    connection_id=connection_id,
                    broker_server=broker_server,
                    password=password,
                    assignment=assignment,
                    force_reprovision=True,
                )
                self._launch_terminal(terminal_dir, startup_ini)

            verification = self._wait_for_assignment_verification(assignment_id)

            self.client.ack_assignment(
                assignment_id,
                "launched",
                terminal_path=str(terminal_dir),
                details={
                    "stage": "launched",
                    "ea_asset": assets.get("installed_artifact"),
                    "bootstrap_json": str(bootstrap_path),
                    "preset_path": str(preset_path),
                    "verification": verification.get("verification") or {},
                },
            )
            logger.info("Assignment %s launched successfully", assignment_id)
        except Exception as exc:
            logger.error("Assignment %s failed: %s", assignment_id, exc, exc_info=True)
            self.client.fail_assignment(
                assignment_id,
                status="failed_launch",
                error=str(exc),
                details={"stage": "failed"},
            )

    def _prepare_terminal_launch(
        self,
        connection_id: str,
        broker_server: str,
        password: str,
        assignment: dict[str, Any],
        force_reprovision: bool,
    ) -> tuple[Path, dict[str, Any], Path, Path, Path]:
        if force_reprovision:
            previous = os.environ.get("MT5_ALLOW_EXISTING_INSTANCE_REPROVISION")
            os.environ["MT5_ALLOW_EXISTING_INSTANCE_REPROVISION"] = "1"
            try:
                terminal_dir = verify_or_reprovision(connection_id, broker_server=broker_server)
            finally:
                if previous is None:
                    os.environ.pop("MT5_ALLOW_EXISTING_INSTANCE_REPROVISION", None)
                else:
                    os.environ["MT5_ALLOW_EXISTING_INSTANCE_REPROVISION"] = previous
        else:
            terminal_dir = verify_or_provision(connection_id, broker_server=broker_server)

        assets = self._install_ea_assets(terminal_dir, assignment)
        preset_path = self._write_set_file(terminal_dir, assignment)
        startup_ini = self._write_startup_ini(
            terminal_dir,
            login=str((assignment.get("connection") or {}).get("account_login") or ""),
            password=password,
            server=broker_server,
            expert_path=assets.get("expert_path") or "",
            expert_parameters=preset_path.name,
        )
        bootstrap_path = self._write_bootstrap_json(terminal_dir, assignment)
        return terminal_dir, assets, preset_path, startup_ini, bootstrap_path

    def _decrypt_connection_password(self, connection: dict[str, Any]) -> str:
        ciphertext = str(connection.get("password_ciphertext_b64") or "")
        nonce = str(connection.get("password_nonce_b64") or "")
        master_key = _require_env("MT5_CREDENTIALS_MASTER_KEY_B64")
        if not ciphertext or not nonce:
            raise RuntimeError("Connection payload missing encrypted broker credentials")
        return decrypt_mt5_password(ciphertext, nonce, master_key)

    def _resolve_ea_source(self, assignment: dict[str, Any]) -> tuple[str, str]:
        release = assignment.get("release") or {}
        artifact_url = str(release.get("artifact_url") or "").strip()
        explicit_source = _resolve_local_ea_candidate((os.getenv("IFX_EA_SOURCE_PATH") or "").strip())

        candidate = explicit_source or artifact_url
        if candidate:
            return candidate, str(release.get("version") or DEFAULT_EA_VERSION)

        fallback_candidates = [
            ROOT / "IFX_Railway_Bridge_v1.ex5",
            ROOT / "IFX_Railway_Bridge_v1.mq5",
            ROOT / "IFX_ControlPlane_Bridge_v1.ex5",
            ROOT / "IFX_ControlPlane_Bridge_v1.mq5",
            ROOT / "IFX_PriceBridge_v3.ex5",
            ROOT / "IFX_PriceBridge_v3.mq5",
        ]
        for fallback in fallback_candidates:
            if fallback.exists():
                resolved = _resolve_local_ea_candidate(str(fallback))
                return resolved, str(release.get("version") or DEFAULT_EA_VERSION)

        raise RuntimeError("No EA source available. Set IFX_EA_SOURCE_PATH or IFX_EA_ARTIFACT_URL.")

    def _install_ea_assets(self, terminal_dir: Path, assignment: dict[str, Any]) -> dict[str, Any]:
        source, version = self._resolve_ea_source(assignment)
        experts_dir = terminal_dir / "MQL5" / "Experts" / "IFX"
        files_dir = terminal_dir / "MQL5" / "Files" / "ifx"
        presets_dir = terminal_dir / "MQL5" / "Presets"
        experts_dir.mkdir(parents=True, exist_ok=True)
        files_dir.mkdir(parents=True, exist_ok=True)
        presets_dir.mkdir(parents=True, exist_ok=True)

        installed_artifact: Path
        if source.startswith("http://") or source.startswith("https://"):
            filename = _sanitize_filename(Path(source.split("?", 1)[0]).name)
            if not filename:
                filename = "IFX_Railway_Bridge_v1.ex5"
            installed_artifact = experts_dir / filename
            with self.client.session.get(source, timeout=self.client.timeout, stream=True) as resp:
                if resp.status_code >= 400:
                    raise RuntimeError(f"Failed to download EA artifact: HTTP {resp.status_code}")
                with open(installed_artifact, "wb") as fh:
                    for chunk in resp.iter_content(chunk_size=65536):
                        if chunk:
                            fh.write(chunk)
        else:
            source_path = Path(source)
            if not source_path.exists():
                raise RuntimeError(f"EA source path not found: {source_path}")
            installed_artifact = experts_dir / _sanitize_filename(source_path.name)
            shutil.copy2(source_path, installed_artifact)

        logger.info("Installed EA asset %s for version %s", installed_artifact, version)
        expert_relative_path = installed_artifact.relative_to(terminal_dir / "MQL5" / "Experts")
        expert_path = str(expert_relative_path.with_suffix(""))
        return {
            "installed_artifact": str(installed_artifact),
            "expert_path": expert_path,
            "version": version,
        }

    def _write_startup_ini(
        self,
        terminal_dir: Path,
        login: str,
        password: str,
        server: str,
        expert_path: str,
        expert_parameters: str,
    ) -> Path:
        if not login or not password or not server:
            raise RuntimeError("Cannot write startup.ini without login, password, and server")
        if not expert_path or not expert_parameters:
            raise RuntimeError("Cannot write startup.ini without expert path and preset file")

        startup_ini = terminal_dir / "startup.ini"
        startup_ini.write_text(
            "\n".join(
                [
                    "[Common]",
                    f"Login={login}",
                    f"Password={password}",
                    f"Server={server}",
                    "KeepPrivate=1",
                    "",
                    "[Charts]",
                    "ProfileLast=Default",
                    "",
                    "[Experts]",
                    "AllowLiveTrading=1",
                    "AllowDllImport=0",
                    "Enabled=1",
                    "Account=0",
                    "Profile=0",
                    "",
                    "[StartUp]",
                    f"Expert={expert_path}",
                    f"ExpertParameters={expert_parameters}",
                    f"Symbol={_resolve_startup_symbol(terminal_dir)}",
                    f"Period={_resolve_startup_period(terminal_dir)}",
                    "ShutdownTerminal=0",
                    "",
                ]
            ),
            encoding="utf-8",
        )
        return startup_ini

    def _write_bootstrap_json(self, terminal_dir: Path, assignment: dict[str, Any]) -> Path:
        release = assignment.get("release") or {}
        scoped_signing_secret = str(assignment.get("install_token") or "").strip()
        bootstrap = {
            "connection_id": assignment.get("connection_id"),
            "install_token": assignment.get("install_token"),
            "release": {
                "version": release.get("version"),
                "channel": release.get("channel"),
                "artifact_url": release.get("artifact_url"),
                "sha256": release.get("sha256"),
            },
            "control_plane": {
                "base_url": _api_base_url(),
                "register_url": _control_plane_url("/api/ea/register"),
                "heartbeat_url": _control_plane_url("/api/ea/heartbeat"),
                "config_url": _control_plane_url("/api/ea/config"),
                "commands_url": _control_plane_url("/api/ea/commands"),
                "command_ack_url": _control_plane_url("/api/ea/commands/ack"),
                "events_url": _control_plane_url("/api/ea/events"),
                "trade_audit_url": _control_plane_url("/api/ea/trade-audit"),
            },
            "relay": {
                "base_url": _relay_base_url(),
                "auth_mode": "install_token",
                "signing_secret_present": bool(scoped_signing_secret),
            },
        }

        path = terminal_dir / "MQL5" / "Files" / "ifx" / "bootstrap.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(bootstrap, indent=2), encoding="utf-8")
        return path

    def _write_set_file(self, terminal_dir: Path, assignment: dict[str, Any]) -> Path:
        connection_id = str(assignment.get("connection_id") or "")
        scoped_signing_secret = str(assignment.get("install_token") or "").strip() or (os.getenv("RELAY_SECRET") or "").strip()
        set_path = terminal_dir / "MQL5" / "Presets" / "ifx_connection.set"
        lines = [
            f"BackendRelayUrl={_relay_base_url()}",
            f"ConnectionId={connection_id}",
            f"SigningSecret={scoped_signing_secret}",
            "EnableLocalFractalSignals=true",
            "StructurePivotWindow=2",
            "StructureBarsToScan=120",
            "LogFractalSignals=true",
        ]
        set_path.parent.mkdir(parents=True, exist_ok=True)
        set_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

        legacy_set_path = terminal_dir / "MQL5" / "Profiles" / "Presets" / set_path.name
        legacy_set_path.parent.mkdir(parents=True, exist_ok=True)
        legacy_set_path.write_text(set_path.read_text(encoding="utf-8"), encoding="utf-8")
        return set_path

    def _launch_terminal(self, terminal_dir: Path, startup_ini: Path) -> None:
        terminal_exe = terminal_dir / "terminal64.exe"
        if not terminal_exe.exists():
            raise RuntimeError(f"terminal64.exe missing: {terminal_exe}")

        launch_timeout = float((os.getenv("MT5_LAUNCH_TIMEOUT_SEC") or "20").strip() or "20")
        expert_timeout = float((os.getenv("MT5_EXPERT_ATTACH_TIMEOUT_SEC") or "30").strip() or "30")
        attempts = max(1, int((os.getenv("MT5_LAUNCH_RETRY_COUNT") or "2").strip() or "2"))

        last_error = ""
        for attempt in range(1, attempts + 1):
            log_path = _latest_terminal_log_path(terminal_dir / "Logs")
            log_offset = _startup_log_offset(log_path)

            _stop_terminal_processes(terminal_exe)
            time.sleep(1.5)

            subprocess.Popen(
                [str(terminal_exe), "/portable", f"/config:{startup_ini}"],
                cwd=str(terminal_dir),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

            deadline = time.time() + launch_timeout
            while time.time() < deadline:
                if _running_terminal_process(terminal_exe):
                    break
                time.sleep(1.0)
            else:
                last_error = f"MT5 terminal did not stay running after launch: {terminal_exe}"
                continue

            expert_deadline = time.time() + expert_timeout
            while time.time() < expert_deadline:
                if _terminal_launch_has_expert_loaded(terminal_dir, startup_ini, log_path, log_offset):
                    return
                time.sleep(1.0)

            last_error = (
                f"MT5 started but expert was not attached automatically for {terminal_exe}. "
                f"startup={startup_ini} attempt={attempt}/{attempts}"
            )

        raise RuntimeError(last_error or f"Failed to launch MT5 with expert: {terminal_exe}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="IFX local terminal manager")
    sub = parser.add_subparsers(dest="command", required=True)

    run_parser = sub.add_parser("run", help="Register host and process terminal assignments")
    run_parser.add_argument("--host-name", default=(os.getenv("TERMINAL_MANAGER_HOST_NAME") or os.getenv("COMPUTERNAME") or "local-host"))
    run_parser.add_argument("--host-type", default=(os.getenv("TERMINAL_MANAGER_HOST_TYPE") or "local"))
    run_parser.add_argument("--capacity", type=int, default=int((os.getenv("TERMINAL_MANAGER_CAPACITY") or "5").strip() or "5"))
    run_parser.add_argument("--poll-seconds", type=float, default=float((os.getenv("TERMINAL_MANAGER_POLL_SEC") or "10").strip() or "10"))
    run_parser.add_argument("--once", action="store_true")

    bootstrap_parser = sub.add_parser("bootstrap-connection", help="Create a pending terminal assignment for a connection")
    bootstrap_parser.add_argument("--connection-id", required=True)
    bootstrap_parser.add_argument("--host-name", default=(os.getenv("TERMINAL_MANAGER_HOST_NAME") or os.getenv("COMPUTERNAME") or "local-host"))
    bootstrap_parser.add_argument("--host-type", default=(os.getenv("TERMINAL_MANAGER_HOST_TYPE") or "local"))
    bootstrap_parser.add_argument("--capacity", type=int, default=int((os.getenv("TERMINAL_MANAGER_CAPACITY") or "5").strip() or "5"))
    bootstrap_parser.add_argument("--release-channel", default=(os.getenv("IFX_EA_RELEASE_CHANNEL") or "stable"))

    build_parser_cmd = sub.add_parser("build-ea", help="Compile the local EA source into an ex5 artifact")
    build_parser_cmd.add_argument("--source", default=(os.getenv("IFX_EA_SOURCE_PATH") or str(ROOT / "IFX_Railway_Bridge_v1.mq5")))

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    if args.command == "run":
        manager = TerminalManager(
            host_name=args.host_name,
            host_type=args.host_type,
            capacity=max(1, int(args.capacity)),
            poll_seconds=max(2.0, float(args.poll_seconds)),
            once=bool(args.once),
        )
        manager.run()
        return 0

    if args.command == "bootstrap-connection":
        manager = TerminalManager(
            host_name=args.host_name,
            host_type=args.host_type,
            capacity=max(1, int(args.capacity)),
            poll_seconds=10.0,
            once=True,
        )
        result = manager.bootstrap_connection(args.connection_id, release_channel=args.release_channel)
        print(json.dumps(result, indent=2))
        return 0

    if args.command == "build-ea":
        compiled = _resolve_local_ea_candidate(str(args.source))
        print(compiled)
        return 0

    parser.error(f"Unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
