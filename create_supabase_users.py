"""create_supabase_users.py

Creates 3 Supabase Auth users (auto-confirmed):
  - user1@ifxsystem.com
  - user2@ifxsystem.com
  - user3@ifxsystem.com

Requires env vars (loaded from .env if present):
  - SUPABASE_URL
  - SUPABASE_SERVICE_ROLE_KEY

Usage:
  .\.venv\Scripts\python.exe create_supabase_users.py
  .\.venv\Scripts\python.exe create_supabase_users.py --password "YourPassword"
    .\.venv\Scripts\python.exe create_supabase_users.py --password "YourPassword" --reset-existing

Notes:
  - Uses Supabase GoTrue Admin API.
    - If a user already exists, it will report and skip unless --reset-existing is used.
"""

from __future__ import annotations

import argparse
import os
import sys
from getpass import getpass
from typing import Any

import requests
from dotenv import load_dotenv


EMAILS = [
    "user1@ifxsystem.com",
    "user2@ifxsystem.com",
    "user3@ifxsystem.com",
]


def _require_env(name: str) -> str:
    val = os.environ.get(name)
    if val:
        return val
    raise SystemExit(
        f"Missing env var {name}. Ensure C:/mt5system/.env exists and has it."
    )


def _post_admin_user(supabase_url: str, service_role_key: str, email: str, password: str) -> tuple[bool, str]:
    url = supabase_url.rstrip("/") + "/auth/v1/admin/users"
    headers = {
        "apikey": service_role_key,
        "Authorization": f"Bearer {service_role_key}",
        "Content-Type": "application/json",
    }
    payload: dict[str, Any] = {
        "email": email,
        "password": password,
        "email_confirm": True,
    }

    resp = requests.post(url, headers=headers, json=payload, timeout=20)

    if 200 <= resp.status_code < 300:
        return True, "created"

    # If already exists, Supabase typically returns 422.
    # We don’t attempt password reset here because it requires user id.
    body = ""
    try:
        body = resp.text
    except Exception:
        body = "<no body>"

    if resp.status_code in (400, 409, 422) and ("already" in body.lower() or "exists" in body.lower()):
        return False, "already exists (skipped)"

    return False, f"failed ({resp.status_code}): {body}"


def _find_user_id_by_email(supabase_url: str, service_role_key: str, email: str) -> str | None:
    url = supabase_url.rstrip("/") + "/auth/v1/admin/users"
    headers = {
        "apikey": service_role_key,
        "Authorization": f"Bearer {service_role_key}",
    }

    page = 1
    while True:
        resp = requests.get(
            url,
            headers=headers,
            params={"page": page, "per_page": 200},
            timeout=20,
        )
        if not (200 <= resp.status_code < 300):
            return None

        users = resp.json().get("users", [])
        for user in users:
            if (user.get("email") or "").lower() == email.lower():
                user_id = user.get("id")
                if isinstance(user_id, str) and user_id:
                    return user_id

        if len(users) < 200:
            return None
        page += 1


def _reset_user_password(
    supabase_url: str,
    service_role_key: str,
    email: str,
    password: str,
) -> tuple[bool, str]:
    user_id = _find_user_id_by_email(supabase_url, service_role_key, email)
    if not user_id:
        return False, "existing user not found for password reset"

    url = supabase_url.rstrip("/") + f"/auth/v1/admin/users/{user_id}"
    headers = {
        "apikey": service_role_key,
        "Authorization": f"Bearer {service_role_key}",
        "Content-Type": "application/json",
    }
    payload: dict[str, Any] = {
        "password": password,
        "email_confirm": True,
    }

    resp = requests.put(url, headers=headers, json=payload, timeout=20)
    if 200 <= resp.status_code < 300:
        return True, "password reset"

    body = ""
    try:
        body = resp.text
    except Exception:
        body = "<no body>"
    return False, f"password reset failed ({resp.status_code}): {body}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--password",
        help="Password to set for all three users. If omitted, you will be prompted.",
        default=None,
    )
    parser.add_argument(
        "--reset-existing",
        action="store_true",
        help="If a user already exists, reset that user's password to the provided password.",
    )
    args = parser.parse_args()

    # Load .env from repo root by default.
    load_dotenv()

    supabase_url = _require_env("SUPABASE_URL")
    service_role_key = _require_env("SUPABASE_SERVICE_ROLE_KEY")

    password = args.password
    if not password:
        password = getpass("Enter password to set for user1/user2/user3: ")
        if not password:
            print("Password cannot be empty.")
            return 2

    print("Creating users in Supabase Auth...")
    for email in EMAILS:
        ok, msg = _post_admin_user(supabase_url, service_role_key, email, password)
        if (not ok) and msg == "already exists (skipped)" and args.reset_existing:
            ok, msg = _reset_user_password(supabase_url, service_role_key, email, password)
        prefix = "OK" if ok else "INFO"
        print(f"{prefix}: {email} -> {msg}")

    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
