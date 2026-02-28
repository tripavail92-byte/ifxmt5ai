//+------------------------------------------------------------------+
//|  IFX_PriceBridge_v3.mq5                                         |
//|  Industrial-grade multi-symbol tick bridge for IFX terminal      |
//|  Architecture: OnTick() + EventSetMillisecondTimer(50)           |
//|  Target: localhost:8082 relay (NOT directly to Railway)          |
//|                                                                  |
//|  SETUP: In MT5 → Tools → Options → Expert Advisors              |
//|    Add  http://localhost:8082  to "Allow WebRequest for listed   |
//|    URL" list — required for the relay connection to work.        |
//+------------------------------------------------------------------+
#property strict
#property version   "3.0"
#property description "IFX Price Bridge v3 — Multi-symbol tick relay → localhost"

//==========================================================================
// SECTION 1 — INPUTS
//==========================================================================
input string  BackendRelayUrl      = "http://localhost:8082";   // Relay URL (NOT Railway direct)
input string  ConnectionId         = "<connection_id>";          // Your MT5 connection UUID
input string  SigningSecret        = "<signing_secret>";         // HMAC-SHA256 key
input int     TickBatchMs          = 150;                        // Tick flush interval (ms)
input int     HistoricalBarsOnInit = 500;                        // 1m bars to push on startup
input int     ConfigRefreshSec     = 60;                         // Symbol list refresh interval

//==========================================================================
// SECTION 2 — GLOBALS
//==========================================================================

// Parallel arrays for per-symbol state (MQL5 structs can't hold dynamic arrays)
string   g_sym_names[];         // Symbol names
int      g_sym_digits[];        // Decimal places
long     g_sym_last_tick_msc[]; // Last tick time_msc (ms precision)
datetime g_sym_last_bar[];      // Last completed 1m bar open-time

int      g_sym_count     = 0;
ulong    g_last_flush_ms = 0;
ulong    g_last_config_ms= 0;

// Tick batch accumulator (plain arrays, flushed every TickBatchMs)
// Max 2000 ticks per batch (at 50ms polling × 20 symbols × flood = safe ceiling)
#define MAX_BATCH 2000
string  g_tick_sym[MAX_BATCH];
double  g_tick_bid[MAX_BATCH];
double  g_tick_ask[MAX_BATCH];
long    g_tick_msc[MAX_BATCH];
int     g_batch_count = 0;

//==========================================================================
// SECTION 3 — INIT / DEINIT
//==========================================================================
int OnInit()
{
   Print("=== IFX Price Bridge v3.0 ===");
   Print("Relay: ", BackendRelayUrl);
   Print("ConnectionId: ", ConnectionId);

   // Fetch symbol list from relay (GET /config)
   // Falls back to hardcoded defaults if relay not yet running
   FetchConfig();

   // Push 500 × 1m historical bars per symbol (blocking on init)
   PushHistoricalBulk();

   // 50ms millisecond timer — polls all symbols for new ticks
   // OnTick() ONLY fires for chart symbol; this covers all others
   EventSetMillisecondTimer(50);

   g_last_flush_ms  = GetTickCount64();
   g_last_config_ms = GetTickCount64();

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

      // Add to batch buffer (guard against overflow)
      if(g_batch_count < MAX_BATCH)
      {
         g_tick_sym[g_batch_count] = g_sym_names[i];
         g_tick_bid[g_batch_count] = tick.bid;
         g_tick_ask[g_batch_count] = tick.ask;
         g_tick_msc[g_batch_count] = tick.time_msc;
         g_batch_count++;
      }

      // Bar detection: has a new 1m candle opened since we last checked?
      // iTime(sym, PERIOD_M1, 0) = open time of the CURRENT (forming) bar
      // When it advances, the previous bar is now complete
      datetime current_bar = iTime(g_sym_names[i], PERIOD_M1, 0);
      if(current_bar > 0 && g_sym_last_bar[i] > 0 && current_bar > g_sym_last_bar[i])
      {
         // The old bar just closed — send it
         // CopyRates(..., 1, 1) = bar at index 1 = the bar that just closed
         SendCandleClose(g_sym_names[i], i);
      }
      if(current_bar > 0)
         g_sym_last_bar[i] = current_bar;
   }

   // Flush tick batch + forming candles every TickBatchMs milliseconds
   if(now_ms - g_last_flush_ms >= (ulong)TickBatchMs)
   {
      FlushTickBatch(now_ms);
      g_last_flush_ms = now_ms;
   }
}

//==========================================================================
// SECTION 6 — FLUSH: BUILD JSON AND POST TO RELAY
//==========================================================================
void FlushTickBatch(ulong now_ms)
{
   // Build JSON: ticks array + forming_candles array
   // sent as POST /tick-batch to localhost:8082

   string json = "{";
   json += "\"connection_id\":\"" + ConnectionId + "\",";
   json += "\"ts_ms\":" + IntegerToString((long)now_ms) + ",";

   // --- ticks ---
   json += "\"ticks\":[";
   for(int i = 0; i < g_batch_count; i++)
   {
      if(i > 0) json += ",";
      int d = FindDigits(g_tick_sym[i]);
      json += "{";
      json += "\"symbol\":\"" + g_tick_sym[i] + "\",";
      json += "\"bid\":"     + DoubleToString(g_tick_bid[i], d) + ",";
      json += "\"ask\":"     + DoubleToString(g_tick_ask[i], d) + ",";
      json += "\"ts_ms\":"   + IntegerToString(g_tick_msc[i]);
      json += "}";
   }
   json += "],";

   // --- forming_candles (current live bar, index 0) ---
   // Read once per flush — one CopyRates per symbol
   json += "\"forming_candles\":[";
   int added = 0;
   for(int i = 0; i < g_sym_count; i++)
   {
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

   // Reset batch
   g_batch_count = 0;

   // Only POST if we have something to send
   if(added == 0)
      return;

   SignedPost("/tick-batch", json, 3000);
}

// Send a single completed bar (called immediately when bar closes)
void SendCandleClose(const string symbol, int sym_idx)
{
   MqlRates r[];
   ArraySetAsSeries(r, true);
   // index 1 = bar that just closed (index 0 is the new forming bar)
   if(CopyRates(symbol, PERIOD_M1, 1, 1, r) <= 0)
      return;

   int d = g_sym_digits[sym_idx];
   string json = "{";
   json += "\"connection_id\":\"" + ConnectionId + "\",";
   json += "\"symbol\":\""        + symbol                           + "\",";
   json += "\"timeframe\":\"1m\",";
   json += "\"time\":"            + IntegerToString((long)r[0].time) + ",";
   json += "\"open\":"            + DoubleToString(r[0].open,  d)   + ",";
   json += "\"high\":"            + DoubleToString(r[0].high,  d)   + ",";
   json += "\"low\":"             + DoubleToString(r[0].low,   d)   + ",";
   json += "\"close\":"           + DoubleToString(r[0].close, d)   + ",";
   json += "\"tick_vol\":"        + IntegerToString(r[0].tick_volume);
   json += "}";

   if(SignedPost("/candle-close", json, 3000))
      Print("✅ [", symbol, "] candle-close T=", TimeToString(r[0].time));
   else
      Print("⚠️ [", symbol, "] candle-close POST failed");
}

//==========================================================================
// SECTION 7 — HISTORICAL BULK PUSH (called once from OnInit)
//==========================================================================
void PushHistoricalBulk()
{
   if(g_sym_count == 0)
      return;

   Print("📦 Pushing ", HistoricalBarsOnInit, " × 1m historical bars for ", g_sym_count, " symbols...");

   // Build one large batch payload covering all symbols
   string json = "{";
   json += "\"connection_id\":\"" + ConnectionId + "\",";
   json += "\"bars_requested\":"  + IntegerToString(HistoricalBarsOnInit) + ",";
   json += "\"symbols\":[";

   int sym_added = 0;
   for(int i = 0; i < g_sym_count; i++)
   {
      MqlRates r[];
      ArraySetAsSeries(r, true);
      // Request HistoricalBarsOnInit bars starting from bar index 1
      // (bar 0 = forming, bars 1..N = completed history)
      int copied = CopyRates(g_sym_names[i], PERIOD_M1, 1, HistoricalBarsOnInit, r);
      if(copied <= 0)
      {
         Print("⚠️ [", g_sym_names[i], "] CopyRates returned 0 bars, skipping");
         continue;
      }

      int d = g_sym_digits[i];
      if(sym_added > 0) json += ",";
      json += "{\"symbol\":\"" + g_sym_names[i] + "\",\"bars\":[";

      // Bars come back newest-first (series order), reverse to send oldest-first
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
      json += "]}";
      sym_added++;

      Print("  [", g_sym_names[i], "] ", copied, " bars ready");
   }
   json += "]}";

   if(sym_added == 0)
   {
      Print("❌ Historical push: no symbols had data");
      return;
   }

   if(SignedPost("/historical-bulk", json, 15000))
      Print("✅ Historical bulk pushed: ", sym_added, " symbols");
   else
      Print("❌ Historical bulk POST failed — relay may not be running yet");
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
   ArrayResize(g_sym_names,          count);
   ArrayResize(g_sym_digits,         count);
   ArrayResize(g_sym_last_tick_msc,  count);
   ArrayResize(g_sym_last_bar,       count);

   int valid = 0;
   for(int i = 0; i < count; i++)
   {
      string s = syms[i];
      if(!SymbolSelect(s, true))
      {
         Print("⚠️ [CONFIG] symbol not available: ", s);
         continue;
      }
      g_sym_names[valid]         = s;
      g_sym_digits[valid]        = (int)SymbolInfoInteger(s, SYMBOL_DIGITS);
      g_sym_last_tick_msc[valid] = 0;
      g_sym_last_bar[valid]      = 0;
      valid++;
   }

   // Trim to valid count
   ArrayResize(g_sym_names,         valid);
   ArrayResize(g_sym_digits,        valid);
   ArrayResize(g_sym_last_tick_msc, valid);
   ArrayResize(g_sym_last_bar,      valid);
   g_sym_count = valid;

   // Reset batch
   g_batch_count = 0;
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

   if(status >= 200 && status < 300)
      return true;

   string resp = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   Print("❌ POST ", path, " → HTTP ", status, " | ", StringSubstr(resp, 0, 120));
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
