import os
import sys
sys.path.append(r'C:\mt5system\runtime')

import supabase

url = os.environ['NEXT_PUBLIC_SUPABASE_URL']
key = os.environ['SUPABASE_SERVICE_ROLE_KEY']
cl = supabase.create_client(url, key)

res = cl.table('mt5_user_connections').select('user_id').execute()
print("Connection Owner IDs:")
for r in res.data:
    print(r['user_id'])

# Fetch tripavail92 user ID
resp = cl.auth.admin.list_users()
for u in resp:
    if u.email == 'tripavail92@gmail.com':
        print("\ntripavail92 ID:", u.id)
