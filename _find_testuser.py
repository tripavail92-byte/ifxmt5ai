"""Find testuser connections."""
import os, json
with open('.env') as f:
    for line in f:
        line = line.strip()
        if line and '=' in line and not line.startswith('#'):
            k, v = line.split('=', 1)
            os.environ.setdefault(k, v.strip())
from supabase import create_client
cl = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY'])
users_resp = cl.auth.admin.list_users()
users_list = users_resp if isinstance(users_resp, list) else users_resp.users
for u in users_list:
    email = str(u.email or '').lower()
    if 'test' in email or 'ifx' in email:
        print(f"user: {u.id}  email: {u.email}")
        conns = cl.table('mt5_user_connections').select('id,account_login,broker_server,status').eq('user_id', u.id).execute()
        for c in conns.data:
            sid = str(c['id'])
            login = c['account_login']
            broker = c['broker_server']
            status = c['status']
            print(f"  conn={sid}  login={login}  broker={broker}  status={status}")
