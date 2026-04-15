"""Reset testuser password."""
import os
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
    email = str(u.email or '')
    if 'testuser@ifxportal.com' in email:
        print(f'Found: id={u.id} email={u.email} confirmed={u.email_confirmed_at is not None}')
        resp = cl.auth.admin.update_user_by_id(u.id, {'password': 'Demo@ifx2026!'})
        uid = resp.user.id if resp.user else 'FAILED'
        print(f'Password reset: {uid}')
