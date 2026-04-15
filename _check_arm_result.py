import os
from pathlib import Path
for l in Path('.env').read_text().splitlines():
    l = l.strip()
    if l and '=' in l and not l.startswith('#'):
        k, v = l.split('=', 1)
        os.environ.setdefault(k.strip(), v.strip())
from supabase import create_client
import json

cl = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY'])
CONN = 'c9fc4e21-f284-4c86-999f-ddedd5649734'

# ea_commands last 6
r = cl.table('ea_commands').select('sequence_no,command_type,status').eq('connection_id', CONN).order('sequence_no', desc=True).limit(6).execute()
print('=== ea_commands ===')
for c in r.data:
    seq = c['sequence_no']
    ct = c['command_type']
    st = c['status']
    print(f'  seq={seq} {ct} -> {st}')

# Check for active armed setups
print('\n=== active armed setups ===')
try:
    setups = cl.table('arm_trade_setups').select('id,status,symbol,side,entry_price,created_at').eq('connection_id', CONN).order('created_at', desc=True).limit(3).execute()
    for s in setups.data:
        print(f'  {s["id"][:8]} {s["symbol"]} {s["side"]} entry={s["entry_price"]} status={s["status"]}')
except Exception as e:
    print(f'  Error: {e}')

# Also check trade_setups or trading_setups
try:
    ts = cl.table('trading_setups').select('id,status,symbol,side,entry_price').eq('connection_id', CONN).order('created_at', desc=True).limit(3).execute()
    print('\n=== trading_setups ===')
    for s in ts.data:
        print(f'  {s["id"][:8]} {s.get("symbol","?")} {s.get("side","?")} entry={s.get("entry_price","?")} status={s.get("status","?")}')
except Exception as e:
    print(f'  trading_setups error: {e}')
