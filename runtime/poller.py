from __future__ import annotations

import asyncio
import base64
import os
from pathlib import Path
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import httpx
from dotenv import load_dotenv

load_dotenv()


_POLLER_MUTEX_HANDLE = None
_POLLER_LOCK_FH = None


def _runtime_dir() -> str:
    return str(Path(__file__).resolve().parent)


def _single_instance_guard(name: str) -> None:
    if os.name != "nt":
        return

    import ctypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    CreateMutexW = kernel32.CreateMutexW
    CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_wchar_p]
    CreateMutexW.restype = ctypes.c_void_p

    ERROR_ALREADY_EXISTS = 183

    ctypes.set_last_error(0)
    handle = CreateMutexW(None, 0, name)
    last_err = int(ctypes.get_last_error())
    if not handle:
        raise RuntimeError(f"failed to create mutex (err={last_err})")

    global _POLLER_MUTEX_HANDLE
    _POLLER_MUTEX_HANDLE = handle

    if last_err == ERROR_ALREADY_EXISTS:
        raise SystemExit(f"ALREADY_RUNNING: another poller instance is already running (mutex={name})")


def _single_instance_lockfile() -> None:
    if os.name != "nt":
        return

    import msvcrt

    path = os.path.join(_runtime_dir(), "poller.lock")
    os.makedirs(os.path.dirname(path), exist_ok=True)

    global _POLLER_LOCK_FH
    if _POLLER_LOCK_FH is not None:
        return

    fh = open(path, "a+", encoding="utf-8")
    try:
        try:
            fh.seek(0)
            msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            raise SystemExit("ALREADY_RUNNING: another poller instance is already running (lockfile busy)")

        fh.seek(0)
        fh.truncate(0)
        fh.write(str(os.getpid()))
        fh.flush()

        _POLLER_LOCK_FH = fh
    except Exception:
        try:
            fh.close()
        except Exception:
            pass
        raise


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _require_env(name: str) -> str:
    value = (os.getenv(name) or "").strip()
    if not value:
        raise RuntimeError(f"{name} is not set")
    return value


def _get_master_key() -> bytes:
    b64 = _require_env("MT5_CREDENTIALS_MASTER_KEY_B64")
    key = base64.b64decode(b64)
    if len(key) != 32:
        raise RuntimeError("MT5_CREDENTIALS_MASTER_KEY_B64 must decode to 32 bytes")
    return key


def decrypt_mt5_password(nonce_b64: str, ciphertext_b64: str) -> str:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    key = _get_master_key()
    aesgcm = AESGCM(key)
    nonce = base64.b64decode(nonce_b64)
    ciphertext = base64.b64decode(ciphertext_b64)
    plaintext = aesgcm.decrypt(nonce, ciphertext, None)
    return plaintext.decode("utf-8")


def _supabase_rest_url(table: str) -> str:
    return f"{_require_env('SUPABASE_URL').rstrip('/')}/rest/v1/{table}"


def _supabase_headers() -> Dict[str, str]:
    key = _require_env("SUPABASE_SERVICE_ROLE_KEY")
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }


def _truthy_env(name: str) -> bool:
    return (os.getenv(name) or "").strip().lower() in ("1", "true", "yes", "y", "on")


def _ensure_terminal_copy(connection_id: str) -> Optional[str]:
    base_dir = (os.getenv("MT5_TERMINAL_BASE_DIR") or "").strip()
    if not base_dir:
        return None

    dest_dir = os.path.join(base_dir, connection_id)
    dest_terminal = os.path.join(dest_dir, "terminal64.exe")
    if os.path.exists(dest_terminal):
        return dest_terminal

    if not _truthy_env("MT5_TERMINAL_PROVISION"):
        return None

    template_dir = (os.getenv("MT5_TERMINAL_TEMPLATE_DIR") or "").strip()
    if not template_dir:
        return None

    template_terminal = os.path.join(template_dir, "terminal64.exe")
    if not os.path.exists(template_terminal):
        return None

    os.makedirs(dest_dir, exist_ok=True)

    if os.name == "nt":
        try:
            import subprocess

            cmd = [
                "robocopy",
                os.path.abspath(template_dir),
                os.path.abspath(dest_dir),
                "/MIR",
                "/NFL",
                "/NDL",
                "/NJH",
                "/NJS",
                "/NP",
            ]
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
            if int(p.returncode) <= 7 and os.path.exists(dest_terminal):
                return dest_terminal
        except Exception:
            pass

    try:
        import shutil

        shutil.copytree(os.path.abspath(template_dir), os.path.abspath(dest_dir), dirs_exist_ok=True)
    except Exception:
        return None

    if os.path.exists(dest_terminal):
        return dest_terminal
    return None


async def _fetch_next_request(client: httpx.AsyncClient) -> Optional[Dict[str, Any]]:
    url = _supabase_rest_url("mt5_user_connections")
    params = {
        "select": "id,user_id,broker_server,account_login,password_nonce_b64,password_ciphertext_b64,test_request_id,test_requested_at",
        "order": "test_requested_at.asc",
        "limit": "1",
        "test_request_id": "not.is.null",
    }

    resp = await client.get(url, headers=_supabase_headers(), params=params)
    if resp.status_code == 400:
        # Some PostgREST versions prefer is.not.null
        params["test_request_id"] = "is.not.null"
        resp = await client.get(url, headers=_supabase_headers(), params=params)

    if resp.status_code != 200:
        raise RuntimeError(f"Supabase fetch failed: HTTP {resp.status_code}: {resp.text}")

    rows = resp.json() or []
    if not rows:
        return None
    return rows[0]


async def _update_row(
    client: httpx.AsyncClient,
    connection_id: str,
    payload: Dict[str, Any],
) -> None:
    url = _supabase_rest_url("mt5_user_connections")
    params = {"id": f"eq.{connection_id}"}
    headers = _supabase_headers() | {"Prefer": "return=minimal"}

    resp = await client.patch(url, headers=headers, params=params, json=payload)
    if resp.status_code not in (200, 204):
        raise RuntimeError(f"Supabase update failed: HTTP {resp.status_code}: {resp.text}")


def _terminal_path_for_connection(connection_id: str) -> Optional[str]:
    base_dir = (os.getenv("MT5_TERMINAL_BASE_DIR") or "").strip()
    if base_dir:
        candidate = os.path.join(base_dir, connection_id, "terminal64.exe")
        if os.path.exists(candidate):
            return candidate
        provisioned = _ensure_terminal_copy(connection_id)
        if provisioned:
            return provisioned

    terminal_path = (os.getenv("MT5_TERMINAL_PATH") or "").strip()
    if terminal_path:
        return terminal_path

    return None


def _mt5_ipc_lock_path() -> str:
    # Shared with job_worker.py (same filename) so poller/tests and workers
    # don't fight over MetaTrader5 IPC.
    return os.path.join(_runtime_dir(), "mt5_ipc.lock")


class _Mt5IpcLock:
    def __init__(self) -> None:
        self._fh = None
        self._acquired = False

    def __enter__(self) -> "_Mt5IpcLock":
        if os.name != "nt" or not _truthy_env("MT5_GLOBAL_IPC_LOCK"):
            return self

        import msvcrt

        timeout_s_raw = (os.getenv("MT5_GLOBAL_IPC_LOCK_TIMEOUT_SECONDS") or "").strip()
        timeout_s = float(timeout_s_raw) if timeout_s_raw else 120.0
        start = time.time()

        fh = open(_mt5_ipc_lock_path(), "a+", encoding="utf-8")
        self._fh = fh
        while True:
            try:
                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
                self._acquired = True
                return self
            except OSError:
                if (time.time() - start) >= timeout_s:
                    raise RuntimeError(f"timed out waiting for MT5 IPC lock after {timeout_s:.1f}s")
                time.sleep(0.1)

    def __exit__(self, exc_type, exc, tb) -> None:
        if os.name != "nt" or not _truthy_env("MT5_GLOBAL_IPC_LOCK"):
            return

        import msvcrt

        try:
            if self._fh and self._acquired:
                self._fh.seek(0)
                msvcrt.locking(self._fh.fileno(), msvcrt.LK_UNLCK, 1)
        finally:
            try:
                if self._fh:
                    self._fh.close()
            except Exception:
                pass


def _run_mt5_login_test(row: Dict[str, Any]) -> Dict[str, Any]:
    broker_server = row.get("broker_server")
    account_login_raw = row.get("account_login")
    connection_id = str(row.get("id") or "").strip()

    try:
        account_login = int(str(account_login_raw))
    except Exception:
        return {"ok": False, "error": "account_login is not an integer", "details": None, "latency_ms": None}

    try:
        password = decrypt_mt5_password(
            str(row.get("password_nonce_b64")),
            str(row.get("password_ciphertext_b64")),
        )
    except Exception as e:
        return {"ok": False, "error": f"Decrypt failed: {e}", "details": None, "latency_ms": None}

    t0 = time.perf_counter()
    ok = False
    error: Optional[str] = None
    details: Optional[Dict[str, Any]] = None

    try:
        import MetaTrader5 as mt5  # type: ignore

        terminal_path = _terminal_path_for_connection(connection_id) if connection_id else None

        timeout_ms_raw = (os.getenv("MT5_TERMINAL_TIMEOUT_MS") or "").strip()
        timeout_ms = int(timeout_ms_raw) if timeout_ms_raw.isdigit() else 60000

        # When using per-connection terminal copies, we want /portable mode so each
        # connection keeps separate config/state (prevents accounts logging each other out).
        portable: bool
        if "MT5_TERMINAL_PORTABLE" in os.environ:
            portable = _truthy_env("MT5_TERMINAL_PORTABLE")
        else:
            portable = bool((os.getenv("MT5_TERMINAL_BASE_DIR") or "").strip())

        def _attempt() -> tuple[bool, Optional[str], Optional[Dict[str, Any]]]:
            init_kwargs: Dict[str, Any] = {
                "login": account_login,
                "password": password,
                "server": str(broker_server),
                "timeout": timeout_ms,
                "portable": portable,
            }
            if terminal_path:
                init_kwargs["path"] = terminal_path

            init_ok = mt5.initialize(**init_kwargs)
            if not init_ok:
                return False, f"mt5.initialize failed: {mt5.last_error()}", None

            acct = mt5.account_info()
            if acct is None:
                return False, f"mt5.account_info returned None: {mt5.last_error()}", None

            return (
                True,
                None,
                {
                    "login": acct.login,
                    "name": acct.name,
                    "company": acct.company,
                    "server": acct.server,
                    "currency": acct.currency,
                    "leverage": acct.leverage,
                    "balance": acct.balance,
                    "equity": acct.equity,
                },
            )

        with _Mt5IpcLock():
            ok1, err1, details1 = _attempt()
            if ok1:
                ok = True
                details = details1
            else:
                # Targeted retry for transient MT5 IPC errors.
                last_err = None
                try:
                    last_err = mt5.last_error()
                except Exception:
                    last_err = None

                retry = False
                if isinstance(last_err, (tuple, list)) and last_err:
                    try:
                        code = int(last_err[0])
                        if code in (-10001, -10005):
                            retry = True
                    except Exception:
                        pass
                if (err1 or "").lower().find("ipc") >= 0:
                    retry = True

                if retry:
                    try:
                        mt5.shutdown()
                    except Exception:
                        pass
                    time.sleep(2.0)
                    ok2, err2, details2 = _attempt()
                    if ok2:
                        ok = True
                        details = details2
                    else:
                        error = err2
                else:
                    error = err1

            try:
                mt5.shutdown()
            except Exception:
                pass

    except Exception as e:
        error = f"MT5 runtime exception: {e}"

    latency_ms = int((time.perf_counter() - t0) * 1000)
    return {"ok": ok, "error": error, "details": details, "latency_ms": latency_ms}


async def run_poller() -> None:
    poll_interval = float(os.getenv("MT5_POLL_INTERVAL_SECONDS") or "2")
    heartbeat_s = float(os.getenv("MT5_POLLER_HEARTBEAT_SECONDS") or "30")

    # Single-instance guard: avoid duplicate pollers racing on the same queue.
    try:
        _single_instance_guard("Global\\IFX_MT5_POLLER")
    except Exception:
        _single_instance_guard("Local\\IFX_MT5_POLLER")
    _single_instance_lockfile()

    print(f"mt5-runtime poller starting (interval={poll_interval}s)", flush=True)

    last_heartbeat = 0.0
    consecutive_errors = 0
    backoff_cap_s = float(os.getenv("MT5_POLLER_ERROR_BACKOFF_CAP_SECONDS") or "30")

    async with httpx.AsyncClient(timeout=20.0) as client:
        while True:
            now = time.time()
            if (now - last_heartbeat) >= heartbeat_s:
                print("poller heartbeat: running", flush=True)
                last_heartbeat = now

            try:
                row = await _fetch_next_request(client)
            except Exception as e:
                consecutive_errors += 1
                sleep_s = min(backoff_cap_s, max(poll_interval, 2 ** min(6, consecutive_errors)))
                print(f"poller fetch error: {type(e).__name__}: {e} (sleep={sleep_s:.1f}s)", flush=True)
                await asyncio.sleep(sleep_s)
                continue

            if not row:
                consecutive_errors = 0
                await asyncio.sleep(poll_interval)
                continue

            connection_id = str(row.get("id"))
            request_id = str(row.get("test_request_id"))
            print(f"Processing test_request_id={request_id} connection_id={connection_id}", flush=True)

            result = _run_mt5_login_test(row)

            payload: Dict[str, Any] = {
                "last_test_at": _now_iso(),
                "last_test_ok": bool(result["ok"]),
                "last_test_error": result.get("error"),
                "last_test_latency_ms": result.get("latency_ms"),
                "last_test_result": result.get("details"),
                # clear the request
                "test_request_id": None,
                "test_requested_at": None,
            }

            try:
                await _update_row(client, connection_id=connection_id, payload=payload)
                consecutive_errors = 0
                err = payload.get("last_test_error")
                if err:
                    err = str(err)
                    if len(err) > 400:
                        err = err[:400] + "..."
                print(
                    f"Done ok={payload['last_test_ok']} latency_ms={payload['last_test_latency_ms']} error={err}",
                    flush=True,
                )
            except Exception as e:
                consecutive_errors += 1
                sleep_s = min(backoff_cap_s, max(poll_interval, 2 ** min(6, consecutive_errors)))
                print(f"poller update error: {type(e).__name__}: {e} (sleep={sleep_s:.1f}s)", flush=True)
                await asyncio.sleep(sleep_s)


if __name__ == "__main__":
    try:
        asyncio.run(run_poller())
    except SystemExit as e:
        msg = str(e)
        if msg.startswith("ALREADY_RUNNING:"):
            print(msg, flush=True)
            raise SystemExit(0)
        raise
