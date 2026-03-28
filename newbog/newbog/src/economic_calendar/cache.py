from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from economic_calendar.models import EconomicEvent


class EventCache:
    """SQLite cache for storing raw payloads and normalized events."""

    def __init__(self, db_path: str | Path = "calendar_cache.db") -> None:
        self.db_path = Path(db_path)
        self._init_schema()

    def _init_schema(self) -> None:
        """Create tables if they don't exist."""
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS raw_payloads (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    provider TEXT NOT NULL,
                    fetched_at TEXT NOT NULL,
                    start_utc TEXT NOT NULL,
                    end_utc TEXT NOT NULL,
                    raw_json TEXT NOT NULL,
                    UNIQUE(provider, fetched_at, start_utc, end_utc)
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS normalized_events (
                    id TEXT PRIMARY KEY,
                    provider TEXT NOT NULL,
                    country TEXT NOT NULL,
                    currency TEXT NOT NULL,
                    title TEXT NOT NULL,
                    event_code TEXT NOT NULL,
                    scheduled_at_utc TEXT NOT NULL,
                    impact TEXT NOT NULL,
                    cached_at TEXT NOT NULL,
                    event_json TEXT NOT NULL,
                    UNIQUE(id, provider)
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS compare_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_at TEXT NOT NULL,
                    providers TEXT NOT NULL,
                    start_utc TEXT NOT NULL,
                    end_utc TEXT NOT NULL,
                    currencies TEXT NOT NULL,
                    impacts TEXT NOT NULL,
                    result_json TEXT NOT NULL
                )
                """
            )
            conn.commit()

    def store_raw_payload(
        self, provider: str, start_utc: datetime, end_utc: datetime, payload: Any
    ) -> None:
        """Store raw API response."""
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO raw_payloads 
                (provider, fetched_at, start_utc, end_utc, raw_json)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    provider,
                    datetime.now(timezone.utc).isoformat(),
                    start_utc.isoformat(),
                    end_utc.isoformat(),
                    json.dumps(payload, default=str),
                ),
            )
            conn.commit()

    def store_events(self, provider: str, events: list[EconomicEvent]) -> None:
        """Store normalized events."""
        now = datetime.now(timezone.utc).isoformat()
        with sqlite3.connect(self.db_path) as conn:
            for event in events:
                conn.execute(
                    """
                    INSERT OR REPLACE INTO normalized_events
                    (id, provider, country, currency, title, event_code, scheduled_at_utc, impact, cached_at, event_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        event.id,
                        provider,
                        event.country,
                        event.currency,
                        event.title,
                        event.event_code,
                        event.scheduled_at_utc.isoformat(),
                        event.impact.value,
                        now,
                        json.dumps(event.to_dict()),
                    ),
                )
            conn.commit()

    def get_events(
        self,
        start_utc: datetime | None = None,
        end_utc: datetime | None = None,
        currencies: list[str] | None = None,
        impacts: list[str] | None = None,
        providers: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Retrieve cached events with optional filters."""
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            query = "SELECT * FROM normalized_events WHERE 1=1"
            params = []

            if start_utc:
                query += " AND scheduled_at_utc >= ?"
                params.append(start_utc.isoformat())

            if end_utc:
                query += " AND scheduled_at_utc <= ?"
                params.append(end_utc.isoformat())

            if currencies:
                placeholders = ",".join("?" * len(currencies))
                query += f" AND currency IN ({placeholders})"
                params.extend(currencies)

            if impacts:
                placeholders = ",".join("?" * len(impacts))
                query += f" AND impact IN ({placeholders})"
                params.extend(impacts)

            if providers:
                placeholders = ",".join("?" * len(providers))
                query += f" AND provider IN ({placeholders})"
                params.extend(providers)

            query += " ORDER BY scheduled_at_utc"

            cursor = conn.execute(query, params)
            return [dict(row) for row in cursor.fetchall()]

    def store_compare_run(
        self,
        providers: list[str],
        start_utc: datetime,
        end_utc: datetime,
        currencies: list[str],
        impacts: list[str],
        result: list[dict[str, Any]],
    ) -> None:
        """Store comparison run results."""
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                INSERT INTO compare_runs
                (run_at, providers, start_utc, end_utc, currencies, impacts, result_json)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    datetime.now(timezone.utc).isoformat(),
                    ",".join(providers),
                    start_utc.isoformat(),
                    end_utc.isoformat(),
                    ",".join(currencies),
                    ",".join(impacts),
                    json.dumps(result, default=str),
                ),
            )
            conn.commit()
