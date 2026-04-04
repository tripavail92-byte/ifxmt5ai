# No-Docker Windows Setup

This project can be started without Docker Desktop.

## What runs natively

- `control_plane` via `uvicorn`
- relay agent via plain Python
- MT5 runtime on Windows

## Scripts

- [start_control_plane.ps1](../start_control_plane.ps1)
- [start_relay_agent.ps1](../start_relay_agent.ps1)
- [start_no_docker_stack.ps1](../start_no_docker_stack.ps1)

## Quick start

From the repo root:

```powershell
.\start_no_docker_stack.ps1
```

Then verify:

```powershell
Invoke-RestMethod http://127.0.0.1:5000/health
Invoke-RestMethod http://127.0.0.1:8083/health
```

## Managed Redis recommended

If no Redis is available, the relay agent still starts, but tick persistence and stream playback are limited.

Example with a remote Redis host:

```powershell
.\start_relay_agent.ps1 -AgentIp "YOUR_PUBLIC_IP" -RedisHost "YOUR_REDIS_HOST" -RedisPort 6379
```

Example with a managed Redis URL:

```powershell
.\start_relay_agent.ps1 -AgentIp "YOUR_PUBLIC_IP" -RedisUrl "redis://default:password@host:6379"
```

## Railway split deployment

Recommended split for VPS:

- Railway: `control_plane`
- Railway Redis plugin or external managed Redis
- Windows VPS: relay agent + MT5 runtime

Important:

- Use Railway for the control plane URL.
- Do not move the MT5 relay itself to Railway, because MT5 stays on Windows VPS.
- The relay needs its own public HTTPS URL from either:
	- a permanent Cloudflare tunnel, or
	- a VPS domain with reverse proxy (recommended non-tunnel option).

For Railway control plane, use the start command:

```bash
python runtime/control_plane.py
```

`control_plane.py` now honors Railway's `PORT` automatically.

Then start the VPS relay agent against Railway:

```powershell
.\start_relay_agent.ps1 `
	-AgentIp "YOUR_VPS_PUBLIC_IP" `
	-AgentBaseUrl "http://relay.myifxacademy.com" `
	-ControlPlaneUrl "https://YOUR-RAILWAY-CONTROL-PLANE.up.railway.app" `
	-RedisUrl "redis://default:password@host:6379"
```

Use `-AgentBaseUrl` when the relay is exposed through a tunnel, reverse proxy, or custom domain.
This avoids bad `127.0.0.1` URLs being returned to Railway or clients.

Current production lock:

- Relay callback base URL: `http://relay.myifxacademy.com`
- Control plane URL: `https://ifx-control-plane-production.up.railway.app`

This is the current stable setting because HTTPS on `relay.myifxacademy.com` is still returning a Cloudflare 502 for POST callbacks.

## Alternative to tunnels: domain + reverse proxy

If you do not want a tunnel, the clean permanent option is:

- point a DNS record like `relay.yourdomain.com` to your VPS public IP
- run the relay locally on `127.0.0.1:8083`
- put Caddy or Nginx in front of it for HTTPS
- register the relay with:

```powershell
.\start_relay_agent.ps1 `
	-AgentIp "YOUR_VPS_PUBLIC_IP" `
	-AgentBaseUrl "https://relay.yourdomain.com" `
	-ControlPlaneUrl "https://ifx-control-plane-production.up.railway.app" `
	-RedisUrl "redis://default:password@host:6379"
```

This is more permanent than a quick tunnel and works well with Railway-hosted control plane.

## Manual start

Control plane:

```powershell
.\start_control_plane.ps1
```

Relay agent:

```powershell
.\start_relay_agent.ps1 -AgentIp "127.0.0.1" -ControlPlaneUrl "http://127.0.0.1:5000"
```

## Notes

- This avoids Docker Desktop completely.
- This is the recommended path for the current Windows VPS.
- If you need production-grade Redis, use a managed Redis service or a separate Linux VPS.