import argparse
import json
import os
import time
import uuid
from pathlib import Path

from supabase import create_client


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


def main() -> int:
    parser = argparse.ArgumentParser(description="Queue and monitor a trade job")
    parser.add_argument("--connection-id", required=True)
    parser.add_argument("--symbol", default="BTCUSDM")
    parser.add_argument("--side", choices=["buy", "sell"], default="buy")
    parser.add_argument("--volume", type=float, default=0.01)
    parser.add_argument("--timeout", type=int, default=120)
    args = parser.parse_args()

    load_dotenv(Path(__file__).with_name(".env"))

    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not supabase_key:
        raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing")

    supabase = create_client(supabase_url, supabase_key)

    idempotency_key = f"script-{int(time.time())}-{uuid.uuid4().hex[:8]}"
    payload = {
        "connection_id": args.connection_id,
        "symbol": args.symbol,
        "side": args.side,
        "volume": args.volume,
        "status": "queued",
        "idempotency_key": idempotency_key,
    }

    inserted = supabase.table("trade_jobs").insert(payload).execute().data[0]
    job_id = inserted["id"]
    print(f"Queued job: {job_id}")

    deadline = time.time() + args.timeout
    last_status = None
    final = None

    while time.time() < deadline:
        row = (
            supabase.table("trade_jobs")
            .select("id,status,error,error_code,result,created_at,claimed_at,executed_at")
            .eq("id", job_id)
            .single()
            .execute()
            .data
        )

        status = row.get("status")
        if status != last_status:
            print(f"Status: {status}")
            last_status = status

        if status in ("success", "failed", "canceled"):
            final = row
            break

        time.sleep(2)

    print(json.dumps(final or row, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
