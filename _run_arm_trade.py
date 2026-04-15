"""
_run_arm_trade.py — directly enqueue arm_trade for live EA (auto path).
Treats it as a fresh case: creates a setup + command with Phase 6 auto_rr fields.
"""
import os, json, uuid, datetime

with open('.env') as f:
    for line in f:
        line = line.strip()
        if line and '=' in line and not line.startswith('#'):
            k, v = line.split('=', 1)
            os.environ.setdefault(k, v.strip())

from supabase import create_client

cl = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY'])

CONN_ID = 'c9fc4e21-f284-4c86-999f-ddedd5649734'
USER_ID  = 'edc89e54-338c-4c4d-9449-f356f9b1d22b'
SYMBOL   = 'XAUUSDm'

# Pull latest XAUUSDm price from heartbeat open positions
hbs = cl.table('mt5_worker_heartbeats').select('last_metrics').eq('connection_id', CONN_ID).single().execute()
positions = (hbs.data or {}).get('last_metrics', {}).get('open_positions', [])
# Try to get XAUUSDm price from any open position
xau_prices = [p['current_price'] for p in positions if SYMBOL.upper().replace('M', '') in p.get('symbol', '').upper()]
if not xau_prices:
    # Fallback: fetch live tick from DB symbol price cache or use hardcoded recent price
    tick_r = cl.table('mt5_worker_heartbeats').select('last_metrics->>bid_price,last_metrics').eq('connection_id', CONN_ID).single().execute()
    metrics = (tick_r.data or {}).get('last_metrics', {})
    # Try ticks dict if available
    ticks = metrics.get('ticks', {}) or metrics.get('prices', {})
    xau_tick = ticks.get(SYMBOL) or ticks.get(SYMBOL.upper())
    if xau_tick:
        current_price = float(xau_tick.get('bid') or xau_tick.get('ask') or xau_tick)
    else:
        # Use last known from positions page - hardcode reasonable fallback
        current_price = 4761.0
        print(f"WARNING: No live XAUUSDm price found, using fallback {current_price}")
else:
    current_price = float(xau_prices[0])
print(f"Current {SYMBOL} price from heartbeat: {current_price}")

# Get next sequence_no
seq_r = cl.table('ea_commands').select('sequence_no').order('sequence_no', desc=True).limit(1).execute()
next_seq = (seq_r.data[0]['sequence_no'] + 1) if seq_r.data else 1
print(f"Using sequence_no: {next_seq}")

setup_id = str(uuid.uuid4())
tp1 = round(current_price * 1.01, 2)
tp2 = round(current_price * 1.02, 2)
sl  = round(current_price * 0.99, 2)
entry = round(current_price, 2)

# 1. Create trading setup
cl.table('trading_setups').insert({
    'id': setup_id,
    'user_id': USER_ID,
    'connection_id': CONN_ID,
    'symbol': SYMBOL,
    'side': 'buy',
    'entry_price': entry,
    'zone_percent': 0.5,
    'zone_low': round(entry * 0.995, 2),
    'zone_high': round(entry * 1.005, 2),
    'loss_edge': sl,
    'target': tp2,
    'state': 'IDLE',
    'timeframe': '5m',
    'ai_sensitivity': 3,
    'pivot': entry,
    'tp1': tp1,
    'tp2': tp2,
    'bias': 'neutral',
    'use_auto_rr': True,
    'auto_rr1': 1.5,
    'auto_rr2': 2.5,
    'notes': 'Phase6 auto arm_trade test — fresh case run',
}).execute()
print(f"Created trading_setup: {setup_id}")

# 2. Enqueue arm_trade ea_command
expires = (datetime.datetime.utcnow() + datetime.timedelta(hours=24)).isoformat() + 'Z'
cmd_payload = {
    'setup_id': setup_id,
    'symbol': SYMBOL,
    'side': 'buy',
    'entry_price': entry,
    'zone_percent': 0.5,
    'timeframe': '5m',
    'ai_sensitivity': 3,
    'pivot': entry,
    'tp1': tp1,
    'tp2': tp2,
    'bias': 'neutral',
    'use_auto_rr': True,
    'auto_rr1': 1.5,
    'auto_rr2': 2.5,
    'trade_plan_notes': 'Phase6 auto arm_trade test — fresh case run',
}

cmd = cl.table('ea_commands').insert({
    'connection_id': CONN_ID,
    'user_id': USER_ID,
    'command_type': 'arm_trade',
    'payload_json': cmd_payload,
    'idempotency_key': f'arm_trade:{CONN_ID}:{setup_id}',
    'sequence_no': next_seq,
    'status': 'pending',
    'expires_at': expires,
}).execute()

cmd_id = cmd.data[0]['id']
print(f"Enqueued ea_command: {cmd_id}")
print(f"  use_auto_rr=True, auto_rr1=1.5, auto_rr2=2.5")
print(f"  entry={entry}, tp1={tp1}, tp2={tp2}, sl={sl}")
print(f"EA will pick this up on next poll cycle (~5s).")
