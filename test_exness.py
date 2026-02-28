import sys
import time
import subprocess
import MetaTrader5 as mt5
from pathlib import Path

TERMINAL = r"C:\mt5system\terminals\a2baa968-f0b3-49aa-892d-5df0e1e1249f\terminal64.exe"
LOGIN = 260352206
PASSWORD = "Awais123!!"
SERVER = "Exness-MT5Trial15"

print(f"Terminal path exists: {Path(TERMINAL).exists()}")
print(f"Attempting direct mt5.initialize()...")

# Try direct initialize first (no subprocess)
ok = mt5.initialize(
    path=TERMINAL,
    portable=True,
    login=LOGIN,
    password=PASSWORD,
    server=SERVER,
    timeout=60000
)

print(f"initialize() result: {ok}")
print(f"last_error(): {mt5.last_error()}")

if ok:
    info = mt5.account_info()
    term = mt5.terminal_info()
    print(f"Account: {info}")
    print(f"Terminal connected: {term.connected if term else 'N/A'}")
    print(f"Trade allowed: {term.trade_allowed if term else 'N/A'}")
    mt5.shutdown()
else:
    print("FAILED to initialize. Trying with subprocess launch first...")
    ini_path = Path(TERMINAL).parent / "startup.ini"
    ini_path.write_text(f"[Common]\nLogin={LOGIN}\nPassword={PASSWORD}\nServer={SERVER}\n")
    subprocess.Popen([TERMINAL, "/portable", f"/config:{ini_path}"])
    print("Waiting 10s for terminal to boot...")
    time.sleep(10)
    
    ok2 = mt5.initialize(path=TERMINAL, portable=True, login=LOGIN, password=PASSWORD, server=SERVER, timeout=30000)
    print(f"Second initialize() result: {ok2}")
    print(f"last_error(): {mt5.last_error()}")
    
    if ini_path.exists():
        ini_path.unlink()
    
    if ok2:
        info = mt5.account_info()
        print(f"Account info: {info}")
        mt5.shutdown()
