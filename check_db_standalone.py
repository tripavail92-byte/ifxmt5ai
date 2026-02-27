import os
import sys
sys.path.append(r'C:\mt5system\runtime')
import supabase

env = {}
with open(r'C:\mt5system\frontend\.env.local') as f:
    for line in f:
        line = line.strip()
        if line and '=' in line and not line.startswith('#'):
            k, v = line.split('=', 1)
            env[k] = v.strip().strip("'").strip('"')

cl = supabase.create_client(env['NEXT_PUBLIC_SUPABASE_URL'], env['SUPABASE_SERVICE_ROLE_KEY'])

events = cl.table('mt5_runtime_events').select('*').order('created_at', desc=True).limit(10).execute()
print("--- LATEST RUNTIME EVENTS ---")
for e in events.data:
    print(e['created_at'], e['level'], e['component'], e['message'])

hbs = cl.table('mt5_worker_heartbeats').select('*').execute()
print("\n--- ACTIVE HEARTBEATS ---")
for h in hbs.data:
    print(h)

conns = cl.table('mt5_user_connections').select('*').execute()
print("\n--- CONNECTIONS ---")
for c in conns.data:
    print(c['id'], c['broker_server'], c['account_login'], c['status'])
