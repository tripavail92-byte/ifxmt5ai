#!/usr/bin/env python3
import sys, os
sys.path.insert(0, 'src')
from economic_calendar.engine import EconomicCalendarEngine
from economic_calendar.cache import EventCache
from datetime import datetime

cache = EventCache('calendar_cache.db')
engine = EconomicCalendarEngine()

# Fetch from all providers - ENTIRE WEEK
print("Fetching economic events for entire week (March 23 - April 5)...")
for provider in ['fred', 'bls', 'ecb', 'ons', 'boj', 'snb', 'rba', 'boc', 'rbnz']:
    start = datetime(2026, 3, 23, 0, 0, 0)
    end = datetime(2026, 4, 5, 23, 59, 59)
    try:
        events = engine.fetch(provider, start, end)
        cache.store_events(provider, events)
        print(f"  [OK] {provider.upper()}: {len(events)} events")
    except Exception as e:
        print(f"  [ERROR] {provider.upper()}: {e}")

# Get all events for major currency pairs - HIGH and MEDIUM impacts only
results = cache.get_events(
    start_utc=datetime(2026, 3, 23, 0, 0, 0),
    end_utc=datetime(2026, 4, 5, 23, 59, 59),
    currencies=['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD'],
    impacts=['high', 'medium']
)

# Sort by date
results = sorted(results, key=lambda x: datetime.fromisoformat(x['scheduled_at_utc']))

# Print as table
print("\n" + "="*110)
print(f"{'Date':<12} {'Time':<6} {'Currency':<8} {'Impact':<8} {'Event':<60} {'Provider':<8}")
print("="*110)

by_currency = {}
for r in results:
    dt = datetime.fromisoformat(r['scheduled_at_utc'])
    date_str = dt.strftime('%Y-%m-%d')
    time_str = dt.strftime('%H:%M')
    title = r['title'][:58]
    
    curr = r['currency']
    if curr not in by_currency:
        by_currency[curr] = []
    by_currency[curr].append(r)
    
    print(f"{date_str:<12} {time_str:<6} {r['currency']:<8} {r['impact']:<8} {title:<60} {r['provider']:<8}")

print("="*110)
print(f"Total events: {len(results)}\n")

# Summary by currency
print("Summary by Currency:")
for curr in sorted(by_currency.keys()):
    count = len(by_currency[curr])
    print(f"  {curr}: {count} events")


