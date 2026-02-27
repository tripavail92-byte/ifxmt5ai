import os
import sys

sys.path.append(r'C:\mt5system\runtime')
import db_client as db
from crypto_utils import decrypt_mt5_password
import MetaTrader5 as mt5

def test():
    conns = db.get_active_connections()
    if not conns:
        print("no conn")
        return
    conn = conns[0]
    c_id = conn['id']

    master = os.environ['MT5_CREDENTIALS_MASTER_KEY_B64']
    pwd = decrypt_mt5_password(conn['password_ciphertext_b64'], conn['password_nonce_b64'], master)

    term_path = rf'C:\mt5system\terminals\{c_id}\terminal64.exe'
    
    print(f"Booting: {term_path}")
    print(f"Server: {conn['broker_server']} Login: {conn['account_login']}")

    res = mt5.initialize(
        path=term_path,
        portable=True,
        server=conn['broker_server'],
        login=int(conn['account_login']),
        password=pwd,
        timeout=30000
    )

    print(f'Init direct login result: {res} err: {mt5.last_error()}')
    if res:
        print(mt5.account_info())
        mt5.shutdown()

if __name__ == '__main__':
    test()
