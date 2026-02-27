import os, sys, json
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

conns = cl.table('mt5_user_connections').select('*').execute().data
events = cl.table('mt5_runtime_events').select('*').order('created_at', desc=True).limit(5).execute().data
hbs = cl.table('mt5_worker_heartbeats').select('*').execute().data

with open('db_dump.txt', 'w') as f:
    f.write("CONNECTIONS\n")
    f.write(json.dumps(conns, indent=2) + "\n\n")
    f.write("EVENTS\n")
    f.write(json.dumps(events, indent=2) + "\n\n")
    f.write("HEARTBEATS\n")
    f.write(json.dumps(hbs, indent=2) + "\n\n")
