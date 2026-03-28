import time
import datetime
import requests

url = "https://ifx-mt5-portal-production.up.railway.app/api/prices?conn_id=200beae4-553b-4607-8653-8a15e5699865"
end = time.time() + 120
prev = None
stalls = 0
sample = 0

print("sample,time,max_ts_ms,delta_ms")

while time.time() < end:
    sample += 1
    try:
        resp = requests.get(url, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        prices = data.get("prices", {})
        max_ts = max((int(v.get("ts_ms", 0)) for v in prices.values()), default=0)

        delta = 0 if prev is None else (max_ts - prev)
        if prev is not None and max_ts <= prev:
            stalls += 1

        print(f"{sample},{datetime.datetime.now().strftime('%H:%M:%S')},{max_ts},{delta}")
        prev = max_ts
    except Exception as exc:
        stalls += 1
        print(f"{sample},{datetime.datetime.now().strftime('%H:%M:%S')},ERROR,ERROR:{type(exc).__name__}")

    time.sleep(5)

print(f"SUMMARY samples={sample} stalls={stalls}")
