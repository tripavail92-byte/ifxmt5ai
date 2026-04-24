//+------------------------------------------------------------------+
//|  IFX_Config.mqh                                                  |
//|  Phase 2B — EA config struct + cloud/input parser                |
//|                                                                  |
//|  Provides:                                                        |
//|    IFX_EaConfig struct  — all v9.30 config fields                |
//|    CFG_ParseFromInputs() — populate struct from EA inputs        |
//|    CFG_ParseFromCloudJson() — override struct from cloud JSON    |
//|    CFG_ApplyAiText()      — parse AI brain text into struct      |
//|                                                                  |
//|  Priority order (lowest → highest):                              |
//|    EA input defaults → CFG_ParseFromInputs()                    |
//|    Cloud /api/ea/config JSON → CFG_ParseFromCloudJson()          |
//|    AI text paste (if present) → CFG_ApplyAiText()               |
//+------------------------------------------------------------------+
#ifndef IFX_CONFIG_MQH
#define IFX_CONFIG_MQH

#property strict

//==========================================================================
// ENUMS (defined here so the main EA can use them in input declarations)
//==========================================================================
enum ENUM_TRADE_BIAS
{
   BIAS_NEUTRAL = 0,   // Neutral
   BIAS_LONG    = 1,   // Long (Buy)
   BIAS_SHORT   = 2,   // Short (Sell)
};

//==========================================================================
// CONFIG STRUCT
//==========================================================================
struct IFX_EaConfig
{
   // ----- Identity -----
   string connection_id;
   string ea_version;

   // ----- AI Setup -----
   string bias;          // "Long" | "Short" | "Neutral"
   double pivot;
   double tp1;
   double tp2;
   double atr_zone_pct;
   double sl_pad_mult;
   int    confidence;    // AI confidence score 0-100 (70 = default)

   // ----- Sessions -----
   bool   use_asia;
   string asia_start;
   string asia_end;
   bool   use_lon;
   string lon_start;
   string lon_end;
   bool   use_ny;
   string ny_start;
   string ny_end;

   // ----- Timeframes -----
   ENUM_TIMEFRAMES tf_engine;
   ENUM_TIMEFRAMES tf_boss;
   bool   use_mtf_sl;
   ENUM_TIMEFRAMES tf_sl;
   ENUM_TIMEFRAMES tf_be;

   // ----- Risk -----
   double risk_pct;
   bool   strict_risk;
   double min_rr;
   int    max_trades;

   // ----- SL / Cooldown -----
   bool   use_dead_sl;
   int    sl_cooldown_min;

   // ----- Auto RR -----
   bool   use_auto_rr;
   double auto_rr1;
   double auto_rr2;

   // ----- Trade Management -----
   int    base_magic;
   int    pivot_len;
   bool   use_partial;
   double tp1_pct;
   bool   use_be;
   bool   be_after_tp1;
   bool   use_eod;
   string eod_time;

   // ----- Visuals -----
   bool   show_struct;
   int    smc_lookback;

   // ----- Discord -----
   string discord_url;
   int    report_hour;
   int    report_min;
   bool   enable_discord;   // master on/off for all Discord alerts
   bool   notify_on_sl;     // post alert when SL / risk-protection fires
   bool   notify_on_tp;     // post alert when TP1 profit hit
   bool   notify_daily;     // post daily performance report

   // ----- Trade Control -----
   bool   exit_on_flip;     // close trade automatically if AI bias flips

   // ----- Symbols (relay list from cloud) -----
   string symbols_csv;   // comma-separated base names e.g. "XAUUSD,EURUSD,GBPUSD"
};

//==========================================================================
// GLOBALS
//==========================================================================
IFX_EaConfig g_cfg;
bool         g_cfg_loaded = false;

//==========================================================================
// HELPERS
//==========================================================================

// Simple keyword-based value parser (matches original ParseValue logic)
double CFG_ParseValue(const string txt, const string keyword, double fallback)
{
   string up_txt = txt;
   StringToUpper(up_txt);
   string up_kw = keyword;
   StringToUpper(up_kw);

   int pos = StringFind(up_txt, up_kw);
   if(pos < 0) return fallback;

   int start = pos + StringLen(up_kw);

   // JSON nested-array fix: for TARGET 1/2 and INVALIDATION keys, jump past the
   // "PRICE POINT" label to avoid capturing stray numbers from condition notes
   // (e.g. "if price closes above 2680") before the actual level value.
   if(StringFind(up_kw, "TARGET 1")    >= 0 || StringFind(up_kw, "TARGET 2")    >= 0 ||
      StringFind(up_kw, "INVALIDATION") >= 0 || StringFind(up_kw, "COUNTER")    >= 0)
   {
      int price_pos = StringFind(up_txt, "PRICE POINT", start);
      if(price_pos > start)
         start = price_pos + 11;  // skip past "PRICE POINT" (len=11)
   }

   string num_str = "";
   bool found_digit = false;

   for(int i = start; i < StringLen(up_txt); i++)
   {
      ushort c = StringGetCharacter(up_txt, i);
      if(c >= '0' && c <= '9') { num_str += ShortToString(c); found_digit = true; }
      else if(c == '.' || c == ',') { num_str += "."; found_digit = true; }
      else if(found_digit) break;
   }
   return (num_str != "") ? StringToDouble(num_str) : fallback;
}

// Extract a JSON string value: "key":"value"
string CFG_JsonString(const string json, const string key, const string fallback = "")
{
   string marker = "\"" + key + "\"";
   int key_pos = StringFind(json, marker);
   if(key_pos < 0) return fallback;
   int colon = StringFind(json, ":", key_pos + StringLen(marker));
   if(colon < 0) return fallback;
   int start = colon + 1;
   while(start < StringLen(json))
   {
      ushort ch = StringGetCharacter(json, start);
      if(ch == ' ' || ch == '\t') { start++; continue; }
      break;
   }
   if(StringGetCharacter(json, start) != '"') return fallback;
   start++;
   int end = start;
   while(end < StringLen(json) && StringGetCharacter(json, end) != '"') end++;
   return StringSubstr(json, start, end - start);
}

// Extract a JSON numeric value: "key":1234.5  (returns fallback if missing)
double CFG_JsonDouble(const string json, const string key, double fallback = 0.0)
{
   string marker = "\"" + key + "\"";
   int key_pos = StringFind(json, marker);
   if(key_pos < 0) return fallback;
   int colon = StringFind(json, ":", key_pos + StringLen(marker));
   if(colon < 0) return fallback;
   int start = colon + 1;
   while(start < StringLen(json))
   {
      ushort ch = StringGetCharacter(json, start);
      if(ch == ' ' || ch == '\t') { start++; continue; }
      break;
   }
   string num_str = "";
   for(int i = start; i < StringLen(json); i++)
   {
      ushort ch = StringGetCharacter(json, i);
      if((ch >= '0' && ch <= '9') || ch == '.' || ch == '-') { uchar c[] = {(uchar)ch}; num_str += CharArrayToString(c); }
      else if(StringLen(num_str) > 0) break;
   }
   return (StringLen(num_str) > 0) ? StringToDouble(num_str) : fallback;
}

double CFG_JsonNumber(const string json, const string key, double fallback = 0.0)
{
   return CFG_JsonDouble(json, key, fallback);
}

// Extract a JSON bool value: "key":true / "key":false
bool CFG_JsonBool(const string json, const string key, bool fallback = false)
{
   string marker = "\"" + key + "\"";
   int key_pos = StringFind(json, marker);
   if(key_pos < 0) return fallback;
   int colon = StringFind(json, ":", key_pos + StringLen(marker));
   if(colon < 0) return fallback;
   int start = colon + 1;
   while(start < StringLen(json))
   {
      ushort ch = StringGetCharacter(json, start);
      if(ch == ' ' || ch == '\t') { start++; continue; }
      break;
   }
   string val = StringSubstr(json, start, 4);
   StringToLower(val);
   if(StringFind(val, "true")  == 0) return true;
   if(StringFind(val, "false") == 0) return false;
   return fallback;
}

// Extract a JSON int value
int CFG_JsonInt(const string json, const string key, int fallback = 0)
{
   return (int)CFG_JsonDouble(json, key, (double)fallback);
}

// Extract a sub-object: returns the content between the first { } after "key":{
string CFG_JsonObject(const string json, const string key)
{
   string marker = "\"" + key + "\"";
   int pos = StringFind(json, marker);
   if(pos < 0) return "";
   int brace = StringFind(json, "{", pos + StringLen(marker));
   if(brace < 0) return "";
   int depth = 0; int end = brace;
   for(int i = brace; i < StringLen(json); i++)
   {
      ushort ch = StringGetCharacter(json, i);
      if(ch == '{') depth++;
      else if(ch == '}') { depth--; if(depth == 0) { end = i; break; } }
   }
   return StringSubstr(json, brace, end - brace + 1);
}

// Parse ENUM_TIMEFRAMES from string label ("M1","M5","H1","H4","D1",etc.)
ENUM_TIMEFRAMES CFG_ParseTimeframe(const string s, ENUM_TIMEFRAMES fallback)
{
   string u = s; StringToUpper(u);
   if(u == "M1"  || u == "1M")  return PERIOD_M1;
   if(u == "M2"  || u == "2M")  return PERIOD_M2;
   if(u == "M3"  || u == "3M")  return PERIOD_M3;
   if(u == "M4"  || u == "4M")  return PERIOD_M4;
   if(u == "M5"  || u == "5M")  return PERIOD_M5;
   if(u == "M6"  || u == "6M")  return PERIOD_M6;
   if(u == "M10" || u == "10M") return PERIOD_M10;
   if(u == "M12" || u == "12M") return PERIOD_M12;
   if(u == "M15" || u == "15M") return PERIOD_M15;
   if(u == "M20" || u == "20M") return PERIOD_M20;
   if(u == "M30" || u == "30M") return PERIOD_M30;
   if(u == "H1"  || u == "1H")  return PERIOD_H1;
   if(u == "H2"  || u == "2H")  return PERIOD_H2;
   if(u == "H3"  || u == "3H")  return PERIOD_H3;
   if(u == "H4"  || u == "4H")  return PERIOD_H4;
   if(u == "H6"  || u == "6H")  return PERIOD_H6;
   if(u == "H8"  || u == "8H")  return PERIOD_H8;
   if(u == "H12" || u == "12H") return PERIOD_H12;
   if(u == "D1"  || u == "1D")  return PERIOD_D1;
   if(u == "W1"  || u == "1W")  return PERIOD_W1;
   if(u == "MN1" || u == "MN")  return PERIOD_MN1;
   return fallback;
}

//==========================================================================
// CFG_GetOptimalAtrPct — Symbol DNA Registry (port of GetOptimalATRPercentage)
// Returns the best ATR zone thickness % for the given symbol class.
// If the user manually changed atr_zone_pct from the default 10.0, honours it.
// Gold/XAU = 18%, Oil = 16%, Indices = 15%, FX pairs = 12.5%, else 10%.
//==========================================================================
double CFG_GetOptimalAtrPct(double configured_pct, const string sym)
{
   // User overrode the default — respect their choice
   if(MathAbs(configured_pct - 10.0) > 0.01) return configured_pct;

   string s = sym;
   StringToUpper(s);

   if(StringFind(s, "XAU")  >= 0 || StringFind(s, "GOLD") >= 0) return 18.0;
   if(StringFind(s, "OIL")  >= 0 || StringFind(s, "WTI")  >= 0 ||
      StringFind(s, "BRN")  >= 0 || StringFind(s, "LCO")  >= 0) return 16.0;
   if(StringFind(s, "30")   >= 0 || StringFind(s, "100")  >= 0 ||
      StringFind(s, "500")  >= 0 || StringFind(s, "DJI")  >= 0 ||
      StringFind(s, "NAS")  >= 0 || StringFind(s, "SPX")  >= 0 ||
      StringFind(s, "GER")  >= 0 || StringFind(s, "DAX")  >= 0) return 15.0;
   if(StringLen(s) >= 6) return 12.5;   // typical FX pair length
   return 10.0;
}

//==========================================================================
// CFG_ParseFromInputs — fill struct from EA input parameters
// Called first. Sets all fields to their input-default values.
//==========================================================================
void CFG_ParseFromInputs(
   IFX_EaConfig   &cfg,
   const string    connection_id,
   const string    ea_version,
   const string    ai_text,
   ENUM_TRADE_BIAS manual_bias,
   double          manual_pivot,
   double          manual_tp1,
   double          manual_tp2,
   double          atr_pct,
   double          sl_pad_mult,
   bool            use_asia,   string asia_start,  string asia_end,
   bool            use_lon,    string lon_start,   string lon_end,
   bool            use_ny,     string ny_start,    string ny_end,
   ENUM_TIMEFRAMES tf_engine,
   ENUM_TIMEFRAMES tf_boss,
   bool            use_mtf_sl,
   ENUM_TIMEFRAMES tf_sl,
   ENUM_TIMEFRAMES tf_be,
   double          risk_pct,
   bool            strict_risk,
   double          min_rr,
   int             max_trades,
   bool            use_dead_sl,
   int             sl_cooldown_min,
   bool            use_auto_rr,
   double          auto_rr1,
   double          auto_rr2,
   int             base_magic,
   int             pivot_len,
   bool            use_partial,
   double          tp1_pct,
   bool            use_be,
   bool            be_after_tp1,
   bool            use_eod,
   string          eod_time,
   bool            show_struct,
   int             smc_lookback,
   string          discord_url,
   int             report_hour,
   int             report_min,
   bool            enable_discord,
   bool            notify_on_sl,
   bool            notify_on_tp,
   bool            notify_daily,
   bool            exit_on_flip
)
{
   cfg.connection_id  = connection_id;
   cfg.ea_version     = ea_version;

   // Resolve bias from manual input
   if(manual_bias == BIAS_LONG)       cfg.bias = "Long";
   else if(manual_bias == BIAS_SHORT) cfg.bias = "Short";
   else                               cfg.bias = "Neutral";

   cfg.pivot          = manual_pivot;
   cfg.tp1            = manual_tp1;
   cfg.tp2            = manual_tp2;
   cfg.atr_zone_pct   = atr_pct;
   cfg.sl_pad_mult    = sl_pad_mult;
   cfg.confidence     = 70;   // default until AI text provides a score

   cfg.use_asia       = use_asia;
   cfg.asia_start     = asia_start;
   cfg.asia_end       = asia_end;
   cfg.use_lon        = use_lon;
   cfg.lon_start      = lon_start;
   cfg.lon_end        = lon_end;
   cfg.use_ny         = use_ny;
   cfg.ny_start       = ny_start;
   cfg.ny_end         = ny_end;

   cfg.tf_engine      = tf_engine;
   cfg.tf_boss        = tf_boss;
   cfg.use_mtf_sl     = use_mtf_sl;
   cfg.tf_sl          = tf_sl;
   cfg.tf_be          = tf_be;

   cfg.risk_pct       = risk_pct;
   cfg.strict_risk    = strict_risk;
   cfg.min_rr         = min_rr;
   cfg.max_trades     = max_trades;

   cfg.use_dead_sl    = use_dead_sl;
   cfg.sl_cooldown_min = sl_cooldown_min;

   cfg.use_auto_rr    = use_auto_rr;
   cfg.auto_rr1       = auto_rr1;
   cfg.auto_rr2       = auto_rr2;

   cfg.base_magic     = base_magic;
   cfg.pivot_len      = pivot_len;
   cfg.use_partial    = use_partial;
   cfg.tp1_pct        = tp1_pct;
   cfg.use_be         = use_be;
   cfg.be_after_tp1   = be_after_tp1;
   cfg.use_eod        = use_eod;
   cfg.eod_time       = eod_time;

   cfg.show_struct    = show_struct;
   cfg.smc_lookback   = smc_lookback;

   cfg.discord_url    = discord_url;
   cfg.report_hour    = report_hour;
   cfg.report_min     = report_min;
   cfg.enable_discord = enable_discord;
   cfg.notify_on_sl   = notify_on_sl;
   cfg.notify_on_tp   = notify_on_tp;
   cfg.notify_daily   = notify_daily;
   cfg.exit_on_flip   = exit_on_flip;

   cfg.symbols_csv    = "";

   // Apply AI text on top of manual inputs (same priority as original EA)
   CFG_ApplyAiText(cfg, ai_text);
}

//==========================================================================
// CFG_ApplyAiText — parse AI brain text into config fields.
// Matches original ParseValue() keyword logic exactly.
// Safe to call with empty string (no-op).
//==========================================================================
void CFG_ApplyAiText(IFX_EaConfig &cfg, const string ai_text)
{
   if(StringLen(ai_text) < 5) return;

   string up = ai_text;
   StringToUpper(up);

   // Bias — try JSON key "BIAS":"..." first, fall back to keyword scan.
   // This handles the structured LLM JSON output format exactly.
   {
      string bias_key_val = CFG_JsonString(ai_text, "BIAS", "");
      if(StringLen(bias_key_val) == 0)
         bias_key_val = CFG_JsonString(ai_text, "bias", "");   // lowercase fallback

      if(StringLen(bias_key_val) > 0)
      {
         StringToUpper(bias_key_val);
         if(StringFind(bias_key_val, "BULLISH") >= 0 || StringFind(bias_key_val, "LONG")  >= 0)
            cfg.bias = "Long";
         else if(StringFind(bias_key_val, "BEARISH") >= 0 || StringFind(bias_key_val, "SHORT") >= 0)
            cfg.bias = "Short";
         else
            cfg.bias = "Neutral";
      }
      else
      {
         // Plain-text fallback (e.g. "Bullish bias expected")
         if(StringFind(up, "BULLISH") >= 0 || StringFind(up, "LONG") >= 0)
            cfg.bias = "Long";
         else if(StringFind(up, "BEARISH") >= 0 || StringFind(up, "SHORT") >= 0)
            cfg.bias = "Short";
         // else keep existing bias
      }
   }

   // Levels — try specific JSON keys first, fall back to generic keywords
   double v;

   // Pivot: "ENTRY PIVOT ZONE" is the structured LLM key; "PIVOT" is the legacy keyword
   v = CFG_ParseValue(ai_text, "ENTRY PIVOT ZONE", 0.0);
   if(v == 0.0) v = CFG_ParseValue(ai_text, "PIVOT", 0.0);
   if(v > 0.0) cfg.pivot = v;

   // TP1: "TARGET 1" (with PRICE POINT fix in CFG_ParseValue), fall back to "TP1"
   v = CFG_ParseValue(ai_text, "TARGET 1", 0.0);
   if(v == 0.0) v = CFG_ParseValue(ai_text, "TP1", 0.0);
   if(v > 0.0) cfg.tp1 = v;

   // TP2: "TARGET 2" (with PRICE POINT fix), fall back to "TP2"
   v = CFG_ParseValue(ai_text, "TARGET 2", 0.0);
   if(v == 0.0) v = CFG_ParseValue(ai_text, "TP2", 0.0);
   if(v > 0.0) cfg.tp2 = v;

   cfg.tp1 = NormalizeDouble(cfg.tp1, _Digits);
   cfg.tp2 = NormalizeDouble(cfg.tp2, _Digits);

   // Confidence score (0-100, default 70)
   int conf = (int)CFG_ParseValue(ai_text, "CONFIDENCE SCORE", 70.0);
   if(conf > 0 && conf <= 100) cfg.confidence = conf;
}

//==========================================================================
// CFG_ParseFromCloudJson — overlay fields from /api/ea/config response JSON.
// Only overwrites fields that are present in the JSON (non-zero / non-empty).
// This makes the cloud config a pure override layer on top of EA inputs.
//
// Expected JSON shape (schema v3):
// {
//   "schema_version": 3,
//   "connection_id": "...",
//   "setup": { "ai_text":"...","bias":"Long","pivot":2650.5,"tp1":2680,"tp2":2720,
//               "atr_zone_thickness_pct":10,"sl_pad_mult":2.0 },
//   "structure": { "boss_timeframe":"H1","sl_timeframe":"M15",
//                  "be_timeframe":"M10","smc_lookback":400,"show_struct":false },
//   "risk": { "risk_percent":2.0,"max_daily_trades":3,
//             "strict_risk":false,"min_rr":1.0 },
//   "execution": { "base_magic":9180,"sl_pad_mult":2.0,"use_mtf_sl":true,
//                  "use_dead_sl":true,"sl_cooldown_min":30,"use_auto_rr":false,
//                  "auto_rr1":1.0,"auto_rr2":2.0,"tp1_pct":75.0,
//                  "break_even_after_tp1":true,"eod_time":"23:50" },
//   "sessions": { "asia":{"enabled":false,"start":"19:00","end":"03:00"},
//                 "london":{"enabled":true,"start":"03:00","end":"11:00"},
//                 "new_york":{"enabled":true,"start":"08:00","end":"17:00"} },
//   "discord": { "webhook_url":"...","report_hour":22,"report_min":0 },
//   "symbols": { "active":["XAUUSD","EURUSD",...] }
// }
//==========================================================================
void CFG_ParseFromCloudJson(IFX_EaConfig &cfg, const string json)
{
   if(StringLen(json) < 5) return;

   // setup section
   string setup = CFG_JsonObject(json, "setup");
   string setup_ai_text = "";
   if(StringLen(setup) > 0)
   {
      setup_ai_text = CFG_JsonString(setup, "ai_text", "");

      string bias_str = CFG_JsonString(setup, "bias", "");
      if(StringLen(bias_str) > 0)
      {
         StringToLower(bias_str);
         if(bias_str == "buy"  || bias_str == "long")  cfg.bias = "Long";
         else if(bias_str == "sell" || bias_str == "short") cfg.bias = "Short";
         else if(bias_str == "neutral")                    cfg.bias = "Neutral";
      }

      double v;
      v = CFG_JsonDouble(setup, "pivot", 0.0);            if(v > 0.0) cfg.pivot = v;
      v = CFG_JsonDouble(setup, "tp1",   0.0);            if(v > 0.0) cfg.tp1   = NormalizeDouble(v, _Digits);
      v = CFG_JsonDouble(setup, "tp2",   0.0);            if(v > 0.0) cfg.tp2   = NormalizeDouble(v, _Digits);
      v = CFG_JsonDouble(setup, "atr_zone_thickness_pct", 0.0); if(v > 0.0) cfg.atr_zone_pct = v;
      v = CFG_JsonDouble(setup, "sl_pad_mult", 0.0);      if(v > 0.0) cfg.sl_pad_mult = v;
   }

   // structure section
   string struc = CFG_JsonObject(json, "structure");
   if(StringLen(struc) > 0)
   {
      string tf;
      tf = CFG_JsonString(struc, "boss_timeframe", ""); if(StringLen(tf) > 0) cfg.tf_boss = CFG_ParseTimeframe(tf, cfg.tf_boss);
      tf = CFG_JsonString(struc, "sl_timeframe",   ""); if(StringLen(tf) > 0) cfg.tf_sl   = CFG_ParseTimeframe(tf, cfg.tf_sl);
      tf = CFG_JsonString(struc, "be_timeframe",   ""); if(StringLen(tf) > 0) cfg.tf_be   = CFG_ParseTimeframe(tf, cfg.tf_be);
      int v_i = CFG_JsonInt(struc, "smc_lookback", 0);  if(v_i > 0) cfg.smc_lookback = v_i;
      // show_struct is a bool — always apply if present
      string tmp = struc;
      if(StringFind(tmp, "\"show_struct\"") >= 0)
         cfg.show_struct = CFG_JsonBool(struc, "show_struct", cfg.show_struct);
   }

   // risk section
   string risk = CFG_JsonObject(json, "risk");
   if(StringLen(risk) > 0)
   {
      double v;
      v = CFG_JsonDouble(risk, "risk_percent",     0.0); if(v > 0.0) cfg.risk_pct   = v;
      int vi = CFG_JsonInt(risk, "max_daily_trades", 0); if(vi > 0) cfg.max_trades  = vi;
      v = CFG_JsonDouble(risk, "min_rr",            0.0); if(v > 0.0) cfg.min_rr     = v;
      if(StringFind(risk, "\"strict_risk\"") >= 0)
         cfg.strict_risk = CFG_JsonBool(risk, "strict_risk", cfg.strict_risk);
   }

   // execution section
   string exec = CFG_JsonObject(json, "execution");
   if(StringLen(exec) > 0)
   {
      int vi;
      double v;
      vi = CFG_JsonInt(exec, "base_magic",      0);     if(vi > 0) cfg.base_magic      = vi;
      v  = CFG_JsonDouble(exec, "sl_pad_mult",  0.0);  if(v > 0.0) cfg.sl_pad_mult     = v;
      vi = CFG_JsonInt(exec, "sl_cooldown_min", 0);     if(vi > 0) cfg.sl_cooldown_min  = vi;
      v  = CFG_JsonDouble(exec, "auto_rr1",     0.0);  if(v > 0.0) cfg.auto_rr1         = v;
      v  = CFG_JsonDouble(exec, "auto_rr2",     0.0);  if(v > 0.0) cfg.auto_rr2         = v;
      v  = CFG_JsonDouble(exec, "tp1_pct",      0.0);  if(v > 0.0) cfg.tp1_pct          = v;
      string eod = CFG_JsonString(exec, "eod_time", ""); if(StringLen(eod) > 0) cfg.eod_time = eod;

      if(StringFind(exec, "\"use_mtf_sl\"")         >= 0) cfg.use_mtf_sl    = CFG_JsonBool(exec, "use_mtf_sl",         cfg.use_mtf_sl);
      if(StringFind(exec, "\"use_dead_sl\"")         >= 0) cfg.use_dead_sl   = CFG_JsonBool(exec, "use_dead_sl",        cfg.use_dead_sl);
      if(StringFind(exec, "\"use_auto_rr\"")         >= 0) cfg.use_auto_rr   = CFG_JsonBool(exec, "use_auto_rr",        cfg.use_auto_rr);
      if(StringFind(exec, "\"break_even_after_tp1\"") >= 0) cfg.be_after_tp1 = CFG_JsonBool(exec, "break_even_after_tp1", cfg.be_after_tp1);
   }

   // sessions section
   string sessions = CFG_JsonObject(json, "sessions");
   if(StringLen(sessions) > 0)
   {
      string asia = CFG_JsonObject(sessions, "asia");
      if(StringLen(asia) > 0)
      {
         if(StringFind(asia, "\"enabled\"") >= 0) cfg.use_asia = CFG_JsonBool(asia, "enabled", cfg.use_asia);
         string v = CFG_JsonString(asia, "start", ""); if(StringLen(v) > 0) cfg.asia_start = v;
         v = CFG_JsonString(asia, "end", "");           if(StringLen(v) > 0) cfg.asia_end   = v;
      }
      string london = CFG_JsonObject(sessions, "london");
      if(StringLen(london) > 0)
      {
         if(StringFind(london, "\"enabled\"") >= 0) cfg.use_lon = CFG_JsonBool(london, "enabled", cfg.use_lon);
         string v = CFG_JsonString(london, "start", ""); if(StringLen(v) > 0) cfg.lon_start = v;
         v = CFG_JsonString(london, "end", "");           if(StringLen(v) > 0) cfg.lon_end   = v;
      }
      string ny = CFG_JsonObject(sessions, "new_york");
      if(StringLen(ny) > 0)
      {
         if(StringFind(ny, "\"enabled\"") >= 0) cfg.use_ny = CFG_JsonBool(ny, "enabled", cfg.use_ny);
         string v = CFG_JsonString(ny, "start", ""); if(StringLen(v) > 0) cfg.ny_start = v;
         v = CFG_JsonString(ny, "end", "");           if(StringLen(v) > 0) cfg.ny_end   = v;
      }
   }

   // discord section
   string disc = CFG_JsonObject(json, "discord");
   if(StringLen(disc) > 0)
   {
      string wh = CFG_JsonString(disc, "webhook_url", ""); if(StringLen(wh) > 0) cfg.discord_url  = wh;
      int rh = CFG_JsonInt(disc, "report_hour", -1);       if(rh >= 0)           cfg.report_hour  = rh;
      int rm = CFG_JsonInt(disc, "report_min",  -1);        if(rm >= 0)           cfg.report_min   = rm;
   }

   // symbols.active → build csv for relay
   string syms_obj = CFG_JsonObject(json, "symbols");
   if(StringLen(syms_obj) > 0)
   {
      // Parse "active":["XAUUSD","EURUSD",...]
      int arr_start = StringFind(syms_obj, "[");
      int arr_end   = StringFind(syms_obj, "]");
      if(arr_start >= 0 && arr_end > arr_start)
      {
         string arr = StringSubstr(syms_obj, arr_start + 1, arr_end - arr_start - 1);
         StringReplace(arr, "\"", "");
         StringReplace(arr, " ",  "");
         if(StringLen(arr) > 0) cfg.symbols_csv = arr;
      }
   }

   if(StringLen(setup_ai_text) > 0)
      CFG_ApplyAiText(cfg, setup_ai_text);
}

//==========================================================================
// CFG_FetchAndApplyCloudConfig
// Performs GET /api/ea/config?connection_id={id} on the Next.js dashboard.
// Passes install_token as Bearer auth (obtained from bootstrap manifest).
// Response shape: { "ok": true, "config": { ...normalizedEaConfig... } }
// Falls back silently if endpoint unreachable.
// Returns true if cloud config was applied.
//==========================================================================
bool CFG_FetchAndApplyCloudConfig(
   IFX_EaConfig &cfg,
   const string  frontend_url,
   const string  connection_id,
   const string  install_token = "")
{
   if(StringLen(frontend_url) == 0 || StringLen(connection_id) == 0) return false;

   string url = frontend_url + "/api/ea/config?connection_id=" + connection_id;

   string req_headers = "Content-Type: application/json\r\n";
   if(StringLen(install_token) > 0)
      req_headers += "Authorization: Bearer " + install_token + "\r\n";

   uchar  emptyData[];
   ArrayResize(emptyData, 0);
   uchar  result[];
   string resultHeaders = "";

   ResetLastError();
   int status = WebRequest("GET", url, req_headers, 8000, emptyData, result, resultHeaders);

   if(status != 200)
   {
      int err = GetLastError();
      Print("⚠️ [CONFIG] cloud config unreachable (HTTP ", status, " err=", err, ") — using inputs");
      return false;
   }

   string json = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   if(StringLen(json) < 5)
   {
      Print("⚠️ [CONFIG] cloud config returned empty body");
      return false;
   }

   // Response: { "ok": true, "config": { ...fields... } }
   // Unwrap the nested "config" object
   string config_obj = CFG_JsonObject(json, "config");
   if(StringLen(config_obj) < 5)
   {
      // Fallback: server returned flat JSON (shouldn't happen but be safe)
      config_obj = json;
   }

   CFG_ParseFromCloudJson(cfg, config_obj);
   Print("✅ [CONFIG] cloud config applied: bias=", cfg.bias,
         " pivot=", DoubleToString(cfg.pivot, _Digits),
         " tp1=",   DoubleToString(cfg.tp1, _Digits),
         " tp2=",   DoubleToString(cfg.tp2, _Digits));
   return true;
}

//==========================================================================
// CFG_ValidateConfig — protect real money from bad config data
// Returns true if config is safe to trade with.
// out_error is set to a human-readable reason on failure.
//
// Rules:
//   1. atr_zone_pct must be in (0, 100]
//   2. sl_pad_mult  must be > 0
//   3. risk_pct     must be in (0, 50]
//   4. bias         must be "Long", "Short", or "Neutral"
//   5. If bias is directional AND pivot > 0 AND TPs are set:
//        Long:  tp1 > pivot,  tp2 > tp1
//        Short: tp1 < pivot,  tp2 < tp1
//
// Note: pivot == 0 is NOT a fatal error — it just means no setup is
// configured yet (Neutral behaviour). The EA will stalk when pivot is set.
//==========================================================================
bool CFG_ValidateConfig(const IFX_EaConfig &cfg, string &out_error)
{
   out_error = "";

   // ── 1. ATR zone ────────────────────────────────────────────────────────
   if(cfg.atr_zone_pct <= 0.0 || cfg.atr_zone_pct > 100.0)
   {
      out_error = "atr_zone_pct out of range (0,100]: " + DoubleToString(cfg.atr_zone_pct, 2);
      return false;
   }

   // ── 2. SL pad multiplier ───────────────────────────────────────────────
   if(cfg.sl_pad_mult <= 0.0)
   {
      out_error = "sl_pad_mult must be > 0 (got " + DoubleToString(cfg.sl_pad_mult, 2) + ")";
      return false;
   }

   // ── 3. Risk percent ────────────────────────────────────────────────────
   if(cfg.risk_pct <= 0.0 || cfg.risk_pct > 50.0)
   {
      out_error = "risk_pct out of range (0,50]: " + DoubleToString(cfg.risk_pct, 2);
      return false;
   }

   // ── 4. Bias string ─────────────────────────────────────────────────────
   if(cfg.bias != "Long" && cfg.bias != "Short" && cfg.bias != "Neutral")
   {
      out_error = "unknown bias value: '" + cfg.bias + "'";
      return false;
   }

   // ── 5. Directional TP structure (only validated when TPs are set) ──────
   if(cfg.pivot > 0.0)
   {
      if(cfg.bias == "Long")
      {
         if(cfg.tp1 > 0.0 && cfg.tp1 <= cfg.pivot)
         {
            out_error = "LONG: tp1 (" + DoubleToString(cfg.tp1, _Digits) +
                        ") must be > pivot (" + DoubleToString(cfg.pivot, _Digits) + ")";
            return false;
         }
         if(cfg.tp1 > 0.0 && cfg.tp2 > 0.0 && cfg.tp2 <= cfg.tp1)
         {
            out_error = "LONG: tp2 (" + DoubleToString(cfg.tp2, _Digits) +
                        ") must be > tp1 (" + DoubleToString(cfg.tp1, _Digits) + ")";
            return false;
         }
      }
      else if(cfg.bias == "Short")
      {
         if(cfg.tp1 > 0.0 && cfg.tp1 >= cfg.pivot)
         {
            out_error = "SHORT: tp1 (" + DoubleToString(cfg.tp1, _Digits) +
                        ") must be < pivot (" + DoubleToString(cfg.pivot, _Digits) + ")";
            return false;
         }
         if(cfg.tp1 > 0.0 && cfg.tp2 > 0.0 && cfg.tp2 >= cfg.tp1)
         {
            out_error = "SHORT: tp2 (" + DoubleToString(cfg.tp2, _Digits) +
                        ") must be < tp1 (" + DoubleToString(cfg.tp1, _Digits) + ")";
            return false;
         }
      }
   }

   return true;
}

//==========================================================================
// CFG_Print — diagnostic log of active config
//==========================================================================
void CFG_Print(const IFX_EaConfig &cfg)
{
   Print("--- IFX Config Snapshot ---");
   Print("  conn=",      cfg.connection_id, "  version=", cfg.ea_version);
   Print("  bias=",      cfg.bias,          "  pivot=",   DoubleToString(cfg.pivot, _Digits));
   Print("  tp1=",       DoubleToString(cfg.tp1, _Digits),
         "  tp2=",       DoubleToString(cfg.tp2, _Digits));
   Print("  atr_pct=",   cfg.atr_zone_pct,  "  sl_pad=",  cfg.sl_pad_mult);
   Print("  risk=",      cfg.risk_pct,       "%  magic=",  cfg.base_magic);
   Print("  tf_engine=", EnumToString(cfg.tf_engine),
         "  tf_boss=",   EnumToString(cfg.tf_boss));
   Print("  symbols=",   cfg.symbols_csv);
   Print("---------------------------");
}

#endif // IFX_CONFIG_MQH
//+------------------------------------------------------------------+
