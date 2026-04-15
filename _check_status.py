"""Quick status check - EA commands + trade audit."""
import os, json
with open('.env') as f:
    for line in f:
        line = line.strip()
        if line and '=' in line and not line.startswith('#'):
            k, v = line.split('=', 1)
            os.environ.setdefault(k, v.strip())
from supabase import create_client
cl = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY'])

r = cl.table('ea_commands').select('id,command_type,status,updated_at,payload_json').order('created_at', desc=True).limit(5).execute()
print('=== RECENT EA_COMMANDS ===')
for c in r.data:
    p = c.get('payload_json') or {}
    cid = str(c['id'])[:8]
    print(f"  {cid} | {c['command_type']} | {c['status']} | uar={p.get('use_auto_rr')} rr1={p.get('auto_rr1')} | updated={c['updated_at']}")

try:
    audit = cl.table('ea_trade_audit').select('*').order('created_at', desc=True).limit(5).execute()
    print('=== EA TRADE AUDIT (last 5) ===')
    for a in audit.data:
        print(json.dumps(a, default=str))
except Exception as e:
    print('trade_audit error:', e)

# Also latest heartbeat
hb = cl.table('mt5_worker_heartbeats').select('status,last_seen_at,mt5_initialized,last_metrics').eq('connection_id', '200beae4-553b-4607-8653-8a15e5699865').execute()
if hb.data:
    m = hb.data[0]
    positions = (m.get('last_metrics') or {}).get('open_positions', [])
    print(f"\n=== HEARTBEAT: status={m['status']}, mt5_init={m['mt5_initialized']}, last_seen={m['last_seen_at']}")
    print(f"Open positions: {len(positions)}")
    for p in positions[-3:]:
        print(f"  {p.get('symbol')} {p.get('type')} {p.get('volume')} @ {p.get('open_price')} profit={p.get('profit')}")
