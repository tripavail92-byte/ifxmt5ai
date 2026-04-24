//+------------------------------------------------------------------+
//|  IFX_Railway_Bridge_v1.mq5                                      |
//|  Railway-only multi-symbol tick bridge for IFX terminals         |
//|  Architecture: OnTick() + EventSetMillisecondTimer(50)           |
//|  Target: Public Railway ingest and control plane                 |
//|                                                                  |
//|  SETUP: In MT5 -> Tools -> Options -> Expert Advisors            |
//|    Add https://ifx-mt5-portal-production.up.railway.app to the   |
//|    "Allow WebRequest for listed URL" list.                      |
//|    BackendRelayUrl must point to the /api/mt5 base path.         |
//|    SigningSecret should be the scoped install token/secret.      |
//+------------------------------------------------------------------+
#property strict
#property version   "4.0"
#property description "IFX Railway Bridge v1 - Multi-symbol tick relay -> public Railway"

#include <Trade\Trade.mqh>

//==========================================================================
// SECTION 1 — INPUTS
//==========================================================================
input string  BackendRelayUrl      = "https://ifx-mt5-portal-production.up.railway.app/api/mt5"; // Public Railway relay base URL
input string  ConnectionId         = "";                         // Set the assigned MT5 connection UUID
input string  SigningSecret        = "";                         // Set the scoped install token/signing secret
input int     TickBatchMs          = 250;                        // Active symbol snapshot flush interval (ms)
input int     WatchlistTickBatchMs = 500;                        // Watchlist symbol snapshot flush interval (ms)
input string  ActiveSymbolsCsv     = "EURUSDm,XAUUSDm,USDJPYm,AUDUSDm,USOILm,GBPUSDm,BTCUSDm,ETHUSDm,USDCHFm,USDCADm,NZDUSDm,EURGBPm"; // Preferred high-rate symbols (max 12); attached chart symbol is always active
input bool    LatestTickOnlyPerFlush = true;                    // Keep only the newest tick per symbol in each flush window
input int     HistoricalBarsOnInit = 500;                        // 1m bars to push on startup
input int     ConfigRefreshSec     = 60;                         // Symbol list refresh interval
input int     HistoryRepairBars    = 240;                        // Recent 1m bars to re-push when candle-close uploads stall
input int     HistoryRepairCooldownSec = 120;                    // Minimum delay between per-symbol repair attempts
input int     HistoryRepairTriggerMissedBars = 3;                // Re-push history after this many closed bars are missing
input int     HistoryRefreshWindowSec = 300;                     // Periodically re-push a recent 1m window even when close uploads look healthy
input bool    EnableAccountHeartbeat = true;                     // Post account metrics so the UI can show real balance/equity
input int     AccountHeartbeatSec = 30;                          // Heartbeat interval for account metrics
input bool    EnableOneShotFullHistoryReseed = true;             // Retry one full historical seed until all configured symbols succeed
input int     OneShotFullHistoryReseedRetrySec = 15;             // Delay between full reseed attempts while the relay is recovering
input bool    EnableLocalFractalSignals = true;                  // Run a minimal local structure detector inside the EA
input ENUM_TIMEFRAMES StructureTimeframe = PERIOD_M5;            // Timeframe for local fractal break detection
input int     StructurePivotWindow = 2;                          // Fractal confirmation width on each side of the pivot
input int     StructureBarsToScan = 120;                         // Closed candles fetched per symbol for structure analysis
input bool    LogFractalSignals = true;                          // Print local bullish/bearish fractal breaks to Experts log

const ulong IFX_COMMAND_MAGIC = 918041;
CTrade g_trade;

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
ulong    g_sym_last_reseed_ms[];      // Last per-symbol sliding-window reseed timestamp
datetime g_sym_last_structure_close[]; // Last closed structure candle analyzed
datetime g_sym_last_structure_signal[]; // Last closed structure candle that emitted a break
double   g_sym_last_structure_high[]; // Latest confirmed fractal swing high
double   g_sym_last_structure_low[];  // Latest confirmed fractal swing low

int      g_sym_count     = 0;
ulong    g_last_flush_ms = 0;
ulong    g_last_watchlist_flush_ms = 0;
ulong    g_last_config_ms= 0;
ulong    g_last_health_ms = 0;  // Last /health check timestamp
ulong    g_last_account_heartbeat_ms = 0;
ulong    g_last_full_reseed_attempt_ms = 0;
int      g_relay_uptime_prev = -2; // -2=first-run  -1=was-down  >=0=last-uptime
bool     g_historical_seeded = false; // true once /historical-bulk succeeds
bool     g_control_plane_ready = false;
bool     g_one_shot_full_reseed_pending = true;
bool     g_runtime_loop_armed = false;
bool     g_initial_config_fetch_pending = true;
bool     g_initial_history_seed_pending = true;
bool     g_registration_pending = true;
bool     g_registration_complete = false;
string   g_install_token = "";
string   g_register_url = "";
string   g_heartbeat_url = "";
string   g_config_url = "";
string   g_commands_url = "";
string   g_command_ack_url = "";
string   g_events_url = "";
string   g_trade_audit_url = "";
int      g_last_config_version = 0;
int      g_last_command_sequence = 0;
int      g_effective_config_refresh_sec = 0;
int      g_effective_command_poll_sec = 0;
int      g_effective_account_heartbeat_sec = 0;
ulong    g_last_command_poll_ms = 0;
ulong    g_startup_ms = 0;
ulong    g_last_timer_trace_ms = 0;
bool     g_trade_execution_enabled = false;
bool     g_trade_disable_kill_switch = false;
bool     g_allow_market_orders = true;
bool     g_allow_pending_orders = true;
double   g_rr_target = 2.0;
double   g_risk_percent = 1.0;
int      g_max_daily_trades = 3;
double   g_max_position_size_lots = 0.0;
string   g_setup_bias = "neutral";
double   g_setup_pivot = 0.0;
double   g_setup_tp1 = 0.0;
double   g_setup_tp2 = 0.0;
double   g_setup_entry_price_hint = 0.0;
bool     g_armed_trade_active = false;
string   g_armed_setup_id = "";
string   g_armed_symbol = "";
string   g_armed_side = "";
string   g_armed_notes = "";

// ── Config-driven trading gates ──────────────────────────────────────────
bool     g_session_london_enabled = true;
bool     g_session_ny_enabled     = true;
bool     g_session_asia_enabled   = false;
bool     g_close_eod              = false;
string   g_eod_time_str           = "23:50";     // "HH:MM" server time
bool     g_eod_closed_today       = false;
datetime g_eod_last_close_day     = 0;
double   g_sl_pad_mult            = 0.2;
ENUM_TIMEFRAMES g_engine_tf       = PERIOD_M1;
bool     g_min_confidence_gate    = false;
double   g_min_confidence         = 0.0;

void AppendDiagLog(const string message)
{
   int handle = FileOpen("ifx\\diag.log", FILE_READ | FILE_WRITE | FILE_TXT | FILE_ANSI, 0, CP_UTF8);
   if(handle == INVALID_HANDLE)
      handle = FileOpen("ifx\\diag.log", FILE_WRITE | FILE_TXT | FILE_ANSI, 0, CP_UTF8);
   if(handle == INVALID_HANDLE)
      return;

   FileSeek(handle, 0, SEEK_END);
   FileWriteString(handle, TimeToString(TimeLocal(), TIME_DATE | TIME_SECONDS) + " | " + message + "\r\n");
   FileClose(handle);
}
string   g_armed_timeframe = "";
double   g_armed_entry_price = 0.0;
int      g_armed_ai_sensitivity = 0;
datetime g_armed_armed_at = 0;

#define CLOSE_REPAIR_RETRY_MS 5000
#define CLOSE_DISCONTINUITY_RESEED_MS 30000

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

string NormalizeSymbolAlias(const string value)
{
   string compact = "";
   string upper = TrimSpaces(value);
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

   int len = StringLen(compact);
   if(len > 5 && StringSubstr(compact, len - 5) == "MICRO")
      compact = StringSubstr(compact, 0, len - 5);

   len = StringLen(compact);
   if(len > 4 && StringSubstr(compact, len - 4) == "MINI")
      compact = StringSubstr(compact, 0, len - 4);

   len = StringLen(compact);
   if(len > 6 && StringSubstr(compact, len - 1) == "M")
      compact = StringSubstr(compact, 0, len - 1);

   return compact;
}

int SymbolAliasMatchScore(const string requested, const string candidate)
{
   string trimmedRequested = TrimSpaces(requested);
   string trimmedCandidate = TrimSpaces(candidate);
   if(StringLen(trimmedRequested) == 0 || StringLen(trimmedCandidate) == 0)
      return -1;

   if(trimmedRequested == trimmedCandidate)
      return 0;

   string normalizedRequested = NormalizeSymbolAlias(trimmedRequested);
   string normalizedCandidate = NormalizeSymbolAlias(trimmedCandidate);
   if(StringLen(normalizedRequested) == 0 || StringLen(normalizedCandidate) == 0)
      return -1;

   if(normalizedRequested == normalizedCandidate)
      return 1 + MathAbs(StringLen(trimmedCandidate) - StringLen(trimmedRequested));

   int diff = MathAbs(StringLen(normalizedRequested) - StringLen(normalizedCandidate));
   if(diff <= 4)
   {
      if(StringFind(normalizedCandidate, normalizedRequested) == 0)
         return 10 + diff;
      if(StringFind(normalizedRequested, normalizedCandidate) == 0)
         return 10 + diff;
   }

   return -1;
}

bool ResolveBrokerSymbol(const string requested, string &resolved)
{
   resolved = TrimSpaces(requested);
   if(StringLen(resolved) == 0)
      return false;

   if(SymbolSelect(resolved, true))
      return true;

   string best = "";
   int best_score = 1000000;

   for(int pass = 0; pass < 2; pass++)
   {
      bool selected_only = (pass == 0);
      int total = SymbolsTotal(selected_only);
      for(int i = 0; i < total; i++)
      {
         string candidate = SymbolName(i, selected_only);
         int score = SymbolAliasMatchScore(resolved, candidate);
         if(score < 0 || score >= best_score)
            continue;
         best = candidate;
         best_score = score;
      }
   }

   if(StringLen(best) == 0)
      return false;
   if(!SymbolSelect(best, true))
      return false;

   resolved = best;
   return true;
}

bool ActiveArrayContains(const string sym)
{
   for(int i = 0; i < g_active_symbol_count; i++)
      if(g_active_symbols[i] == sym)
         return true;
   return false;
}

string EscapeJson(const string value)
{
   string escaped = value;
   StringReplace(escaped, "\\", "\\\\");
   StringReplace(escaped, "\"", "\\\"");
   StringReplace(escaped, "\r", "");
   StringReplace(escaped, "\n", " ");
   return escaped;
}

bool IsFiniteJsonNumber(const double value)
{
   return MathIsValidNumber(value);
}

bool IsValidPriceSnapshot(const double bid, const double ask, const long ts_ms)
{
   if(ts_ms <= 0)
      return false;
   if(!IsFiniteJsonNumber(bid) || !IsFiniteJsonNumber(ask))
      return false;
   if(bid <= 0.0 || ask <= 0.0)
      return false;
   return true;
}

bool IsValidRateBar(const MqlRates &bar)
{
   if(bar.time <= 0)
      return false;
   if(!IsFiniteJsonNumber(bar.open) || !IsFiniteJsonNumber(bar.high)
      || !IsFiniteJsonNumber(bar.low) || !IsFiniteJsonNumber(bar.close))
      return false;
   if(bar.open <= 0.0 || bar.high <= 0.0 || bar.low <= 0.0 || bar.close <= 0.0)
      return false;
   return true;
}

string JsonExtractStringAfter(const string json, int from_pos, const string key)
{
   string marker = "\"" + key + "\"";
   int key_pos = StringFind(json, marker, from_pos);
   if(key_pos < 0)
      return "";

   int colon_pos = StringFind(json, ":", key_pos + StringLen(marker));
   if(colon_pos < 0)
      return "";

   int start = colon_pos + 1;
   while(start < StringLen(json))
   {
      ushort ch = StringGetCharacter(json, start);
      if(ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n')
      {
         start++;
         continue;
      }
      break;
   }

   if(start >= StringLen(json) || StringGetCharacter(json, start) != '"')
      return "";

   start++;
   int finish = start;
   while(finish < StringLen(json))
   {
      if(StringGetCharacter(json, finish) == '"')
         break;
      finish++;
   }

   if(finish <= start)
      return "";

   return StringSubstr(json, start, finish - start);
}

int FindMatchingJsonToken(const string json, int start_pos, ushort open_char, ushort close_char)
{
   int depth = 0;
   for(int i = start_pos; i < StringLen(json); i++)
   {
      ushort ch = StringGetCharacter(json, i);
      if(ch == open_char)
         depth++;
      else if(ch == close_char)
      {
         depth--;
         if(depth == 0)
            return i;
      }
   }
   return -1;
}

string JsonExtractObjectAfter(const string json, int from_pos, const string key)
{
   string marker = "\"" + key + "\"";
   int key_pos = StringFind(json, marker, from_pos);
   if(key_pos < 0)
      return "";

   int colon_pos = StringFind(json, ":", key_pos + StringLen(marker));
   if(colon_pos < 0)
      return "";

   int start = colon_pos + 1;
   while(start < StringLen(json))
   {
      ushort ch = StringGetCharacter(json, start);
      if(ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n')
      {
         start++;
         continue;
      }
      break;
   }

   if(start >= StringLen(json) || StringGetCharacter(json, start) != '{')
      return "";

   int finish = FindMatchingJsonToken(json, start, '{', '}');
   if(finish < start)
      return "";

   return StringSubstr(json, start, finish - start + 1);
}

string JsonExtractArrayAfter(const string json, int from_pos, const string key)
{
   string marker = "\"" + key + "\"";
   int key_pos = StringFind(json, marker, from_pos);
   if(key_pos < 0)
      return "";

   int colon_pos = StringFind(json, ":", key_pos + StringLen(marker));
   if(colon_pos < 0)
      return "";

   int start = colon_pos + 1;
   while(start < StringLen(json))
   {
      ushort ch = StringGetCharacter(json, start);
      if(ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n')
      {
         start++;
         continue;
      }
      break;
   }

   if(start >= StringLen(json) || StringGetCharacter(json, start) != '[')
      return "";

   int finish = FindMatchingJsonToken(json, start, '[', ']');
   if(finish < start)
   {
      // Closing bracket not found — response may be truncated by MQL5's string handling.
      // Return the partial array so callers can still iterate over complete {…} objects.
      int remaining = StringLen(json) - start;
      if(remaining > 0)
         return StringSubstr(json, start, remaining);
      return "";
   }

   return StringSubstr(json, start, finish - start + 1);
}

int JsonExtractIntAfter(const string json, int from_pos, const string key, int fallback)
{
   string marker = "\"" + key + "\"";
   int key_pos = StringFind(json, marker, from_pos);
   if(key_pos < 0)
      return fallback;

   int colon_pos = StringFind(json, ":", key_pos + StringLen(marker));
   if(colon_pos < 0)
      return fallback;

   int start = colon_pos + 1;
   while(start < StringLen(json))
   {
      ushort ch = StringGetCharacter(json, start);
      if(ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n')
      {
         start++;
         continue;
      }
      break;
   }

   string num = "";
   for(int i = start; i < StringLen(json); i++)
   {
      ushort ch = StringGetCharacter(json, i);
      if((ch >= '0' && ch <= '9') || ch == '-')
      {
         uchar c[] = {(uchar)ch};
         num += CharArrayToString(c);
      }
      else if(StringLen(num) > 0)
      {
         break;
      }
      else if(ch != ' ' && ch != '\t' && ch != '\r' && ch != '\n')
      {
         break;
      }
   }

   if(StringLen(num) == 0)
      return fallback;

   return (int)StringToInteger(num);
}

double JsonExtractDoubleAfter(const string json, int from_pos, const string key, double fallback)
{
   string marker = "\"" + key + "\"";
   int key_pos = StringFind(json, marker, from_pos);
   if(key_pos < 0)
      return fallback;

   int colon_pos = StringFind(json, ":", key_pos + StringLen(marker));
   if(colon_pos < 0)
      return fallback;

   int start = colon_pos + 1;
   while(start < StringLen(json))
   {
      ushort ch = StringGetCharacter(json, start);
      if(ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n')
      {
         start++;
         continue;
      }
      break;
   }

   string num = "";
   for(int i = start; i < StringLen(json); i++)
   {
      ushort ch = StringGetCharacter(json, i);
      if((ch >= '0' && ch <= '9') || ch == '-' || ch == '.')
      {
         uchar c[] = {(uchar)ch};
         num += CharArrayToString(c);
      }
      else if(StringLen(num) > 0)
      {
         break;
      }
      else if(ch != ' ' && ch != '\t' && ch != '\r' && ch != '\n')
      {
         break;
      }
   }

   if(StringLen(num) == 0)
      return fallback;

   return StringToDouble(num);
}

bool JsonExtractBoolAfter(const string json, int from_pos, const string key, bool fallback)
{
   string marker = "\"" + key + "\"";
   int key_pos = StringFind(json, marker, from_pos);
   if(key_pos < 0)
      return fallback;

   int colon_pos = StringFind(json, ":", key_pos + StringLen(marker));
   if(colon_pos < 0)
      return fallback;

   int start = colon_pos + 1;
   while(start < StringLen(json))
   {
      ushort ch = StringGetCharacter(json, start);
      if(ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n')
      {
         start++;
         continue;
      }
      break;
   }

   string lower = StringSubstr(json, start, 5);
   StringToLower(lower);
   if(StringFind(lower, "true") == 0)
      return true;
   if(StringFind(lower, "false") == 0)
      return false;
   return fallback;
}

int ParseJsonStringArray(const string array_json, string &values[])
{
   ArrayResize(values, 0);
   if(StringLen(array_json) < 2)
      return 0;

   int count = 0;
   int cursor = 0;
   while(true)
   {
      int start = StringFind(array_json, "\"", cursor);
      if(start < 0)
         break;
      int finish = StringFind(array_json, "\"", start + 1);
      if(finish <= start)
         break;
      string value = StringSubstr(array_json, start + 1, finish - start - 1);
      if(StringLen(value) > 0)
      {
         ArrayResize(values, count + 1);
         values[count++] = value;
      }
      cursor = finish + 1;
   }
   return count;
}

void ApplyHighPrioritySymbolsFromJson(const string array_json)
{
   string parsed[];
   int count = ParseJsonStringArray(array_json, parsed);
   ArrayResize(g_active_symbols, 0);
   g_active_symbol_count = 0;

   for(int i = 0; i < count; i++)
   {
      string sym = "";
      if(!ResolveBrokerSymbol(parsed[i], sym))
         continue;
      if(StringLen(sym) == 0 || ActiveArrayContains(sym))
         continue;
      if(g_active_symbol_count >= MAX_ACTIVE_SYMBOLS)
         break;

      ArrayResize(g_active_symbols, g_active_symbol_count + 1);
      g_active_symbols[g_active_symbol_count++] = sym;
   }
}

bool ReadTextFileUtf8(const string relative_path, string &content)
{
   content = "";
   int handle = FileOpen(relative_path, FILE_READ | FILE_TXT | FILE_ANSI, 0, CP_UTF8);
   if(handle == INVALID_HANDLE)
      return false;

   while(!FileIsEnding(handle))
      content += FileReadString(handle);

   FileClose(handle);
   return StringLen(content) > 0;
}

bool LoadControlPlaneHeartbeatBootstrap()
{
   string manifest = "";
   if(!ReadTextFileUtf8("ifx\\bootstrap.json", manifest))
      return false;

   int control_pos = StringFind(manifest, "\"control_plane\"");
   g_install_token = JsonExtractStringAfter(manifest, 0, "install_token");
   g_register_url = JsonExtractStringAfter(manifest, control_pos, "register_url");
   g_heartbeat_url = JsonExtractStringAfter(manifest, control_pos, "heartbeat_url");
   g_config_url = JsonExtractStringAfter(manifest, control_pos, "config_url");
   g_commands_url = JsonExtractStringAfter(manifest, control_pos, "commands_url");
   g_command_ack_url = JsonExtractStringAfter(manifest, control_pos, "command_ack_url");
   g_events_url = JsonExtractStringAfter(manifest, control_pos, "events_url");
   g_trade_audit_url = JsonExtractStringAfter(manifest, control_pos, "trade_audit_url");
   g_control_plane_ready = (StringLen(g_install_token) > 0 && StringLen(g_heartbeat_url) > 0);

   if(g_control_plane_ready)
      Print("✅ [HEARTBEAT] control-plane heartbeat bootstrap loaded");

   return g_control_plane_ready;
}

bool ControlPlanePost(const string url, const string json, int timeout_ms)
{
   if(StringLen(url) == 0 || StringLen(g_install_token) == 0)
   {
      AppendDiagLog("ControlPlanePost skipped url/token missing");
      return false;
   }

   string headers = "Content-Type: application/json\r\n";
   headers += "X-IFX-INSTALL-TOKEN: " + g_install_token + "\r\n";

   uchar post[];
   StringToCharArray(json, post, 0, WHOLE_ARRAY, CP_UTF8);
   if(ArraySize(post) > 0)
      ArrayResize(post, ArraySize(post) - 1);

   uchar result[];
   string resultHeaders = "";

   ResetLastError();
   int status = WebRequest("POST", url, headers, timeout_ms, post, result, resultHeaders);
   int err = GetLastError();

   if(status >= 200 && status < 300)
   {
      AppendDiagLog("ControlPlanePost ok url=" + url);
      return true;
   }

   string resp = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   if(status == -1)
      Print("❌ [HEARTBEAT] POST failed err=", err, " | url=", url);
   else
      Print("❌ [HEARTBEAT] POST ", url, " → HTTP ", status, " err=", err, " | ", StringSubstr(resp, 0, 120));
   AppendDiagLog("ControlPlanePost failed status=" + IntegerToString(status) + " err=" + IntegerToString(err) + " url=" + url + " resp=" + StringSubstr(resp, 0, 120));
   return false;
}

bool ControlPlaneGet(const string url, string &response, int timeout_ms)
{
   response = "";
   if(StringLen(url) == 0 || StringLen(g_install_token) == 0)
   {
      AppendDiagLog("ControlPlaneGet skipped url/token missing");
      return false;
   }

   string headers = "X-IFX-INSTALL-TOKEN: " + g_install_token + "\r\n";
   uchar emptyData[];
   ArrayResize(emptyData, 0);
   uchar result[];
   string resultHeaders = "";

   ResetLastError();
   int status = WebRequest("GET", url, headers, timeout_ms, emptyData, result, resultHeaders);
   int err = GetLastError();
   response = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);

   if(status >= 200 && status < 300)
   {
      AppendDiagLog("ControlPlaneGet ok url=" + url + " bytes=" + IntegerToString(StringLen(response)));
      return true;
   }

   if(status == -1)
      Print("❌ [CONTROL] GET failed err=", err, " | url=", url);
   else
      Print("❌ [CONTROL] GET ", url, " → HTTP ", status, " err=", err, " | ", StringSubstr(response, 0, 120));
   AppendDiagLog("ControlPlaneGet failed status=" + IntegerToString(status) + " err=" + IntegerToString(err) + " url=" + url + " resp=" + StringSubstr(response, 0, 120));
   return false;
}

bool SendAccountHeartbeat()
{
   if(!EnableAccountHeartbeat || !g_control_plane_ready)
      return false;

   string accountLogin = IntegerToString((int)AccountInfoInteger(ACCOUNT_LOGIN));
   string terminalPath = EscapeJson(TerminalInfoString(TERMINAL_DATA_PATH));
   double margin = AccountInfoDouble(ACCOUNT_MARGIN);
   double marginLevel = margin > 0.0 ? AccountInfoDouble(ACCOUNT_MARGIN_LEVEL) : 0.0;
   string openPositions = "[";
   bool firstPosition = true;
   int totalPositions = PositionsTotal();
   for(int i = 0; i < totalPositions; i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0 || !PositionSelectByTicket(ticket))
         continue;

      string symbol = PositionGetString(POSITION_SYMBOL);
      int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
      string side = PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? "buy" : "sell";
      string slJson = PositionGetDouble(POSITION_SL) > 0.0 ? DoubleToString(PositionGetDouble(POSITION_SL), digits) : "null";
      string tpJson = PositionGetDouble(POSITION_TP) > 0.0 ? DoubleToString(PositionGetDouble(POSITION_TP), digits) : "null";

      if(!firstPosition)
         openPositions += ",";

      openPositions += StringFormat(
         "{\"ticket\":%I64u,\"symbol\":\"%s\",\"type\":\"%s\",\"volume\":%.2f,\"open_price\":%s,\"current_price\":%s,\"sl\":%s,\"tp\":%s,\"profit\":%.2f,\"swap\":%.2f,\"open_time\":%I64d,\"comment\":\"%s\"}",
         ticket,
         EscapeJson(symbol),
         EscapeJson(side),
         PositionGetDouble(POSITION_VOLUME),
         DoubleToString(PositionGetDouble(POSITION_PRICE_OPEN), digits),
         DoubleToString(PositionGetDouble(POSITION_PRICE_CURRENT), digits),
         slJson,
         tpJson,
         PositionGetDouble(POSITION_PROFIT),
         PositionGetDouble(POSITION_SWAP),
         (long)PositionGetInteger(POSITION_TIME),
         EscapeJson(PositionGetString(POSITION_COMMENT))
      );
      firstPosition = false;
   }
   openPositions += "]";

   string json = "{";
   json += "\"connection_id\":\"" + EscapeJson(ConnectionId) + "\",";
   json += "\"status\":\"online\",";
   json += "\"terminal_path\":\"" + terminalPath + "\",";
   json += "\"account_login\":\"" + accountLogin + "\",";
   json += "\"metrics\":{";
   json += "\"account_login\":\"" + accountLogin + "\",";
   json += "\"balance\":" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + ",";
   json += "\"equity\":" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) + ",";
   json += "\"margin\":" + DoubleToString(margin, 2) + ",";
   json += "\"free_margin\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2) + ",";
   json += "\"margin_level\":" + DoubleToString(marginLevel, 2) + ",";
   json += "\"profit\":" + DoubleToString(AccountInfoDouble(ACCOUNT_PROFIT), 2) + ",";
   json += "\"open_positions\":" + openPositions + ",";
   json += "\"daily_trades\":" + IntegerToString(CountTodayExecutedTrades()) + ",";
   json += "\"host\":\"mt5-ea\",";
   json += "\"pid\":0,";
   json += "\"mt5_initialized\":true";
   json += "}}";

   if(ControlPlanePost(g_heartbeat_url, json, 5000))
   {
      Print("✅ [HEARTBEAT] balance=", DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2),
            " equity=", DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2));
      return true;
   }
   return false;
}

bool RegisterControlPlaneInstallation()
{
   if(!g_control_plane_ready || StringLen(g_register_url) == 0)
   {
      AppendDiagLog("RegisterControlPlaneInstallation skipped ready/url missing");
      return false;
   }

   string accountLogin = IntegerToString((int)AccountInfoInteger(ACCOUNT_LOGIN));
   string terminalPath = EscapeJson(TerminalInfoString(TERMINAL_DATA_PATH));
   string json = "{";
   json += "\"connection_id\":\"" + EscapeJson(ConnectionId) + "\",";
   json += "\"terminal_path\":\"" + terminalPath + "\",";
   json += "\"ea_version\":\"4.0\",";
   json += "\"metadata\":{";
   json += "\"account_login\":\"" + EscapeJson(accountLogin) + "\",";
   json += "\"terminal_path\":\"" + terminalPath + "\"";
   json += "}}";

   if(ControlPlanePost(g_register_url, json, 5000))
   {
      g_registration_complete = true;
      g_registration_pending = false;
      Print("✅ [CONTROL] installation registered account=", accountLogin);
      AppendDiagLog("RegisterControlPlaneInstallation ok account=" + accountLogin);
      return true;
   }

   AppendDiagLog("RegisterControlPlaneInstallation failed account=" + accountLogin);
   return false;
}

void MaybeRegisterControlPlaneInstallation()
{
   if(!g_registration_pending)
      return;
   if(!g_control_plane_ready && !LoadControlPlaneHeartbeatBootstrap())
      return;

   RegisterControlPlaneInstallation();
}

void MaybeSendAccountHeartbeat(const ulong now_ms)
{
   if(!EnableAccountHeartbeat)
      return;
   MaybeRegisterControlPlaneInstallation();
   if(!g_registration_complete)
      return;
   if(!g_control_plane_ready && !LoadControlPlaneHeartbeatBootstrap())
      return;

   ulong interval_ms = (ulong)MathMax(5, g_effective_account_heartbeat_sec) * 1000;
   if(g_last_account_heartbeat_ms == 0 || now_ms - g_last_account_heartbeat_ms >= interval_ms)
   {
      if(SendAccountHeartbeat())
         g_last_account_heartbeat_ms = now_ms;
   }
}

void MaybeRunOneShotFullHistoryReseed(const ulong now_ms)
{
   if(!EnableOneShotFullHistoryReseed || !g_one_shot_full_reseed_pending)
      return;
   if(g_sym_count <= 0)
      return;

   ulong retry_ms = (ulong)MathMax(5, OneShotFullHistoryReseedRetrySec) * 1000;
   if(g_last_full_reseed_attempt_ms > 0 && now_ms - g_last_full_reseed_attempt_ms < retry_ms)
      return;

   g_last_full_reseed_attempt_ms = now_ms;
   Print("🔄 [RESEED-ALL] attempting one-shot full historical reseed for ", g_sym_count, " symbols");
   PushHistoricalBulk();
   if(g_historical_seeded)
   {
      g_one_shot_full_reseed_pending = false;
      Print("✅ [RESEED-ALL] full historical reseed completed");
   }
   else
   {
      Print("⚠️ [RESEED-ALL] full historical reseed incomplete — will retry");
   }
}

void RunControlPlaneLoop(const ulong now_ms)
{
   MaybeRegisterControlPlaneInstallation();

   ulong command_poll_ms = (ulong)MathMax(5, g_effective_command_poll_sec) * 1000;
   if(g_last_command_poll_ms == 0 || now_ms - g_last_command_poll_ms >= command_poll_ms)
   {
      PollEaCommands();
      g_last_command_poll_ms = now_ms;
   }

   if(now_ms - g_last_config_ms >= (ulong)g_effective_config_refresh_sec * 1000)
   {
      FetchConfig();
      g_last_config_ms = now_ms;
   }

   if(now_ms - g_last_health_ms >= 10000)
   {
      CheckRelayRestart();
      g_last_health_ms = now_ms;
   }

   MaybeSendAccountHeartbeat(now_ms);
   MaybeRunOneShotFullHistoryReseed(now_ms);
   MaybeCloseEod();
}

void MaybeCloseEod()
{
   if(!g_close_eod) return;

   MqlDateTime now_dt;
   TimeToStruct(TimeCurrent(), now_dt);
   datetime today = StructToTime(now_dt) - (now_dt.hour * 3600 + now_dt.min * 60 + now_dt.sec);

   if(g_eod_last_close_day == today && g_eod_closed_today) return;
   if(g_eod_last_close_day != today) { g_eod_closed_today = false; g_eod_last_close_day = today; }

   #define PARSE_HM2(s) (((int)StringToInteger(StringSubstr(s,0,2)))*60 + (int)StringToInteger(StringSubstr(s,3,2)))
   int eod_min = PARSE_HM2(g_eod_time_str);
   int now_min  = now_dt.hour * 60 + now_dt.min;
   if(now_min < eod_min) return;

   int closed = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(!PositionSelectByTicket(ticket)) continue;
      if(g_trade.PositionClose(ticket, 50))
         closed++;
   }
   g_eod_closed_today = true;
   if(closed > 0)
   {
      SendEaRuntimeEvent("eod_close", StringFormat("{\"closed\":%d,\"eod_time\":\"%s\"}", closed, EscapeJson(g_eod_time_str)));
      Print("⏰ [EOD] Closed ", closed, " position(s) at ", g_eod_time_str, " server time");
   }
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
      string requested = TrimSpaces(parts[i]);
      string sym = "";
      if(StringLen(requested) == 0)
         continue;
      if(!ResolveBrokerSymbol(requested, sym))
      {
         Print("⚠️ [ACTIVE] symbol alias not available: ", requested);
         continue;
      }
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

bool ApplyControlPlaneConfig(const string response)
{
   int version = JsonExtractIntAfter(response, 0, "version", g_last_config_version);
   string config = JsonExtractObjectAfter(response, 0, "config");
   if(StringLen(config) == 0)
      return false;

   string symbols = JsonExtractObjectAfter(config, 0, "symbols");
   string activeArray = JsonExtractArrayAfter(symbols, 0, "active");
   string highPriorityArray = JsonExtractArrayAfter(symbols, 0, "high_priority");
   string activeSymbols[];
   int activeCount = ParseJsonStringArray(activeArray, activeSymbols);
   if(activeCount <= 0)
      return false;

   ApplySymbolList(activeSymbols, activeCount);
   if(StringLen(highPriorityArray) > 0)
      ApplyHighPrioritySymbolsFromJson(highPriorityArray);

   string trading = JsonExtractObjectAfter(config, 0, "trading");
   g_trade_execution_enabled = JsonExtractBoolAfter(trading, 0, "enabled", g_trade_execution_enabled);
   g_trade_disable_kill_switch = JsonExtractBoolAfter(trading, 0, "trade_disable_kill_switch", g_trade_disable_kill_switch);

   string setup = JsonExtractObjectAfter(config, 0, "setup");
   g_setup_bias = JsonExtractStringAfter(setup, 0, "bias");
   g_setup_pivot = JsonExtractDoubleAfter(setup, 0, "pivot", g_setup_pivot);
   g_setup_tp1 = JsonExtractDoubleAfter(setup, 0, "tp1", g_setup_tp1);
   g_setup_tp2 = JsonExtractDoubleAfter(setup, 0, "tp2", g_setup_tp2);
   g_setup_entry_price_hint = JsonExtractDoubleAfter(setup, 0, "entry_price_hint", g_setup_entry_price_hint);

   string risk = JsonExtractObjectAfter(config, 0, "risk");
   g_risk_percent = MathMax(0.1, JsonExtractDoubleAfter(risk, 0, "risk_percent", g_risk_percent));
   g_max_daily_trades = MathMax(0, JsonExtractIntAfter(risk, 0, "max_daily_trades", g_max_daily_trades));
   g_max_position_size_lots = JsonExtractDoubleAfter(risk, 0, "max_position_size_lots", g_max_position_size_lots);

   string execution = JsonExtractObjectAfter(config, 0, "execution");
   g_allow_market_orders = JsonExtractBoolAfter(execution, 0, "allow_market_orders", g_allow_market_orders);
   g_allow_pending_orders = JsonExtractBoolAfter(execution, 0, "allow_pending_orders", g_allow_pending_orders);
   g_rr_target = MathMax(0.5, JsonExtractDoubleAfter(execution, 0, "rr_target", g_rr_target));
   g_sl_pad_mult = MathMax(0.0, JsonExtractDoubleAfter(execution, 0, "sl_pad_mult", g_sl_pad_mult));
   g_close_eod   = JsonExtractBoolAfter(execution, 0, "close_eod", g_close_eod);
   string new_eod = JsonExtractStringAfter(execution, 0, "eod_time");
   if(StringLen(new_eod) >= 4) { g_eod_time_str = new_eod; g_eod_closed_today = false; }

   // ── Sessions (enabled flags) ─────────────────────────────────────────
   string sessions = JsonExtractObjectAfter(config, 0, "sessions");
   if(StringLen(sessions) > 0)
   {
      string lon = JsonExtractObjectAfter(sessions, 0, "london");
      string ny  = JsonExtractObjectAfter(sessions, 0, "new_york");
      string asia = JsonExtractObjectAfter(sessions, 0, "asia");
      if(StringLen(lon)  > 0) g_session_london_enabled = JsonExtractBoolAfter(lon,  0, "enabled", g_session_london_enabled);
      if(StringLen(ny)   > 0) g_session_ny_enabled     = JsonExtractBoolAfter(ny,   0, "enabled", g_session_ny_enabled);
      if(StringLen(asia) > 0) g_session_asia_enabled   = JsonExtractBoolAfter(asia, 0, "enabled", g_session_asia_enabled);
   }

   // ── Risk gates ────────────────────────────────────────────────────────
   double min_conf = JsonExtractDoubleAfter(risk, 0, "min_confidence", -1.0);
   if(min_conf >= 0.0) { g_min_confidence = min_conf; g_min_confidence_gate = (min_conf > 0.0); }

   // ── Structure timeframe ───────────────────────────────────────────────
   string structure = JsonExtractObjectAfter(config, 0, "structure");
   string tf_str = JsonExtractStringAfter(structure, 0, "timeframe");
   if(StringLen(tf_str) > 0)
   {
      if(tf_str == "M1")  g_engine_tf = PERIOD_M1;
      else if(tf_str == "M5")  g_engine_tf = PERIOD_M5;
      else if(tf_str == "M15") g_engine_tf = PERIOD_M15;
      else if(tf_str == "M30") g_engine_tf = PERIOD_M30;
      else if(tf_str == "H1")  g_engine_tf = PERIOD_H1;
   }

   string telemetry = JsonExtractObjectAfter(config, 0, "telemetry");
   int config_poll_sec = MathMax(5, JsonExtractIntAfter(telemetry, 0, "config_poll_sec", g_effective_config_refresh_sec));
   g_effective_config_refresh_sec = config_poll_sec;
   g_effective_command_poll_sec = MathMax(5, JsonExtractIntAfter(telemetry, 0, "command_poll_sec", config_poll_sec));
   g_effective_account_heartbeat_sec = MathMax(5, JsonExtractIntAfter(telemetry, 0, "heartbeat_sec", g_effective_account_heartbeat_sec));
   g_last_config_version = version;

   Print("✅ [CONFIG] control-plane config version ", version, " applied for ", activeCount, " symbols | sessions: L=", (string)g_session_london_enabled, " NY=", (string)g_session_ny_enabled, " AS=", (string)g_session_asia_enabled, " EOD=", (string)g_close_eod, "@", g_eod_time_str);
   return true;
}

bool FetchControlPlaneConfig()
{
   if(!g_control_plane_ready || StringLen(g_config_url) == 0 || StringLen(ConnectionId) == 0)
      return false;

   string separator = (StringFind(g_config_url, "?") >= 0) ? "&" : "?";
   string url = g_config_url + separator + "connection_id=" + ConnectionId + "&version=" + IntegerToString(g_last_config_version);
   string response = "";
   if(!ControlPlaneGet(url, response, 5000))
      return false;

   return ApplyControlPlaneConfig(response);
}

bool SendEaRuntimeEvent(const string event_type, const string payload_json)
{
   if(!g_control_plane_ready || StringLen(g_events_url) == 0 || StringLen(ConnectionId) == 0)
      return false;

   string payload = payload_json;
   if(StringLen(payload) == 0)
      payload = "{}";

   string json = StringFormat(
      "{\"connection_id\":\"%s\",\"event_type\":\"%s\",\"payload\":%s}",
      EscapeJson(ConnectionId),
      EscapeJson(event_type),
      payload
   );
   return ControlPlanePost(g_events_url, json, 5000);
}

bool SendTradeAudit(
   const string decision_reason,
   const string symbol,
   const string side,
   const double entry,
   const double sl,
   const double tp,
   const double volume,
   const ulong broker_ticket,
   const int retcode,
   const string status,
   const string message,
   const string payload_json)
{
   if(!g_control_plane_ready || StringLen(g_trade_audit_url) == 0 || StringLen(ConnectionId) == 0)
      return false;

   string payload = payload_json;
   if(StringLen(payload) == 0)
      payload = "{}";

   string brokerTicketJson = broker_ticket > 0 ? "\"" + StringFormat("%I64u", broker_ticket) + "\"" : "null";
   string json = StringFormat(
      "{\"connection_id\":\"%s\",\"symbol\":\"%s\",\"side\":\"%s\",\"entry\":%.5f,\"sl\":%.5f,\"tp\":%.5f,\"volume\":%.2f,\"decision_reason\":\"%s\",\"broker_ticket\":%s,\"status\":\"%s\",\"payload\":{\"retcode\":%d,\"message\":\"%s\",\"details\":%s}}",
      EscapeJson(ConnectionId),
      EscapeJson(symbol),
      EscapeJson(side),
      entry,
      sl,
      tp,
      volume,
      EscapeJson(decision_reason),
      brokerTicketJson,
      EscapeJson(status),
      retcode,
      EscapeJson(message),
      payload
   );
   return ControlPlanePost(g_trade_audit_url, json, 5000);
}

bool AckEaCommand(const string command_id, const int sequence_no, const string status, const string ack_payload_json)
{
   if(!g_control_plane_ready || StringLen(g_command_ack_url) == 0 || StringLen(ConnectionId) == 0)
      return false;

   string payload = ack_payload_json;
   if(StringLen(payload) == 0)
      payload = "{}";

   string json = StringFormat(
      "{\"connection_id\":\"%s\",\"command_id\":\"%s\",\"sequence_no\":%d,\"status\":\"%s\",\"ack_payload_json\":%s,\"applied_config_version\":%d}",
      EscapeJson(ConnectionId),
      EscapeJson(command_id),
      sequence_no,
      EscapeJson(status),
      payload,
      g_last_config_version
   );
   return ControlPlanePost(g_command_ack_url, json, 5000);
}

bool HandleEaCommand(const string command_json)
{
   string command_id = JsonExtractStringAfter(command_json, 0, "id");
   int sequence_no = JsonExtractIntAfter(command_json, 0, "sequence_no", 0);
   string command_type = JsonExtractStringAfter(command_json, 0, "command_type");
   string payload = JsonExtractObjectAfter(command_json, 0, "payload");
   if(StringLen(payload) == 0)
      payload = "{}";

   if(StringLen(command_id) == 0 || sequence_no <= 0 || StringLen(command_type) == 0)
   {
      AppendDiagLog("HandleEaCommand invalid payload=" + command_json);
      return false;
   }

   if(sequence_no <= g_last_command_sequence)
   {
      AppendDiagLog("HandleEaCommand skipped old sequence=" + IntegerToString(sequence_no));
      return true;
   }

   string symbol = JsonExtractStringAfter(payload, 0, "symbol");
   string ack_status = "acknowledged";
   string reason = "";
   bool command_ok = true;
   string ack_payload = "{}";

   if(command_type == "sync_config")
   {
      command_ok = FetchControlPlaneConfig();
      if(!command_ok)
      {
         ack_status = "rejected";
         reason = "config_refresh_failed";
      }
      ack_payload = StringFormat("{\"command_type\":\"sync_config\",\"config_version\":%d,\"status\":\"%s\"}", g_last_config_version, EscapeJson(ack_status));
   }
   else if(command_type == "manual_trade")
   {
      string side = JsonExtractStringAfter(payload, 0, "side");
      double volume = JsonExtractDoubleAfter(payload, 0, "volume", 0.0);
      double sl = JsonExtractDoubleAfter(payload, 0, "sl", 0.0);
      double tp = JsonExtractDoubleAfter(payload, 0, "tp", 0.0);
      string comment = JsonExtractStringAfter(payload, 0, "comment");
      command_ok = ExecuteManualTradeCommand(command_id, "manual_trade", symbol, side, volume, sl, tp, comment, reason, ack_payload);
      if(!command_ok)
         ack_status = "rejected";
   }
   else if(command_type == "close_position")
   {
      long ticket = (long)JsonExtractIntAfter(payload, 0, "ticket", 0);
      command_ok = ExecuteClosePositionCommand(ticket, reason, ack_payload);
      if(!command_ok)
         ack_status = "rejected";
   }
   else if(command_type == "arm_trade")
   {
      string setup_id = JsonExtractStringAfter(payload, 0, "setup_id");
      string side = JsonExtractStringAfter(payload, 0, "side");
      double entry_price = JsonExtractDoubleAfter(payload, 0, "entry_price", 0.0);
      string timeframe = JsonExtractStringAfter(payload, 0, "timeframe");
      int ai_sensitivity = JsonExtractIntAfter(payload, 0, "ai_sensitivity", 0);
      string notes = JsonExtractStringAfter(payload, 0, "trade_plan_notes");
      command_ok = ArmTradeCommand(setup_id, symbol, side, entry_price, timeframe, ai_sensitivity, notes, reason, ack_payload);
      if(!command_ok)
         ack_status = "rejected";
   }
   else
   {
      command_ok = false;
      ack_status = "rejected";
      reason = "bridge_ingest_only_attach_trading_ea";
   }

   if(StringLen(ack_payload) == 0 || ack_payload == "{}")
   {
      ack_payload = StringFormat(
         "{\"command_type\":\"%s\",\"symbol\":\"%s\",\"reason\":\"%s\",\"status\":\"%s\",\"config_version\":%d}",
         EscapeJson(command_type),
         EscapeJson(symbol),
         EscapeJson(reason),
         EscapeJson(ack_status),
         g_last_config_version
      );
   }

   if(!AckEaCommand(command_id, sequence_no, ack_status, ack_payload))
   {
      AppendDiagLog("HandleEaCommand ack failed type=" + command_type + " sequence=" + IntegerToString(sequence_no) + " status=" + ack_status);
      return false;
   }

   g_last_command_sequence = sequence_no;
   AppendDiagLog("HandleEaCommand acked type=" + command_type + " sequence=" + IntegerToString(sequence_no) + " status=" + ack_status);

   string event_payload = StringFormat(
      "{\"command_id\":\"%s\",\"command_type\":\"%s\",\"symbol\":\"%s\",\"reason\":\"%s\",\"status\":\"%s\",\"sequence_no\":%d}",
      EscapeJson(command_id),
      EscapeJson(command_type),
      EscapeJson(symbol),
      EscapeJson(reason),
      EscapeJson(ack_status),
      sequence_no
   );
   SendEaRuntimeEvent("command_processed", event_payload);

   if(command_ok)
      Print("[COMMAND] processed ", command_type, " seq=", sequence_no, " version=", g_last_config_version);
   else
      Print("[COMMAND] rejected ", command_type, " seq=", sequence_no, " reason=", reason);

   return true;
}

bool PollEaCommands()
{
   Print("[TRACE] PollEaCommands enter cursor=", g_last_command_sequence,
         " registered=", g_registration_complete,
         " ready=", g_control_plane_ready,
         " commands_url_len=", StringLen(g_commands_url));
   MaybeRegisterControlPlaneInstallation();
   if(!g_registration_complete)
   {
      AppendDiagLog("PollEaCommands skipped registration incomplete");
      Print("[TRACE] PollEaCommands skip registration_incomplete");
      return false;
   }
   if(!g_control_plane_ready || StringLen(g_commands_url) == 0 || StringLen(ConnectionId) == 0)
   {
      AppendDiagLog("PollEaCommands skipped ready/url/connection missing");
      Print("[TRACE] PollEaCommands skip control_plane_not_ready connection_len=", StringLen(ConnectionId));
      return false;
   }

   string separator = (StringFind(g_commands_url, "?") >= 0) ? "&" : "?";
   string url = g_commands_url + separator + "connection_id=" + ConnectionId + "&cursor=" + IntegerToString(g_last_command_sequence) + "&limit=20";
   string response = "";
   AppendDiagLog("PollEaCommands start cursor=" + IntegerToString(g_last_command_sequence));
   Print("[TRACE] PollEaCommands GET url=", url);
   if(!ControlPlaneGet(url, response, 5000))
   {
      Print("[TRACE] PollEaCommands GET failed cursor=", g_last_command_sequence);
      return false;
   }

   string commands = JsonExtractArrayAfter(response, 0, "commands");
   if(StringLen(commands) == 0)
   {
      AppendDiagLog("PollEaCommands no commands in response=" + StringSubstr(response, 0, 160));
      Print("[TRACE] PollEaCommands no_commands response=", StringSubstr(response, 0, 160));
      return true;
   }

   AppendDiagLog("PollEaCommands commands payload=" + StringSubstr(commands, 0, 160));
   Print("[TRACE] PollEaCommands commands_payload=", StringSubstr(commands, 0, 160));

   int cursor = 0;
   bool handled = false;
   while(true)
   {
      int start = StringFind(commands, "{", cursor);
      if(start < 0)
         break;
      int finish = FindMatchingJsonToken(commands, start, '{', '}');
      if(finish < start)
         break;

      string command_json = StringSubstr(commands, start, finish - start + 1);
      if(HandleEaCommand(command_json))
         handled = true;
      cursor = finish + 1;
   }

   Print("[TRACE] PollEaCommands exit handled=", handled, " new_cursor=", g_last_command_sequence);
   return handled;
}

string BuildCommandComment(const string command_id)
{
   string compact = "";
   for(int i = 0; i < StringLen(command_id); i++)
   {
      ushort ch = StringGetCharacter(command_id, i);
      bool is_alpha = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
      bool is_digit = (ch >= '0' && ch <= '9');
      if(is_alpha || is_digit)
      {
         uchar c[] = {(uchar)ch};
         compact += CharArrayToString(c);
      }
   }
   return "IFX" + StringSubstr(compact, 0, 20);
}

bool EnsureTradeSymbol(const string symbol, int &digits, string &resolved_out)
{
   resolved_out = "";
   if(!ResolveBrokerSymbol(symbol, resolved_out))
      return false;

   digits = (int)SymbolInfoInteger(resolved_out, SYMBOL_DIGITS);
   return true;
}

double NormalizeVolumeForSymbol(const string symbol, double volume)
{
   double min_lot = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double max_lot = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   double step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   if(step <= 0.0)
      step = 0.01;

   if(volume < min_lot)
      volume = min_lot;
   if(max_lot > 0.0 && volume > max_lot)
      volume = max_lot;
   if(g_max_position_size_lots > 0.0 && volume > g_max_position_size_lots)
      volume = g_max_position_size_lots;

   volume = MathFloor((volume + 1e-8) / step) * step;
   if(volume < min_lot)
      volume = min_lot;
   return NormalizeDouble(volume, 2);
}

double RoundPriceToTick(const string symbol, double value, bool round_up)
{
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   double tick_size = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE);
   if(tick_size <= 0.0)
      tick_size = SymbolInfoDouble(symbol, SYMBOL_POINT);
   if(tick_size <= 0.0)
      return NormalizeDouble(value, digits);

   double units = value / tick_size;
   double rounded_units = round_up ? MathCeil(units - 1e-12) : MathFloor(units + 1e-12);
   return NormalizeDouble(rounded_units * tick_size, digits);
}

void NormalizeStopsForSymbol(const string symbol, const string side, double &sl, double &tp)
{
   MqlTick tick;
   if(!SymbolInfoTick(symbol, tick))
      return;

   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   double tick_size = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE);
   if(tick_size <= 0.0)
      tick_size = point;

   double stop_level = (double)SymbolInfoInteger(symbol, SYMBOL_TRADE_STOPS_LEVEL) * point;
   double freeze_level = (double)SymbolInfoInteger(symbol, SYMBOL_TRADE_FREEZE_LEVEL) * point;
   double min_distance = MathMax(stop_level, freeze_level);
   if(tick_size > 0.0)
      min_distance = MathMax(min_distance, tick_size);

   if(side == "buy")
   {
      if(sl > 0.0)
         sl = RoundPriceToTick(symbol, MathMin(sl, tick.bid - min_distance), false);
      if(tp > 0.0)
         tp = RoundPriceToTick(symbol, MathMax(tp, tick.ask + min_distance), true);
   }
   else
   {
      if(sl > 0.0)
         sl = RoundPriceToTick(symbol, MathMax(sl, tick.ask + min_distance), true);
      if(tp > 0.0)
         tp = RoundPriceToTick(symbol, MathMin(tp, tick.bid - min_distance), false);
   }
}

bool SendTradeRequestWithFallback(MqlTradeRequest &base_request, MqlTradeResult &result)
{
   int modes[4];
   int mode_count = 0;
   int filling_mode = (int)SymbolInfoInteger(base_request.symbol, SYMBOL_FILLING_MODE);
   modes[mode_count++] = filling_mode;
   modes[mode_count++] = ORDER_FILLING_IOC;
   modes[mode_count++] = ORDER_FILLING_FOK;
   modes[mode_count++] = ORDER_FILLING_RETURN;

   for(int i = 0; i < mode_count; i++)
   {
      int mode = modes[i];
      bool seen = false;
      for(int j = 0; j < i; j++)
      {
         if(modes[j] == mode)
         {
            seen = true;
            break;
         }
      }
      if(seen)
         continue;

      MqlTradeRequest request = base_request;
      request.type_filling = (ENUM_ORDER_TYPE_FILLING)mode;
      ZeroMemory(result);
      ResetLastError();
      if(!OrderSend(request, result))
      {
         if(result.retcode == 10030)
            continue;
         return false;
      }
      if(result.retcode == 10030)
         continue;
      return true;
   }

   return (result.retcode == TRADE_RETCODE_DONE || result.retcode == TRADE_RETCODE_PLACED);
}

double CalculateRiskVolumeForCommand(const string symbol, const string side, double stop_loss)
{
   MqlTick tick;
   if(!SymbolInfoTick(symbol, tick))
      return 0.0;

   double price = side == "buy" ? tick.ask : tick.bid;
   double tick_size = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE);
   if(tick_size <= 0.0)
      tick_size = SymbolInfoDouble(symbol, SYMBOL_POINT);
   double tick_value = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_VALUE);
   if(tick_size <= 0.0 || tick_value <= 0.0 || stop_loss <= 0.0)
      return 0.0;

   double distance_ticks = MathAbs(price - stop_loss) / tick_size;
   if(distance_ticks <= 0.0)
      return 0.0;

   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   double risk_usd = equity * (g_risk_percent / 100.0);
   double raw_lots = risk_usd / (distance_ticks * tick_value);
   return NormalizeVolumeForSymbol(symbol, raw_lots);
}

int CountTodayExecutedTrades()
{
   MqlDateTime now_struct;
   TimeToStruct(TimeCurrent(), now_struct);
   now_struct.hour = 0;
   now_struct.min = 0;
   now_struct.sec = 0;
   datetime day_start = StructToTime(now_struct);
   if(!HistorySelect(day_start, TimeCurrent()))
      return 0;

   int count = 0;
   for(int i = HistoryDealsTotal() - 1; i >= 0; i--)
   {
      ulong deal_ticket = HistoryDealGetTicket(i);
      if((ulong)HistoryDealGetInteger(deal_ticket, DEAL_MAGIC) == IFX_COMMAND_MAGIC
         && (int)HistoryDealGetInteger(deal_ticket, DEAL_ENTRY) == DEAL_ENTRY_IN)
      {
         count++;
      }
   }
   return count;
}

bool ExecuteManualTradeCommand(
   const string command_id,
   const string audit_reason,
   const string symbol,
   const string side,
   double volume,
   double sl,
   double tp,
   const string comment,
   string &reason,
   string &ack_payload)
{
   reason = "";
   ack_payload = "{}";

   if(!g_trade_execution_enabled || g_trade_disable_kill_switch)
   {
      reason = "trading_disabled";
      return false;
   }

   if(side != "buy" && side != "sell")
   {
      reason = "invalid_side";
      return false;
   }

   int digits = 0;
   string resolved_sym = "";
   if(!EnsureTradeSymbol(symbol, digits, resolved_sym))
   {
      reason = "symbol_unavailable";
      return false;
   }

   bool is_pending = StringFind(comment, "__limit__:") == 0 || StringFind(comment, "__stop__:") == 0;
   if(is_pending && !g_allow_pending_orders)
   {
      reason = "pending_orders_disabled";
      return false;
   }
   if(!is_pending && !g_allow_market_orders)
   {
      reason = "market_orders_disabled";
      return false;
   }

   volume = NormalizeVolumeForSymbol(resolved_sym, volume);
   NormalizeStopsForSymbol(resolved_sym, side, sl, tp);

   MqlTick tick;
   bool tick_ok = false;
   for(int _t = 0; _t < 15; _t++)
   {
      if(SymbolInfoTick(resolved_sym, tick) && tick.time > 0)
      { tick_ok = true; break; }
      Sleep(500);
   }
   if(!tick_ok)
   {
      reason = "tick_unavailable";
      return false;
   }

   MqlTradeRequest request;
   MqlTradeResult result;
   ZeroMemory(request);
   ZeroMemory(result);

   request.symbol = resolved_sym;
   request.magic = IFX_COMMAND_MAGIC;
   request.volume = volume;
   request.deviation = 20;
   request.type_time = ORDER_TIME_GTC;
   request.comment = BuildCommandComment(command_id);

   if(is_pending)
   {
      double pending_price = 0.0;
      if(StringFind(comment, "__limit__:") == 0)
         pending_price = StringToDouble(StringSubstr(comment, 10));
      else if(StringFind(comment, "__stop__:") == 0)
         pending_price = StringToDouble(StringSubstr(comment, 9));

      if(pending_price <= 0.0)
      {
         reason = "invalid_pending_price";
         return false;
      }

      request.action = TRADE_ACTION_PENDING;
      request.price = NormalizeDouble(pending_price, digits);
      request.sl = sl;
      request.tp = tp;
      if(side == "buy")
         request.type = StringFind(comment, "__limit__:") == 0 ? ORDER_TYPE_BUY_LIMIT : ORDER_TYPE_BUY_STOP;
      else
         request.type = StringFind(comment, "__limit__:") == 0 ? ORDER_TYPE_SELL_LIMIT : ORDER_TYPE_SELL_STOP;
      request.type_filling = ORDER_FILLING_RETURN;

      if(!OrderSend(request, result))
      {
         reason = IntegerToString((int)result.retcode);
      }
   }
   else
   {
      request.action = TRADE_ACTION_DEAL;
      request.type = side == "buy" ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
      request.price = side == "buy" ? tick.ask : tick.bid;
      request.sl = sl;
      request.tp = tp;
      SendTradeRequestWithFallback(request, result);
   }

   ack_payload = StringFormat(
      "{\"symbol\":\"%s\",\"side\":\"%s\",\"volume\":%.2f,\"order_id\":%I64u,\"retcode\":%d,\"message\":\"%s\"}",
      EscapeJson(symbol),
      EscapeJson(side),
      volume,
      result.order,
      (int)result.retcode,
      EscapeJson(result.comment)
   );

   string auditStatus = (result.retcode == TRADE_RETCODE_DONE || result.retcode == TRADE_RETCODE_PLACED) ? "accepted" : "rejected";
   SendTradeAudit(audit_reason, resolved_sym, side, request.price, sl, tp, volume, result.order, (int)result.retcode, auditStatus, result.comment, ack_payload);

   if(result.retcode == TRADE_RETCODE_DONE || result.retcode == TRADE_RETCODE_PLACED)
      return true;

   reason = result.comment;
   if(StringLen(reason) == 0)
      reason = IntegerToString((int)result.retcode);
   return false;
}

bool ExecuteClosePositionCommand(long ticket, string &reason, string &ack_payload)
{
   reason = "";
   ack_payload = "{}";

   if(ticket <= 0)
   {
      reason = "invalid_ticket";
      return false;
   }

   if(!PositionSelectByTicket((ulong)ticket))
   {
      reason = "position_not_found";
      return false;
   }

   string symbol = PositionGetString(POSITION_SYMBOL);
   double volume = PositionGetDouble(POSITION_VOLUME);
   long type = PositionGetInteger(POSITION_TYPE);
   MqlTick tick;
   bool tick_ok = false;
   for(int _t = 0; _t < 15; _t++)
   {
      if(SymbolInfoTick(symbol, tick) && tick.time > 0)
      { tick_ok = true; break; }
      Sleep(500);
   }
   if(!tick_ok)
   {
      reason = "tick_unavailable";
      return false;
   }

   MqlTradeRequest request;
   MqlTradeResult result;
   ZeroMemory(request);
   ZeroMemory(result);

   request.action = TRADE_ACTION_DEAL;
   request.position = (ulong)ticket;
   request.magic = IFX_COMMAND_MAGIC;
   request.symbol = symbol;
   request.volume = volume;
   request.deviation = 20;
   request.type_time = ORDER_TIME_GTC;
   request.comment = "ifx_close";
   request.type = type == POSITION_TYPE_BUY ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
   request.price = type == POSITION_TYPE_BUY ? tick.bid : tick.ask;

   SendTradeRequestWithFallback(request, result);

   ack_payload = StringFormat(
      "{\"ticket\":%I64d,\"symbol\":\"%s\",\"retcode\":%d,\"message\":\"%s\",\"order_id\":%I64u}",
      ticket,
      EscapeJson(symbol),
      (int)result.retcode,
      EscapeJson(result.comment),
      result.order
   );

   string auditStatus = (result.retcode == TRADE_RETCODE_DONE || result.retcode == TRADE_RETCODE_PLACED) ? "accepted" : "rejected";
   SendTradeAudit("close_position", symbol, type == POSITION_TYPE_BUY ? "sell" : "buy", request.price, 0.0, 0.0, volume, result.order, (int)result.retcode, auditStatus, result.comment, ack_payload);

   if(result.retcode == TRADE_RETCODE_DONE || result.retcode == TRADE_RETCODE_PLACED)
      return true;

   reason = result.comment;
   if(StringLen(reason) == 0)
      reason = IntegerToString((int)result.retcode);
   return false;
}

bool ArmTradeCommand(const string setup_id, const string symbol, const string side, double entry_price, const string timeframe, int ai_sensitivity, const string notes, string &reason, string &ack_payload)
{
   reason = "";
   ack_payload = "{}";

   FetchControlPlaneConfig();

   if(!g_trade_execution_enabled || g_trade_disable_kill_switch)
   {
      reason = "trading_disabled";
      return false;
   }

   if(side != "buy" && side != "sell")
   {
      reason = "invalid_side";
      return false;
   }

   g_armed_trade_active = true;
   g_armed_setup_id = setup_id;
   g_armed_symbol = symbol;
   g_armed_side = side;
   g_armed_entry_price = entry_price;
   g_armed_timeframe = timeframe;
   g_armed_ai_sensitivity = ai_sensitivity;
   g_armed_notes = notes;
   g_armed_armed_at = TimeCurrent();

   ack_payload = StringFormat(
      "{\"setup_id\":\"%s\",\"symbol\":\"%s\",\"side\":\"%s\",\"entry_price\":%.5f,\"timeframe\":\"%s\",\"status\":\"armed\"}",
      EscapeJson(setup_id),
      EscapeJson(symbol),
      EscapeJson(side),
      entry_price,
      EscapeJson(timeframe)
   );
   SendEaRuntimeEvent("trade_armed", ack_payload);
   return true;
}

void ClearArmedTradeState()
{
   g_armed_trade_active = false;
   g_armed_setup_id = "";
   g_armed_symbol = "";
   g_armed_side = "";
   g_armed_notes = "";
   g_armed_timeframe = "";
   g_armed_entry_price = 0.0;
   g_armed_ai_sensitivity = 0;
   g_armed_armed_at = 0;
}

// Returns true if the current server time falls within any enabled session window.
// Times are "HH:MM" strings in server (broker) time. Overnight ranges (start > end) are handled.
bool IsInAllowedTradingSession()
{
   if(!g_session_london_enabled && !g_session_ny_enabled && !g_session_asia_enabled)
      return true;  // no filter configured → allow all

   MqlDateTime now_struct;
   TimeToStruct(TimeCurrent(), now_struct);
   int now_min = now_struct.hour * 60 + now_struct.min;

   // Helper lambda-equivalent: parse "HH:MM" to minutes
   #define PARSE_HM(s) (((int)StringToInteger(StringSubstr(s,0,2)))*60 + (int)StringToInteger(StringSubstr(s,3,2)))

   // London  03:00–11:00 default
   if(g_session_london_enabled) {
      int s = PARSE_HM("03:00"), e = PARSE_HM("11:00");
      if(now_min >= s && now_min < e) return true;
   }
   // New York  08:00–17:00 default
   if(g_session_ny_enabled) {
      int s = PARSE_HM("08:00"), e = PARSE_HM("17:00");
      if(now_min >= s && now_min < e) return true;
   }
   // Asia  19:00–03:00 (overnight)
   if(g_session_asia_enabled) {
      int s = PARSE_HM("19:00"), e = PARSE_HM("03:00");
      if(s > e) { if(now_min >= s || now_min < e) return true; }
      else       { if(now_min >= s && now_min < e) return true; }
   }
   return false;
}

void MaybeExecuteArmedTrade(const int sym_idx, const string signal_side, const double stop_anchor, const double signal_price)
{
   if(!g_armed_trade_active)
      return;
   if(sym_idx < 0 || sym_idx >= g_sym_count)
      return;
   if(g_sym_names[sym_idx] != g_armed_symbol)
      return;
   if(signal_side != g_armed_side)
      return;
   if(g_max_daily_trades > 0 && CountTodayExecutedTrades() >= g_max_daily_trades)
   {
      SendEaRuntimeEvent("armed_trade_skipped", StringFormat("{\"setup_id\":\"%s\",\"symbol\":\"%s\",\"reason\":\"max_daily_trades\"}", EscapeJson(g_armed_setup_id), EscapeJson(g_armed_symbol)));
      ClearArmedTradeState();
      return;
   }
   if(!IsInAllowedTradingSession())
   {
      SendEaRuntimeEvent("armed_trade_skipped", StringFormat("{\"setup_id\":\"%s\",\"symbol\":\"%s\",\"reason\":\"outside_session\"}", EscapeJson(g_armed_setup_id), EscapeJson(g_armed_symbol)));
      return;  // keep armed — fire when session opens
   }

   double sl = stop_anchor;
   double tp = g_setup_tp2;
   if(tp <= 0.0)
   {
      double distance = MathAbs(signal_price - sl);
      if(distance > 0.0)
      {
         tp = signal_side == "buy"
            ? signal_price + (distance * g_rr_target)
            : signal_price - (distance * g_rr_target);
      }
   }

   double volume = CalculateRiskVolumeForCommand(g_armed_symbol, signal_side, sl);
   string reason = "";
   string ack_payload = "";
   bool ok = ExecuteManualTradeCommand(g_armed_setup_id, "armed_trade", g_armed_symbol, signal_side, volume, sl, tp, "", reason, ack_payload);
   if(ok)
      SendEaRuntimeEvent("armed_trade_executed", StringFormat("{\"setup_id\":\"%s\",\"symbol\":\"%s\",\"side\":\"%s\",\"payload\":%s}", EscapeJson(g_armed_setup_id), EscapeJson(g_armed_symbol), EscapeJson(signal_side), ack_payload));
   else
      SendEaRuntimeEvent("armed_trade_rejected", StringFormat("{\"setup_id\":\"%s\",\"symbol\":\"%s\",\"side\":\"%s\",\"reason\":\"%s\",\"payload\":%s}", EscapeJson(g_armed_setup_id), EscapeJson(g_armed_symbol), EscapeJson(signal_side), EscapeJson(reason), ack_payload));
   ClearArmedTradeState();
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

int SanitizedStructurePivotWindow()
{
   int window = StructurePivotWindow;
   if(window < 1)
      window = 1;
   if(window > 20)
      window = 20;
   return window;
}

int SanitizedStructureBarsToScan()
{
   int bars = StructureBarsToScan;
   int minimum = 2 * SanitizedStructurePivotWindow() + 5;
   if(bars < minimum)
      bars = minimum;
   if(bars > 500)
      bars = 500;
   return bars;
}

string TimeframeLabel(const ENUM_TIMEFRAMES timeframe)
{
   switch(timeframe)
   {
      case PERIOD_M1: return "1m";
      case PERIOD_M2: return "2m";
      case PERIOD_M3: return "3m";
      case PERIOD_M4: return "4m";
      case PERIOD_M5: return "5m";
      case PERIOD_M6: return "6m";
      case PERIOD_M10: return "10m";
      case PERIOD_M12: return "12m";
      case PERIOD_M15: return "15m";
      case PERIOD_M20: return "20m";
      case PERIOD_M30: return "30m";
      case PERIOD_H1: return "1h";
      case PERIOD_H2: return "2h";
      case PERIOD_H3: return "3h";
      case PERIOD_H4: return "4h";
      case PERIOD_H6: return "6h";
      case PERIOD_H8: return "8h";
      case PERIOD_H12: return "12h";
      case PERIOD_D1: return "1d";
      case PERIOD_W1: return "1w";
      case PERIOD_MN1: return "1mn";
   }
   return IntegerToString((int)timeframe);
}

bool IsPivotHigh(const MqlRates &bars[], int idx, int window)
{
   double level = bars[idx].high;
   for(int j = idx - window; j <= idx + window; j++)
   {
      if(j == idx)
         continue;
      if(bars[j].high >= level)
         return false;
   }
   return true;
}

bool IsPivotLow(const MqlRates &bars[], int idx, int window)
{
   double level = bars[idx].low;
   for(int j = idx - window; j <= idx + window; j++)
   {
      if(j == idx)
         continue;
      if(bars[j].low <= level)
         return false;
   }
   return true;
}

int LoadClosedStructureBars(const string symbol, MqlRates &bars[])
{
   MqlRates seriesBars[];
   ArraySetAsSeries(seriesBars, true);

   int copied = CopyRates(symbol, StructureTimeframe, 1, SanitizedStructureBarsToScan(), seriesBars);
   if(copied <= 0)
      return 0;

   ArrayResize(bars, copied);
   for(int i = 0; i < copied; i++)
      bars[i] = seriesBars[copied - 1 - i];

   return copied;
}

bool DetectLatestConfirmedFractalLevels(
   const MqlRates &bars[],
   int copied,
   int window,
   double &swingHigh,
   datetime &swingHighTime,
   double &swingLow,
   datetime &swingLowTime)
{
   swingHigh = 0.0;
   swingHighTime = 0;
   swingLow = 0.0;
   swingLowTime = 0;

   if(window < 1)
      window = 1;
   if(copied < (2 * window + 3))
      return false;

   int lastIdx = copied - 1 - window;
   for(int i = window; i <= lastIdx; i++)
   {
      if(IsPivotHigh(bars, i, window))
      {
         swingHigh = bars[i].high;
         swingHighTime = bars[i].time;
      }
      if(IsPivotLow(bars, i, window))
      {
         swingLow = bars[i].low;
         swingLowTime = bars[i].time;
      }
   }

   return (swingHighTime > 0 || swingLowTime > 0);
}

void MaybeProcessLocalFractalSignal(const int sym_idx)
{
   if(!EnableLocalFractalSignals)
      return;
   if(sym_idx < 0 || sym_idx >= g_sym_count)
      return;

   int window = SanitizedStructurePivotWindow();
   MqlRates bars[];
   int copied = LoadClosedStructureBars(g_sym_names[sym_idx], bars);
   if(copied < (2 * window + 3))
      return;

   datetime latestClosedTime = bars[copied - 1].time;
   if(latestClosedTime <= 0 || latestClosedTime <= g_sym_last_structure_close[sym_idx])
      return;

   g_sym_last_structure_close[sym_idx] = latestClosedTime;

   double swingHigh = 0.0;
   datetime swingHighTime = 0;
   double swingLow = 0.0;
   datetime swingLowTime = 0;
   if(!DetectLatestConfirmedFractalLevels(bars, copied, window, swingHigh, swingHighTime, swingLow, swingLowTime))
      return;

   g_sym_last_structure_high[sym_idx] = swingHigh;
   g_sym_last_structure_low[sym_idx] = swingLow;

   if(!LogFractalSignals)
      return;

   if(g_sym_last_structure_signal[sym_idx] >= latestClosedTime)
      return;

   double closePrice = bars[copied - 1].close;
   string tfLabel = TimeframeLabel(StructureTimeframe);
   int digits = g_sym_digits[sym_idx];

   if(swingHighTime > 0 && closePrice > swingHigh)
   {
      g_sym_last_structure_signal[sym_idx] = latestClosedTime;
      Print("⚡ [FRACTAL] ", g_sym_names[sym_idx], " ", tfLabel,
            " bullish break close=", DoubleToString(closePrice, digits),
            " level=", DoubleToString(swingHigh, digits),
            " pivot_window=", window,
            " candle=", TimeToString(latestClosedTime));
      MaybeExecuteArmedTrade(sym_idx, "buy", swingLow, closePrice);
      return;
   }

   if(swingLowTime > 0 && closePrice < swingLow)
   {
      g_sym_last_structure_signal[sym_idx] = latestClosedTime;
      Print("⚡ [FRACTAL] ", g_sym_names[sym_idx], " ", tfLabel,
            " bearish break close=", DoubleToString(closePrice, digits),
            " level=", DoubleToString(swingLow, digits),
            " pivot_window=", window,
            " candle=", TimeToString(latestClosedTime));
      MaybeExecuteArmedTrade(sym_idx, "sell", swingHigh, closePrice);
   }
}

bool IsTerminalRuntimeReady()
{
   if(!TerminalInfoInteger(TERMINAL_CONNECTED))
      return false;

   if((int)AccountInfoInteger(ACCOUNT_LOGIN) <= 0)
      return false;

   if((long)SeriesInfoInteger(_Symbol, PERIOD_CURRENT, SERIES_SYNCHRONIZED) == 0)
      return false;

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick) || tick.time <= 0)
      return false;

   return true;
}

bool IsControlPlaneRuntimeReady()
{
   if(!TerminalInfoInteger(TERMINAL_CONNECTED))
      return false;

   if((int)AccountInfoInteger(ACCOUNT_LOGIN) <= 0)
      return false;

   return true;
}

//==========================================================================
// SECTION 3 — INIT / DEINIT
//==========================================================================
int OnInit()
{
   int probe_handle = FileOpen("probe.txt", FILE_READ | FILE_WRITE | FILE_TXT | FILE_ANSI, 0, CP_UTF8);
   if(probe_handle == INVALID_HANDLE)
      probe_handle = FileOpen("probe.txt", FILE_WRITE | FILE_TXT | FILE_ANSI, 0, CP_UTF8);
   if(probe_handle != INVALID_HANDLE)
   {
      FileSeek(probe_handle, 0, SEEK_END);
      FileWriteString(probe_handle, TimeToString(TimeLocal(), TIME_DATE | TIME_SECONDS) + " | IFX_Railway_Bridge_v1 OnInit probe symbol=" + _Symbol + "\r\n");
      FileClose(probe_handle);
   }

   Print("[TRACE] OnInit enter symbol=", _Symbol,
         " connected=", (int)TerminalInfoInteger(TERMINAL_CONNECTED),
         " login=", (int)AccountInfoInteger(ACCOUNT_LOGIN));
   g_effective_config_refresh_sec = MathMax(5, ConfigRefreshSec);
   g_effective_command_poll_sec = MathMax(5, ConfigRefreshSec);
   g_effective_account_heartbeat_sec = MathMax(5, AccountHeartbeatSec);
   g_runtime_loop_armed = false;
   g_initial_config_fetch_pending = true;
   g_initial_history_seed_pending = true;
   g_registration_pending = true;
   g_registration_complete = false;
   LoadPreferredActiveSymbols();
   InitDefaultSymbols();
   g_startup_ms = GetTickCount64();

      bool bootstrap_loaded = LoadControlPlaneHeartbeatBootstrap();
      Print("[TRACE] OnInit bootstrap_loaded=", bootstrap_loaded,
         " ready=", g_control_plane_ready,
         " register_url_len=", StringLen(g_register_url),
         " heartbeat_url_len=", StringLen(g_heartbeat_url),
         " install_token_len=", StringLen(g_install_token));
      AppendDiagLog("OnInit bootstrap_loaded=" + (bootstrap_loaded ? "true" : "false")
              + " ready=" + (g_control_plane_ready ? "true" : "false"));

      bool init_runtime_ready = IsControlPlaneRuntimeReady();
      Print("[TRACE] OnInit control_plane_runtime_ready=", init_runtime_ready);
      Print("[TRACE] OnInit register_deferred bootstrap_loaded=", bootstrap_loaded,
         " runtime_ready=", init_runtime_ready,
         " registration_pending=", g_registration_pending);

   EventSetMillisecondTimer(50);
      Print("[TRACE] OnInit exit timer_set=1 symbol=", _Symbol);
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   Comment("");
}

//==========================================================================
// SECTION 4 — TICK + TIMER HANDLERS
//==========================================================================

// OnTick fires immediately for the chart symbol — use it as a bonus fast path
void OnTick()
{
   Print("[TRACE] OnTick enter symbol=", _Symbol,
         " armed=", g_runtime_loop_armed,
         " terminal_ready=", IsTerminalRuntimeReady(),
         " control_ready=", g_control_plane_ready,
         " registered=", g_registration_complete);
   if(!g_runtime_loop_armed)
   {
      if(!IsTerminalRuntimeReady())
         return;
      g_runtime_loop_armed = true;
      AppendDiagLog("Runtime loop armed from OnTick symbol=" + _Symbol);
   }

   PollAllSymbols();
   RunControlPlaneLoop(GetTickCount64());
   Print("[TRACE] OnTick exit symbol=", _Symbol,
      " cursor=", g_last_command_sequence,
      " registered=", g_registration_complete);
}

// 50ms timer fires for all other symbols
void OnTimer()
{
   Print("[TRACE] OnTimer enter symbol=", _Symbol,
         " armed=", g_runtime_loop_armed,
         " control_runtime_ready=", IsControlPlaneRuntimeReady(),
         " control_ready=", g_control_plane_ready,
         " registered=", g_registration_complete);
   if(!g_runtime_loop_armed)
   {
      if(!IsControlPlaneRuntimeReady())
         return;
      g_runtime_loop_armed = true;
      AppendDiagLog("Runtime loop armed from OnTimer symbol=" + _Symbol);
   }

   PollAllSymbols();
   RunControlPlaneLoop(GetTickCount64());
   Print("[TRACE] OnTimer exit symbol=", _Symbol,
      " cursor=", g_last_command_sequence,
      " registered=", g_registration_complete);
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
            datetime last_uploaded_before = g_sym_last_uploaded_close[i];
            if(live_copied > 1)
            {
               if(SendCandleCloseBar(g_sym_names[i], i, live_rates[1]))
               {
                  advanced_bar = true;

                  if(last_uploaded_before > 0
                     && (live_rates[1].time - last_uploaded_before) > 60
                     && now_ms - g_sym_last_reseed_ms[i] >= CLOSE_DISCONTINUITY_RESEED_MS)
                  {
                     g_sym_last_reseed_ms[i] = now_ms;
                     Print("🔄 [RESEED] ", g_sym_names[i], " close stream resumed after ",
                           (int)((live_rates[1].time - last_uploaded_before) / 60),
                           " missed minutes — pushing recent history window");
                     if(PushHistoricalBulkSymbol(i, RepairBarsToSend()))
                        g_historical_seeded = true;
                  }
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

         if(latest_closed_bar > 0
            && HistoryRefreshWindowSec > 0
            && RepairBarsToSend() > 0
            && now_ms - g_sym_last_reseed_ms[i] >= (ulong)HistoryRefreshWindowSec * 1000)
         {
            datetime last_uploaded = g_sym_last_uploaded_close[i];
            string refresh_reason = "periodic sliding-window refresh";
            if(last_uploaded <= 0)
               refresh_reason = "symbol history not seeded yet";
            else if(latest_closed_bar > last_uploaded)
               refresh_reason = IntegerToString((int)((latest_closed_bar - last_uploaded) / 60)) + " closed bars behind";

            g_sym_last_reseed_ms[i] = now_ms;
            Print("🔄 [SYNC] ", g_sym_names[i], " ", refresh_reason,
                  " — re-pushing last ", RepairBarsToSend(), " bars");
            if(PushHistoricalBulkSymbol(i, RepairBarsToSend()))
               g_historical_seeded = true;
         }

         if(latest_closed_bar > 0)
            MaybeProcessLocalFractalSignal(i);
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
   json += "\"connection_id\":\"" + EscapeJson(ConnectionId) + "\",";
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
      if(!IsValidPriceSnapshot(g_pending_bid[i], g_pending_ask[i], g_pending_msc[i]))
      {
         Print("⚠️ [", g_sym_names[i], "] skipping invalid tick snapshot bid=", DoubleToString(g_pending_bid[i], g_sym_digits[i]),
               " ask=", DoubleToString(g_pending_ask[i], g_sym_digits[i]), " ts_ms=", IntegerToString(g_pending_msc[i]));
         g_pending_dirty[i] = false;
         continue;
      }

      if(tickCount > 0) json += ",";
      int d = g_sym_digits[i];
      json += "{";
      json += "\"symbol\":\"" + EscapeJson(g_sym_names[i]) + "\",";
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
      if(!IsValidRateBar(r[0]))
      {
         Print("⚠️ [", g_sym_names[i], "] skipping invalid forming candle in tick-batch");
         continue;
      }

      int d = g_sym_digits[i];
      if(added > 0) json += ",";
      json += "{";
      json += "\"symbol\":\""  + EscapeJson(g_sym_names[i])               + "\",";
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
   if(tickCount == 0 && added == 0)
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
   if(!IsValidRateBar(bar))
   {
      Print("⚠️ [", symbol, "] skipping invalid candle-close payload");
      return false;
   }

   int d = g_sym_digits[sym_idx];
   string json = "{";
   json += "\"connection_id\":\"" + EscapeJson(ConnectionId) + "\",";
   json += "\"symbol\":\""        + EscapeJson(symbol)        + "\",";
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
   json += "\"connection_id\":\"" + EscapeJson(ConnectionId) + "\",";
   json += "\"bars_requested\":"  + IntegerToString(barsRequested) + ",";
   json += "\"symbols\":[{";
   json += "\"symbol\":\"" + EscapeJson(g_sym_names[sym_idx]) + "\",\"bars\":[";

   int validBars = 0;

   for(int j = copied - 1; j >= 0; j--)
   {
      if(!IsValidRateBar(r[j]))
         continue;
      if(validBars > 0) json += ",";
      json += "{";
      json += "\"t\":"  + IntegerToString((long)r[j].time)     + ",";
      json += "\"o\":"  + DoubleToString(r[j].open,  d)         + ",";
      json += "\"h\":"  + DoubleToString(r[j].high,  d)         + ",";
      json += "\"l\":"  + DoubleToString(r[j].low,   d)         + ",";
      json += "\"c\":"  + DoubleToString(r[j].close, d)         + ",";
      json += "\"v\":"  + IntegerToString(r[j].tick_volume);
      json += "}";
      validBars++;
   }
   json += "]}]}";

   if(validBars == 0)
   {
      Print("⚠️ [", g_sym_names[sym_idx], "] no valid bars available for historical bulk");
      return false;
   }

   Print("  [", g_sym_names[sym_idx], "] ", validBars, " valid bars ready");

   if(SignedPost("/historical-bulk", json, 15000))
   {
      g_sym_last_uploaded_close[sym_idx] = r[0].time;
      g_sym_last_repair_ms[sym_idx] = GetTickCount64();
      g_sym_last_reseed_ms[sym_idx] = g_sym_last_repair_ms[sym_idx];
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
   if(FetchControlPlaneConfig())
      return;

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
   // Hardcoded fallback uses suffix-neutral aliases and resolves them per broker.
   string defaults[] = {
      "EURUSD","GBPUSD","USDJPY","USDCAD","AUDUSD",
      "NZDUSD","USDCHF","EURGBP","XAUUSD","BTCUSD",
      "ETHUSD","USOIL"
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
   ulong    prev_last_reseed_ms[];
   datetime prev_last_structure_close[];
   datetime prev_last_structure_signal[];
   double   prev_last_structure_high[];
   double   prev_last_structure_low[];
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
   ArrayResize(prev_last_reseed_ms, prev_count);
   ArrayResize(prev_last_structure_close, prev_count);
   ArrayResize(prev_last_structure_signal, prev_count);
   ArrayResize(prev_last_structure_high, prev_count);
   ArrayResize(prev_last_structure_low, prev_count);

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
      prev_last_reseed_ms[i] = g_sym_last_reseed_ms[i];
      prev_last_structure_close[i] = g_sym_last_structure_close[i];
      prev_last_structure_signal[i] = g_sym_last_structure_signal[i];
      prev_last_structure_high[i] = g_sym_last_structure_high[i];
      prev_last_structure_low[i] = g_sym_last_structure_low[i];
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
   ArrayResize(g_sym_last_reseed_ms, count);
   ArrayResize(g_sym_last_structure_close, count);
   ArrayResize(g_sym_last_structure_signal, count);
   ArrayResize(g_sym_last_structure_high, count);
   ArrayResize(g_sym_last_structure_low, count);

   int valid = 0;
   for(int i = 0; i < count; i++)
   {
      string requested = syms[i];
      string s = "";
      if(!ResolveBrokerSymbol(requested, s))
      {
         Print("⚠️ [CONFIG] symbol alias not available: ", requested);
         continue;
      }
      if(s != TrimSpaces(requested))
         Print("ℹ️ [CONFIG] resolved symbol alias ", requested, " -> ", s);

      bool duplicate = false;
      for(int existing = 0; existing < valid; existing++)
      {
         if(g_sym_names[existing] == s)
         {
            duplicate = true;
            break;
         }
      }
      if(duplicate)
         continue;

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
      g_sym_last_reseed_ms[valid] = (prev_idx >= 0) ? prev_last_reseed_ms[prev_idx] : 0;
      g_sym_last_structure_close[valid] = (prev_idx >= 0) ? prev_last_structure_close[prev_idx] : 0;
      g_sym_last_structure_signal[valid] = (prev_idx >= 0) ? prev_last_structure_signal[prev_idx] : 0;
      g_sym_last_structure_high[valid] = (prev_idx >= 0) ? prev_last_structure_high[prev_idx] : 0.0;
      g_sym_last_structure_low[valid] = (prev_idx >= 0) ? prev_last_structure_low[prev_idx] : 0.0;
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
   ArrayResize(g_sym_last_reseed_ms, valid);
   ArrayResize(g_sym_last_structure_close, valid);
   ArrayResize(g_sym_last_structure_signal, valid);
   ArrayResize(g_sym_last_structure_high, valid);
   ArrayResize(g_sym_last_structure_low, valid);
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
      if(status == 400)
         Print("⚠️ POST payload prefix ", path, " => ", StringSubstr(json, 0, 240));
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
