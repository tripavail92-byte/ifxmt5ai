"""
Fix the pending arm_trade seq 20 by replacing EM DASH in trade_plan_notes with ASCII hyphen.
The EM DASH causes MQL5's CharArrayToString to produce a string where the closing ] is out of bounds.
"""
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

# Get the pending arm_trade commands
cmds = cl.table('ea_commands').select('id,sequence_no,command_type,payload_json').eq('connection_id', CONN).eq('status', 'pending').execute()
print('Pending commands:')
for c in cmds.data:
    notes = c.get('payload_json', {}).get('trade_plan_notes', '')
    non_ascii = any(ord(ch) > 127 for ch in notes)
    print(f'  seq={c["sequence_no"]} {c["command_type"]} notes={notes!r} non_ascii={non_ascii}')

# Fix seq 20 - replace EM DASH with ASCII hyphen
for c in cmds.data:
    payload = c.get('payload_json', {})
    notes = payload.get('trade_plan_notes', '')
    if any(ord(ch) > 127 for ch in notes):
        fixed_notes = notes.encode('ascii', 'replace').decode('ascii').replace('?', '-')
        payload['trade_plan_notes'] = fixed_notes
        print(f'\nFixing seq={c["sequence_no"]}: {notes!r} -> {fixed_notes!r}')
        cl.table('ea_commands').update({'payload_json': payload}).eq('id', c['id']).execute()
        print('  Updated in DB')

# Verify the fix via API
import requests
base = 'https://ifx-mt5-portal-production.up.railway.app'
token = 'baadafbe9e2940ac869e070b7b01ece5991196889f114483bb0b0a19b316affa'
url = base + '/api/ea/commands?connection_id=' + CONN + '&cursor=0&limit=20'
resp = requests.get(url, headers={'X-IFX-INSTALL-TOKEN': token}, timeout=10)
data = resp.json()
cmds_api = data.get('commands', [])
print('\nAPI response after fix:')
print('  Length:', len(resp.text))
for c in cmds_api:
    notes = c.get('payload', {}).get('trade_plan_notes', '')
    has_non_ascii = any(ord(ch) > 127 for ch in notes)
    print(f'  seq={c.get("sequence_no")} {c.get("command_type")} non_ascii={has_non_ascii}')
print('\nFull response (last 100 chars):', resp.text[-100:])
