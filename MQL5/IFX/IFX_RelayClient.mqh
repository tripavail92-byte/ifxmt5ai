//+------------------------------------------------------------------+
//|  IFX_RelayClient.mqh                                             |
//|  Phase 2A — Relay client module extracted from                   |
//|  IFX_ControlPlane_Bridge_v1.mq5                                  |
//|                                                                  |
//|  Provides:                                                        |
//|    RelayClient_Init()   — call from OnInit()                     |
//|    RelayClient_Tick()   — call from OnTick()                     |
//|    RelayClient_Timer()  — call from OnTimer() (any interval)     |
//|    RelayClient_Deinit() — call from OnDeinit()                   |
//|                                                                  |
//|  Universal broker support: suffix-neutral symbol resolution      |
//|  works with XM, Exness, Octa, ICMarkets, and any broker that     |
//|  appends suffixes (.m, .r, .pro, etc.) to base symbol names.     |
//|                                                                  |
//|  Symbol list is driven by config.symbols.active from the cloud   |
//|  config endpoint. Falls back to InitDefaultSymbols() if the      |
//|  relay or config endpoint is unreachable.                        |
//|                                                                  |
//|  SETUP: MT5 → Tools → Options → Expert Advisors                  |
//|    Add your Railway URL to "Allow WebRequest" list.              |
//+------------------------------------------------------------------+
#ifndef IFX_RELAY_CLIENT_MQH
#define IFX_RELAY_CLIENT_MQH

#property strict

//==========================================================================
// INPUTS — relay/control-plane settings
// These appear in the unified EA's parameter dialog.
//==========================================================================
input group "=== Relay / Control Plane ==="
input string  RC_BackendRelayUrl      = "https://ifx-mt5-portal-production.up.railway.app/api/mt5"; // Relay base URL
input string  RC_ConnectionId         = "";        // MT5 connection UUID (from dashboard)
input string  RC_SigningSecret        = "";        // Must match Railway RELAY_SECRET
input int     RC_TickBatchMs          = 250;       // Active symbol flush interval (ms)
input int     RC_WatchlistTickBatchMs = 500;       // Watchlist flush interval (ms)
input bool    RC_LatestTickOnlyPerFlush = true;    // One tick per symbol per flush window
input int     RC_HistoricalBarsOnInit = 500;       // 1m bars to push on startup
input int     RC_ConfigRefreshSec     = 60;        // Symbol list refresh interval (s)
input int     RC_HistoryRepairBars    = 240;       // Bars to re-push when candle-close stalls
input int     RC_HistoryRepairCooldownSec = 120;   // Min delay between per-symbol repairs
input int     RC_HistoryRepairTriggerMissedBars = 3; // Re-push after this many missed closes
input int     RC_HistoryRefreshWindowSec = 300;    // Periodic sliding-window reseed interval

input group "=== Fractal Signal Detector ==="
input bool    RC_EnableLocalFractalSignals = true; // Run local structure detector
input ENUM_TIMEFRAMES RC_StructureTimeframe = PERIOD_M5; // Timeframe for fractal detection
input int     RC_StructurePivotWindow = 2;         // Pivot confirmation width each side
input int     RC_StructureBarsToScan  = 120;       // Closed candles per symbol to scan
input bool    RC_LogFractalSignals    = true;      // Log fractal breaks to Experts log

input group "=== Control Plane Bootstrap ==="
input bool    RC_EnableControlPlaneBootstrap = true;             // Register/heartbeat with control plane
input string  RC_BootstrapManifestPath = "ifx\\bootstrap.json"; // MQL5/Files-relative path
input int     RC_ControlPlaneHeartbeatSec = 30;                  // Fallback heartbeat interval

//==========================================================================
// GLOBALS — all prefixed rc_ to avoid collision with trading brain globals
//==========================================================================

// Parallel arrays for per-symbol state
string   rc_sym_names[];
int      rc_sym_digits[];
long     rc_sym_last_tick_msc[];
datetime rc_sym_last_bar[];
datetime rc_sym_last_uploaded_close[];
ulong    rc_sym_last_repair_ms[];
ulong    rc_sym_last_reseed_ms[];
datetime rc_sym_last_structure_close[];
datetime rc_sym_last_structure_signal[];
double   rc_sym_last_structure_high[];
double   rc_sym_last_structure_low[];

int      rc_sym_count          = 0;
ulong    rc_last_flush_ms      = 0;
ulong    rc_last_watchlist_flush_ms = 0;
ulong    rc_last_config_ms     = 0;
ulong    rc_last_health_ms     = 0;

int      rc_relay_uptime_prev  = -2; // -2=first-run, -1=was-down, >=0=last-uptime
bool     rc_historical_seeded  = false;
bool     rc_control_plane_ready = false;
bool     rc_ea_registered      = false;

string   rc_backend_url        = "";
string   rc_connection_id      = "";
string   rc_signing_secret     = "";
string   rc_install_token      = "";
string   rc_register_url       = "";
string   rc_heartbeat_url      = "";
ulong    rc_last_register_attempt_ms = 0;
ulong    rc_last_heartbeat_attempt_ms = 0;
int      rc_effective_heartbeat_sec  = 30;

// Pending per-symbol snapshots (latest tick per flush window)
double   rc_pending_bid[];
double   rc_pending_ask[];
long     rc_pending_msc[];
bool     rc_pending_dirty[];

// Active (high-rate) symbols resolved from config
string   rc_active_symbols[];
int      rc_active_symbol_count = 0;

#define RC_CLOSE_REPAIR_RETRY_MS          5000
#define RC_CLOSE_DISCONTINUITY_RESEED_MS  30000
#define RC_MAX_SYMBOLS                    64    // no hard cap; broker determines what's available

//==========================================================================
// SECTION A — STRING / SYMBOL UTILITIES
//==========================================================================

string RC_TrimSpaces(const string value)
{
   string v = value;
   StringReplace(v, " ", "");
   return v;
}

string RC_NormalizeSymbolAlias(const string value)
{
   string compact = "";
   string upper = RC_TrimSpaces(value);
   StringToUpper(upper);

   for(int i = 0; i < StringLen(upper); i++)
   {
      ushort ch = StringGetCharacter(upper, i);
      bool is_alpha = (ch >= 'A' && ch <= 'Z');
      bool is_digit = (ch >= '0' && ch <= '9');
      if(!is_alpha && !is_digit)
         continue;
      uchar c[] = {(uchar)ch};
      compact += CharArrayToString(c);
   }

   // Strip known trailing length indicators
   int len = StringLen(compact);
   if(len > 5 && StringSubstr(compact, len - 5) == "MICRO")
      compact = StringSubstr(compact, 0, len - 5);
   len = StringLen(compact);
   if(len > 4 && StringSubstr(compact, len - 4) == "MINI")
      compact = StringSubstr(compact, 0, len - 4);
   len = StringLen(compact);
   // strip trailing single 'M' only when name is long enough to be a suffix
   if(len > 6 && StringSubstr(compact, len - 1) == "M")
      compact = StringSubstr(compact, 0, len - 1);

   return compact;
}

int RC_SymbolAliasMatchScore(const string requested, const string candidate)
{
   string tr = RC_TrimSpaces(requested);
   string tc = RC_TrimSpaces(candidate);
   if(StringLen(tr) == 0 || StringLen(tc) == 0) return -1;
   if(tr == tc) return 0;

   string nr = RC_NormalizeSymbolAlias(tr);
   string nc = RC_NormalizeSymbolAlias(tc);
   if(StringLen(nr) == 0 || StringLen(nc) == 0) return -1;
   if(nr == nc) return 1 + MathAbs(StringLen(tc) - StringLen(tr));

   int diff = MathAbs(StringLen(nr) - StringLen(nc));
   if(diff <= 4)
   {
      if(StringFind(nc, nr) == 0) return 10 + diff;
      if(StringFind(nr, nc) == 0) return 10 + diff;
   }
   return -1;
}

bool RC_ResolveBrokerSymbol(const string requested, string &resolved)
{
   resolved = RC_TrimSpaces(requested);
   if(StringLen(resolved) == 0) return false;
   if(SymbolSelect(resolved, true)) return true;

   string best = "";
   int    best_score = 1000000;
   for(int pass = 0; pass < 2; pass++)
   {
      bool sel = (pass == 0);
      int total = SymbolsTotal(sel);
      for(int i = 0; i < total; i++)
      {
         string candidate = SymbolName(i, sel);
         int score = RC_SymbolAliasMatchScore(resolved, candidate);
         if(score < 0 || score >= best_score) continue;
         best       = candidate;
         best_score = score;
      }
   }
   if(StringLen(best) == 0) return false;
   if(!SymbolSelect(best, true)) return false;
   resolved = best;
   return true;
}

bool RC_ActiveArrayContains(const string sym)
{
   for(int i = 0; i < rc_active_symbol_count; i++)
      if(rc_active_symbols[i] == sym) return true;
   return false;
}

bool RC_IsActiveSymbol(const string sym)
{
   if(sym == _Symbol) return true;
   return RC_ActiveArrayContains(sym);
}

string RC_RuntimeBackendUrl()
{
   return (StringLen(rc_backend_url) > 0) ? rc_backend_url : RC_BackendRelayUrl;
}

string RC_RuntimeConnectionId()
{
   return (StringLen(rc_connection_id) > 0) ? rc_connection_id : RC_ConnectionId;
}

string RC_EscapeJson(const string value)
{
   string e = value;
   StringReplace(e, "\\", "\\\\");
   StringReplace(e, "\"", "\\\"");
   StringReplace(e, "\r", "");
   StringReplace(e, "\n", " ");
   return e;
}

bool RC_IsFiniteJsonNumber(const double v)
{
   return MathIsValidNumber(v);
}

bool RC_IsValidPriceSnapshot(const double bid, const double ask, const long ts_ms)
{
   if(ts_ms <= 0) return false;
   if(!RC_IsFiniteJsonNumber(bid) || !RC_IsFiniteJsonNumber(ask)) return false;
   if(bid <= 0.0 || ask <= 0.0) return false;
   return true;
}

bool RC_IsValidRateBar(const MqlRates &bar)
{
   if(bar.time <= 0) return false;
   if(!RC_IsFiniteJsonNumber(bar.open) || !RC_IsFiniteJsonNumber(bar.high)
      || !RC_IsFiniteJsonNumber(bar.low) || !RC_IsFiniteJsonNumber(bar.close)) return false;
   if(bar.open <= 0.0 || bar.high <= 0.0 || bar.low <= 0.0 || bar.close <= 0.0) return false;
   return true;
}

string RC_JsonExtractStringAfter(const string json, int from_pos, const string key)
{
   string marker = "\"" + key + "\"";
   int key_pos = StringFind(json, marker, from_pos);
   if(key_pos < 0) return "";
   int colon_pos = StringFind(json, ":", key_pos + StringLen(marker));
   if(colon_pos < 0) return "";

   int start = colon_pos + 1;
   while(start < StringLen(json))
   {
      ushort ch = StringGetCharacter(json, start);
      if(ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n') { start++; continue; }
      break;
   }
   if(start >= StringLen(json) || StringGetCharacter(json, start) != '"') return "";
   start++;
   int finish = start;
   while(finish < StringLen(json))
   {
      if(StringGetCharacter(json, finish) == '"') break;
      finish++;
   }
   if(finish <= start) return "";
   return StringSubstr(json, start, finish - start);
}

bool RC_ReadTextFileUtf8(const string relative_path, string &content)
{
   content = "";
   int handle = FileOpen(relative_path, FILE_READ | FILE_TXT | FILE_ANSI, 0, CP_UTF8);
   if(handle == INVALID_HANDLE)
   {
      Print("⚠️ [RELAY] bootstrap file open failed: ", relative_path, " err=", GetLastError());
      return false;
   }
   while(!FileIsEnding(handle))
      content += FileReadString(handle);
   FileClose(handle);
   return StringLen(content) > 0;
}

string RC_TimeframeLabel(const ENUM_TIMEFRAMES tf)
{
   switch(tf)
   {
      case PERIOD_M1:  return "1m";   case PERIOD_M2:  return "2m";
      case PERIOD_M3:  return "3m";   case PERIOD_M4:  return "4m";
      case PERIOD_M5:  return "5m";   case PERIOD_M6:  return "6m";
      case PERIOD_M10: return "10m";  case PERIOD_M12: return "12m";
      case PERIOD_M15: return "15m";  case PERIOD_M20: return "20m";
      case PERIOD_M30: return "30m";  case PERIOD_H1:  return "1h";
      case PERIOD_H2:  return "2h";   case PERIOD_H3:  return "3h";
      case PERIOD_H4:  return "4h";   case PERIOD_H6:  return "6h";
      case PERIOD_H8:  return "8h";   case PERIOD_H12: return "12h";
      case PERIOD_D1:  return "1d";   case PERIOD_W1:  return "1w";
      case PERIOD_MN1: return "1mn";
   }
   return IntegerToString((int)tf);
}

int RC_SanitizedPivotWindow()
{
   int w = RC_StructurePivotWindow;
   if(w < 1) w = 1;
   if(w > 20) w = 20;
   return w;
}

int RC_SanitizedBarsToScan()
{
   int b = RC_StructureBarsToScan;
   int min = 2 * RC_SanitizedPivotWindow() + 5;
   if(b < min) b = min;
   if(b > 500) b = 500;
   return b;
}

int RC_RepairBarsToSend()
{
   int r = RC_HistoryRepairBars;
   if(r <= 0) r = RC_HistoricalBarsOnInit;
   if(r <= 0) r = 120;
   return r;
}

int RC_FindDigits(const string sym)
{
   for(int i = 0; i < rc_sym_count; i++)
      if(rc_sym_names[i] == sym) return rc_sym_digits[i];
   return 5;
}

//==========================================================================
// SECTION B — CONTROL PLANE (bootstrap / heartbeat)
//==========================================================================

bool RC_LoadBootstrap()
{
   if(!RC_EnableControlPlaneBootstrap) return false;

   string manifest = "";
   if(!RC_ReadTextFileUtf8(RC_BootstrapManifestPath, manifest)) return false;

   rc_backend_url        = RC_BackendRelayUrl;
   rc_connection_id      = RC_ConnectionId;
   rc_signing_secret     = RC_SigningSecret;
   rc_effective_heartbeat_sec = MathMax(5, RC_ControlPlaneHeartbeatSec);

   int relay_pos   = StringFind(manifest, "\"relay\"");
   int control_pos = StringFind(manifest, "\"control_plane\"");

   string manifest_conn = RC_JsonExtractStringAfter(manifest, 0, "connection_id");
   if(StringLen(manifest_conn) > 0) rc_connection_id = manifest_conn;

   rc_install_token  = RC_JsonExtractStringAfter(manifest, 0, "install_token");
   rc_register_url   = RC_JsonExtractStringAfter(manifest, control_pos, "register_url");
   rc_heartbeat_url  = RC_JsonExtractStringAfter(manifest, control_pos, "heartbeat_url");

   string relay_url  = RC_JsonExtractStringAfter(manifest, relay_pos, "base_url");
   if(StringLen(relay_url) > 0) rc_backend_url = relay_url;

   rc_control_plane_ready = (StringLen(rc_install_token) > 0
      && StringLen(rc_register_url) > 0
      && StringLen(rc_heartbeat_url) > 0
      && StringLen(rc_connection_id) > 0);

   if(rc_control_plane_ready)
   {
      Print("✅ [RELAY] bootstrap loaded. conn=", rc_connection_id);
      Print("✅ [RELAY] register=", rc_register_url);
   }
   else
   {
      Print("⚠️ [RELAY] bootstrap found but required fields missing");
   }
   return rc_control_plane_ready;
}

bool RC_ControlPlanePost(const string url, const string json, string &response, int timeout_ms)
{
   response = "";
   if(StringLen(url) == 0 || StringLen(rc_install_token) == 0) return false;

   string headers = "Content-Type: application/json\r\n";
   headers += "X-IFX-INSTALL-TOKEN: " + rc_install_token + "\r\n";

   uchar payload[];
   StringToCharArray(json, payload, 0, WHOLE_ARRAY, CP_UTF8);
   if(ArraySize(payload) > 0) ArrayResize(payload, ArraySize(payload) - 1);

   uchar result[];
   string result_headers = "";
   ResetLastError();
   int status = WebRequest("POST", url, headers, timeout_ms, payload, result, result_headers);
   int err = GetLastError();
   response = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);

   if(status >= 200 && status < 300) return true;
   if(status == -1)
      Print("❌ [RELAY] control-plane POST failed err=", err, " url=", url);
   else
      Print("❌ [RELAY] control-plane POST ", url, " → HTTP ", status, " err=", err,
            " | ", StringSubstr(response, 0, 160));
   return false;
}

bool RC_RegisterInstallation(const string ea_version)
{
   if(!rc_control_plane_ready) return false;

   string payload = "{";
   payload += "\"connection_id\":\"" + RC_EscapeJson(RC_RuntimeConnectionId()) + "\",";
   payload += "\"terminal_path\":\"" + RC_EscapeJson(TerminalInfoString(TERMINAL_DATA_PATH)) + "\",";
   payload += "\"ea_version\":\""    + RC_EscapeJson(ea_version) + "\",";
   payload += "\"metadata\":{";
   payload += "\"account_login\":\""  + IntegerToString((int)AccountInfoInteger(ACCOUNT_LOGIN)) + "\",";
   payload += "\"broker_server\":\""  + RC_EscapeJson(AccountInfoString(ACCOUNT_SERVER)) + "\",";
   payload += "\"chart_symbol\":\""   + RC_EscapeJson(_Symbol) + "\"";
   payload += "}}";

   string response = "";
   if(!RC_ControlPlanePost(rc_register_url, payload, response, 5000)) return false;

   rc_ea_registered = true;
   Print("✅ [RELAY] registered with control plane: ", RC_RuntimeConnectionId());
   return true;
}

bool RC_SendHeartbeat()
{
   if(!rc_control_plane_ready) return false;

   string payload = "{";
   payload += "\"connection_id\":\"" + RC_EscapeJson(RC_RuntimeConnectionId()) + "\",";
   payload += "\"status\":\"online\",";
   payload += "\"metrics\":{";
   payload += "\"account_login\":\"" + IntegerToString((int)AccountInfoInteger(ACCOUNT_LOGIN)) + "\",";
   payload += "\"equity\":"  + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY),  2) + ",";
   payload += "\"balance\":" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + ",";
   payload += "\"symbol_count\":" + IntegerToString(rc_sym_count);
   payload += "}}";

   string response = "";
   if(!RC_ControlPlanePost(rc_heartbeat_url, payload, response, 5000)) return false;
   Print("✅ [RELAY] heartbeat ok conn=", RC_RuntimeConnectionId());
   return true;
}

void RC_MaybeSyncControlPlane(const string ea_version)
{
   if(!RC_EnableControlPlaneBootstrap) return;

   ulong now_ms = GetTickCount64();
   if(!rc_control_plane_ready)
   {
      if(now_ms - rc_last_register_attempt_ms >= 10000)
      {
         rc_last_register_attempt_ms = now_ms;
         RC_LoadBootstrap();
      }
      return;
   }
   if(!rc_ea_registered)
   {
      if(now_ms - rc_last_register_attempt_ms >= 5000)
      {
         rc_last_register_attempt_ms = now_ms;
         if(RC_RegisterInstallation(ea_version))
            rc_last_heartbeat_attempt_ms = now_ms;
      }
      return;
   }
   if(now_ms - rc_last_heartbeat_attempt_ms >= (ulong)MathMax(5, rc_effective_heartbeat_sec) * 1000)
   {
      if(RC_SendHeartbeat())
         rc_last_heartbeat_attempt_ms = now_ms;
   }
}

//==========================================================================
// SECTION C — SYMBOL LIST MANAGEMENT
//==========================================================================

// EnsureChartSymbolTracked: guarantee _Symbol is always monitored.
// Called at the end of ApplySymbolList.
void RC_EnsureChartSymbolTracked()
{
   for(int i = 0; i < rc_sym_count; i++)
      if(rc_sym_names[i] == _Symbol) return; // already present

   // Not found — append
   int n = rc_sym_count;
   ArrayResize(rc_sym_names,               n + 1);
   ArrayResize(rc_sym_digits,              n + 1);
   ArrayResize(rc_sym_last_tick_msc,       n + 1);
   ArrayResize(rc_sym_last_bar,            n + 1);
   ArrayResize(rc_sym_last_uploaded_close, n + 1);
   ArrayResize(rc_pending_bid,             n + 1);
   ArrayResize(rc_pending_ask,             n + 1);
   ArrayResize(rc_pending_msc,             n + 1);
   ArrayResize(rc_pending_dirty,           n + 1);
   ArrayResize(rc_sym_last_repair_ms,      n + 1);
   ArrayResize(rc_sym_last_reseed_ms,      n + 1);
   ArrayResize(rc_sym_last_structure_close,  n + 1);
   ArrayResize(rc_sym_last_structure_signal, n + 1);
   ArrayResize(rc_sym_last_structure_high,   n + 1);
   ArrayResize(rc_sym_last_structure_low,    n + 1);

   rc_sym_names[n]               = _Symbol;
   rc_sym_digits[n]              = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   rc_sym_last_tick_msc[n]       = 0;
   rc_sym_last_bar[n]            = 0;
   rc_sym_last_uploaded_close[n] = 0;
   rc_pending_bid[n]             = 0.0;
   rc_pending_ask[n]             = 0.0;
   rc_pending_msc[n]             = 0;
   rc_pending_dirty[n]           = false;
   rc_sym_last_repair_ms[n]      = 0;
   rc_sym_last_reseed_ms[n]      = 0;
   rc_sym_last_structure_close[n]  = 0;
   rc_sym_last_structure_signal[n] = 0;
   rc_sym_last_structure_high[n]   = 0.0;
   rc_sym_last_structure_low[n]    = 0.0;
   rc_sym_count = n + 1;

   Print("ℹ️ [RELAY] chart symbol ", _Symbol, " auto-added to relay list (not in config)");
}

void RC_ApplySymbolList(const string &syms[], int count)
{
   // Snapshot previous state so we can transfer per-symbol history
   string   prev_names[];             int prev_count = rc_sym_count;
   int      prev_digits[];
   long     prev_last_tick_msc[];
   datetime prev_last_bar[];
   datetime prev_last_uploaded_close[];
   double   prev_pending_bid[];
   double   prev_pending_ask[];
   long     prev_pending_msc[];
   bool     prev_pending_dirty[];
   ulong    prev_last_repair_ms[];
   ulong    prev_last_reseed_ms[];
   datetime prev_last_structure_close[];
   datetime prev_last_structure_signal[];
   double   prev_last_structure_high[];
   double   prev_last_structure_low[];

   ArrayResize(prev_names,               prev_count);
   ArrayResize(prev_digits,              prev_count);
   ArrayResize(prev_last_tick_msc,       prev_count);
   ArrayResize(prev_last_bar,            prev_count);
   ArrayResize(prev_last_uploaded_close, prev_count);
   ArrayResize(prev_pending_bid,         prev_count);
   ArrayResize(prev_pending_ask,         prev_count);
   ArrayResize(prev_pending_msc,         prev_count);
   ArrayResize(prev_pending_dirty,       prev_count);
   ArrayResize(prev_last_repair_ms,      prev_count);
   ArrayResize(prev_last_reseed_ms,      prev_count);
   ArrayResize(prev_last_structure_close,  prev_count);
   ArrayResize(prev_last_structure_signal, prev_count);
   ArrayResize(prev_last_structure_high,   prev_count);
   ArrayResize(prev_last_structure_low,    prev_count);

   for(int i = 0; i < prev_count; i++)
   {
      prev_names[i]               = rc_sym_names[i];
      prev_digits[i]              = rc_sym_digits[i];
      prev_last_tick_msc[i]       = rc_sym_last_tick_msc[i];
      prev_last_bar[i]            = rc_sym_last_bar[i];
      prev_last_uploaded_close[i] = rc_sym_last_uploaded_close[i];
      prev_pending_bid[i]         = rc_pending_bid[i];
      prev_pending_ask[i]         = rc_pending_ask[i];
      prev_pending_msc[i]         = rc_pending_msc[i];
      prev_pending_dirty[i]       = rc_pending_dirty[i];
      prev_last_repair_ms[i]      = rc_sym_last_repair_ms[i];
      prev_last_reseed_ms[i]      = rc_sym_last_reseed_ms[i];
      prev_last_structure_close[i]  = rc_sym_last_structure_close[i];
      prev_last_structure_signal[i] = rc_sym_last_structure_signal[i];
      prev_last_structure_high[i]   = rc_sym_last_structure_high[i];
      prev_last_structure_low[i]    = rc_sym_last_structure_low[i];
   }

   // Allocate for new list
   ArrayResize(rc_sym_names,               count);
   ArrayResize(rc_sym_digits,              count);
   ArrayResize(rc_sym_last_tick_msc,       count);
   ArrayResize(rc_sym_last_bar,            count);
   ArrayResize(rc_sym_last_uploaded_close, count);
   ArrayResize(rc_pending_bid,             count);
   ArrayResize(rc_pending_ask,             count);
   ArrayResize(rc_pending_msc,             count);
   ArrayResize(rc_pending_dirty,           count);
   ArrayResize(rc_sym_last_repair_ms,      count);
   ArrayResize(rc_sym_last_reseed_ms,      count);
   ArrayResize(rc_sym_last_structure_close,  count);
   ArrayResize(rc_sym_last_structure_signal, count);
   ArrayResize(rc_sym_last_structure_high,   count);
   ArrayResize(rc_sym_last_structure_low,    count);

   int valid = 0;
   for(int i = 0; i < count; i++)
   {
      string requested = syms[i];
      string s = "";
      if(!RC_ResolveBrokerSymbol(requested, s))
      {
         Print("⚠️ [RELAY] symbol alias not available on this broker: ", requested);
         continue;
      }
      if(s != RC_TrimSpaces(requested))
         Print("ℹ️ [RELAY] resolved ", requested, " → ", s);

      // Deduplicate
      bool duplicate = false;
      for(int j = 0; j < valid; j++)
         if(rc_sym_names[j] == s) { duplicate = true; break; }
      if(duplicate) continue;

      // Restore previous state if symbol was already tracked
      int prev_idx = -1;
      for(int j = 0; j < prev_count; j++)
         if(prev_names[j] == s) { prev_idx = j; break; }

      rc_sym_names[valid]               = s;
      rc_sym_digits[valid]              = (int)SymbolInfoInteger(s, SYMBOL_DIGITS);
      rc_sym_last_tick_msc[valid]       = (prev_idx >= 0) ? prev_last_tick_msc[prev_idx]       : 0;
      rc_sym_last_bar[valid]            = (prev_idx >= 0) ? prev_last_bar[prev_idx]             : 0;
      rc_sym_last_uploaded_close[valid] = (prev_idx >= 0) ? prev_last_uploaded_close[prev_idx] : 0;
      rc_pending_bid[valid]             = (prev_idx >= 0) ? prev_pending_bid[prev_idx]          : 0.0;
      rc_pending_ask[valid]             = (prev_idx >= 0) ? prev_pending_ask[prev_idx]          : 0.0;
      rc_pending_msc[valid]             = (prev_idx >= 0) ? prev_pending_msc[prev_idx]          : 0;
      rc_pending_dirty[valid]           = (prev_idx >= 0) ? prev_pending_dirty[prev_idx]        : false;
      rc_sym_last_repair_ms[valid]      = (prev_idx >= 0) ? prev_last_repair_ms[prev_idx]       : 0;
      rc_sym_last_reseed_ms[valid]      = (prev_idx >= 0) ? prev_last_reseed_ms[prev_idx]       : 0;
      rc_sym_last_structure_close[valid]  = (prev_idx >= 0) ? prev_last_structure_close[prev_idx]  : 0;
      rc_sym_last_structure_signal[valid] = (prev_idx >= 0) ? prev_last_structure_signal[prev_idx] : 0;
      rc_sym_last_structure_high[valid]   = (prev_idx >= 0) ? prev_last_structure_high[prev_idx]   : 0.0;
      rc_sym_last_structure_low[valid]    = (prev_idx >= 0) ? prev_last_structure_low[prev_idx]    : 0.0;
      valid++;
   }

   // Trim to valid count
   ArrayResize(rc_sym_names,               valid);
   ArrayResize(rc_sym_digits,              valid);
   ArrayResize(rc_sym_last_tick_msc,       valid);
   ArrayResize(rc_sym_last_bar,            valid);
   ArrayResize(rc_sym_last_uploaded_close, valid);
   ArrayResize(rc_pending_bid,             valid);
   ArrayResize(rc_pending_ask,             valid);
   ArrayResize(rc_pending_msc,             valid);
   ArrayResize(rc_pending_dirty,           valid);
   ArrayResize(rc_sym_last_repair_ms,      valid);
   ArrayResize(rc_sym_last_reseed_ms,      valid);
   ArrayResize(rc_sym_last_structure_close,  valid);
   ArrayResize(rc_sym_last_structure_signal, valid);
   ArrayResize(rc_sym_last_structure_high,   valid);
   ArrayResize(rc_sym_last_structure_low,    valid);
   rc_sym_count = valid;

   // IMPROVEMENT: always ensure the chart symbol is tracked
   RC_EnsureChartSymbolTracked();
}

// InitDefaultSymbols: broker-neutral base names, resolved per broker at runtime.
// Also used as fallback when relay/config endpoint is unreachable.
void RC_InitDefaultSymbols()
{
   string defaults[] = {
      "EURUSD", "GBPUSD", "USDJPY", "USDCAD", "AUDUSD",
      "NZDUSD", "USDCHF", "EURGBP", "XAUUSD", "BTCUSD",
      "ETHUSD", "USOIL"
   };
   RC_ApplySymbolList(defaults, ArraySize(defaults));
   Print("ℹ️ [RELAY] using ", rc_sym_count, " default symbols (relay not reachable)");
}

// LoadPreferredActiveSymbols: builds rc_active_symbols[] from RC_BackendRelayUrl config
// (the high-rate symbol list passed through from the cloud EA config).
void RC_LoadPreferredActiveSymbols(const string &syms_csv)
{
   ArrayResize(rc_active_symbols, 0);
   rc_active_symbol_count = 0;

   string cleaned = RC_TrimSpaces(syms_csv);
   if(StringLen(cleaned) == 0) return;

   string parts[];
   int count = StringSplit(cleaned, ',', parts);
   for(int i = 0; i < count; i++)
   {
      string requested = RC_TrimSpaces(parts[i]);
      string sym = "";
      if(StringLen(requested) == 0) continue;
      if(!RC_ResolveBrokerSymbol(requested, sym)) continue;
      if(RC_ActiveArrayContains(sym)) continue;

      ArrayResize(rc_active_symbols, rc_active_symbol_count + 1);
      rc_active_symbols[rc_active_symbol_count++] = sym;
   }
}

//==========================================================================
// SECTION D — CONFIG FETCH  (GET /config from relay)
//==========================================================================

// FetchConfig: fetches the symbol list from the relay /config endpoint.
// Parses "symbols" JSON array (base names, broker-resolved at runtime).
// On failure falls back to InitDefaultSymbols.
void RC_FetchConfig()
{
   string url = RC_RuntimeBackendUrl() + "/config";
   uchar emptyData[];
   ArrayResize(emptyData, 0);
   uchar result[];
   string resultHeaders = "";

   ResetLastError();
   int status = WebRequest("GET", url, "", 3000, emptyData, result, resultHeaders);

   if(status != 200)
   {
      int err = GetLastError();
      Print("⚠️ [RELAY] /config unreachable (HTTP ", status, " err=", err, ") — using defaults");
      RC_InitDefaultSymbols();
      return;
   }

   string resp = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);

   // Parse "symbols":[...] array
   int arr_start = StringFind(resp, "[");
   int arr_end   = StringFind(resp, "]");
   if(arr_start < 0 || arr_end < arr_start)
   {
      Print("⚠️ [RELAY] bad /config response format — using defaults");
      RC_InitDefaultSymbols();
      return;
   }

   string arr_content = StringSubstr(resp, arr_start + 1, arr_end - arr_start - 1);
   StringReplace(arr_content, "\"", "");
   StringReplace(arr_content, " ",  "");

   string parsed[];
   int count = 0;
   string remaining = arr_content;
   while(true)
   {
      int comma = StringFind(remaining, ",");
      string sym;
      if(comma < 0) { sym = remaining; if(StringLen(sym) > 0) { ArrayResize(parsed, count + 1); parsed[count++] = sym; } break; }
      sym = StringSubstr(remaining, 0, comma);
      if(StringLen(sym) > 0) { ArrayResize(parsed, count + 1); parsed[count++] = sym; }
      remaining = StringSubstr(remaining, comma + 1);
   }

   if(count == 0)
   {
      Print("⚠️ [RELAY] /config returned 0 symbols — using defaults");
      RC_InitDefaultSymbols();
      return;
   }

   RC_ApplySymbolList(parsed, count);
   Print("✅ [RELAY] ", rc_sym_count, " symbols active (", count, " from config)");
}

//==========================================================================
// SECTION E — FRACTAL STRUCTURE DETECTOR (local, no cloud dependency)
//==========================================================================

bool RC_IsPivotHigh(const MqlRates &bars[], int idx, int window)
{
   double level = bars[idx].high;
   for(int j = idx - window; j <= idx + window; j++)
   {
      if(j == idx) continue;
      if(bars[j].high >= level) return false;
   }
   return true;
}

bool RC_IsPivotLow(const MqlRates &bars[], int idx, int window)
{
   double level = bars[idx].low;
   for(int j = idx - window; j <= idx + window; j++)
   {
      if(j == idx) continue;
      if(bars[j].low <= level) return false;
   }
   return true;
}

int RC_LoadClosedStructureBars(const string symbol, MqlRates &bars[])
{
   MqlRates series[];
   ArraySetAsSeries(series, true);
   int copied = CopyRates(symbol, RC_StructureTimeframe, 1, RC_SanitizedBarsToScan(), series);
   if(copied <= 0) return 0;
   ArrayResize(bars, copied);
   for(int i = 0; i < copied; i++) bars[i] = series[copied - 1 - i];
   return copied;
}

bool RC_DetectFractalLevels(
   const MqlRates &bars[], int copied, int window,
   double &swingHigh, datetime &swingHighTime,
   double &swingLow,  datetime &swingLowTime)
{
   swingHigh = 0.0; swingHighTime = 0;
   swingLow  = 0.0; swingLowTime  = 0;
   if(window < 1) window = 1;
   if(copied < (2 * window + 3)) return false;
   int lastIdx = copied - 1 - window;
   for(int i = window; i <= lastIdx; i++)
   {
      if(RC_IsPivotHigh(bars, i, window)) { swingHigh = bars[i].high; swingHighTime = bars[i].time; }
      if(RC_IsPivotLow (bars, i, window)) { swingLow  = bars[i].low;  swingLowTime  = bars[i].time; }
   }
   return (swingHighTime > 0 || swingLowTime > 0);
}

void RC_MaybeProcessFractalSignal(const int sym_idx)
{
   if(!RC_EnableLocalFractalSignals) return;
   if(sym_idx < 0 || sym_idx >= rc_sym_count) return;

   int window = RC_SanitizedPivotWindow();
   MqlRates bars[];
   int copied = RC_LoadClosedStructureBars(rc_sym_names[sym_idx], bars);
   if(copied < (2 * window + 3)) return;

   datetime latestClose = bars[copied - 1].time;
   if(latestClose <= 0 || latestClose <= rc_sym_last_structure_close[sym_idx]) return;
   rc_sym_last_structure_close[sym_idx] = latestClose;

   double swingHigh = 0.0; datetime swingHighTime = 0;
   double swingLow  = 0.0; datetime swingLowTime  = 0;
   if(!RC_DetectFractalLevels(bars, copied, window, swingHigh, swingHighTime, swingLow, swingLowTime)) return;

   rc_sym_last_structure_high[sym_idx] = swingHigh;
   rc_sym_last_structure_low[sym_idx]  = swingLow;

   if(!RC_LogFractalSignals) return;
   if(rc_sym_last_structure_signal[sym_idx] >= latestClose) return;

   double closePrice = bars[copied - 1].close;
   string tfLabel    = RC_TimeframeLabel(RC_StructureTimeframe);
   int    digits     = rc_sym_digits[sym_idx];

   if(swingHighTime > 0 && closePrice > swingHigh)
   {
      rc_sym_last_structure_signal[sym_idx] = latestClose;
      Print("⚡ [FRACTAL] ", rc_sym_names[sym_idx], " ", tfLabel,
            " bullish break close=", DoubleToString(closePrice, digits),
            " level=", DoubleToString(swingHigh, digits));
      return;
   }
   if(swingLowTime > 0 && closePrice < swingLow)
   {
      rc_sym_last_structure_signal[sym_idx] = latestClose;
      Print("⚡ [FRACTAL] ", rc_sym_names[sym_idx], " ", tfLabel,
            " bearish break close=", DoubleToString(closePrice, digits),
            " level=", DoubleToString(swingLow, digits));
   }
}

//==========================================================================
// SECTION F — HISTORICAL BULK PUSH
//==========================================================================

bool RC_PushHistoricalBulkSymbol(const int sym_idx, int barsRequested)
{
   if(sym_idx < 0 || sym_idx >= rc_sym_count) return false;
   if(barsRequested <= 0) barsRequested = RC_HistoricalBarsOnInit;
   if(barsRequested <= 0) return false;

   MqlRates r[];
   ArraySetAsSeries(r, true);
   int copied = CopyRates(rc_sym_names[sym_idx], PERIOD_M1, 1, barsRequested, r);
   if(copied <= 0)
   {
      Print("⚠️ [RELAY] CopyRates returned 0 bars for ", rc_sym_names[sym_idx]);
      return false;
   }

   int d = rc_sym_digits[sym_idx];
   string json = "{";
   json += "\"connection_id\":\"" + RC_EscapeJson(RC_RuntimeConnectionId()) + "\",";
   json += "\"bars_requested\":" + IntegerToString(barsRequested) + ",";
   json += "\"symbols\":[{";
   json += "\"symbol\":\"" + RC_EscapeJson(rc_sym_names[sym_idx]) + "\",\"bars\":[";

   int validBars = 0;
   for(int j = copied - 1; j >= 0; j--)
   {
      if(!RC_IsValidRateBar(r[j])) continue;
      if(validBars > 0) json += ",";
      json += "{";
      json += "\"t\":"  + IntegerToString((long)r[j].time)      + ",";
      json += "\"o\":"  + DoubleToString(r[j].open,  d)          + ",";
      json += "\"h\":"  + DoubleToString(r[j].high,  d)          + ",";
      json += "\"l\":"  + DoubleToString(r[j].low,   d)          + ",";
      json += "\"c\":"  + DoubleToString(r[j].close, d)          + ",";
      json += "\"v\":"  + IntegerToString(r[j].tick_volume);
      json += "}";
      validBars++;
   }
   json += "]}]}";

   if(validBars == 0)
   {
      Print("⚠️ [RELAY] no valid bars for ", rc_sym_names[sym_idx]);
      return false;
   }

   if(RC_SignedPost("/historical-bulk", json, 15000))
   {
      rc_sym_last_uploaded_close[sym_idx] = r[0].time;
      rc_sym_last_repair_ms[sym_idx]      = GetTickCount64();
      rc_sym_last_reseed_ms[sym_idx]      = rc_sym_last_repair_ms[sym_idx];
      Print("✅ [RELAY] historical bulk pushed: ", rc_sym_names[sym_idx], " (", validBars, " bars)");
      return true;
   }
   Print("⚠️ [RELAY] historical bulk failed: ", rc_sym_names[sym_idx]);
   return false;
}

void RC_PushHistoricalBulk()
{
   if(rc_sym_count == 0) { rc_historical_seeded = false; return; }
   Print("📦 [RELAY] pushing ", RC_HistoricalBarsOnInit, " × 1m bars for ", rc_sym_count, " symbols...");

   int succeeded = 0;
   for(int i = 0; i < rc_sym_count; i++)
      if(RC_PushHistoricalBulkSymbol(i, RC_HistoricalBarsOnInit)) succeeded++;

   rc_historical_seeded = (succeeded == rc_sym_count);
   if(rc_historical_seeded)
      Print("✅ [RELAY] historical bulk complete: ", succeeded, "/", rc_sym_count);
   else
      Print("❌ [RELAY] historical bulk partial: ", succeeded, "/", rc_sym_count);
}

//==========================================================================
// SECTION G — RELAY RESTART DETECTION
//==========================================================================

void RC_CheckRelayRestart()
{
   string url = RC_RuntimeBackendUrl() + "/health";
   uchar  emptyData[];
   ArrayResize(emptyData, 0);
   uchar  result[];
   string resultHeaders = "";

   ResetLastError();
   int status = WebRequest("GET", url, "", 3000, emptyData, result, resultHeaders);

   if(status != 200)
   {
      if(rc_relay_uptime_prev != -1)
         Print("⚠️ [RELAY] /health unreachable (HTTP ", status, ") — will re-push when back");
      rc_relay_uptime_prev = -1;
      return;
   }

   string resp = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   int pos = StringFind(resp, "\"uptime_s\":");
   if(pos < 0) return;

   string after  = StringSubstr(resp, pos + 11);
   string numStr = "";
   for(int i = 0; i < MathMin(StringLen(after), 20); i++)
   {
      ushort ch = StringGetCharacter(after, i);
      if(ch >= '0' && ch <= '9') { uchar c[] = {(uchar)ch}; numStr += CharArrayToString(c); }
      else if(StringLen(numStr) > 0) break;
   }
   int uptime = (int)StringToDouble(numStr);

   if(rc_relay_uptime_prev == -2)
   {
      rc_relay_uptime_prev = uptime;
      if(!rc_historical_seeded)
      {
         Print("🔄 [RELAY] relay reachable (uptime=", uptime, "s) — seeding history now");
         RC_PushHistoricalBulk();
      }
      else Print("🔗 [RELAY] baseline uptime=", uptime, "s");
   }
   else if(rc_relay_uptime_prev == -1)
   {
      Print("🔄 [RELAY] relay back online (uptime=", uptime, "s) — re-pushing history");
      rc_relay_uptime_prev = uptime;
      RC_PushHistoricalBulk();
   }
   else if(uptime < rc_relay_uptime_prev)
   {
      Print("🔄 [RELAY] relay restarted (", rc_relay_uptime_prev, "→", uptime, "s) — re-pushing history");
      rc_relay_uptime_prev = uptime;
      RC_PushHistoricalBulk();
   }
   else
   {
      rc_relay_uptime_prev = uptime;
      if(!rc_historical_seeded)
      {
         Print("🔄 [RELAY] history still not seeded — retrying");
         RC_PushHistoricalBulk();
      }
   }
}

//==========================================================================
// SECTION H — TICK POLL + BATCH FLUSH
//==========================================================================

void RC_FlushTickBatch(ulong now_ms, bool activeSymbols)
{
   string json = "{";
   json += "\"connection_id\":\"" + RC_EscapeJson(RC_RuntimeConnectionId()) + "\",";
   json += "\"ts_ms\":" + IntegerToString((long)now_ms) + ",";

   int sentIdx[];
   int sentCount = 0;

   // ticks array
   json += "\"ticks\":[";
   int tickCount = 0;
   for(int i = 0; i < rc_sym_count; i++)
   {
      if(RC_IsActiveSymbol(rc_sym_names[i]) != activeSymbols) continue;
      if(!rc_pending_dirty[i]) continue;
      if(!RC_IsValidPriceSnapshot(rc_pending_bid[i], rc_pending_ask[i], rc_pending_msc[i]))
      {
         rc_pending_dirty[i] = false;
         continue;
      }
      if(tickCount > 0) json += ",";
      int d = rc_sym_digits[i];
      json += "{";
      json += "\"symbol\":\"" + RC_EscapeJson(rc_sym_names[i]) + "\",";
      json += "\"bid\":"     + DoubleToString(rc_pending_bid[i], d) + ",";
      json += "\"ask\":"     + DoubleToString(rc_pending_ask[i], d) + ",";
      json += "\"ts_ms\":"   + IntegerToString(rc_pending_msc[i]);
      json += "}";
      ArrayResize(sentIdx, sentCount + 1);
      sentIdx[sentCount++] = i;
      tickCount++;
   }
   json += "],";

   // forming_candles array
   json += "\"forming_candles\":[";
   int added = 0;
   for(int i = 0; i < rc_sym_count; i++)
   {
      if(RC_IsActiveSymbol(rc_sym_names[i]) != activeSymbols) continue;
      MqlRates r[];
      ArraySetAsSeries(r, true);
      if(CopyRates(rc_sym_names[i], PERIOD_M1, 0, 1, r) <= 0) continue;
      if(!RC_IsValidRateBar(r[0])) continue;
      int d = rc_sym_digits[i];
      if(added > 0) json += ",";
      json += "{";
      json += "\"symbol\":\""  + RC_EscapeJson(rc_sym_names[i])          + "\",";
      json += "\"time\":"      + IntegerToString((long)r[0].time)        + ",";
      json += "\"open\":"      + DoubleToString(r[0].open,  d)           + ",";
      json += "\"high\":"      + DoubleToString(r[0].high,  d)           + ",";
      json += "\"low\":"       + DoubleToString(r[0].low,   d)           + ",";
      json += "\"close\":"     + DoubleToString(r[0].close, d)           + ",";
      json += "\"tick_vol\":"  + IntegerToString(r[0].tick_volume);
      json += "}";
      added++;
   }
   json += "]}";

   if(tickCount == 0 && added == 0) return;

   if(RC_SignedPost("/tick-batch", json, 3000))
      for(int i = 0; i < sentCount; i++) rc_pending_dirty[sentIdx[i]] = false;
}

bool RC_SendCandleCloseBar(const string symbol, int sym_idx, const MqlRates &bar)
{
   if(!RC_IsValidRateBar(bar)) { Print("⚠️ [RELAY] invalid candle-close bar: ", symbol); return false; }

   int d = rc_sym_digits[sym_idx];
   string json = "{";
   json += "\"connection_id\":\"" + RC_EscapeJson(RC_RuntimeConnectionId()) + "\",";
   json += "\"symbol\":\""        + RC_EscapeJson(symbol)              + "\",";
   json += "\"timeframe\":\"1m\",";
   json += "\"time\":"            + IntegerToString((long)bar.time)    + ",";
   json += "\"open\":"            + DoubleToString(bar.open,  d)       + ",";
   json += "\"high\":"            + DoubleToString(bar.high,  d)       + ",";
   json += "\"low\":"             + DoubleToString(bar.low,   d)       + ",";
   json += "\"close\":"           + DoubleToString(bar.close, d)       + ",";
   json += "\"tick_vol\":"        + IntegerToString(bar.tick_volume);
   json += "}";

   if(RC_SignedPost("/candle-close", json, 3000))
   {
      rc_sym_last_uploaded_close[sym_idx] = bar.time;
      Print("✅ [RELAY] candle-close ", symbol, " T=", TimeToString(bar.time));
      return true;
   }
   Print("⚠️ [RELAY] candle-close POST failed: ", symbol);
   return false;
}

void RC_PollAllSymbols()
{
   ulong now_ms = GetTickCount64();

   for(int i = 0; i < rc_sym_count; i++)
   {
      MqlTick tick;
      if(!SymbolInfoTick(rc_sym_names[i], tick)) continue;
      if(tick.time_msc <= rc_sym_last_tick_msc[i]) continue;

      rc_sym_last_tick_msc[i] = tick.time_msc;
      rc_pending_bid[i]       = tick.bid;
      rc_pending_ask[i]       = tick.ask;
      rc_pending_msc[i]       = tick.time_msc;
      rc_pending_dirty[i]     = true;

      MqlRates live_rates[];
      ArraySetAsSeries(live_rates, true);
      int live_copied = CopyRates(rc_sym_names[i], PERIOD_M1, 0, 2, live_rates);
      if(live_copied > 0)
      {
         datetime current_bar    = live_rates[0].time;
         datetime latest_closed  = (live_copied > 1) ? live_rates[1].time : 0;

         if(rc_sym_last_bar[i] == 0)
         {
            rc_sym_last_bar[i] = current_bar;
         }
         else if(current_bar > rc_sym_last_bar[i])
         {
            bool advanced = false;
            datetime prev_uploaded = rc_sym_last_uploaded_close[i];
            if(live_copied > 1)
            {
               if(RC_SendCandleCloseBar(rc_sym_names[i], i, live_rates[1]))
               {
                  advanced = true;
                  if(prev_uploaded > 0
                     && (live_rates[1].time - prev_uploaded) > 60
                     && now_ms - rc_sym_last_reseed_ms[i] >= RC_CLOSE_DISCONTINUITY_RESEED_MS)
                  {
                     rc_sym_last_reseed_ms[i] = now_ms;
                     Print("🔄 [RELAY] ", rc_sym_names[i], " stream gap — reseeding history");
                     if(RC_PushHistoricalBulkSymbol(i, RC_RepairBarsToSend()))
                        rc_historical_seeded = true;
                  }
               }
               else if(now_ms - rc_sym_last_repair_ms[i] >= RC_CLOSE_REPAIR_RETRY_MS)
               {
                  rc_sym_last_repair_ms[i] = now_ms;
                  Print("🔄 [RELAY] ", rc_sym_names[i], " candle-close failed — recovery push");
                  if(RC_PushHistoricalBulkSymbol(i, RC_RepairBarsToSend()))
                  {
                     rc_historical_seeded = true;
                     advanced = true;
                  }
               }
            }
            if(advanced) rc_sym_last_bar[i] = current_bar;
         }

         // Repair trigger: too many missed closes
         if(latest_closed > 0 && RC_HistoryRepairTriggerMissedBars > 0
            && RC_HistoryRepairCooldownSec > 0 && RC_RepairBarsToSend() > 0)
         {
            datetime last_up = rc_sym_last_uploaded_close[i];
            int missing = (last_up > 0) ? (int)((latest_closed - last_up) / 60) : RC_HistoryRepairTriggerMissedBars;
            if(missing >= RC_HistoryRepairTriggerMissedBars)
            {
               ulong cooldown = (ulong)RC_HistoryRepairCooldownSec * 1000;
               if(now_ms - rc_sym_last_repair_ms[i] >= cooldown)
               {
                  rc_sym_last_repair_ms[i] = now_ms;
                  Print("🔄 [RELAY] ", rc_sym_names[i], " missing ", missing, " bars — repair push");
                  if(RC_PushHistoricalBulkSymbol(i, RC_RepairBarsToSend()))
                     rc_historical_seeded = true;
               }
            }
         }

         // Periodic sliding-window reseed
         if(latest_closed > 0 && RC_HistoryRefreshWindowSec > 0 && RC_RepairBarsToSend() > 0
            && now_ms - rc_sym_last_reseed_ms[i] >= (ulong)RC_HistoryRefreshWindowSec * 1000)
         {
            rc_sym_last_reseed_ms[i] = now_ms;
            Print("🔄 [RELAY] ", rc_sym_names[i], " periodic reseed");
            if(RC_PushHistoricalBulkSymbol(i, RC_RepairBarsToSend()))
               rc_historical_seeded = true;
         }

         if(latest_closed > 0) RC_MaybeProcessFractalSignal(i);
      }
   }

   // Flush active symbols (high rate)
   if(now_ms - rc_last_flush_ms >= (ulong)MathMax(RC_TickBatchMs, 50))
   {
      RC_FlushTickBatch(now_ms, true);
      rc_last_flush_ms = now_ms;
   }

   // Flush watchlist symbols (lower rate)
   if(now_ms - rc_last_watchlist_flush_ms >= (ulong)MathMax(RC_WatchlistTickBatchMs, RC_TickBatchMs))
   {
      RC_FlushTickBatch(now_ms, false);
      rc_last_watchlist_flush_ms = now_ms;
   }
}

//==========================================================================
// SECTION I — SIGNED HTTP POST + CRYPTO
//==========================================================================

string RC_Sha256Hex(const string text)
{
   uchar data[];
   StringToCharArray(text, data, 0, WHOLE_ARRAY, CP_UTF8);
   if(ArraySize(data) > 0) ArrayResize(data, ArraySize(data) - 1);
   uchar hash[];
   uchar emptyKey[];
   ArrayResize(emptyKey, 0);
   if(CryptEncode(CRYPT_HASH_SHA256, data, emptyKey, hash) <= 0) return "";
   return RC_BytesToHex(hash);
}

string RC_HmacSha256Hex(const string keyStr, const string message)
{
   uchar key[];
   StringToCharArray(keyStr, key, 0, WHOLE_ARRAY, CP_UTF8);
   if(ArraySize(key) > 0) ArrayResize(key, ArraySize(key) - 1);
   uchar emptyKey[];
   ArrayResize(emptyKey, 0);

   if(ArraySize(key) > 64)
   {
      uchar keyHash[];
      if(CryptEncode(CRYPT_HASH_SHA256, key, emptyKey, keyHash) <= 0) return "";
      ArrayResize(key, ArraySize(keyHash));
      ArrayCopy(key, keyHash, 0, 0, WHOLE_ARRAY);
   }

   uchar ipad[64]; uchar opad[64];
   for(int i = 0; i < 64; i++)
   {
      uchar k = (i < ArraySize(key)) ? key[i] : 0;
      ipad[i] = (uchar)(k ^ 0x36);
      opad[i] = (uchar)(k ^ 0x5C);
   }

   uchar msg[];
   StringToCharArray(message, msg, 0, WHOLE_ARRAY, CP_UTF8);
   if(ArraySize(msg) > 0) ArrayResize(msg, ArraySize(msg) - 1);

   uchar inner[];
   ArrayResize(inner, 64 + ArraySize(msg));
   for(int i = 0; i < 64; i++)              inner[i]        = ipad[i];
   for(int i = 0; i < ArraySize(msg); i++)  inner[64 + i]   = msg[i];

   uchar innerHash[];
   if(CryptEncode(CRYPT_HASH_SHA256, inner, emptyKey, innerHash) <= 0) return "";

   uchar outer[];
   ArrayResize(outer, 64 + ArraySize(innerHash));
   for(int i = 0; i < 64; i++)                    outer[i]      = opad[i];
   for(int i = 0; i < ArraySize(innerHash); i++)  outer[64 + i] = innerHash[i];

   uchar hmac[];
   if(CryptEncode(CRYPT_HASH_SHA256, outer, emptyKey, hmac) <= 0) return "";
   return RC_BytesToHex(hmac);
}

string RC_BytesToHex(const uchar &data[])
{
   string out = "";
   for(int i = 0; i < ArraySize(data); i++)
      out += StringFormat("%02X", data[i]);
   return out;
}

bool RC_SignedPost(const string path, const string json, int timeout_ms)
{
   string url       = RC_RuntimeBackendUrl() + path;
   string ts        = IntegerToString((long)TimeGMT() * 1000);
   string nonce     = IntegerToString((long)GetTickCount64());
   string bodyHash  = RC_Sha256Hex(json);
   string sts       = "POST\n" + path + "\n" + ts + "\n" + nonce + "\n" + bodyHash;
   string signature = RC_HmacSha256Hex(rc_signing_secret, sts);

   // Fallback: if signing secret wasn't loaded from bootstrap, use input
   if(StringLen(rc_signing_secret) == 0)
      signature = RC_HmacSha256Hex(RC_SigningSecret, sts);

   string headers  = "Content-Type: application/json\r\n";
   headers += "X-IFX-CONN-ID: "   + RC_RuntimeConnectionId() + "\r\n";
   headers += "X-IFX-TS: "        + ts                       + "\r\n";
   headers += "X-IFX-NONCE: "     + nonce                    + "\r\n";
   headers += "X-IFX-SIGNATURE: " + signature                + "\r\n";

   uchar post[];
   StringToCharArray(json, post, 0, WHOLE_ARRAY, CP_UTF8);
   if(ArraySize(post) > 0) ArrayResize(post, ArraySize(post) - 1);

   uchar result[];
   string resultHeaders = "";
   ResetLastError();
   int status = WebRequest("POST", url, headers, timeout_ms, post, result, resultHeaders);
   int err    = GetLastError();

   if(status >= 200 && status < 300) return true;

   string resp = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   if(status == -1)
      Print("❌ [RELAY] POST ", path, " → HTTP -1 err=", err,
            " | check MT5: Tools→Options→Expert Advisors→Allow WebRequest url=", url);
   else
      Print("❌ [RELAY] POST ", path, " → HTTP ", status, " err=", err,
            " | ", StringSubstr(resp, 0, 120));
   if(status == 400)
      Print("⚠️ [RELAY] bad payload prefix: ", StringSubstr(json, 0, 240));

   return false;
}

//==========================================================================
// SECTION J — PUBLIC LIFECYCLE API
// Call these from the main EA OnInit/OnTick/OnTimer/OnDeinit.
//==========================================================================

// RelayClient_Init — call from OnInit().
// ea_version: string to register with control plane ("IFX_6Gate_Cloud_v1" etc.)
// symbols_csv: comma-separated base symbol names from cloud config (or "" for defaults)
//              e.g. "XAUUSD,EURUSD,GBPUSD,USDJPY"
int RelayClient_Init(const string ea_version, const string symbols_csv = "")
{
   rc_backend_url        = RC_BackendRelayUrl;
   rc_connection_id      = RC_ConnectionId;
   rc_signing_secret     = RC_SigningSecret;
   rc_effective_heartbeat_sec = MathMax(5, RC_ControlPlaneHeartbeatSec);

   // Bootstrap overwrites if valid manifest exists
   RC_LoadBootstrap();

   Print("=== IFX Relay Client ===");
   Print("Relay URL : ", RC_RuntimeBackendUrl());
   Print("Connection: ", RC_RuntimeConnectionId());
   if(RC_EnableLocalFractalSignals)
      Print("🧠 Fractal detector tf=", RC_TimeframeLabel(RC_StructureTimeframe),
            " window=", RC_SanitizedPivotWindow(), " bars=", RC_SanitizedBarsToScan());

   // Apply symbol list from cloud config if provided, else fetch from relay /config
   if(StringLen(symbols_csv) > 0)
   {
      string parts[];
      int count = StringSplit(symbols_csv, ',', parts);
      if(count > 0)
      {
         RC_ApplySymbolList(parts, count);
         Print("✅ [RELAY] symbol list from cloud config (", rc_sym_count, " symbols)");
      }
      else RC_FetchConfig();
   }
   else RC_FetchConfig();

   // Push historical bars (blocking on init — acceptable as MT5 EA init is synchronous)
   RC_PushHistoricalBulk();

   ulong now_ms = GetTickCount64();
   rc_last_flush_ms           = now_ms;
   rc_last_watchlist_flush_ms = now_ms;
   rc_last_config_ms          = now_ms;
   rc_last_health_ms          = now_ms;
   rc_last_register_attempt_ms  = 0;
   rc_last_heartbeat_attempt_ms = 0;

   RC_MaybeSyncControlPlane(ea_version);

   Print("✅ [RELAY] monitoring ", rc_sym_count, " symbols");
   return INIT_SUCCEEDED;
}

// RelayClient_Tick — call from OnTick() for fast-path chart-symbol ticks
void RelayClient_Tick(const string ea_version)
{
   RC_PollAllSymbols();
}

// RelayClient_Timer — call from OnTimer() (1s recommended)
// ea_version: passed to control plane heartbeat/register
void RelayClient_Timer(const string ea_version)
{
   RC_PollAllSymbols();
   RC_MaybeSyncControlPlane(ea_version);

   ulong now_ms = GetTickCount64();

   if(now_ms - rc_last_config_ms >= (ulong)RC_ConfigRefreshSec * 1000)
   {
      RC_FetchConfig();
      rc_last_config_ms = now_ms;
   }

   if(now_ms - rc_last_health_ms >= 10000)
   {
      RC_CheckRelayRestart();
      rc_last_health_ms = now_ms;
   }
}

// RelayClient_Deinit — call from OnDeinit()
void RelayClient_Deinit()
{
   // Nothing to flush — EA timer is killed by the MQL5 runtime after OnDeinit returns.
   // Resource cleanup if needed in future goes here.
}

// RelayClient_GetSymCount — number of monitored symbols after resolution
int RelayClient_GetSymCount()  { return rc_sym_count; }

// RelayClient_GetSymName — get resolved broker symbol name at index
string RelayClient_GetSymName(int idx)
{
   if(idx < 0 || idx >= rc_sym_count) return "";
   return rc_sym_names[idx];
}

// RelayClient_GetSwingHigh/Low — latest fractal levels for chart symbol
double RelayClient_GetSwingHigh(const string symbol)
{
   for(int i = 0; i < rc_sym_count; i++)
      if(rc_sym_names[i] == symbol) return rc_sym_last_structure_high[i];
   return 0.0;
}
double RelayClient_GetSwingLow(const string symbol)
{
   for(int i = 0; i < rc_sym_count; i++)
      if(rc_sym_names[i] == symbol) return rc_sym_last_structure_low[i];
   return 0.0;
}

// RelayClient_GetConnectionId — bootstrap-resolved connection UUID.
// Falls back to the RC_ConnectionId input if manifest was not loaded.
string RelayClient_GetConnectionId()
{
   return RC_RuntimeConnectionId();
}

// RelayClient_GetInstallToken — install token from bootstrap manifest.
// Used as Bearer auth when calling the dashboard /api/ea/config endpoint.
string RelayClient_GetInstallToken()
{
   return rc_install_token;
}

#endif // IFX_RELAY_CLIENT_MQH
//+------------------------------------------------------------------+
