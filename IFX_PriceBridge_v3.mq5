//+------------------------------------------------------------------+
//|  IFX_PriceBridge_v3.mq5                                         |
//|  Industrial-grade multi-symbol tick bridge for IFX terminal      |
//|  Architecture: OnTick() + EventSetMillisecondTimer(50)           |
//|  Target: Railway cloud ingest (/api/mt5)                         |
//|                                                                  |
//|  SETUP: In MT5 -> Tools -> Options -> Expert Advisors            |
//|    Add https://ifx-mt5-ingest-production.up.railway.app to the   |
//|    "Allow WebRequest for listed URL" list.                      |
//|    BackendRelayUrl should point to the /api/mt5 base path.       |
//+------------------------------------------------------------------+
#property strict
#property version   "3.0"
#property description "IFX Price Bridge v3 - Multi-symbol tick relay -> Railway cloud ingest"

//==========================================================================
// SECTION 1 — INPUTS
//==========================================================================
input string  BackendRelayUrl      = "https://ifx-mt5-ingest-production.up.railway.app/api/mt5"; // Railway ingest base URL
input string  ConnectionId         = "200beae4-553b-4607-8653-8a15e5699865"; // Your MT5 connection UUID
input string  SigningSecret        = "ZoySwg4Mbjc+QtqnNEJc0QuUzaPWoYsgiUBJUji4gJ4="; // Must match Railway RELAY_SECRET
input int     TickBatchMs          = 250;                        // Active symbol snapshot flush interval (ms)
input int     WatchlistTickBatchMs = 500;                        // Watchlist symbol snapshot flush interval (ms)
input string  ActiveSymbolsCsv     = "EURUSDm,XAUUSDm,USDJPYm,AUDUSDm,USOILm,GBPUSDm,BTCUSDm,ETHUSDm,USDCHFm,USDCADm,NZDUSDm,EURGBPm"; // Preferred high-rate symbols (max 12); attached chart symbol is always active
input bool    LatestTickOnlyPerFlush = true;                    // Keep only the newest tick per symbol in each flush window
input int     HistoricalBarsOnInit = 500;                        // 1m bars to push on startup
input int     ConfigRefreshSec     = 60;                         // Symbol list refresh interval
input int     HistoryRepairBars    = 240;                        // Recent 1m bars to re-push when candle-close uploads stall
input int     HistoryRepairCooldownSec = 120;                    // Minimum delay between per-symbol repair attempts
input int     HistoryRepairTriggerMissedBars = 3;                // Re-push history after this many closed bars are missing

//==========================================================================
// SECTION 2 — GLOBALS
//==========================================================================

// Parallel arrays for per-symbol state (MQL5 structs can't hold dynamic arrays)
string   g_sym_names[];         // Symbol names
int      g_sym_digits[];        // Decimal places
long     g_sym_last_tick_msc[]; // Last tick time_msc (ms precision)
datetime g_sym_last_bar[];      // Last completed 1m bar open-time
datetime g_sym_last_uploaded_close[]; // Last closed 1m bar confirmed sent to relay
ulong    g_sym_last_repair_ms[];      // Last per-symbol history repair attempt timestamp

int      g_sym_count     = 0;
ulong    g_last_flush_ms = 0;
ulong    g_last_watchlist_flush_ms = 0;
ulong    g_last_config_ms= 0;
ulong    g_last_health_ms = 0;  // Last /health check timestamp
int      g_relay_uptime_prev = -2; // -2=first-run  -1=was-down  >=0=last-uptime
bool     g_historical_seeded = false; // true once /historical-bulk succeeds

#define CLOSE_REPAIR_RETRY_MS 5000

#define MAX_ACTIVE_SYMBOLS 12

string   g_active_symbols[];
int      g_active_symbol_count = 0;

// Pending per-symbol snapshots let us emit active-chart symbols more often
// than watchlist symbols while still sending only the latest price per symbol.
double  g_pending_bid[];
double  g_pending_ask[];
long    g_pending_msc[];
bool    g_pending_dirty[];

string TrimSpaces(const string value)
{
   string trimmed = value;
   StringReplace(trimmed, " ", "");
   return trimmed;
}

bool ActiveArrayContains(const string sym)
{
   for(int i = 0; i < g_active_symbol_count; i++)
      if(g_active_symbols[i] == sym)
         return true;
   return false;
}

void LoadPreferredActiveSymbols()
{
   string cleaned = TrimSpaces(ActiveSymbolsCsv);
   ArrayResize(g_active_symbols, 0);
   g_active_symbol_count = 0;

   if(StringLen(cleaned) == 0)
   {
      Print("ℹ️ [ACTIVE] no preferred symbols configured; chart symbol stays high-rate");
      return;
   }

   string parts[];
   int count = StringSplit(cleaned, ',', parts);
   for(int i = 0; i < count; i++)
   {
      string sym = TrimSpaces(parts[i]);
      if(StringLen(sym) == 0)
         continue;
      if(ActiveArrayContains(sym))
         continue;
      if(g_active_symbol_count >= MAX_ACTIVE_SYMBOLS)
      {
         Print("⚠️ [ACTIVE] max preferred symbols is ", MAX_ACTIVE_SYMBOLS, "; ignoring extra symbol ", sym);
         continue;
      }

      ArrayResize(g_active_symbols, g_active_symbol_count + 1);
      g_active_symbols[g_active_symbol_count++] = sym;
   }

   if(g_active_symbol_count == 0)
   {
      Print("ℹ️ [ACTIVE] no valid preferred symbols configured; chart symbol stays high-rate");
      return;
   }

   string finalCsv = "";
   for(int i = 0; i < g_active_symbol_count; i++)
   {
      if(i > 0) finalCsv += ",";
      finalCsv += g_active_symbols[i];
   }
   Print("✅ [ACTIVE] preferred high-rate symbols (", g_active_symbol_count, "/", MAX_ACTIVE_SYMBOLS, "): ", finalCsv);
}

bool IsActiveSymbol(const string sym)
{
   if(sym == _Symbol)
      return true;
   return ActiveArrayContains(sym);
}

int RepairBarsToSend()
{
   int requested = HistoryRepairBars;
   if(requested <= 0)
      requested = HistoricalBarsOnInit;
   if(requested <= 0)
      requested = 120;
   return requested;
}

//==========================================================================
// SECTION 3 — INIT / DEINIT
//==========================================================================
int OnInit()
{
   Print("=== IFX Price Bridge v3.0 ===");
   Print("Relay: ", BackendRelayUrl, " (must be whitelisted in MT5 Options -> Expert Advisors)");
   Print("ConnectionId: ", ConnectionId);
   LoadPreferredActiveSymbols();

   // Fetch symbol list from relay (GET /config)
   // Falls back to hardcoded defaults if relay not yet running
   FetchConfig();

   // Push 500 × 1m historical bars per symbol (blocking on init)
   PushHistoricalBulk();

   // 50ms millisecond timer — polls all symbols for new ticks
   // OnTick() ONLY fires for chart symbol; this covers all others
   EventSetMillisecondTimer(50);

   g_last_flush_ms  = GetTickCount64();
   g_last_watchlist_flush_ms = g_last_flush_ms;
   g_last_config_ms = GetTickCount64();
   g_last_health_ms = GetTickCount64();

   Print("✅ Started. Monitoring ", g_sym_count, " symbols");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   Comment("");
   Print("IFX Price Bridge v3 stopped. Reason: ", reason);
}

//==========================================================================
// SECTION 4 — TICK + TIMER HANDLERS
//==========================================================================

// OnTick fires immediately for the chart symbol — use it as a bonus fast path
void OnTick()
{
   PollAllSymbols();
}

// 50ms timer fires for all other symbols
void OnTimer()
{
   PollAllSymbols();

   // Config refresh
   ulong now_ms = GetTickCount64();
   if(now_ms - g_last_config_ms >= (ulong)ConfigRefreshSec * 1000)
   {
      FetchConfig();
      g_last_config_ms = now_ms;
   }

   // Relay restart detection — every 10s
   if(now_ms - g_last_health_ms >= 10000)
   {
      CheckRelayRestart();
      g_last_health_ms = now_ms;
   }
}

//==========================================================================
// SECTION 5 — CORE: POLL + BATCH + FLUSH
//==========================================================================
void PollAllSymbols()
{
   ulong now_ms = GetTickCount64();

   for(int i = 0; i < g_sym_count; i++)
   {
      MqlTick tick;
      if(!SymbolInfoTick(g_sym_names[i], tick))
         continue;

      // Only process if this is a genuinely new tick (time_msc advanced)
      if(tick.time_msc <= g_sym_last_tick_msc[i])
         continue;

      g_sym_last_tick_msc[i] = tick.time_msc;

      g_pending_bid[i] = tick.bid;
      g_pending_ask[i] = tick.ask;
      g_pending_msc[i] = tick.time_msc;
      g_pending_dirty[i] = true;

      // Bar detection uses CopyRates directly so off-chart symbols rely on the
      // same synchronized series source as the forming candle snapshots.
      MqlRates live_rates[];
      ArraySetAsSeries(live_rates, true);
      int live_copied = CopyRates(g_sym_names[i], PERIOD_M1, 0, 2, live_rates);
      if(live_copied > 0)
      {
         datetime current_bar = live_rates[0].time;
         datetime latest_closed_bar = (live_copied > 1) ? live_rates[1].time : 0;
         if(g_sym_last_bar[i] == 0)
         {
            g_sym_last_bar[i] = current_bar;
         }
         else if(current_bar > g_sym_last_bar[i])
         {
            bool advanced_bar = false;
            if(live_copied > 1)
            {
               if(SendCandleCloseBar(g_sym_names[i], i, live_rates[1]))
               {
                  advanced_bar = true;
               }
               else if(now_ms - g_sym_last_repair_ms[i] >= CLOSE_REPAIR_RETRY_MS)
               {
                  g_sym_last_repair_ms[i] = now_ms;
                  Print("🔄 [RECOVER] ", g_sym_names[i], " candle-close failed — pushing recent history before advancing bar state");
                  if(PushHistoricalBulkSymbol(i, RepairBarsToSend()))
                  {
                     g_historical_seeded = true;
                     advanced_bar = true;
                  }
               }
            }

            if(advanced_bar)
               g_sym_last_bar[i] = current_bar;
         }

         if(latest_closed_bar > 0
            && HistoryRepairTriggerMissedBars > 0
            && HistoryRepairCooldownSec > 0
            && RepairBarsToSend() > 0)
         {
            datetime last_uploaded = g_sym_last_uploaded_close[i];
            int missingBars = (last_uploaded > 0) ? (int)((latest_closed_bar - last_uploaded) / 60) : HistoryRepairTriggerMissedBars;
            if(missingBars >= HistoryRepairTriggerMissedBars)
            {
               ulong cooldown_ms = (ulong)HistoryRepairCooldownSec * 1000;
               if(now_ms - g_sym_last_repair_ms[i] >= cooldown_ms)
               {
                  g_sym_last_repair_ms[i] = now_ms;
                  Print("🔄 [REPAIR] ", g_sym_names[i], " missing ", missingBars, " closed bars — re-pushing recent history");
                  if(PushHistoricalBulkSymbol(i, RepairBarsToSend()))
                     g_historical_seeded = true;
               }
            }
         }
      }
   }

   // Flush active symbols more frequently than the broader watchlist.
   if(now_ms - g_last_flush_ms >= (ulong)MathMax(TickBatchMs, 50))
   {
      FlushTickBatch(now_ms, true);
      g_last_flush_ms = now_ms;
   }

   if(now_ms - g_last_watchlist_flush_ms >= (ulong)MathMax(WatchlistTickBatchMs, TickBatchMs))
   {
      FlushTickBatch(now_ms, false);
      g_last_watchlist_flush_ms = now_ms;
   }
}

//==========================================================================
// SECTION 6 — FLUSH: BUILD JSON AND POST TO RELAY
//==========================================================================
void FlushTickBatch(ulong now_ms, bool activeSymbols)
{
   // Build JSON: ticks array + forming_candles array for either the active
   // chart symbols or the lower-priority watchlist symbols.

   string json = "{";
   json += "\"connection_id\":\"" + ConnectionId + "\",";
   json += "\"ts_ms\":" + IntegerToString((long)now_ms) + ",";

   int sentIdx[];
   int sentCount = 0;

   // --- ticks ---
   json += "\"ticks\":[";
   int tickCount = 0;
   for(int i = 0; i < g_sym_count; i++)
   {
      if(IsActiveSymbol(g_sym_names[i]) != activeSymbols)
         continue;
      if(!g_pending_dirty[i])
         continue;

      if(tickCount > 0) json += ",";
      int d = g_sym_digits[i];
      json += "{";
      json += "\"symbol\":\"" + g_sym_names[i] + "\",";
      json += "\"bid\":"     + DoubleToString(g_pending_bid[i], d) + ",";
      json += "\"ask\":"     + DoubleToString(g_pending_ask[i], d) + ",";
      json += "\"ts_ms\":"   + IntegerToString(g_pending_msc[i]);
      json += "}";

      ArrayResize(sentIdx, sentCount + 1);
      sentIdx[sentCount++] = i;
      tickCount++;
   }
   json += "],";

   // --- forming_candles (current live bar, index 0) ---
   // Read once per flush — one CopyRates per symbol
   json += "\"forming_candles\":[";
   int added = 0;
   for(int i = 0; i < g_sym_count; i++)
   {
      if(IsActiveSymbol(g_sym_names[i]) != activeSymbols)
         continue;

      MqlRates r[];
      ArraySetAsSeries(r, true);
      if(CopyRates(g_sym_names[i], PERIOD_M1, 0, 1, r) <= 0)
         continue;

      int d = g_sym_digits[i];
      if(added > 0) json += ",";
      json += "{";
      json += "\"symbol\":\""  + g_sym_names[i]                          + "\",";
      json += "\"time\":"      + IntegerToString((long)r[0].time)         + ",";
      json += "\"open\":"      + DoubleToString(r[0].open,   d)           + ",";
      json += "\"high\":"      + DoubleToString(r[0].high,   d)           + ",";
      json += "\"low\":"       + DoubleToString(r[0].low,    d)           + ",";
      json += "\"close\":"     + DoubleToString(r[0].close,  d)           + ",";
      json += "\"tick_vol\":"  + IntegerToString(r[0].tick_volume);
      json += "}";
      added++;
   }
   json += "]}";

   // Only POST if there are symbols in this group.
   if(added == 0)
      return;

   if(SignedPost("/tick-batch", json, 3000))
   {
      for(int i = 0; i < sentCount; i++)
         g_pending_dirty[sentIdx[i]] = false;
   }
}

// Send a single completed bar (called immediately when bar closes)
bool SendCandleCloseBar(const string symbol, int sym_idx, const MqlRates &bar)
{
   int d = g_sym_digits[sym_idx];
   string json = "{";
   json += "\"connection_id\":\"" + ConnectionId + "\",";
   json += "\"symbol\":\""        + symbol                        + "\",";
   json += "\"timeframe\":\"1m\",";
   json += "\"time\":"            + IntegerToString((long)bar.time) + ",";
   json += "\"open\":"            + DoubleToString(bar.open,  d)    + ",";
   json += "\"high\":"            + DoubleToString(bar.high,  d)    + ",";
   json += "\"low\":"             + DoubleToString(bar.low,   d)    + ",";
   json += "\"close\":"           + DoubleToString(bar.close, d)    + ",";
   json += "\"tick_vol\":"        + IntegerToString(bar.tick_volume);
   json += "}";

   if(SignedPost("/candle-close", json, 3000))
   {
      g_sym_last_uploaded_close[sym_idx] = bar.time;
      Print("✅ [", symbol, "] candle-close T=", TimeToString(bar.time));
      return true;
   }
   else
   {
      Print("⚠️ [", symbol, "] candle-close POST failed");
   }

   return false;
}

// Send a single completed bar (fallback helper)
void SendCandleClose(const string symbol, int sym_idx)
{
   MqlRates r[];
   ArraySetAsSeries(r, true);
   // index 1 = bar that just closed (index 0 is the new forming bar)
   if(CopyRates(symbol, PERIOD_M1, 1, 1, r) <= 0)
      return;

   SendCandleCloseBar(symbol, sym_idx, r[0]);
}

//==========================================================================
// SECTION 7 — HISTORICAL BULK PUSH (called once from OnInit)
//==========================================================================
bool PushHistoricalBulkSymbol(const int sym_idx, int barsRequested)
{
   if(sym_idx < 0 || sym_idx >= g_sym_count)
      return false;

   if(barsRequested <= 0)
      barsRequested = HistoricalBarsOnInit;
   if(barsRequested <= 0)
      return false;

   MqlRates r[];
   ArraySetAsSeries(r, true);
   int copied = CopyRates(g_sym_names[sym_idx], PERIOD_M1, 1, barsRequested, r);
   if(copied <= 0)
   {
      Print("⚠️ [", g_sym_names[sym_idx], "] CopyRates returned 0 bars, skipping");
      return false;
   }

   int d = g_sym_digits[sym_idx];
   string json = "{";
   json += "\"connection_id\":\"" + ConnectionId + "\",";
   json += "\"bars_requested\":"  + IntegerToString(barsRequested) + ",";
   json += "\"symbols\":[{";
   json += "\"symbol\":\"" + g_sym_names[sym_idx] + "\",\"bars\":[";

   for(int j = copied - 1; j >= 0; j--)
   {
      if(j < copied - 1) json += ",";
      json += "{";
      json += "\"t\":"  + IntegerToString((long)r[j].time)     + ",";
      json += "\"o\":"  + DoubleToString(r[j].open,  d)         + ",";
      json += "\"h\":"  + DoubleToString(r[j].high,  d)         + ",";
      json += "\"l\":"  + DoubleToString(r[j].low,   d)         + ",";
      json += "\"c\":"  + DoubleToString(r[j].close, d)         + ",";
      json += "\"v\":"  + IntegerToString(r[j].tick_volume);
      json += "}";
   }
   json += "]}]}";

   Print("  [", g_sym_names[sym_idx], "] ", copied, " bars ready");

   if(SignedPost("/historical-bulk", json, 15000))
   {
      g_sym_last_uploaded_close[sym_idx] = r[0].time;
      g_sym_last_repair_ms[sym_idx] = GetTickCount64();
      Print("✅ [", g_sym_names[sym_idx], "] historical bulk pushed");
      return true;
   }

   Print("⚠️ [", g_sym_names[sym_idx], "] historical bulk POST failed");
   return false;
}

void PushHistoricalBulk()
{
   if(g_sym_count == 0)
   {
      g_historical_seeded = false;
      return;
   }

   Print("📦 Pushing ", HistoricalBarsOnInit, " × 1m historical bars for ", g_sym_count, " symbols...");

   int sym_added = 0;
   int sym_succeeded = 0;
   for(int i = 0; i < g_sym_count; i++)
   {
      sym_added++;
      if(PushHistoricalBulkSymbol(i, HistoricalBarsOnInit))
         sym_succeeded++;
   }

   if(sym_added == 0)
   {
      Print("❌ Historical push: no symbols had data");
      g_historical_seeded = false;
      return;
   }

   if(sym_succeeded == sym_added)
   {
      g_historical_seeded = true;
      Print("✅ Historical bulk pushed: ", sym_succeeded, "/", sym_added, " symbols");
   }
   else
   {
      g_historical_seeded = false;
      Print("❌ Historical bulk incomplete: ", sym_succeeded, "/", sym_added, " symbols pushed");
   }
}

//==========================================================================
// SECTION 7b — RELAY RESTART DETECTION
// Calls GET /health every 10s; if uptime_s drops (relay restarted) or relay
// was previously unreachable, re-pushes the full 500-bar history.
//==========================================================================
void CheckRelayRestart()
{
   string url = BackendRelayUrl + "/health";
   uchar  emptyData[];
   ArrayResize(emptyData, 0);
   uchar  result[];
   string resultHeaders = "";

   ResetLastError();
   int status = WebRequest("GET", url, "", 3000, emptyData, result, resultHeaders);

   if(status != 200)
   {
      // Relay is down — remember so next success triggers re-push
      if(g_relay_uptime_prev != -1)
         Print("⚠️ [HEALTH] relay unreachable (HTTP ", status, ") — will re-push history when it returns");
      g_relay_uptime_prev = -1;
      return;
   }

   // Parse uptime_s from JSON response
   string resp = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   int pos = StringFind(resp, "\"uptime_s\":");
   if(pos < 0) return;

   string after = StringSubstr(resp, pos + 11);
   string numStr = "";
   for(int i = 0; i < MathMin(StringLen(after), 20); i++)
   {
      ushort ch = StringGetCharacter(after, i);
      if(ch >= '0' && ch <= '9')
      {
         uchar c[] = {(uchar)ch};
         numStr += CharArrayToString(c);
      }
      else if(StringLen(numStr) > 0)
         break;
   }
   int uptime = (int)StringToDouble(numStr);

   if(g_relay_uptime_prev == -2)
   {
      // First health check after EA init.
      // If init push failed (relay not up yet), seed history now.
      g_relay_uptime_prev = uptime;
      if(!g_historical_seeded)
      {
         Print("🔄 [HEALTH] relay reachable (uptime=", uptime, "s) but history not seeded — pushing now");
         PushHistoricalBulk();
      }
      else
      {
         Print("🔗 [HEALTH] relay baseline uptime=", uptime, "s");
      }
   }
   else if(g_relay_uptime_prev == -1)
   {
      // Relay was down, now back — re-push history
      Print("🔄 [HEALTH] relay back online (uptime=", uptime, "s) — re-pushing history");
      g_relay_uptime_prev = uptime;
      PushHistoricalBulk();
   }
   else if(uptime < g_relay_uptime_prev)
   {
      // Uptime reset — relay restarted
      Print("🔄 [HEALTH] relay restarted (uptime ", g_relay_uptime_prev, "→", uptime, "s) — re-pushing history");
      g_relay_uptime_prev = uptime;
      PushHistoricalBulk();
   }
   else
   {
      g_relay_uptime_prev = uptime;
      if(!g_historical_seeded)
      {
         Print("🔄 [HEALTH] history still not seeded — retrying historical push");
         PushHistoricalBulk();
      }
   }
}

//==========================================================================
// SECTION 8 — CONFIG FETCH (GET /config from relay)
//==========================================================================
void FetchConfig()
{
   string url = BackendRelayUrl + "/config";
   uchar emptyData[];
   ArrayResize(emptyData, 0);
   uchar result[];
   string resultHeaders = "";

   ResetLastError();
   int status = WebRequest("GET", url, "", 3000, emptyData, result, resultHeaders);

   if(status != 200)
   {
      int err = GetLastError();
      Print("⚠️ [CONFIG] relay unreachable (HTTP ", status, ", error=", err, ") — using defaults");
      InitDefaultSymbols();
      return;
   }

   string resp = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);

   // Simple JSON parse for "symbols" array
   // Expected: {"symbols":["EURUSDm","GBPUSDm",...]}
   int arr_start = StringFind(resp, "[");
   int arr_end   = StringFind(resp, "]");
   if(arr_start < 0 || arr_end < 0 || arr_end <= arr_start)
   {
      Print("⚠️ [CONFIG] bad response format, using defaults");
      InitDefaultSymbols();
      return;
   }

   string arr_content = StringSubstr(resp, arr_start + 1, arr_end - arr_start - 1);
   StringReplace(arr_content, "\"", "");
   StringReplace(arr_content, " ",  "");

   // Split by comma
   string parsed[];
   int count = 0;

   string remaining = arr_content;
   while(true)
   {
      int comma = StringFind(remaining, ",");
      string sym;
      if(comma < 0)
      {
         sym = remaining;
         if(StringLen(sym) > 0)
         {
            ArrayResize(parsed, count + 1);
            parsed[count++] = sym;
         }
         break;
      }
      sym = StringSubstr(remaining, 0, comma);
      if(StringLen(sym) > 0)
      {
         ArrayResize(parsed, count + 1);
         parsed[count++] = sym;
      }
      remaining = StringSubstr(remaining, comma + 1);
   }

   if(count == 0)
   {
      Print("⚠️ [CONFIG] parsed 0 symbols, using defaults");
      InitDefaultSymbols();
      return;
   }

   ApplySymbolList(parsed, count);
   Print("✅ [CONFIG] ", count, " symbols from relay");
}

void InitDefaultSymbols()
{
   // Hardcoded fallback — same list as the old EA
   string defaults[] = {
      "EURUSDm","GBPUSDm","USDJPYm","USDCADm","AUDUSDm",
      "NZDUSDm","USDCHFm","EURGBPm","XAUUSDm","BTCUSDm",
      "ETHUSDm","USOILm"
   };
   ApplySymbolList(defaults, ArraySize(defaults));
   Print("ℹ️ [CONFIG] using ", ArraySize(defaults), " default symbols (relay not running)");
}

void ApplySymbolList(const string &syms[], int count)
{
   string   prev_names[];
   int      prev_digits[];
   long     prev_last_tick_msc[];
   datetime prev_last_bar[];
   datetime prev_last_uploaded_close[];
   double   prev_pending_bid[];
   double   prev_pending_ask[];
   long     prev_pending_msc[];
   bool     prev_pending_dirty[];
   ulong    prev_last_repair_ms[];
   int      prev_count = g_sym_count;

   ArrayResize(prev_names, prev_count);
   ArrayResize(prev_digits, prev_count);
   ArrayResize(prev_last_tick_msc, prev_count);
   ArrayResize(prev_last_bar, prev_count);
   ArrayResize(prev_last_uploaded_close, prev_count);
   ArrayResize(prev_pending_bid, prev_count);
   ArrayResize(prev_pending_ask, prev_count);
   ArrayResize(prev_pending_msc, prev_count);
   ArrayResize(prev_pending_dirty, prev_count);
   ArrayResize(prev_last_repair_ms, prev_count);

   for(int i = 0; i < prev_count; i++)
   {
      prev_names[i] = g_sym_names[i];
      prev_digits[i] = g_sym_digits[i];
      prev_last_tick_msc[i] = g_sym_last_tick_msc[i];
      prev_last_bar[i] = g_sym_last_bar[i];
      prev_last_uploaded_close[i] = g_sym_last_uploaded_close[i];
      prev_pending_bid[i] = g_pending_bid[i];
      prev_pending_ask[i] = g_pending_ask[i];
      prev_pending_msc[i] = g_pending_msc[i];
      prev_pending_dirty[i] = g_pending_dirty[i];
      prev_last_repair_ms[i] = g_sym_last_repair_ms[i];
   }

   ArrayResize(g_sym_names,          count);
   ArrayResize(g_sym_digits,         count);
   ArrayResize(g_sym_last_tick_msc,  count);
   ArrayResize(g_sym_last_bar,       count);
   ArrayResize(g_sym_last_uploaded_close, count);
   ArrayResize(g_pending_bid,        count);
   ArrayResize(g_pending_ask,        count);
   ArrayResize(g_pending_msc,        count);
   ArrayResize(g_pending_dirty,      count);
   ArrayResize(g_sym_last_repair_ms, count);

   int valid = 0;
   for(int i = 0; i < count; i++)
   {
      string s = syms[i];
      if(!SymbolSelect(s, true))
      {
         Print("⚠️ [CONFIG] symbol not available: ", s);
         continue;
      }

      int prev_idx = -1;
      for(int j = 0; j < prev_count; j++)
      {
         if(prev_names[j] == s)
         {
            prev_idx = j;
            break;
         }
      }

      g_sym_names[valid]         = s;
      g_sym_digits[valid]        = (int)SymbolInfoInteger(s, SYMBOL_DIGITS);
      g_sym_last_tick_msc[valid] = (prev_idx >= 0) ? prev_last_tick_msc[prev_idx] : 0;
      g_sym_last_bar[valid]      = (prev_idx >= 0) ? prev_last_bar[prev_idx] : 0;
      g_sym_last_uploaded_close[valid] = (prev_idx >= 0) ? prev_last_uploaded_close[prev_idx] : 0;
      g_pending_bid[valid]       = (prev_idx >= 0) ? prev_pending_bid[prev_idx] : 0.0;
      g_pending_ask[valid]       = (prev_idx >= 0) ? prev_pending_ask[prev_idx] : 0.0;
      g_pending_msc[valid]       = (prev_idx >= 0) ? prev_pending_msc[prev_idx] : 0;
      g_pending_dirty[valid]     = (prev_idx >= 0) ? prev_pending_dirty[prev_idx] : false;
      g_sym_last_repair_ms[valid] = (prev_idx >= 0) ? prev_last_repair_ms[prev_idx] : 0;
      valid++;
   }

   // Trim to valid count
   ArrayResize(g_sym_names,         valid);
   ArrayResize(g_sym_digits,        valid);
   ArrayResize(g_sym_last_tick_msc, valid);
   ArrayResize(g_sym_last_bar,      valid);
   ArrayResize(g_sym_last_uploaded_close, valid);
   ArrayResize(g_pending_bid,       valid);
   ArrayResize(g_pending_ask,       valid);
   ArrayResize(g_pending_msc,       valid);
   ArrayResize(g_pending_dirty,     valid);
   ArrayResize(g_sym_last_repair_ms, valid);
   g_sym_count = valid;

}

// Helper: find digits for a symbol by name (used in flush loop)
int FindDigits(const string sym)
{
   for(int i = 0; i < g_sym_count; i++)
      if(g_sym_names[i] == sym)
         return g_sym_digits[i];
   return 5; // safe default
}

//==========================================================================
// SECTION 9 — SIGNED HTTP POST
//==========================================================================
bool SignedPost(const string path, const string json, int timeout_ms)
{
   string url = BackendRelayUrl + path;
   string ts    = IntegerToString((long)TimeGMT() * 1000);
   string nonce = IntegerToString((long)GetTickCount64());

   string bodyHash     = Sha256Hex(json);
   string stringToSign = "POST\n" + path + "\n" + ts + "\n" + nonce + "\n" + bodyHash;
   string signature    = HmacSha256Hex(SigningSecret, stringToSign);

   string headers  = "Content-Type: application/json\r\n";
   headers += "X-IFX-CONN-ID: "   + ConnectionId + "\r\n";
   headers += "X-IFX-TS: "        + ts           + "\r\n";
   headers += "X-IFX-NONCE: "     + nonce        + "\r\n";
   headers += "X-IFX-SIGNATURE: " + signature    + "\r\n";

   uchar post[];
   StringToCharArray(json, post, 0, WHOLE_ARRAY, CP_UTF8);
   if(ArraySize(post) > 0)
      ArrayResize(post, ArraySize(post) - 1); // strip null terminator

   uchar result[];
   string resultHeaders = "";

   ResetLastError();
   int status = WebRequest("POST", url, headers, timeout_ms, post, result, resultHeaders);
   int err = GetLastError();

   if(status >= 200 && status < 300)
      return true;

   string resp = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);

   if(status == -1)
   {
      Print("❌ POST ", path, " → HTTP -1 (WebRequest failed) err=", err,
            " | url=", url,
            " | check MT5: Tools→Options→Expert Advisors→Allow WebRequest");
   }
   else
   {
      Print("❌ POST ", path, " → HTTP ", status, " err=", err, " | ", StringSubstr(resp, 0, 120));
   }
   return false;
}

//==========================================================================
// SECTION 10 — CRYPTO HELPERS (unchanged from v2 — verified working)
//==========================================================================
string Sha256Hex(const string text)
{
   uchar data[];
   StringToCharArray(text, data, 0, WHOLE_ARRAY, CP_UTF8);
   if(ArraySize(data) > 0)
      ArrayResize(data, ArraySize(data) - 1);

   uchar hash[];
   uchar emptyKey[];
   ArrayResize(emptyKey, 0);
   if(CryptEncode(CRYPT_HASH_SHA256, data, emptyKey, hash) <= 0)
      return "";
   return BytesToHex(hash);
}

string HmacSha256Hex(const string keyStr, const string message)
{
   uchar key[];
   StringToCharArray(keyStr, key, 0, WHOLE_ARRAY, CP_UTF8);
   if(ArraySize(key) > 0)
      ArrayResize(key, ArraySize(key) - 1);

   uchar emptyKey[];
   ArrayResize(emptyKey, 0);

   if(ArraySize(key) > 64)
   {
      uchar keyHash[];
      if(CryptEncode(CRYPT_HASH_SHA256, key, emptyKey, keyHash) <= 0)
         return "";
      ArrayResize(key, ArraySize(keyHash));
      ArrayCopy(key, keyHash, 0, 0, WHOLE_ARRAY);
   }

   uchar ipad[64];
   uchar opad[64];
   for(int i = 0; i < 64; i++)
   {
      uchar k = (i < ArraySize(key)) ? key[i] : 0;
      ipad[i] = (uchar)(k ^ 0x36);
      opad[i] = (uchar)(k ^ 0x5C);
   }

   uchar msg[];
   StringToCharArray(message, msg, 0, WHOLE_ARRAY, CP_UTF8);
   if(ArraySize(msg) > 0)
      ArrayResize(msg, ArraySize(msg) - 1);

   uchar inner[];
   ArrayResize(inner, 64 + ArraySize(msg));
   for(int i = 0; i < 64; i++)      inner[i]        = ipad[i];
   for(int i = 0; i < ArraySize(msg); i++) inner[64 + i] = msg[i];

   uchar innerHash[];
   if(CryptEncode(CRYPT_HASH_SHA256, inner, emptyKey, innerHash) <= 0)
      return "";

   uchar outer[];
   ArrayResize(outer, 64 + ArraySize(innerHash));
   for(int i = 0; i < 64; i++)               outer[i]        = opad[i];
   for(int i = 0; i < ArraySize(innerHash); i++) outer[64 + i] = innerHash[i];

   uchar hmac[];
   if(CryptEncode(CRYPT_HASH_SHA256, outer, emptyKey, hmac) <= 0)
      return "";
   return BytesToHex(hmac);
}

string BytesToHex(const uchar &data[])
{
   string out = "";
   for(int i = 0; i < ArraySize(data); i++)
      out += StringFormat("%02X", data[i]);
   return out;
}
//+------------------------------------------------------------------+
