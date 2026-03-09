"""
main.py
IFX MT5 Runtime — Root entry point launcher.

Usage:
  python main.py supervisor          # start supervisor
  python main.py worker <conn_id>    # start one worker (supervisor does this automatically)
  python main.py scheduler           # start AI eval scheduler
  python main.py poller              # start poller

This script adds the correct module paths before importing.
Always run from C:\\mt5system with the .venv active.
"""

import sys
import os
from pathlib import Path


def load_dotenv(dotenv_path: Path) -> None:
    if not dotenv_path.exists():
        return

    for raw_line in dotenv_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if key and key not in os.environ:
            os.environ[key] = value

# Ensure all submodule folders are on the path
ROOT = Path(__file__).resolve().parent
for folder in ['runtime', 'risk_engine', 'ai_engine', 'job_queue']:
    sys.path.insert(0, str(ROOT / folder))
sys.path.insert(0, str(ROOT))


def main():
    load_dotenv(ROOT / ".env")

    # Minimal startup trace for diagnosing duplicate launcher issues.
    # Appends a single line per invocation; safe to leave enabled.
    try:
        trace_path = ROOT / "runtime" / "logs" / "launcher_trace.log"
        trace_path.parent.mkdir(parents=True, exist_ok=True)
        with open(trace_path, "a", encoding="utf-8") as fh:
            fh.write(
                f"pid={os.getpid()} argv={sys.argv} exe={sys.executable} prefix={getattr(sys, 'prefix', '')}\n"
            )
    except Exception:
        pass

    # Enforce running inside the workspace venv.
    # Note: do NOT use Path.resolve() here — venv python.exe can be a symlink
    # to the base interpreter, which would make system-Python appear identical.
    venv_root = ROOT / ".venv"
    if venv_root.exists():
        expected_venv_python = venv_root / "Scripts" / "python.exe"

        expected_exe = os.path.normcase(os.path.abspath(str(expected_venv_python)))
        actual_exe = os.path.normcase(os.path.abspath(str(getattr(sys, "executable", ""))))
        if expected_exe and actual_exe and actual_exe != expected_exe:
            print(
                "Refusing to run with non-venv Python executable. "
                f"Expected sys.executable={expected_exe} | Got sys.executable={actual_exe}"
            )
            print(f"Run with: {expected_venv_python} main.py <command>")
            sys.exit(2)

        expected_prefix = os.path.normcase(os.path.abspath(str(venv_root)))
        actual_prefix = os.path.normcase(os.path.abspath(str(getattr(sys, "prefix", ""))))
        if expected_prefix and actual_prefix and actual_prefix != expected_prefix:
            print(
                "Refusing to run outside the workspace venv. "
                f"Expected sys.prefix={expected_prefix} | Got sys.prefix={actual_prefix}"
            )
            print(f"Run with: {expected_venv_python} main.py <command>")
            sys.exit(2)

    if len(sys.argv) < 2:
        print("Usage: python main.py [supervisor|worker <conn_id>|scheduler|poller]")
        sys.exit(1)

    command = sys.argv[1].lower()

    # Guard against duplicate supervisor launches as early as possible.
    if command == "supervisor" and os.name == "nt":
        try:
            import ctypes
            import ctypes.wintypes as wt

            def _append_trace(msg: str) -> None:
                try:
                    trace_path = ROOT / "runtime" / "logs" / "launcher_trace.log"
                    trace_path.parent.mkdir(parents=True, exist_ok=True)
                    with open(trace_path, "a", encoding="utf-8") as fh:
                        fh.write(f"pid={os.getpid()} supervisor_mutex {msg}\n")
                except Exception:
                    pass

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            create_mutex = kernel32.CreateMutexW
            create_mutex.argtypes = [wt.LPVOID, wt.BOOL, wt.LPCWSTR]
            create_mutex.restype = wt.HANDLE

            wait_for_single_object = kernel32.WaitForSingleObject
            wait_for_single_object.argtypes = [wt.HANDLE, wt.DWORD]
            wait_for_single_object.restype = wt.DWORD

            # Use Local namespace to avoid Global namespace privilege/session issues.
            mutex_name = "Local\\IFX_MT5_SUPERVISOR_LAUNCH"

            # Create and immediately acquire ownership to avoid a startup race.
            handle = create_mutex(None, True, mutex_name)
            if not handle:
                raise OSError(f"CreateMutexW failed: {ctypes.get_last_error()}")

            last_err = ctypes.get_last_error()

            WAIT_OBJECT_0 = 0x00000000
            WAIT_ABANDONED = 0x00000080
            WAIT_TIMEOUT = 0x00000102

            # If the mutex already existed, we may not own it; check if we can acquire.
            res = wait_for_single_object(handle, 0)
            if res == WAIT_TIMEOUT:
                _append_trace(f"name={mutex_name} owned_by_other last_error={last_err}")
                print("Another supervisor launcher is already running; exiting.")
                sys.exit(0)
            if res not in (WAIT_OBJECT_0, WAIT_ABANDONED):
                raise OSError(f"WaitForSingleObject failed: {res}")

            _append_trace(f"name={mutex_name} acquired res={res} last_error={last_err}")

            globals()["_SUPERVISOR_LAUNCH_MUTEX_HANDLE"] = handle
        except SystemExit:
            raise
        except Exception as exc:
            print(f"Supervisor launcher mutex error: {exc}")

    if command == "supervisor":
        from runtime.supervisor import main as run
        run()

    elif command == "worker":
        if len(sys.argv) < 3:
            print("Usage: python main.py worker <connection_id>")
            sys.exit(1)
        connection_id = sys.argv[2]
        from runtime.job_worker import run_worker
        run_worker(connection_id)

    elif command == "scheduler":
        from ai_engine.eval_scheduler import run_eval_loop
        run_eval_loop()

    elif command == "poller":
        from runtime.poller import main as run
        run()

    else:
        print(f"Unknown command: {command}")
        print("Valid commands: supervisor, worker, scheduler, poller")
        sys.exit(1)


if __name__ == "__main__":
    main()
