import sys
sys.path.append(r'C:\mt5system\runtime')
import db_client as db

for hb in db.get_all_heartbeats():
    print(f"{hb.get('connection_id')} - Status: {hb.get('status')} - Ready: {hb.get('mt5_initialized')} - PID: {hb.get('pid')}")
