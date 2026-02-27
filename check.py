import os
import sys
sys.path.append(r'C:\mt5system\runtime')

import supabase

url = os.environ['NEXT_PUBLIC_SUPABASE_URL']
key = os.environ['SUPABASE_SERVICE_ROLE_KEY']
cl = supabase.create_client(url, key)

res = cl.table('mt5_user_connections').select('*').execute()
print(f"Total connections: {len(res.data)}")
for r in res.data:
    print(r['id'], r['broker_server'], r['account_login'])
