from supabase import create_client
import json

url = 'https://agipjfxfdygfilriffxv.supabase.co'
key = None
for line in open('.env'):
    l = line.strip()
    if l.startswith('SUPABASE_SERVICE_ROLE_KEY='):
        key = l.split('=', 1)[1].strip()

c = create_client(url, key)
conn_id = '9e9be7f0-fd3e-44fa-84be-3a6f2394ad40'
token   = 'dd79fc65802a4d48ac6042f7ceffaf1f85ea6bb87a0f4a7bab7b0c66d2fb0679'

# 1. See what mt5_user_connections looks like (service role bypasses RLS)
print('--- mt5_user_connections sample ---')
r = c.table('mt5_user_connections').select('*').limit(3).execute()
print(json.dumps(r.data, indent=2))

# 2. Check if row already exists
r2 = c.table('mt5_user_connections').select('*').eq('connection_id', conn_id).execute()
print('existing row:', json.dumps(r2.data, indent=2))

# 3. Insert into mt5_user_connections if missing
if not r2.data:
    # build a minimal row matching the existing schema
    # look at sample to know required cols
    sample = r.data[0] if r.data else {}
    print('sample keys:', list(sample.keys()))
    mc_row = {'connection_id': conn_id}
    # common nullable cols we know exist:
    try:
        ins = c.table('mt5_user_connections').insert(mc_row).execute()
        print('mt5_user_connections insert:', json.dumps(ins.data, indent=2))
    except Exception as e:
        print('mt5_user_connections insert ERROR:', str(e)[:400])

# 4. Insert ea_installations
r3 = c.table('ea_installations').select('connection_id').eq('connection_id', conn_id).execute()
if not r3.data:
    ei_row = {
        'connection_id': conn_id,
        'host_id': '873903fb-9930-46bf-b379-b0b3d9cf796b',
        'terminal_path': 'C:\\mt5system\\terminals\\9e9be7f0-fd3e-44fa-84be-3a6f2394ad40',
        'ea_version': '4.0',
        'status': 'online',
        'install_token': token,
        'metadata_json': {'account_login': '25119784'},
    }
    try:
        ins2 = c.table('ea_installations').insert(ei_row).execute()
        print('ea_installations insert:', json.dumps(ins2.data, indent=2))
    except Exception as e:
        print('ea_installations insert ERROR:', str(e)[:400])
else:
    print('ea_installations row already exists:', json.dumps(r3.data, indent=2))
