/**
 * mt5-state.ts — Global in-memory state for MT5 live price data (Sprint 4)
 *
 * Singleton pattern using globalThis so it survives Next.js hot reloads in dev
 * and is shared across all Route Handler invocations in the same process.
 *
 * Data flow:
 *   VPS relay  →  POST /api/mt5/ingest  →  Mt5State  →  SSE subscribers (browsers)
 *                                                      →  GET /api/candles (REST)
 *                                                      →  GET /api/prices  (REST)
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CandleBar {
  t: number;  // unix epoch seconds
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;  // tick volume
}

export interface PriceSnapshot {
  bid:   number;
  ask:   number;
  ts_ms: number;
}

export interface SseSubscriber {
  controller:  ReadableStreamDefaultController<Uint8Array>;
  connFilter?: string;  // if set, only receive events for this connection_id
}

// ─── TF aggregation map ───────────────────────────────────────────────────────

export const TF_MINUTES: Record<string, number> = {
  "1m":  1,
  "3m":  3,
  "5m":  5,
  "15m": 15,
  "30m": 30,
  "1h":  60,
  "4h":  240,
  "1d":  1440,
  "1w":  10080,
  "1mo": 43200,
};

function parseMaxBars(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(300, Math.min(n, 50_000));
}

// Default to ~7 days of 1m data per symbol. Override via MT5_CANDLE_MAXBARS.
const CANDLE_MAXBARS = parseMaxBars(process.env.MT5_CANDLE_MAXBARS, 10_000);

// ─── State class ─────────────────────────────────────────────────────────────

class Mt5State {
  // conn_id → symbol → closed 1m bars (oldest→newest, capped at CANDLE_MAXBARS)
  candles  = new Map<string, Map<string, CandleBar[]>>();
  // conn_id → symbol → current forming 1m bar
  forming  = new Map<string, Map<string, CandleBar>>();
  // conn_id → symbol → latest bid/ask
  prices   = new Map<string, Map<string, PriceSnapshot>>();
  // conn_id → symbol list
  symbols  = new Map<string, string[]>();
  // SSE subscriber set
  subscribers = new Set<SseSubscriber>();

  // ── Internal helpers ───────────────────────────────────────────────────────

  private ensureConn(connId: string) {
    if (!this.candles.has(connId))  this.candles.set(connId, new Map());
    if (!this.forming.has(connId))  this.forming.set(connId, new Map());
    if (!this.prices.has(connId))   this.prices.set(connId, new Map());
  }

  private pushCandle(connId: string, symbol: string, bar: CandleBar) {
    this.ensureConn(connId);
    const sym_map = this.candles.get(connId)!;
    let buf = sym_map.get(symbol);
    if (!buf) { buf = []; sym_map.set(symbol, buf); }

    // Avoid duplicate timestamps
    if (buf.length && buf[buf.length - 1].t === bar.t) {
      buf[buf.length - 1] = bar;  // update
    } else {
      buf.push(bar);
      if (buf.length > CANDLE_MAXBARS) buf.shift();  // evict oldest
    }
  }

  // ── Public write methods ───────────────────────────────────────────────────

  applyTickBatch(connId: string, ticks: Array<{symbol: string; bid: number; ask: number; ts_ms: number}>, formingCandles: Array<{symbol: string; time: number; open: number; high: number; low: number; close: number; tick_vol: number}>) {
    this.ensureConn(connId);
    const priceMap   = this.prices.get(connId)!;
    const formingMap = this.forming.get(connId)!;

    for (const t of ticks) {
      priceMap.set(t.symbol, { bid: t.bid, ask: t.ask, ts_ms: t.ts_ms });
    }

    // Auto-register symbols from tick/forming data
    const knownSymbols = this.symbols.get(connId) ?? [];
    const knownSet = new Set(knownSymbols);
    let updated = false;
    for (const t of ticks) {
      if (!knownSet.has(t.symbol)) { knownSymbols.push(t.symbol); knownSet.add(t.symbol); updated = true; }
    }
    for (const c of formingCandles) {
      if (!knownSet.has(c.symbol)) { knownSymbols.push(c.symbol); knownSet.add(c.symbol); updated = true; }
    }
    if (updated) this.symbols.set(connId, knownSymbols);

    const updatedSymbols: string[] = [];
    const closedBars: Array<{ symbol: string; bar: CandleBar }> = [];
    for (const c of formingCandles) {
      const bar: CandleBar = { t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.tick_vol };

      // If the EA does not send explicit candle_close messages, we can still
      // detect closes by observing the forming bar's open-time rollover.
      const prev = formingMap.get(c.symbol);
      if (prev && prev.t && bar.t && prev.t !== bar.t) {
        this.pushCandle(connId, c.symbol, prev);
        closedBars.push({ symbol: c.symbol, bar: prev });
      }

      formingMap.set(c.symbol, bar);
      updatedSymbols.push(c.symbol);
    }

    // Broadcast forming candle updates to SSE subscribers
    if (updatedSymbols.length) {
      const formingSnap: Record<string, CandleBar> = {};
      for (const sym of updatedSymbols) {
        const b = formingMap.get(sym);
        if (b) formingSnap[sym] = b;
      }
      this.broadcast({ type: "candle_update", connection_id: connId, forming: formingSnap });
    }

    // Broadcast synthetic candle closes (derived from forming rollover)
    if (closedBars.length) {
      for (const e of closedBars) {
        this.broadcast({ type: "candle_close", connection_id: connId, symbol: e.symbol, bar: e.bar });
      }
    }

    // Broadcast price updates
    if (ticks.length) {
      const snap: Record<string, PriceSnapshot> = {};
      for (const t of ticks) snap[t.symbol] = { bid: t.bid, ask: t.ask, ts_ms: t.ts_ms };
      this.broadcast({ type: "prices", connection_id: connId, prices: snap });
    }
  }

  applyCandleClose(connId: string, symbol: string, bar: CandleBar) {
    this.pushCandle(connId, symbol, bar);
    this.broadcast({ type: "candle_close", connection_id: connId, symbol, bar });
  }

  applyHistoricalBulk(connId: string, symbolsData: Array<{symbol: string; bars: Array<{t: number; o: number; h: number; l: number; c: number; v: number}>}>) {
    this.ensureConn(connId);

    const symNames = new Set(this.symbols.get(connId) ?? []);
    for (const entry of symbolsData) {
      const sym  = entry.symbol;
      const bars = entry.bars as CandleBar[];
      symNames.add(sym);

      // Seed the buffer with EA-provided history (oldest-first already)
      const sym_map = this.candles.get(connId)!;
      const existing = sym_map.get(sym) ?? [];
      const existingSet = new Set(existing.map(b => b.t));

      for (const bar of bars) {
        if (!existingSet.has(bar.t)) {
          existing.push(bar);
          existingSet.add(bar.t);
        }
      }
      // Sort by time and cap
      existing.sort((a, b) => a.t - b.t);
      sym_map.set(sym, existing.slice(-CANDLE_MAXBARS));
    }

    if (symNames.size) this.symbols.set(connId, [...symNames]);

    // Notify subscribers that history is ready
    this.broadcast({ type: "connected", connection_id: connId, symbols: [...symNames] });
  }

  // ── Read methods ───────────────────────────────────────────────────────────

  getCandles(connId: string, symbol: string, tf: string, count: number): CandleBar[] {
    const tfMin = TF_MINUTES[tf] ?? 1;

    // Try the specified conn, else MERGE bars from all connections.
    // This is critical: push_history_now.py stores under "push_script" while live
    // EA bars accumulate under the EA's UUID. We need both merged by timestamp.
    let bars1m: CandleBar[] = [];
    if (connId) {
      bars1m = this.candles.get(connId)?.get(symbol) ?? [];
    } else {
      // Merge from all connections — de-dup by timestamp (last writer wins)
      const merged = new Map<number, CandleBar>();
      for (const [, symMap] of this.candles) {
        const b = symMap.get(symbol);
        if (b) {
          for (const bar of b) merged.set(bar.t, bar);
        }
      }
      bars1m = [...merged.values()].sort((a, b) => a.t - b.t);
    }

    const aggregated = this.aggregate(bars1m, tfMin);

    // Append forming candle (if it belongs to this TF's current slot)
    const formingBar = this.getFormingBar(connId, symbol, tfMin);
    if (formingBar) {
      const last = aggregated[aggregated.length - 1];
      if (!last || last.t < formingBar.t) {
        aggregated.push(formingBar);
      } else if (last.t === formingBar.t) {
        aggregated[aggregated.length - 1] = formingBar;
      }
    }

    return count < aggregated.length ? aggregated.slice(-count) : aggregated;
  }

  private getFormingBar(connId: string, symbol: string, tfMin: number): CandleBar | null {
    const b = this.forming.get(connId)?.get(symbol);
    if (!b) {
      // Search all connections
      for (const [, formMap] of this.forming) {
        const f = formMap.get(symbol);
        if (f) return this.snapToTfSlot(f, tfMin);
      }
      return null;
    }
    return this.snapToTfSlot(b, tfMin);
  }

  private snapToTfSlot(bar: CandleBar, tfMin: number): CandleBar {
    const slotSec = tfMin * 60;
    return { ...bar, t: Math.floor(bar.t / slotSec) * slotSec };
  }

  aggregate(bars1m: CandleBar[], tfMin: number): CandleBar[] {
    if (tfMin === 1) return [...bars1m];
    const slotSec = tfMin * 60;
    const result: CandleBar[] = [];

    for (const b of bars1m) {
      const slot = Math.floor(b.t / slotSec) * slotSec;
      const last = result[result.length - 1];
      if (last && last.t === slot) {
        last.h = Math.max(last.h, b.h);
        last.l = Math.min(last.l, b.l);
        last.c = b.c;
        last.v += b.v;
      } else {
        result.push({ t: slot, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
      }
    }
    return result;
  }

  getPrices(connId?: string): Record<string, PriceSnapshot> {
    const out: Record<string, PriceSnapshot> = {};
    if (connId) {
      const m = this.prices.get(connId);
      if (m) m.forEach((v, k) => { out[k] = v; });
    } else {
      this.prices.forEach(m => m.forEach((v, k) => { out[k] = v; }));
    }
    return out;
  }

  getSymbols(connId?: string): string[] {
    if (connId) {
      const syms = new Set<string>(this.symbols.get(connId) ?? []);
      this.prices.get(connId)?.forEach((_, key) => syms.add(key));
      return [...syms];
    }
    const syms = new Set<string>();
    this.symbols.forEach(list => list.forEach(s => syms.add(s)));
    this.prices.forEach(m => m.forEach((_, k) => syms.add(k)));
    return [...syms];
  }

  // ── SSE broadcast ──────────────────────────────────────────────────────────

  broadcast(payload: object) {
    // Include event name so EventSource.addEventListener(type, ...) works
    const type = (payload as { type?: string }).type ?? "message";
    const line = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    const encoded = new TextEncoder().encode(line);
    const dead: SseSubscriber[] = [];

    for (const sub of this.subscribers) {
      try {
        sub.controller.enqueue(encoded);
      } catch {
        dead.push(sub);
      }
    }
    for (const sub of dead) this.subscribers.delete(sub);
  }

  addSubscriber(sub: SseSubscriber) {
    this.subscribers.add(sub);
  }

  removeSubscriber(sub: SseSubscriber) {
    this.subscribers.delete(sub);
  }

  get subscriberCount() {
    return this.subscribers.size;
  }
}

// ─── Singleton (survives HMR in dev) ─────────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __mt5State: Mt5State | undefined;
}

export const mt5State: Mt5State =
  globalThis.__mt5State ?? (globalThis.__mt5State = new Mt5State());
