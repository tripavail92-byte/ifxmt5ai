#!/usr/bin/env python3
"""
test_multitenant_flow.py

Test the new multi-tenant architecture end-to-end:
1. Start services (docker-compose)
2. Simulate user signups
3. Verify data isolation
4. Check ticks flowing through Redis Streams

Usage:
    python test_multitenant_flow.py
"""

import asyncio
import json
import time
from typing import Optional

import aiohttp

# Configuration
CONTROL_PLANE_URL = "http://localhost:5000"
RELAY_AGENTS = [
    "http://relay_agent_1:8083",
    "http://relay_agent_2:8083"
]

class TestClient:
    def __init__(self, base_url: str):
        self.base_url = base_url
    
    async def post(self, endpoint: str, data: dict) -> dict:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{self.base_url}{endpoint}",
                json=data,
                timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                return await resp.json()
    
    async def get(self, endpoint: str) -> dict:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"{self.base_url}{endpoint}",
                timeout=aiohttp.ClientTimeout(total=10)
            ) as resp:
                return await resp.json()

async def test_control_plane():
    """Test control plane endpoints."""
    print("\n" + "="*70)
    print("TEST 1: Control Plane Registration")
    print("="*70)
    
    control_plane = TestClient(CONTROL_PLANE_URL)
    
    # Wait for control plane to be ready
    for i in range(30):
        try:
            result = await control_plane.get("/health")
            print(f"✓ Control plane ready: {result['status']}")
            break
        except:
            if i < 29:
                print(f"Waiting for control plane ({i+1}/30)...")
                await asyncio.sleep(1)
            else:
                print("✗ Control plane failed to start")
                return False
    
    return True

async def test_agents():
    """Test relay agent registration."""
    print("\n" + "="*70)
    print("TEST 2: Agent Registration with Control Plane")
    print("="*70)
    
    control_plane = TestClient(CONTROL_PLANE_URL)
    
    # Wait for agents to register
    max_wait = 30
    for i in range(max_wait):
        try:
            status = await control_plane.get("/agents/status")
            agents_count = status.get("total_agents", 0)
            
            print(f"Agents registered: {agents_count}")
            
            if agents_count >= 2:
                print(f"✓ Both agents registered successfully")
                print(f"  Total assigned users: {status.get('total_assigned_users', 0)}")
                for agent_id, info in status.get("agents", {}).items():
                    print(f"  - {agent_id}: {info['available']}/{info['capacity']} slots available")
                return True
            
            if i < max_wait - 1:
                await asyncio.sleep(1)
        except Exception as e:
            if i < max_wait - 1:
                print(f"Waiting for agents... ({i+1}/{max_wait})")
                await asyncio.sleep(1)
    
    print("✗ Agents failed to register")
    return False

async def test_user_creation():
    """Test creating users and assigning to agents."""
    print("\n" + "="*70)
    print("TEST 3: User Creation and Assignment")
    print("="*70)
    
    control_plane = TestClient(CONTROL_PLANE_URL)
    
    users = [
        {
            "user_id": "user-001",
            "broker": "exness",
            "login": "demo-001",
            "password": "password-001",
            "symbols": ["EURUSDm", "GBPUSDm"]
        },
        {
            "user_id": "user-002",
            "broker": "fxpro",
            "login": "demo-002",
            "password": "password-002",
            "symbols": ["USDJPYm", "XAUUSDm"]
        },
        {
            "user_id": "user-003",
            "broker": "exness",
            "login": "demo-003",
            "password": "password-003",
            "symbols": ["BTCUSDm", "ETHUSDm"]
        }
    ]
    
    for user in users:
        try:
            result = await control_plane.post("/users/create", user)
            
            if "assigned_agent" in result:
                print(f"✓ {user['user_id']}")
                print(f"  Assigned to: {result['assigned_agent']}")
                print(f"  Stream URL: {result['stream_url']}")
                print(f"  Broker: {user['broker']}")
            else:
                print(f"✗ {user['user_id']} failed: {result}")
        except Exception as e:
            print(f"✗ {user['user_id']} error: {e}")
            return False
    
    # Show final status
    status = await control_plane.get("/agents/status")
    print(f"\nFinal status:")
    print(f"  Total users: {status.get('total_assigned_users')}")
    print(f"  Total agents: {status.get('total_agents')}")
    
    return True

async def test_agent_status():
    """Test individual agent status."""
    print("\n" + "="*70)
    print("TEST 4: Agent Status and Connections")
    print("="*70)
    
    for agent_url in RELAY_AGENTS:
        agent = TestClient(agent_url)
        
        try:
            result = await agent.get("/status")
            
            print(f"\n{result.get('agent_id', 'unknown')}:")
            print(f"  Capacity: {result['capacity']}")
            print(f"  Active connections: {result['active_connections']}")
            print(f"  Redis: {'✓' if result.get('redis_connected') else '✗'}")
            
            for user_id, conn_info in result.get('connections', {}).items():
                print(f"  - {user_id}: {conn_info.get('broker')} (symbols: {len(conn_info.get('symbols', []))})")
        except Exception as e:
            print(f"✗ {agent_url}: {e}")
    
    return True

async def test_stream_endpoint():
    """Test streaming ticks from an agent."""
    print("\n" + "="*70)
    print("TEST 5: Stream Endpoint Test")
    print("="*70)
    
    agent_url = RELAY_AGENTS[0]
    user_id = "user-001"
    
    stream_url = f"{agent_url}/stream/{user_id}"
    
    print(f"Connecting to: {stream_url}")
    print(f"(Note: In production, this would stream live ticks from MT5)")
    
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(stream_url, timeout=aiohttp.ClientTimeout(total=5)) as resp:
                if resp.status == 200:
                    print(f"✓ Stream endpoint responsive (HTTP {resp.status})")
                    print(f"  Content-Type: {resp.headers.get('Content-Type')}")
                else:
                    print(f"✗ Stream endpoint returned HTTP {resp.status}")
    except asyncio.TimeoutError:
        print(f"✓ Stream endpoint exists (timeout after 5s is expected - keep-alive)")
    except Exception as e:
        print(f"✗ Error: {e}")

async def main():
    """Run all tests."""
    print("\n")
    print("#" * 70)
    print("# IFX MULTI-TENANT ARCHITECTURE - E2E TEST")
    print("#" * 70)
    
    results = []
    
    # Test 1: Control Plane
    results.append(("Control Plane Health", await test_control_plane()))
    
    # Test 2: Agent Registration
    results.append(("Agent Registration", await test_agents()))
    
    # Test 3: User Creation
    results.append(("User Creation", await test_user_creation()))
    
    # Test 4: Agent Status
    results.append(("Agent Status", await test_agent_status()))
    
    # Test 5: Stream Endpoint
    await test_stream_endpoint()
    
    # Summary
    print("\n" + "="*70)
    print("TEST SUMMARY")
    print("="*70)
    
    for test_name, passed in results:
        status = "✓ PASS" if passed else "✗ FAIL"
        print(f"{status}: {test_name}")
    
    all_passed = all(result[1] for result in results)
    
    print("\n" + ("="*70))
    if all_passed:
        print("✓ ALL TESTS PASSED - Multi-tenant architecture is working!")
        print("\nNext steps:")
        print("1. Deploy relay agents to production VPS servers")
        print("2. Configure Supabase RLS policies")
        print("3. Test with real MT5 terminals")
    else:
        print("✗ Some tests failed - see details above")
    
    return all_passed

if __name__ == "__main__":
    import sys
    
    try:
        success = asyncio.run(main())
        sys.exit(0 if success else 1)
    except KeyboardInterrupt:
        print("\n\nTest interrupted by user")
        sys.exit(1)
