import requests, json

base = 'https://ifx-mt5-portal-production.up.railway.app'
conn = 'c9fc4e21-f284-4c86-999f-ddedd5649734'
token = 'baadafbe9e2940ac869e070b7b01ece5991196889f114483bb0b0a19b316affa'
url = base + '/api/ea/commands?connection_id=' + conn + '&cursor=0&limit=20'
resp = requests.get(url, headers={'X-IFX-INSTALL-TOKEN': token}, timeout=10)
print('Status:', resp.status_code)
print('Length:', len(resp.text))
data = resp.json()
cmds = data.get('commands', [])
print('commands count:', len(cmds))
for c in cmds:
    seq = c.get('sequence_no')
    ct = c.get('command_type')
    expires = c.get('expires_at', '?')
    payload_keys = list(c.get('payload', {}).keys())
    print(f'  seq={seq} {ct} expires={expires}')
    print(f'  payload keys: {payload_keys}')
print()
print('Full response (repr):')
print(repr(resp.text))
