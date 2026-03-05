"""check_symbol_counts.py

Quick helper: prints mt5_symbols row counts for the known active connections.
Reads SUPABASE_* from the workspace .env.

Usage:
  C:/mt5system/.venv/Scripts/python.exe check_symbol_counts.py
"""

from __future__ import annotations

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


def main() -> None:
    root = Path(__file__).resolve().parent
    load_dotenv(root / ".env")

    from runtime import db_client

    conn_ids = [
        "49ff88b0-c07d-4a26-a861-7771feb5d77e",
        "90b8a9ac-f8f6-4b4b-a3d7-f4efc41e7b65",
    ]

    client = db_client.get_client()

    for cid in conn_ids:
        resp = (
            client.table("mt5_symbols")
            .select("symbol", count="exact", head=True)
            .eq("connection_id", cid)
            .execute()
        )
        print(f"{cid} count={resp.count}")


if __name__ == "__main__":
    main()
