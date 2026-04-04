# Stale Connections Fix

## Problem
Workers were crashing when heartbeat updates were attempted on deleted connections, causing them to become "stale" (unresponsive). The supervisor would then detect stale heartbeats and kill the workers, but the root cause was never fixed, resulting in a cycle of worker crashes.

### Root Cause
When a connection is deleted from the `mt5_user_connections` table in Supabase, any attempt by the worker to upsert a heartbeat to `mt5_worker_heartbeats` would fail with a foreign key constraint violation (error code 23503):

```
insert or update on table "mt5_worker_heartbeats" violates foreign key constraint 
"mt5_worker_heartbeats_connection_id_fkey"
```

This would cause an uncaught exception, crashing the worker and preventing further heartbeat updates, making it appear "stale" to the supervisor.

## Solution
The fix involves three changes:

### 1. Updated `db_client.py` - `upsert_heartbeat()` function
- Added detection for foreign key constraint errors (code 23503)
- When a connection no longer exists, raise a descriptive `RuntimeError` instead of the generic API error
- Log an informative message for debugging

### 2. Updated `job_worker.py` - Main event loop
- Wrapped the main heartbeat update in a try-except block
- When a connection deletion is detected, the worker exits gracefully with `sys.exit(0)`
- This allows the supervisor to clean up the heartbeat row and respawn a new worker

### 3. Updated `job_worker.py` - Initialization paths
- Added connection deletion handling to:
  - `touch_starting_heartbeat()` - During MT5 initialization phase
  - `start_keepalive()` - Background thread that keeps heartbeat fresh during blocking calls
  - Error handling paths after failed MT5 init
  - Health check failure paths
  - Reinitialize callback functions

## Result
Now when a connection is deleted:
1. Worker detects the foreign key constraint error
2. Worker logs a clear message: "Connection was deleted — exiting worker"
3. Worker exits gracefully with exit code 0
4. Supervisor cleans up the orphaned heartbeat row
5. System is ready to provision a new worker when/if the connection is recreated

This prevents the "stale heartbeat" cycle and gives clear diagnostic information about what happened.

## Files Modified
- `runtime/db_client.py` - Lines 200-250 (upsert_heartbeat function)
- `runtime/job_worker.py` - Multiple locations:
  - Lines 770-790 (touch_starting_heartbeat function)
  - Lines 794-817 (start_keepalive function)  
  - Lines 896-912 (MT5 init error handling)
  - Lines 1005-1020 (Main loop heartbeat update)
  - Lines 1030-1040 (Health check failed)
  - Lines 1060-1090 (Reinitialize callbacks)
