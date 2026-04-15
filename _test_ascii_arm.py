import os, uuid, json
from pathlib import Path
from datetime import datetime, timezone, timedelta

for l in Path('.env').read_text().splitlines():
    l = l.strip()
    if l and '=' in l and not l.startswith('#'):
        k, v = l.split('=', 1)
        os.environ.setdefault(k.strip(), v.strip())

from supabase import create_client
cl = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY'])

CONN = 'c9fc4e21-f284-4c86-999f-ddedd5649734'
r = cl.table('ea_commands').select('sequence_no').eq('connection_id', CONN).order('sequence_no', desc=True).limit(1).execute()
seq = (r.data[0]['sequence_no'] + 1) if r.data else 1
setup_id = '672f38ba-4fb8-494c-b288-7f2c71906aad'
notes = 'ASCII only test - no special chars'
payload = {
    'setup_id': setup_id, 'symbol': 'XAUUSDm', 'side': 'buy',
    'entry_price': 4761, 'timeframe': '5m', 'ai_sensitivity': 3,
    'trade_plan_notes': notes,
    'use_auto_rr': True, 'auto_rr1': 1.5, 'auto_rr2': 2.5,
    'tp1': 4808.61, 'tp2': 4856.22, 'sl': 4713.39
}
cmd_id = str(uuid.uuid4())
cl.table('ea_commands').insert({
    'id': cmd_id, 'connection_id': CONN, 'user_id': 'edc89e54-338c-4c4d-9449-f356f9b1d22b',
    'command_type': 'arm_trade', 'payload_json': payload, 'sequence_no': seq,
    'idempotency_key': 'arm_trade_ascii_test_' + str(seq),
    'status': 'pending',
    'expires_at': (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat()
}).execute()

print('Enqueued seq =', seq, 'cmd_id =', cmd_id)
print('Notes:', notes)

# Fetch combined response from API to check length
import requests
base = 'https://ifx-mt5-portal-production.up.railway.app'
token = 'baadafbe9e2940ac869e070b7b01ece5991196889f114483bb0b0a19b316affa'
url = base + '/api/ea/commands?connection_id=' + CONN + '&cursor=0&limit=20'
resp = requests.get(url, headers={'X-IFX-INSTALL-TOKEN': token}, timeout=10)
data = resp.json()
cmds = data.get('commands', [])
print('\nAPI now returns', len(cmds), 'commands:')
for c in cmds:
    notes_val = c.get('payload', {}).get('trade_plan_notes', '')
    has_non_ascii = any(ord(ch) > 127 for ch in notes_val)
    print('  seq =', c.get('sequence_no'), c.get('command_type'), 'non_ascii =', has_non_ascii, 'resp_len =', len(resp.text))
