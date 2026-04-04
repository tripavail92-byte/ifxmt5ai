"""
control_plane.py
IFX Multi-Tenant Control Plane

Central orchestrator that:
- Registers relay agents (VPS nodes)
- Assigns users to least-loaded agents
- Monitors agent health
- Scales automatically

Runs on: Your main machine or separate control server
Port: 5000
"""

import asyncio
import json
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

# ============================================================================
# DATA MODELS
# ============================================================================

class AgentRegistration(BaseModel):
    agent_id: str
    ip: str
    port: int
    capacity: int
    base_url: Optional[str] = None
    status: str = "ready"

class UserCreationRequest(BaseModel):
    user_id: str
    broker: str  # "exness", "fxpro", "fxcm", etc.
    login: str
    password: str
    symbols: list[str] = None  # e.g., ["EURUSDm", "GBPUSDm", ...]

class UserStreamResponse(BaseModel):
    user_id: str
    assigned_agent: str
    stream_url: str
    relay_url: str
    status: str

# ============================================================================
# IN-MEMORY REGISTRY (Production: use Redis or PostgreSQL)
# ============================================================================

class ControlPlaneState:
    """Central registry of agents and user assignments."""
    
    def __init__(self):
        self.agents: Dict[str, dict] = {}  # agent_id → {ip, port, capacity, used_slots, status, timestamp}
        self.user_assignments: Dict[str, str] = {}  # user_id → agent_id
        self.pending_jobs: Dict[str, list[dict]] = {}
        self.lock = asyncio.Lock()
        self.last_healthcheck = {}
    
    async def register_agent(self, reg: AgentRegistration) -> bool:
        """VPS agent registers itself."""
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
                "stream_url": f"{base_url}/stream"
            }
            self.pending_jobs.setdefault(reg.agent_id, [])
            logger.info(
                f"✓ Registered agent: {reg.agent_id} ({base_url}, capacity={reg.capacity})"
            )
            return True
    
    async def heartbeat(self, agent_id: str) -> bool:
        """Keep-alive ping from agent."""
        async with self.lock:
            if agent_id not in self.agents:
                return False
            self.agents[agent_id]["status"] = "healthy"
            self.agents[agent_id]["timestamp"] = time.time()
            self.last_healthcheck[agent_id] = time.time()
            return True
    
    async def find_best_agent(self) -> Optional[str]:
        """Find agent with most available capacity."""
        async with self.lock:
            best_agent = None
            best_available = 0
            
            current_time = time.time()
            
            for agent_id, info in self.agents.items():
                # Skip dead agents (no heartbeat for 60s)
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
        """Assign user to agent."""
        async with self.lock:
            if agent_id not in self.agents:
                return False
            
            self.user_assignments[user_id] = agent_id
            self.agents[agent_id]["used_slots"] += 1
            logger.info(f"✓ Assigned user {user_id} to agent {agent_id}")
            return True
    
    async def get_agent_info(self, agent_id: str) -> Optional[dict]:
        """Get agent details."""
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
        """Get overall status."""
        async with self.lock:
            summary = {
                "total_agents": len(self.agents),
                "total_assigned_users": len(self.user_assignments),
                "agents": {}
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
                    "last_seen": datetime.fromtimestamp(info["timestamp"]).isoformat()
                }
            
            return summary

# Global state
state = ControlPlaneState()


async def post_spawn_request(agent_base_url: str, spawn_payload: dict, best_agent: str):
    """Call the relay spawn endpoint, with HTTP fallback for Cloudflare tunnel edge issues."""
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

# ============================================================================
# API ENDPOINTS
# ============================================================================

@app.post("/agents/register")
async def register_agent(reg: AgentRegistration):
    """VPS agents call this to register when starting."""
    await state.register_agent(reg)
    return {
        "status": "registered",
        "agent_id": reg.agent_id,
        "message": f"Agent {reg.agent_id} registered with {reg.capacity} capacity"
    }

@app.post("/agents/heartbeat")
async def agent_heartbeat(agent_id: str):
    """VPS agents call this every 30 seconds to stay alive."""
    ok = await state.heartbeat(agent_id)
    if not ok:
        raise HTTPException(status_code=404, detail=f"Agent {agent_id} not found")
    return {"status": "ack", "agent_id": agent_id}

@app.get("/agents/status")
async def get_agents_status():
    """Get status of all agents."""
    status = await state.get_status()
    return status


@app.post("/agents/jobs/claim")
async def claim_agent_jobs(agent_id: str, limit: int = 10):
    """Relay agents pull pending spawn jobs from the control plane."""
    jobs = await state.claim_jobs(agent_id, limit)
    return {"jobs": jobs, "count": len(jobs)}

@app.post("/users/create")
async def create_user(req: UserCreationRequest):
    """
    New user signs up → Control plane assigns to least-loaded VPS.
    
    Steps:
    1. Find best agent (least loaded)
    2. Assign user to agent
    3. Tell agent to spawn MT5 connection
    4. Return stream endpoint to user
    """
    
    # Find best agent
    best_agent = await state.find_best_agent()
    if not best_agent:
        raise HTTPException(
            status_code=503,
            detail="No available agents (cluster at capacity)"
        )
    
    # Get agent details
    agent_info = await state.get_agent_info(best_agent)
    if not agent_info:
        raise HTTPException(status_code=500, detail="Agent info missing")
    
    # Assign user to this agent
    await state.assign_user(req.user_id, best_agent)
    
    # Tell agent to spawn MT5 connection
    agent_base_url = (agent_info.get("base_url") or f"http://{agent_info['ip']}:{agent_info['port']}").rstrip("/")
    spawn_payload = {
        "user_id": req.user_id,
        "broker": req.broker,
        "login": req.login,
        "password": req.password,
        "symbols": req.symbols or ["EURUSDm", "GBPUSDm", "USDJPYm"]
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
        status=status
    )

@app.get("/health")
async def health():
    """Health check."""
    status = await state.get_status()
    return {
        "status": "healthy",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "agents_count": status["total_agents"],
        "users_count": status["total_assigned_users"]
    }

@app.get("/")
async def root():
    """Root endpoint."""
    return {
        "service": "IFX Control Plane",
        "version": "1.0",
        "endpoints": {
            "POST /agents/register": "Register a new relay agent (VPS)",
            "POST /agents/heartbeat?agent_id=...": "Keep-alive ping from agent",
            "GET /agents/status": "Status of all agents",
            "POST /users/create": "Create new user and assign to agent",
            "GET /health": "Health check",
        }
    }

# ============================================================================
# STARTUP/SHUTDOWN
# ============================================================================

@app.on_event("startup")
async def startup_event():
    logger.info("=" * 70)
    logger.info("IFX Control Plane starting...")
    logger.info(f"Listening on http://0.0.0.0:5000")
    logger.info("=" * 70)

@app.on_event("shutdown")
async def shutdown_event():
    logger.info("Control Plane shutdown")

# ============================================================================
# MAIN
# ============================================================================

if __name__ == "__main__":
    import uvicorn
    
    port = int(os.getenv("CONTROL_PLANE_PORT") or os.getenv("PORT") or 5000)
    
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=port,
        log_level="info"
    )
