import json
from pathlib import Path
import sys

sys.path.append(r"C:\mt5system\runtime")
import supabase  # type: ignore


def load_env(path: str) -> dict[str, str]:
    env: dict[str, str] = {}
    for raw in Path(path).read_text().splitlines():
        line = raw.strip()
        if line and "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            env[k] = v.strip().strip("'").strip('"')
    return env


env = load_env(r"C:\mt5system\frontend\.env.local")
cl = supabase.create_client(env["NEXT_PUBLIC_SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"])

conn_rows = (
    cl.table("mt5_user_connections")
    .select("id,account_login,broker_server,status,is_active,updated_at")
    .eq("account_login", "260437559")
    .eq("broker_server", "Exness-MT5Trial15")
    .execute()
    .data
)

print("CONNECTION=")
print(json.dumps(conn_rows, indent=2))

if not conn_rows:
    raise SystemExit(0)

conn_id = conn_rows[0]["id"]

heartbeats = (
    cl.table("mt5_worker_heartbeats")
    .select("*")
    .eq("connection_id", conn_id)
    .limit(5)
    .execute()
    .data
)

setups = (
    cl.table("trading_setups")
    .select("id,symbol,state,trade_now_active,entry_price,zone_low,zone_high,timeframe,ai_sensitivity,updated_at")
    .eq("connection_id", conn_id)
    .order("updated_at", desc=True)
    .limit(10)
    .execute()
    .data
)

jobs = (
    cl.table("trade_jobs")
    .select("*")
    .eq("connection_id", conn_id)
    .order("created_at", desc=True)
    .limit(10)
    .execute()
    .data
)

print("HEARTBEATS=")
print(json.dumps(heartbeats, indent=2))
print("SETUPS=")
print(json.dumps(setups, indent=2))
print("TRADE_JOBS=")
print(json.dumps(jobs, indent=2))

for setup in setups[:3]:
    setup_id = setup["id"]
    transitions = (
        cl.table("setup_state_transitions")
        .select("id,from_state,to_state,trigger,price,candle_time,created_at")
        .eq("setup_id", setup_id)
        .order("created_at", desc=True)
        .limit(10)
        .execute()
        .data
    )
    print(f"TRANSITIONS[{setup['symbol']}]={json.dumps(transitions, indent=2)}")
    try:
        structure = (
            cl.table("setup_structure_events")
            .select("*")
            .eq("setup_id", setup_id)
            .order("created_at", desc=True)
            .limit(10)
            .execute()
            .data
        )
    except Exception as exc:  # pragma: no cover
        structure = {"error": str(exc)}
    print(f"STRUCTURE[{setup['symbol']}]={json.dumps(structure, indent=2)}")
