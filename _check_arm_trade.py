import os, time
with open(".env") as f:
    for line in f:
        line = line.strip()
        if line and "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k, v.strip())
from supabase import create_client
cl = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
CONN = "c9fc4e21-f284-4c86-999f-ddedd5649734"
print("Polling arm_trade & heartbeat (3x 5s)...")
for i in range(3):
    time.sleep(5)
    cmds = cl.table("ea_commands").select("sequence_no,command_type,status").eq("connection_id", CONN).order("sequence_no", desc=True).limit(4).execute()
    for c in cmds.data:
        print("  seq=%d %-12s -> %s" % (c["sequence_no"], c["command_type"], c["status"]))
    hb = cl.table("mt5_worker_heartbeats").select("last_metrics,last_seen_at").eq("connection_id", CONN).single().execute()
    m = (hb.data or {}).get("last_metrics", {})
    pos = m.get("open_positions", [])
    print("  HB equity=%s margin=%s positions=%d last_seen=%s" % (
        m.get("equity"), m.get("margin"), len(pos), str(hb.data.get("last_seen_at", ""))[:19]))
    for p in pos:
        print("    pos: %s %s price=%s" % (p.get("symbol"), p.get("side"), p.get("current_price")))
    print()
