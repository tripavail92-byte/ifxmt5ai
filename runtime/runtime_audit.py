"""
runtime_audit.py
Production runtime audit for IFX MT5 services.

Purpose:
  - detect missing supervisor / relay processes
  - detect missing or stale worker heartbeats for active connections
  - detect queued trade jobs stuck too long
  - return a non-zero exit code for schedulers / watchdogs

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


def _audit_process_topology(findings: list[AuditFinding]) -> None:
	relay_procs = _find_processes("runtime/price_relay.py")
	supervisor_procs = _find_processes("main.py", "supervisor")

	if len(relay_procs) == 0:
		findings.append(AuditFinding("critical", "Relay process is not running."))
	elif len(relay_procs) > 1:
		findings.append(AuditFinding("critical", f"Multiple relay processes detected ({len(relay_procs)})."))
	else:
		findings.append(AuditFinding("info", f"Relay OK (pid={relay_procs[0].pid})."))

	if len(supervisor_procs) == 0:
		findings.append(AuditFinding("critical", "Supervisor process is not running."))
	elif len(supervisor_procs) > 1:
		findings.append(AuditFinding("critical", f"Multiple supervisor processes detected ({len(supervisor_procs)})."))
	else:
		findings.append(AuditFinding("info", f"Supervisor OK (pid={supervisor_procs[0].pid})."))


def _audit_connections(
	findings: list[AuditFinding],
	stale_heartbeat_sec: int,
	queued_job_max_age_sec: int,
) -> None:
	now = datetime.now(timezone.utc)
	active_connections = db.get_active_connections()
	heartbeats = {row.get("connection_id"): row for row in db.get_all_heartbeats()}

	client = db.get_client()
	summary = {
		"active_connections": len(active_connections),
		"fresh_heartbeats": 0,
		"stale_heartbeats": 0,
		"stuck_jobs": 0,
		"queued_jobs": 0,
	}

	for conn in active_connections:
		conn_id = conn.get("id")
		if not conn_id:
			continue

		hb = heartbeats.get(conn_id)
		if not hb:
			findings.append(AuditFinding("critical", f"{conn_id[:8]}: no worker heartbeat for active connection."))
			summary["stale_heartbeats"] += 1
			continue

		last_seen = _parse_iso_utc(hb.get("last_seen_at"))
		if not last_seen:
			findings.append(AuditFinding("critical", f"{conn_id[:8]}: heartbeat has invalid last_seen_at."))
			summary["stale_heartbeats"] += 1
			continue

		age = (now - last_seen).total_seconds()
		if age > stale_heartbeat_sec:
			summary["stale_heartbeats"] += 1
			findings.append(
				AuditFinding(
					"critical",
					f"{conn_id[:8]}: stale heartbeat age={age:.0f}s (> {stale_heartbeat_sec}s).",
				)
			)
		else:
			summary["fresh_heartbeats"] += 1
			findings.append(
				AuditFinding(
					"info",
					f"{conn_id[:8]}: worker heartbeat OK age={age:.0f}s pid={hb.get('pid')}",
				)
			)

		try:
			resp = (
				client.table("trade_jobs")
				.select("id,created_at,status")
				.eq("connection_id", conn_id)
				.in_("status", ["queued", "retry", "claimed", "executing"])
				.order("created_at", desc=False)
				.limit(20)
				.execute()
			)
			rows = resp.data or []
		except Exception as exc:
			findings.append(AuditFinding("warning", f"{conn_id[:8]}: queued-job audit failed: {exc!r}"))
			continue

		for row in rows:
			summary["queued_jobs"] += 1
			created_at = _parse_iso_utc(row.get("created_at"))
			if not created_at:
				continue
			age = (now - created_at).total_seconds()
			if age > queued_job_max_age_sec:
				summary["stuck_jobs"] += 1
				findings.append(
					AuditFinding(
						"critical",
						f"{conn_id[:8]}: job {row.get('id')} stuck in {row.get('status')} for {age:.0f}s.",
					)
				)

	return summary


def _build_summary(findings: list[AuditFinding], connection_summary: dict) -> dict:
	info_count = sum(1 for f in findings if f.severity == "info")
	warning_count = sum(1 for f in findings if f.severity == "warning")
	critical_count = sum(1 for f in findings if f.severity == "critical")

	relay_ok = not any(f.message.startswith("Relay process") or f.message.startswith("Multiple relay") for f in findings if f.severity == "critical")
	supervisor_ok = not any(f.message.startswith("Supervisor process") or f.message.startswith("Multiple supervisor") for f in findings if f.severity == "critical")

	overall_status = "ok"
	if critical_count:
		overall_status = "critical"
	elif warning_count:
		overall_status = "warning"

	return {
		"host": socket.gethostname(),
		"overall_status": overall_status,
		"relay_ok": relay_ok,
		"supervisor_ok": supervisor_ok,
		"info_count": info_count,
		"warning_count": warning_count,
		"critical_count": critical_count,
		"active_connections": connection_summary["active_connections"],
		"fresh_heartbeats": connection_summary["fresh_heartbeats"],
		"stale_heartbeats": connection_summary["stale_heartbeats"],
		"queued_jobs": connection_summary["queued_jobs"],
		"stuck_jobs": connection_summary["stuck_jobs"],
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
		f"supervisor={'ok' if summary['supervisor_ok'] else 'down'} "
		f"workers={summary['fresh_heartbeats']}/{summary['active_connections']} "
		f"queued={summary['queued_jobs']} stuck={summary['stuck_jobs']}"
	)
	try:
		db.get_client().table("mt5_runtime_events").insert({
			"connection_id": None,
			"level": "info" if summary["overall_status"] == "ok" else ("warn" if summary["overall_status"] == "warning" else "error"),
			"component": "supervisor",
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
			"supervisor_ok": summary["supervisor_ok"],
			"stale_heartbeats": summary["stale_heartbeats"],
			"stuck_jobs": summary["stuck_jobs"],
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
			f"supervisor={'ok' if summary['supervisor_ok'] else 'down'} | "
			f"workers={summary['fresh_heartbeats']}/{summary['active_connections']} | "
			f"queued={summary['queued_jobs']} stuck={summary['stuck_jobs']}"
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
		"fresh_heartbeats": 0,
		"stale_heartbeats": 0,
		"stuck_jobs": 0,
		"queued_jobs": 0,
	}

	try:
		_audit_process_topology(findings)
		connection_summary = _audit_connections(findings, args.stale_heartbeat_sec, args.queued_job_max_age_sec)
	except Exception as exc:
		print(f"CRITICAL: audit failed unexpectedly: {exc!r}")
		return 2

	summary = _build_summary(findings, connection_summary)
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
