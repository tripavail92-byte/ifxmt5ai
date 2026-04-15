"""
Enqueue a fresh arm_trade command with ASCII-only notes to test if EM DASH causes parsing issues.
"""
import os, sys, json
from pathlib import Path

# Load .env
env_path = Path(__file__).parent / '.env'
for line in env_path.read_text().splitlines():
    line = line.strip()
    if line and '=' in line and not line.startswith('#'):
        k, v = line.split('=', 1)
        os.environ.setdefault(k.strip(), v.strip())

from supabase import create_client

cl = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY'])

CONN_ID = 'c9fc4e21-f284-4c86-999f-ddedd5649734'
USER_ID = 'edc89e54-338c-4c4d-9449-f356f9b1d22b'
SYMBOL  = 'XAUUSDm'

# Get next sequence number
r = cl.table('ea_commands').select('sequence_no').eq('connection_id', CONN_ID).order('sequence_no', desc=True).limit(1).execute()
next_seq = (r.data[0]['sequence_no'] + 1) if r.data else 1

# Get a setup_id
setups = cl.table('trade_setups').select('id').eq('connection_id', CONN_ID).order('created_at', desc=True).limit(1).execute()
if setups.data:
    setup_id = setups.data[0]['id']
else:
    import uuid
    setup_id = str(uuid.uuid4())
    print(f"No existing setup, creating new setup_id={setup_id}")
    cl.table('trade_setups').insert({
        'id': setup_id,
        'connection_id': CONN_ID,
        'user_id': USER_ID,
        'symbol': SYMBOL,
        'side': 'buy',
        'entry_price': 4761.0,
        'status': 'pending',
        'ai_sensitivity': 3,
    }).execute()

entry = 4761.0

cmd_payload = {
    'setup_id': setup_id,
    'symbol': SYMBOL,
    'side': 'buy',
    'entry_price': entry,
    'timeframe': '5m',
    'ai_sensitivity': 3,
    'trade_plan_notes': 'ASCII only test arm trade no special chars',  # No EM DASH!
    'use_auto_rr': True,
    'auto_rr1': 1.5,
    'auto_rr2': 2.5,
    'tp1': round(entry + entry * 0.01, 2),
    'tp2': round(entry + entry * 0.02, 2),
    'sl': round(entry - entry * 0.01, 2),
}

import uuid
from datetime import datetime, timezone, timedelta

cmd_id = str(uuid.uuid4())
idem_key = f"arm_trade:{CONN_ID}:{setup_id}:test_ascii"

result = cl.table('ea_commands').insert({
    'id': cmd_id,
    'connection_id': CONN_ID,
    'command_type': 'arm_trade',
    'payload_json': cmd_payload,
    'sequence_no': next_seq,
    'idempotency_key': idem_key,
    'status': 'pending',
    'expires_at': (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat(),
}).execute()

print(f"Enqueued arm_trade seq={next_seq} cmd_id={cmd_id}")
print(f"setup_id={setup_id}")
print(f"notes={cmd_payload['trade_plan_notes']!r}")
print()
print("Full JSON length:", len(json.dumps(cmd_payload)))
