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

# Ensure all submodule folders are on the path
ROOT = Path(__file__).parent
for folder in ['runtime', 'risk_engine', 'ai_engine', 'job_queue']:
    sys.path.insert(0, str(ROOT / folder))
sys.path.insert(0, str(ROOT))


def main():
    if len(sys.argv) < 2:
        print("Usage: python main.py [supervisor|worker <conn_id>|scheduler|poller]")
        sys.exit(1)

    command = sys.argv[1].lower()

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
