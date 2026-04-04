"""
Standalone Railway deployment target for the IFX multi-tenant control plane.
This mirrors runtime/control_plane.py so Railway can deploy only this folder.
"""

import asyncio
import logging
import os
import time
from datetime import datetime, timezone
from typing import Dict, Optional

import aiohttp
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] %(message)s"
)
logger = logging.getLogger(__name__)

app = FastAPI(title="IFX Control Plane", version="1.0")


class AgentRegistration(BaseModel):
    agent_id: str
    ip: str
    port: int
    capacity: int
    base_url: Optional[str] = None
    status: str = "ready"


class UserCreationRequest(BaseModel):
    user_id: str
    broker: str
    login: str
    password: str
    symbols: list[str] = None


class UserStreamResponse(BaseModel):
    user_id: str
    assigned_agent: str
    stream_url: str
    relay_url: str
    status: str


class ControlPlaneState:
    def __init__(self):
        self.agents: Dict[str, dict] = {}
        self.user_assignments: Dict[str, str] = {}
        self.pending_jobs: Dict[str, list[dict]] = {}
        self.lock = asyncio.Lock()
        self.last_healthcheck = {}

    async def register_agent(self, reg: AgentRegistration) -> bool:
        async with self.lock:
            base_url = (reg.base_url or f"http://{reg.ip}:{reg.port}").rstrip("/")
            self.agents[reg.agent_id] = {
                "ip": reg.ip,
                "port": reg.port,
                "base_url": base_url,
                "capacity": reg.capacity,
                "used_slots": 0,
                "status": "healthy",
                "timestamp": time.time(),
                "stream_url": f"{base_url}/stream",
            }
            self.pending_jobs.setdefault(reg.agent_id, [])
            logger.info(
                f"✓ Registered agent: {reg.agent_id} ({base_url}, capacity={reg.capacity})"
            )
            return True

    async def heartbeat(self, agent_id: str) -> bool:
        async with self.lock:
            if agent_id not in self.agents:
                return False
            self.agents[agent_id]["status"] = "healthy"
            self.agents[agent_id]["timestamp"] = time.time()
            self.last_healthcheck[agent_id] = time.time()
            return True

    async def find_best_agent(self) -> Optional[str]:
        async with self.lock:
            best_agent = None
            best_available = 0
            current_time = time.time()

            for agent_id, info in self.agents.items():
                if current_time - info["timestamp"] > 60:
                    logger.warning(f"Agent {agent_id} is dead (no heartbeat for 60s)")
                    continue
                if info["status"] != "healthy":
                    continue

                available = info["capacity"] - info["used_slots"]
                if available > best_available:
                    best_agent = agent_id
                    best_available = available

            return best_agent

    async def assign_user(self, user_id: str, agent_id: str) -> bool:
        async with self.lock:
            if agent_id not in self.agents:
                return False
            self.user_assignments[user_id] = agent_id
            self.agents[agent_id]["used_slots"] += 1
            logger.info(f"✓ Assigned user {user_id} to agent {agent_id}")
            return True

    async def get_agent_info(self, agent_id: str) -> Optional[dict]:
        async with self.lock:
            return self.agents.get(agent_id)

    async def queue_spawn_job(self, agent_id: str, payload: dict):
        async with self.lock:
            self.pending_jobs.setdefault(agent_id, []).append(payload)

    async def claim_jobs(self, agent_id: str, limit: int = 10) -> list[dict]:
        async with self.lock:
            jobs = self.pending_jobs.get(agent_id, [])
            claimed = jobs[:limit]
            self.pending_jobs[agent_id] = jobs[limit:]
            return claimed

    async def get_status(self) -> dict:
        async with self.lock:
            summary = {
                "total_agents": len(self.agents),
                "total_assigned_users": len(self.user_assignments),
                "agents": {},
            }

            for agent_id, info in self.agents.items():
                summary["agents"][agent_id] = {
                    "ip": info["ip"],
                    "port": info["port"],
                    "base_url": info.get("base_url"),
                    "capacity": info["capacity"],
                    "used_slots": info["used_slots"],
                    "available": info["capacity"] - info["used_slots"],
                    "status": info["status"],
                    "last_seen": datetime.fromtimestamp(info["timestamp"]).isoformat(),
                }

            return summary


state = ControlPlaneState()


async def post_spawn_request(agent_base_url: str, spawn_payload: dict, best_agent: str):
    candidate_base_urls = [agent_base_url]
    if agent_base_url.startswith("https://"):
        candidate_base_urls.append("http://" + agent_base_url[len("https://"):])

    last_error = None
    for candidate_base_url in candidate_base_urls:
        spawn_url = f"{candidate_base_url.rstrip('/')}/spawn-connection"
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    spawn_url,
                    json=spawn_payload,
                    timeout=aiohttp.ClientTimeout(total=30),
                ) as resp:
                    if resp.status == 200:
                        return await resp.json()

                    error_text = await resp.text()
                    logger.error(f"Failed to spawn connection on {best_agent} via {spawn_url}: {error_text}")
                    last_error = HTTPException(
                        status_code=502,
                        detail=f"Failed to spawn MT5 on agent {best_agent}",
                    )
        except asyncio.TimeoutError:
            last_error = HTTPException(
                status_code=504,
                detail=f"Agent {best_agent} did not respond (timeout)",
            )
        except Exception as e:
            logger.error(f"Error spawning connection via {spawn_url}: {e}")
            last_error = HTTPException(status_code=502, detail=str(e))

    raise last_error or HTTPException(status_code=502, detail=f"Failed to spawn MT5 on agent {best_agent}")


@app.post("/agents/register")
async def register_agent(reg: AgentRegistration):
    await state.register_agent(reg)
    return {
        "status": "registered",
        "agent_id": reg.agent_id,
        "message": f"Agent {reg.agent_id} registered with {reg.capacity} capacity",
    }


@app.post("/agents/heartbeat")
async def agent_heartbeat(agent_id: str):
    ok = await state.heartbeat(agent_id)
    if not ok:
        raise HTTPException(status_code=404, detail=f"Agent {agent_id} not found")
    return {"status": "ack", "agent_id": agent_id}


@app.get("/agents/status")
async def get_agents_status():
    return await state.get_status()


@app.post("/agents/jobs/claim")
async def claim_agent_jobs(agent_id: str, limit: int = 10):
    jobs = await state.claim_jobs(agent_id, limit)
    return {"jobs": jobs, "count": len(jobs)}


@app.post("/users/create")
async def create_user(req: UserCreationRequest):
    best_agent = await state.find_best_agent()
    if not best_agent:
        raise HTTPException(status_code=503, detail="No available agents (cluster at capacity)")

    agent_info = await state.get_agent_info(best_agent)
    if not agent_info:
        raise HTTPException(status_code=500, detail="Agent info missing")

    await state.assign_user(req.user_id, best_agent)

    agent_base_url = (
        agent_info.get("base_url") or f"http://{agent_info['ip']}:{agent_info['port']}"
    ).rstrip("/")
    spawn_payload = {
        "user_id": req.user_id,
        "broker": req.broker,
        "login": req.login,
        "password": req.password,
        "symbols": req.symbols or ["EURUSDm", "GBPUSDm", "USDJPYm"],
    }

    status = "created"
    try:
        await post_spawn_request(agent_base_url, spawn_payload, best_agent)
    except HTTPException as e:
        logger.warning(
            f"Direct spawn failed for {req.user_id} on {best_agent}; queueing fallback job: {e.detail}"
        )
        await state.queue_spawn_job(best_agent, spawn_payload)
        status = "queued"

    logger.info(f"✓ User {req.user_id} created on agent {best_agent}")

    return UserStreamResponse(
        user_id=req.user_id,
        assigned_agent=best_agent,
        stream_url=f"{agent_base_url}/stream/{req.user_id}",
        relay_url=agent_base_url,
        status=status,
    )


@app.get("/health")
async def health():
    status = await state.get_status()
    return {
        "status": "healthy",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "agents_count": status["total_agents"],
        "users_count": status["total_assigned_users"],
    }


@app.get("/")
async def root():
    return {
        "service": "IFX Control Plane",
        "version": "1.0",
        "endpoints": {
            "POST /agents/register": "Register a new relay agent (VPS)",
            "POST /agents/heartbeat?agent_id=...": "Keep-alive ping from agent",
            "GET /agents/status": "Status of all agents",
            "POST /users/create": "Create new user and assign to agent",
            "GET /health": "Health check",
        },
    }


@app.on_event("startup")
async def startup_event():
    logger.info("=" * 70)
    logger.info("IFX Control Plane starting...")
    logger.info("Listening on Railway-assigned port")
    logger.info("=" * 70)


@app.on_event("shutdown")
async def shutdown_event():
    logger.info("Control Plane shutdown")


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("CONTROL_PLANE_PORT") or os.getenv("PORT") or 5000)

    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
