"""
runtime_audit.py
Production runtime audit for the EA-first IFX MT5 stack.

Purpose:
	- verify public relay health
	- verify the local terminal_manager heartbeat in control-plane state
	- detect missing or stale terminal / EA heartbeats for active connections
	- detect pending actions stuck too long across both EA and legacy queues
	- flag deprecated local runtime processes that should no longer be on the live path

Usage:
	python runtime/runtime_audit.py
	python runtime/runtime_audit.py --queued-job-max-age-sec 30 --stale-heartbeat-sec 45
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib import error as urlerror
from urllib import request as urlrequest

import psutil

import db_client as db


ROOT = Path(__file__).resolve().parent.parent
STATE_FILE = ROOT / "runtime" / "logs" / "runtime_audit_state.json"
RELAY_LOG_FILE = ROOT / "runtime" / "logs" / "price_relay.log"
DEFAULT_CONTROL_PLANE_URL = "https://ifx-mt5-portal-production.up.railway.app"


def _load_dotenv(path: Path) -> None:
	try:
		if not path.exists():
			return
		for raw_line in path.read_text(encoding="utf-8").splitlines():
			line = raw_line.strip()
			if not line or line.startswith("#") or "=" not in line:
				continue
			key, value = line.split("=", 1)
			key = key.strip()
			value = value.strip().strip('"').strip("'")
			if key and key not in os.environ:
				os.environ[key] = value
	except Exception:
		return


_load_dotenv(ROOT / ".env")

EXCLUDED_CONNECTION_IDS = {
	value.strip()
	for value in (
		os.environ.get("PUBLIC_TERMINAL_CONN_ID"),
		os.environ.get("NEXT_PUBLIC_PUBLIC_TERMINAL_CONN_ID"),
	)
	if value and value.strip()
}


@dataclass(slots=True)
class AuditFinding:
	severity: str  # info | warning | critical
	message: str


def _load_state() -> dict:
	try:
		return json.loads(STATE_FILE.read_text(encoding="utf-8"))
	except Exception:
		return {}


def _save_state(state: dict) -> None:
	try:
		STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
		STATE_FILE.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")
	except Exception:
		pass


def _parse_iso_utc(value: str | None) -> datetime | None:
	if not value:
		return None
	try:
		text = value.replace("Z", "+00:00")
		dt = datetime.fromisoformat(text)
		if dt.tzinfo is None:
			return dt.replace(tzinfo=timezone.utc)
		return dt.astimezone(timezone.utc)
	except Exception:
		return None


def _find_processes(*needles: str) -> list[psutil.Process]:
	found: list[psutil.Process] = []
	normalized_needles = [needle.replace("\\", "/").lower() for needle in needles]
	for proc in psutil.process_iter(attrs=["pid", "cmdline"]):
		try:
			cmdline = proc.info.get("cmdline") or []
		except (psutil.NoSuchProcess, psutil.AccessDenied):
			continue
		if not cmdline:
			continue
		text = " ".join(cmdline).replace("\\", "/").lower()
		if all(needle in text for needle in normalized_needles):
			found.append(proc)

	# Windows venv launchers can appear as a thin parent process that spawns the
	# real base-python child running the same command line. Collapse that pair so
	# the audit counts one logical service, not two processes.
	found_by_pid = {proc.pid: proc for proc in found}
	collapsed: list[psutil.Process] = []
	for proc in found:
		try:
			children = proc.children(recursive=False)
		except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
			children = []
		if any(child.pid in found_by_pid for child in children):
			continue
		collapsed.append(proc)
	return collapsed


def _control_plane_url() -> str:
	return (os.environ.get("CONTROL_PLANE_URL") or DEFAULT_CONTROL_PLANE_URL).strip().rstrip("/")


def _audit_public_relay(findings: list[AuditFinding]) -> bool:
	url = _control_plane_url() + "/api/mt5/health"
	try:
		with urlrequest.urlopen(url, timeout=10) as resp:
			status = getattr(resp, "status", 200)
			resp.read()
			if 200 <= status < 300:
				findings.append(AuditFinding("info", f"Public relay OK (HTTP {status})."))
				return True
			findings.append(AuditFinding("critical", f"Public relay unhealthy (HTTP {status})."))
			return False
	except Exception as exc:
		findings.append(AuditFinding("critical", f"Public relay health check failed: {exc!r}"))
		return False


def _audit_terminal_manager_host(findings: list[AuditFinding]) -> bool:
	host_name = (
		os.environ.get("TERMINAL_MANAGER_HOST_NAME")
		or os.environ.get("COMPUTERNAME")
		or socket.gethostname()
	)
	poll_sec_raw = os.environ.get("TERMINAL_MANAGER_POLL_SEC", "10")
	try:
		poll_sec = float(poll_sec_raw)
	except Exception:
		poll_sec = 10.0
	stale_after_sec = max(45, int(poll_sec * 3))

	try:
		resp = (
			db.get_client()
			.table("terminal_hosts")
			.select("id,host_name,status,last_seen_at,updated_at")
			.eq("host_name", host_name)
			.order("updated_at", desc=True)
			.limit(1)
			.execute()
		)
		rows = resp.data or []
	except Exception as exc:
		findings.append(AuditFinding("critical", f"Terminal manager heartbeat lookup failed: {exc!r}"))
		return False

	host = rows[0] if rows else None
	if not host:
		findings.append(AuditFinding("critical", f"Terminal manager host '{host_name}' is not registered."))
		return False

	status = str(host.get("status") or "unknown")
	last_seen = _parse_iso_utc(host.get("last_seen_at"))
	if status != "online":
		findings.append(AuditFinding("critical", f"Terminal manager host '{host_name}' status is '{status}'."))
		return False
	if not last_seen:
		findings.append(AuditFinding("critical", f"Terminal manager host '{host_name}' has no valid heartbeat timestamp."))
		return False

	age = (datetime.now(timezone.utc) - last_seen).total_seconds()
	if age > stale_after_sec:
		findings.append(AuditFinding("critical", f"Terminal manager host '{host_name}' heartbeat is stale age={age:.0f}s (> {stale_after_sec}s)."))
		return False

	findings.append(AuditFinding("info", f"Terminal manager OK host={host_name} age={age:.0f}s."))
	return True


def _audit_deprecated_runtime_processes(findings: list[AuditFinding]) -> int:
	process_map = {
		"price_relay": _find_processes("runtime/price_relay.py"),
		"supervisor": _find_processes("main.py", "supervisor"),
		"scheduler": _find_processes("main.py", "scheduler"),
		"job_worker": _find_processes("job_worker.py"),
	}
	count = 0
	for label, procs in process_map.items():
		count += len(procs)
		for proc in procs:
			findings.append(AuditFinding("warning", f"Deprecated local runtime process still running: {label} pid={proc.pid}"))
	if count == 0:
		findings.append(AuditFinding("info", "No deprecated local runtime processes detected."))
	return count


def _audit_connections(
	findings: list[AuditFinding],
	stale_heartbeat_sec: int,
	queued_job_max_age_sec: int,
) -> None:
	now = datetime.now(timezone.utc)
	active_connections = db.get_active_connections()
	heartbeats = {row.get("connection_id"): row for row in db.get_all_heartbeats()}
	client = db.get_client()
	installations: dict[str, dict] = {}
	try:
		resp = (
			client.table("ea_installations")
			.select("connection_id,status,last_seen_at,last_metrics,last_error,created_at")
			.order("created_at", desc=True)
			.execute()
		)
		for row in resp.data or []:
			connection_id = row.get("connection_id")
			if connection_id and connection_id not in installations:
				installations[connection_id] = row
	except Exception as exc:
		findings.append(AuditFinding("warning", f"EA installation audit fallback failed: {exc!r}"))

	summary = {
		"active_connections": len(active_connections),
		"fresh_terminal_signals": 0,
		"stale_terminal_signals": 0,
		"stuck_actions": 0,
		"pending_actions": 0,
	}

	for conn in active_connections:
		conn_id = conn.get("id")
		if not conn_id:
			continue

		if conn_id in EXCLUDED_CONNECTION_IDS:
			findings.append(AuditFinding("info", f"{conn_id[:8]}: skipped public feed connection."))
			continue

		hb = heartbeats.get(conn_id)
		installation = installations.get(conn_id)
		heartbeat_seen = _parse_iso_utc(hb.get("last_seen_at") if hb else None)
		installation_seen = _parse_iso_utc(installation.get("last_seen_at") if installation else None)
		heartbeat_age = (now - heartbeat_seen).total_seconds() if heartbeat_seen else None
		installation_age = (now - installation_seen).total_seconds() if installation_seen else None
		heartbeat_fresh = bool(
			hb
			and hb.get("mt5_initialized")
			and heartbeat_age is not None
			and heartbeat_age <= stale_heartbeat_sec
		)
		installation_fresh = bool(
			installation
			and str(installation.get("status") or "").lower() == "online"
			and installation_age is not None
			and installation_age <= stale_heartbeat_sec
		)

		if heartbeat_fresh or installation_fresh:
			summary["fresh_terminal_signals"] += 1
			if heartbeat_fresh:
				findings.append(
					AuditFinding(
						"info",
						f"{conn_id[:8]}: terminal heartbeat OK age={heartbeat_age:.0f}s pid={hb.get('pid')}",
					)
				)
			else:
				findings.append(
					AuditFinding(
						"info",
						f"{conn_id[:8]}: EA installation heartbeat OK age={installation_age:.0f}s.",
					)
				)
		else:
			summary["stale_terminal_signals"] += 1
			findings.append(
				AuditFinding(
					"critical",
					f"{conn_id[:8]}: no fresh terminal or EA heartbeat signal (> {stale_heartbeat_sec}s).",
				)
			)

		try:
			legacy_resp = (
				client.table("trade_jobs")
				.select("id,created_at,status")
				.eq("connection_id", conn_id)
				.in_("status", ["queued", "retry", "claimed", "executing"])
				.order("created_at", desc=False)
				.limit(20)
				.execute()
			)
			command_resp = (
				client.table("ea_commands")
				.select("id,created_at,status")
				.eq("connection_id", conn_id)
				.eq("status", "pending")
				.order("created_at", desc=False)
				.limit(20)
				.execute()
			)
			rows = [
				*[{**row, "source": "legacy"} for row in (legacy_resp.data or [])],
				*[{**row, "source": "ea"} for row in (command_resp.data or [])],
			]
		except Exception as exc:
			findings.append(AuditFinding("warning", f"{conn_id[:8]}: pending-action audit failed: {exc!r}"))
			continue

		for row in rows:
			summary["pending_actions"] += 1
			created_at = _parse_iso_utc(row.get("created_at"))
			if not created_at:
				continue
			age = (now - created_at).total_seconds()
			if age > queued_job_max_age_sec:
				summary["stuck_actions"] += 1
				findings.append(
					AuditFinding(
						"critical",
						f"{conn_id[:8]}: {row.get('source')} action {row.get('id')} stuck in {row.get('status')} for {age:.0f}s.",
					)
				)

	return summary


def _build_summary(findings: list[AuditFinding], connection_summary: dict, service_summary: dict) -> dict:
	info_count = sum(1 for f in findings if f.severity == "info")
	warning_count = sum(1 for f in findings if f.severity == "warning")
	critical_count = sum(1 for f in findings if f.severity == "critical")

	overall_status = "ok"
	if critical_count:
		overall_status = "critical"
	elif warning_count:
		overall_status = "warning"

	return {
		"host": socket.gethostname(),
		"overall_status": overall_status,
		"relay_ok": service_summary["relay_ok"],
		"terminal_manager_ok": service_summary["terminal_manager_ok"],
		"deprecated_processes": service_summary["deprecated_processes"],
		"info_count": info_count,
		"warning_count": warning_count,
		"critical_count": critical_count,
		"active_connections": connection_summary["active_connections"],
		"fresh_terminal_signals": connection_summary["fresh_terminal_signals"],
		"stale_terminal_signals": connection_summary["stale_terminal_signals"],
		"pending_actions": connection_summary["pending_actions"],
		"stuck_actions": connection_summary["stuck_actions"],
		"findings": [
			{"severity": f.severity, "message": f.message}
			for f in findings
			if f.severity != "info"
		],
		"emitted_at": datetime.now(timezone.utc).isoformat(),
	}


def _write_audit_event(summary: dict) -> None:
	message = (
		f"[runtime_audit] {summary['overall_status']} | "
		f"relay={'ok' if summary['relay_ok'] else 'down'} "
		f"terminal_manager={'ok' if summary['terminal_manager_ok'] else 'down'} "
		f"terminals={summary['fresh_terminal_signals']}/{summary['active_connections']} "
		f"pending={summary['pending_actions']} stuck={summary['stuck_actions']}"
	)
	try:
		db.get_client().table("mt5_runtime_events").insert({
			"connection_id": None,
			"level": "info" if summary["overall_status"] == "ok" else ("warn" if summary["overall_status"] == "warning" else "error"),
			"component": "scheduler",
			"message": message,
			"details": summary,
		}).execute()
	except Exception as exc:
		print(f"WARNING: failed to write runtime audit event: {exc!r}")


def _post_webhook(url: str, payload: dict) -> None:
	req = urlrequest.Request(
		url,
		data=json.dumps(payload).encode("utf-8"),
		headers={"Content-Type": "application/json"},
		method="POST",
	)
	with urlrequest.urlopen(req, timeout=10) as resp:
		resp.read()


def _maybe_send_alert(summary: dict) -> None:
	webhook_url = (os.environ.get("RUNTIME_ALERT_WEBHOOK_URL") or "").strip()
	if not webhook_url:
		return

	state = _load_state()
	cooldown_sec = int(os.environ.get("RUNTIME_ALERT_COOLDOWN_SEC", "900") or "900")
	last_status = state.get("last_status")
	last_alert_at = float(state.get("last_alert_at", 0) or 0)
	fingerprint = json.dumps(
		{
			"overall_status": summary["overall_status"],
			"relay_ok": summary["relay_ok"],
			"terminal_manager_ok": summary["terminal_manager_ok"],
			"stale_terminal_signals": summary["stale_terminal_signals"],
			"stuck_actions": summary["stuck_actions"],
			"findings": summary["findings"],
		},
		sort_keys=True,
	)
	should_send = False

	if summary["overall_status"] != "ok":
		if fingerprint != state.get("last_alert_fingerprint"):
			should_send = True
		elif time.time() - last_alert_at >= cooldown_sec:
			should_send = True
	elif last_status and last_status != "ok":
		should_send = True

	state["last_status"] = summary["overall_status"]

	if not should_send:
		_save_state(state)
		return

	payload = {
		"text": (
			f"IFX runtime audit: {summary['overall_status'].upper()} on {summary['host']} | "
			f"relay={'ok' if summary['relay_ok'] else 'down'} | "
			f"terminal_manager={'ok' if summary['terminal_manager_ok'] else 'down'} | "
			f"terminals={summary['fresh_terminal_signals']}/{summary['active_connections']} | "
			f"pending={summary['pending_actions']} stuck={summary['stuck_actions']}"
		),
		"summary": summary,
	}

	try:
		_post_webhook(webhook_url, payload)
		state["last_alert_at"] = time.time()
		state["last_alert_fingerprint"] = fingerprint
	except (urlerror.URLError, TimeoutError, OSError) as exc:
		print(f"WARNING: failed to send runtime alert webhook: {exc!r}")

	_save_state(state)


def main() -> int:
	parser = argparse.ArgumentParser(description="Audit IFX runtime health.")
	parser.add_argument("--stale-heartbeat-sec", type=int, default=45)
	parser.add_argument("--queued-job-max-age-sec", type=int, default=60)
	args = parser.parse_args()

	findings: list[AuditFinding] = []
	started = time.time()

	connection_summary = {
		"active_connections": 0,
		"fresh_terminal_signals": 0,
		"stale_terminal_signals": 0,
		"stuck_actions": 0,
		"pending_actions": 0,
	}
	service_summary = {
		"relay_ok": False,
		"terminal_manager_ok": False,
		"deprecated_processes": 0,
	}

	try:
		service_summary["relay_ok"] = _audit_public_relay(findings)
		service_summary["terminal_manager_ok"] = _audit_terminal_manager_host(findings)
		service_summary["deprecated_processes"] = _audit_deprecated_runtime_processes(findings)
		connection_summary = _audit_connections(findings, args.stale_heartbeat_sec, args.queued_job_max_age_sec)
	except Exception as exc:
		print(f"CRITICAL: audit failed unexpectedly: {exc!r}")
		return 2

	summary = _build_summary(findings, connection_summary, service_summary)
	_write_audit_event(summary)
	_maybe_send_alert(summary)

	severity_rank = {"info": 0, "warning": 1, "critical": 2}
	highest = max((severity_rank[f.severity] for f in findings), default=0)

	for severity in ("critical", "warning", "info"):
		for item in findings:
			if item.severity == severity:
				print(f"{severity.upper()}: {item.message}")

	duration_ms = int((time.time() - started) * 1000)
	print(f"AUDIT_DURATION_MS: {duration_ms}")

	if highest >= 2:
		return 2
	if highest == 1:
		return 1
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
