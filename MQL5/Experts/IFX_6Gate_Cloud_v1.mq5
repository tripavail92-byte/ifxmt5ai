//+------------------------------------------------------------------+
//|  IFX_6Gate_Cloud_v1.mq5                                          |
//|  IFX 6-Gate Sniper — Cloud Edition v1.00                         |
//|  Phase 2C — Thin main EA shell                                   |
//|                                                                  |
//|  Architecture: Modular Facade (5 #include modules)               |
//|    IFX_RelayClient.mqh     cloud relay + multi-symbol bridge     |
//|    IFX_Config.mqh          config struct + cloud/AI text parser  |
//|    IFX_StructureEngine.mqh SMC pivot detection + HUD + drawing   |
//|    IFX_RiskEngine.mqh      lot sizing + sessions + SL cooldown   |
//|    IFX_TradeExecutor.mqh   entry + manage + Discord              |
//|                                                                  |
//|  OnInit   → CFG_ParseFromInputs → CFG_FetchAndApplyCloudConfig  |
//|             → RelayClient_Init → zone calc → HUD draw            |
//|  OnTick   → RelayClient_Tick → gate checks → entry / manage     |
//|  OnTimer  → RelayClient_Timer → HUD refresh → report check      |
//|  OnDeinit → RelayClient_Deinit → SE_CleanupObjects               |
//+------------------------------------------------------------------+
#property copyright "IFX Trading Systems"
#property link      ""
#property version   "1.00"
#property strict

//==========================================================================
// INCLUDES — order matters (each module uses types from those above it)
//==========================================================================
#include <IFX\IFX_RelayClient.mqh>
#include <IFX\IFX_Config.mqh>
#include <IFX\IFX_StructureEngine.mqh>
#include <IFX\IFX_RiskEngine.mqh>
#include <IFX\IFX_TradeExecutor.mqh>

//==========================================================================
// INPUTS — AI BRAIN SETUP
//==========================================================================
input group              "=== AI Brain Setup ==="
input string             i_ai_text      = "";               // AI Brain Text (paste full output)
input ENUM_TRADE_BIAS    i_bias         = BIAS_NEUTRAL;     // Manual Bias Override
input double             i_pivot        = 0.0;              // Manual Pivot Price
input double             i_tp1          = 0.0;              // Manual TP1 Price
input double             i_tp2          = 0.0;              // Manual TP2 Price
input double             i_atrPct       = 10.0;             // Zone Thickness (% of Daily ATR)
input double             i_slPadMult    = 2.0;              // SL Pad Multiplier (× point)

//==========================================================================
// INPUTS — SESSIONS
//==========================================================================
input group              "=== Trading Sessions ==="
input bool               i_useAsia      = false;            // Enable Asia Session
input string             i_asiaStart    = "19:00";          // Asia Start (server time)
input string             i_asiaEnd      = "03:00";          // Asia End
input bool               i_useLon       = true;             // Enable London Session
input string             i_lonStart     = "03:00";          // London Start
input string             i_lonEnd       = "11:00";          // London End
input bool               i_useNY        = true;             // Enable New York Session
input string             i_nyStart      = "08:00";          // New York Start
input string             i_nyEnd        = "17:00";          // New York End

//==========================================================================
// INPUTS — TIMEFRAMES
//==========================================================================
input group              "=== Timeframes ==="
input ENUM_TIMEFRAMES    i_tfEngine     = PERIOD_M15;       // Engine / Entry Timeframe
input ENUM_TIMEFRAMES    i_tfBoss       = PERIOD_H1;        // Boss / Invalidation Timeframe
input bool               i_useMtfSL    = true;              // Enable MTF SL Trailing
input ENUM_TIMEFRAMES    i_tfSL         = PERIOD_M15;       // SL Trailing Timeframe
input ENUM_TIMEFRAMES    i_tfBE         = PERIOD_M10;       // Break-Even Reference Timeframe

//==========================================================================
// INPUTS — RISK
//==========================================================================
input group              "=== Risk ==="
input double             i_riskPct      = 2.0;              // Risk Per Trade (%)
input bool               i_strictRisk   = false;            // Strict Risk (use equity, not balance)
input double             i_minRR        = 1.5;              // Minimum R:R Ratio (0 = disabled)
input int                i_maxTrades    = 3;                // Max Daily Trades

//==========================================================================
// INPUTS — TRADE MANAGEMENT
//==========================================================================
input group              "=== Trade Management ==="
input bool               i_useDeadSL    = true;             // Enable SL Cooldown Guard
input int                i_slCooldown   = 30;               // SL Cooldown (minutes)
input bool               i_useAutoRR    = false;            // Use Auto R:R from SL Distance
input double             i_autoRR1      = 1.0;              // Auto RR Multiplier TP1
input double             i_autoRR2      = 2.0;              // Auto RR Multiplier TP2
input int                i_baseMagic    = 9180;             // Base Magic Number
input int                i_pivotLen     = 10;               // Pivot High/Low Lookback (bars)
input bool               i_usePartial   = true;             // Partial Exit at TP1
input double             i_tp1Pct       = 75.0;             // Lots to Close at TP1 (%)
input bool               i_useBE        = true;             // Enable Break-Even
input bool               i_beAfterTP1   = true;             // Move BE After TP1 Hit
input bool               i_useEOD       = true;             // Close All at EOD
input string             i_eodTime      = "23:50";          // EOD Cutoff Time (server)

//==========================================================================
// INPUTS — VISUALS & DISCORD
//==========================================================================
input group              "=== Visuals ==="
input bool               i_showStruct   = true;             // Draw SMC Structure
input int                i_smcLookback  = 400;              // SMC Lookback (bars)

input group              "=== Discord ==="
input string             i_discordUrl   = "";               // Discord Webhook URL
input int                i_reportHour   = 22;               // Daily Report Hour
input int                i_reportMin    = 0;                // Daily Report Minute

//==========================================================================
// INPUTS — CLOUD CONNECTION
//==========================================================================
input group              "=== Cloud Connection ==="
input string             i_connectionId  = "";              // Connection ID override (leave blank = auto from bootstrap)
input string             i_frontendUrl   = "";              // Dashboard URL e.g. https://app.ifx.com (for cloud config sync)

//==========================================================================
// EA STATE MACHINE
//==========================================================================
enum EA_STATE
{
   STATE_UNPAIRED,        // no bootstrap.json / no connection_id — waiting for provisioning
   STATE_CONFIG_LOADING,  // have connection_id, cloud config not yet verified
   STATE_READY,           // config validated, trading gates active
   STATE_DEAD,            // fatal stop: invalid config, stale timeout, too many failures
   STATE_ERROR            // persistent comms failure (>10 fetch retries in CONFIG_LOADING)
};

//==========================================================================
// EA STATE
//==========================================================================
string       s_ea_version             = "IFX_6Gate_Cloud_v1.00";
EA_STATE     g_ea_state               = STATE_UNPAIRED;
int          s_cfg_retry_count        = 0;  // CONFIG_LOADING retry counter
datetime     s_last_cfg_poll          = 0;  // last time a config fetch was attempted
int          s_hot_reload_fail_count  = 0;  // consecutive hot-reload failures in STATE_READY
datetime     s_last_valid_cfg_time    = 0;  // when config was last successfully validated
string       s_locked_conn_id         = ""; // connection_id pinned when entering STATE_READY
bool         g_has_pending_cfg        = false; // queued config waiting for trade close
IFX_EaConfig g_pending_cfg;                    // deferred config buffer
double       s_zone_high              = 0.0;
double       s_zone_low               = 0.0;
double       s_calc_inval             = 0.0;
bool         s_zone_valid             = false;
int          s_atr_handle             = INVALID_HANDLE;

// Phase 4: command polling + live-state push
long         s_cmd_cursor             = 0;    // highest sequence_no acked so far
datetime     s_last_cmd_poll          = 0;    // last command poll attempt
datetime     s_last_hud_push          = 0;    // last live-state POST attempt

// Phase 5: trade audit
datetime     s_last_audit_check       = 0;    // last closed-trade scan

//==========================================================================
// CMD_PollAndExecute — polls /api/ea/commands and executes each command
// Called every ~5 seconds from OnTimer (STATE_READY only).
//==========================================================================
void CMD_PollAndExecute(const string frontend_url, const string conn_id, const string install_token)
{
   if(StringLen(frontend_url) == 0 || StringLen(conn_id) == 0 || StringLen(install_token) == 0) return;

   // Build URL: GET /api/ea/commands?connection_id=...&cursor=...
   string url = frontend_url + "/api/ea/commands"
                + "?connection_id=" + conn_id
                + "&cursor="        + IntegerToString(s_cmd_cursor)
                + "&limit=20";

   string headers = "Content-Type: application/json\r\nX-IFX-INSTALL-TOKEN: " + install_token + "\r\n";
   uchar  empty[];
   ArrayResize(empty, 0);
   uchar  result[];
   string result_headers = "";

   ResetLastError();
   int status = WebRequest("GET", url, headers, 5000, empty, result, result_headers);
   if(status < 200 || status >= 300)
   {
      // Silent — avoid log spam on transient failures
      return;
   }

   string resp = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);

   // Quick sanity: must contain "commands"
   if(StringFind(resp, "\"commands\"") < 0) return;

   // Iterate over command objects.  We do a simple sequential scan rather than
   // a full JSON parser — commands array is small (<= 20 items) and predictable.
   int pos = StringFind(resp, "\"commands\"");
   int arr_open = StringFind(resp, "[", pos);
   if(arr_open < 0) return;

   int depth    = 0;
   int obj_open = -1;

   for(int i = arr_open; i < StringLen(resp); i++)
   {
      ushort ch = StringGetCharacter(resp, i);

      if(ch == '{')
      {
         if(depth == 1) obj_open = i;  // start of a command object at depth 1
         depth++;
      }
      else if(ch == '}')
      {
         depth--;
         if(depth == 1 && obj_open >= 0)
         {
            // Extract the command object substring
            string cmd_json = StringSubstr(resp, obj_open, i - obj_open + 1);

            // Parse fields we need
            string cmd_id   = RC_JsonExtractStringAfter(cmd_json, 0, "id");
            string cmd_type = RC_JsonExtractStringAfter(cmd_json, 0, "command_type");
            int    seq_no   = 0;
            {
               int sn_key = StringFind(cmd_json, "\"sequence_no\"");
               if(sn_key >= 0)
               {
                  int colon = StringFind(cmd_json, ":", sn_key);
                  if(colon >= 0) seq_no = (int)StringToInteger(StringSubstr(cmd_json, colon + 1, 20));
               }
            }

            if(StringLen(cmd_id) == 0 || StringLen(cmd_type) == 0) { obj_open = -1; continue; }

            // ── Execute command ───────────────────────────────────────────
            string ack_status = "acknowledged";

            if(cmd_type == "close_position")
            {
               if(RE_CountOpenPositions(g_cfg) > 0)
               {
                  TE_CloseAllPositions(g_cfg);
                  Print("🛑 [CMD] close_position executed. id=", cmd_id);
               }
            }
            else if(cmd_type == "sync_config")
            {
               // Force immediate config re-fetch on the next poll cycle
               s_last_cfg_poll = 0;
               Print("🔄 [CMD] sync_config — forced re-fetch. id=", cmd_id);
            }
            else if(cmd_type == "arm_trade" || cmd_type == "set_setup")
            {
               // Extract payload fields for pivot/tp1/tp2/bias — update live config
               // Only applied when no position is open (safe to change setup mid-session)
               if(RE_CountOpenPositions(g_cfg) == 0)
               {
                  int pay_pos = StringFind(cmd_json, "\"payload\"");
                  if(pay_pos >= 0)
                  {
                     string bias_val  = RC_JsonExtractStringAfter(cmd_json, pay_pos, "bias");
                     string pivot_str = RC_JsonExtractStringAfter(cmd_json, pay_pos, "pivot");
                     string tp1_str   = RC_JsonExtractStringAfter(cmd_json, pay_pos, "tp1");
                     string tp2_str   = RC_JsonExtractStringAfter(cmd_json, pay_pos, "tp2");

                     // Use field directly too (bare numeric): re-scan for "entry_price" legacy
                     if(StringLen(pivot_str) == 0)
                        pivot_str = RC_JsonExtractStringAfter(cmd_json, pay_pos, "entry_price");

                     if(StringLen(bias_val) > 0)
                     {
                        string b = bias_val;
                        StringToUpper(b);
                        if(b == "BUY" || b == "LONG")        g_cfg.bias = "Long";
                        else if(b == "SELL" || b == "SHORT") g_cfg.bias = "Short";
                        else                                  g_cfg.bias = "Neutral";
                     }
                     if(StringLen(pivot_str) > 0 && StringToDouble(pivot_str) > 0.0)
                        g_cfg.pivot = StringToDouble(pivot_str);
                     if(StringLen(tp1_str) > 0 && StringToDouble(tp1_str) > 0.0)
                        g_cfg.tp1 = StringToDouble(tp1_str);
                     if(StringLen(tp2_str) > 0 && StringToDouble(tp2_str) > 0.0)
                        g_cfg.tp2 = StringToDouble(tp2_str);

                     RecalcZone();
                     Print("\U0001F3AF [CMD] arm_trade applied. bias=", g_cfg.bias,
                           " pivot=", DoubleToString(g_cfg.pivot, _Digits),
                           "  id=", cmd_id);
                  }
               }
               else
               {
                  // Trade active — cannot change setup mid-position
                  Print("ℹ️ [CMD] arm_trade deferred — trade open. id=", cmd_id);
                  ack_status = "failed";
               }
            }
            else if(cmd_type == "cancel_trade")
            {
               // Reset pivot so the EA stops watching this zone
               g_cfg.pivot = 0.0;
               s_zone_valid = false;
               Print("\U0001F6AB [CMD] cancel_trade \u2014 pivot cleared. id=", cmd_id);
            }
            else
            {
               Print("ℹ️ [CMD] unknown command_type=", cmd_type, " id=", cmd_id);
            }

            // ── ACK ─────────────────────────────────────────────────────
            string ack_url  = frontend_url + "/api/ea/commands/ack";
            string ack_json = "{";
            ack_json += "\"connection_id\":\"" + RC_EscapeJson(conn_id) + "\",";
            ack_json += "\"command_id\":\""    + RC_EscapeJson(cmd_id)  + "\",";
            ack_json += "\"sequence_no\":"     + IntegerToString(seq_no) + ",";
            ack_json += "\"status\":\""        + RC_EscapeJson(ack_status) + "\"";
            ack_json += "}";

            string ack_resp = "";
            RC_ControlPlanePost(ack_url, ack_json, ack_resp, 5000);

            // Advance cursor to highest processed sequence_no
            if(seq_no > s_cmd_cursor) s_cmd_cursor = seq_no;

            obj_open = -1;
         }
      }
      else if(ch == ']' && depth == 1)
      {
         // End of commands array
         break;
      }
   }
}

//==========================================================================
// HUD_PushLiveState — POSTs current HUD + position state to /api/ea/live-state
// Called every ~15 seconds from OnTimer (STATE_READY only).
//==========================================================================
void HUD_PushLiveState(
   const string frontend_url, const string conn_id, const string install_token,
   const string hud_status,   bool in_zone,         bool be_secured,
   int daily_cnt)
{
   if(StringLen(frontend_url) == 0 || StringLen(conn_id) == 0 || StringLen(install_token) == 0) return;

   // Gather position data
   double live_sl   = TE_GetLiveSL(g_cfg);
   double live_lots = TE_GetLiveLots(g_cfg);
   double unrealised_pnl = 0.0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong t = PositionGetTicket(i);
      if(PositionGetString(t, POSITION_SYMBOL) != _Symbol) continue;
      long mg = PositionGetInteger(t, POSITION_MAGIC);
      if(mg < g_cfg.base_magic || mg > g_cfg.base_magic + 50) continue;
      unrealised_pnl += PositionGetDouble(t, POSITION_PROFIT);
   }

   // Build JSON
   string j = "{";
   j += "\"connection_id\":\""   + RC_EscapeJson(conn_id) + "\",";
   j += "\"hud_status\":\""      + RC_EscapeJson(hud_status) + "\",";
   j += "\"sys_bias\":\""        + RC_EscapeJson(g_cfg.bias) + "\",";
   j += "\"sys_pivot\":"         + DoubleToString(g_cfg.pivot, _Digits) + ",";
   j += "\"sys_tp1\":"           + DoubleToString(g_cfg.tp1,   _Digits) + ",";
   j += "\"sys_tp2\":"           + DoubleToString(g_cfg.tp2,   _Digits) + ",";
   j += "\"invalidation_lvl\":"  + DoubleToString(s_calc_inval, _Digits) + ",";
   j += "\"live_sl\":"           + DoubleToString(live_sl,   _Digits) + ",";
   j += "\"live_lots\":"         + DoubleToString(live_lots, 2)        + ",";
   j += "\"is_inside_zone\":"    + (in_zone    ? "true" : "false") + ",";
   j += "\"is_be_secured\":"     + (be_secured ? "true" : "false") + ",";
   j += "\"unrealised_pnl\":"    + DoubleToString(unrealised_pnl, 2) + ",";
   j += "\"daily_trades\":"      + IntegerToString(daily_cnt) + ",";
   j += "\"daily_pnl_usd\":"     + DoubleToString(0.0, 2) + ",";  // 0 until HistoryDeals tracked
   j += "\"top_ledger\":[]";
   j += "}";

   string url = frontend_url + "/api/ea/live-state";
   string resp = "";
   RC_ControlPlanePost(url, j, resp, 5000);
}

//==========================================================================
// ZONE CALCULATION
// Zone is centred on pivot, thickness = ATR(D1,14) × atr_zone_pct / 100
// Invalidation is taken from boss-TF PL (Long) or PH (Short)
//==========================================================================
void RecalcZone()
{
   if(g_cfg.pivot <= 0.0) { s_zone_valid = false; return; }

   double atr_val = 0.0;
   if(s_atr_handle != INVALID_HANDLE)
   {
      double buf[];
      ArraySetAsSeries(buf, true);
      if(CopyBuffer(s_atr_handle, 0, 1, 1, buf) == 1)
         atr_val = buf[0];
   }
   if(atr_val <= 0.0) atr_val = g_cfg.pivot * 0.005;  // fallback 0.5% of price

   double zone_thick = atr_val * (g_cfg.atr_zone_pct / 100.0);
   s_zone_high = NormalizeDouble(g_cfg.pivot + zone_thick * 0.5, _Digits);
   s_zone_low  = NormalizeDouble(g_cfg.pivot - zone_thick * 0.5, _Digits);

   // Boss-TF invalidation level
   double ph, pl;
   datetime tph, tpl;
   SE_GetActiveStructure(g_cfg.tf_boss, g_cfg.pivot_len, g_cfg.smc_lookback, ph, pl, tph, tpl);

   if(g_cfg.bias == "Long")
      s_calc_inval = (pl != EMPTY_VALUE) ? NormalizeDouble(pl, _Digits)
                                         : NormalizeDouble(g_cfg.pivot * 0.995, _Digits);
   else if(g_cfg.bias == "Short")
      s_calc_inval = (ph != EMPTY_VALUE) ? NormalizeDouble(ph, _Digits)
                                         : NormalizeDouble(g_cfg.pivot * 1.005, _Digits);
   else
      s_calc_inval = (pl != EMPTY_VALUE) ? NormalizeDouble(pl, _Digits)
                                         : NormalizeDouble(g_cfg.pivot * 0.995, _Digits);

   s_zone_valid = true;
}

//==========================================================================
// HUD STATUS — maps booleans to ASLEEP/STALKING/etc.
// Caller must check g_ea_state FIRST and short-circuit for
// UNPAIRED / CONFIG_LOADING / ERROR before calling this.
//==========================================================================
string GetHudStatus(bool in_session, bool in_zone, bool has_pos,
                    bool sl_cooling, bool max_reached, bool is_eod)
{
   if(is_eod)       return "DEAD";
   if(max_reached)  return "MAX_TRADES";
   if(sl_cooling)   return "PURGATORY";
   if(has_pos)
   {
      double pnl = 0.0;
      for(int i = PositionsTotal() - 1; i >= 0; i--)
      {
         ulong t  = PositionGetTicket(i);
         if(PositionGetString(t, POSITION_SYMBOL) != _Symbol) continue;
         long mg  = PositionGetInteger(t, POSITION_MAGIC);
         if(mg < g_cfg.base_magic || mg > g_cfg.base_magic + 50) continue;
         pnl += PositionGetDouble(t, POSITION_PROFIT);
      }
      return (pnl < 0.0) ? "BLEEDING" : "IN_TRADE";
   }
   if(!in_session)  return "ASLEEP";
   if(in_zone)      return "STALKING";
   return "ASLEEP";
}

color GetStatusColor(const string status)
{
   if(status == "IN_TRADE")      return C'30,100,220';
   if(status == "BLEEDING")      return C'180,0,30';
   if(status == "STALKING")      return C'30,140,60';
   if(status == "PURGATORY")     return C'200,100,0';
   if(status == "DEAD")          return C'60,60,60';
   if(status == "MAX_TRADES")    return C'60,60,60';
   if(status == "UNPAIRED")      return C'120,80,160';
   if(status == "LOADING")       return C'100,130,160';
   if(status == "CONFIG_ERROR")  return C'180,50,50';
   return C'60,60,60';   // ASLEEP
}

//==========================================================================
// ZONE ENTRY CHECK
//==========================================================================
bool IsInsideZone()
{
   if(!s_zone_valid) return false;
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   if(g_cfg.bias == "Long")  return (ask >= s_zone_low && ask <= s_zone_high);
   if(g_cfg.bias == "Short") return (bid >= s_zone_low && bid <= s_zone_high);
   return false;
}

//==========================================================================
// OnInit
//==========================================================================
int OnInit()
{
   // ── 1. Build config from EA inputs ────────────────────────────────────
   // Use input connection_id as initial value; relay bootstrap may override below
   CFG_ParseFromInputs(
      g_cfg,
      (StringLen(i_connectionId) > 0) ? i_connectionId : "pending",  s_ea_version,
      i_ai_text,       i_bias,
      i_pivot,         i_tp1,        i_tp2,
      i_atrPct,        i_slPadMult,
      i_useAsia,       i_asiaStart,  i_asiaEnd,
      i_useLon,        i_lonStart,   i_lonEnd,
      i_useNY,         i_nyStart,    i_nyEnd,
      i_tfEngine,      i_tfBoss,
      i_useMtfSL,      i_tfSL,       i_tfBE,
      i_riskPct,       i_strictRisk, i_minRR,      i_maxTrades,
      i_useDeadSL,     i_slCooldown,
      i_useAutoRR,     i_autoRR1,    i_autoRR2,
      i_baseMagic,     i_pivotLen,
      i_usePartial,    i_tp1Pct,
      i_useBE,         i_beAfterTP1,
      i_useEOD,        i_eodTime,
      i_showStruct,    i_smcLookback,
      i_discordUrl,    i_reportHour, i_reportMin
   );

   // ── 2. Relay init — reads bootstrap manifest, resolves connection_id ───
   // The bootstrap manifest (MQL5/Files/ifx/bootstrap.json) is written by the
   // relay manager when the account is provisioned. No manual pasting needed.
   string sym_csv = (StringLen(g_cfg.symbols_csv) > 0) ? g_cfg.symbols_csv : _Symbol;
   RelayClient_Init(s_ea_version, sym_csv);

   // ── 3. Auto-resolve connection_id from bootstrap manifest ─────────────
   // Priority: manifest > EA input override
   string resolved_conn = RelayClient_GetConnectionId();
   if(StringLen(resolved_conn) > 0 && resolved_conn != "pending")
      g_cfg.connection_id = resolved_conn;
   else if(StringLen(i_connectionId) > 0)
      g_cfg.connection_id = i_connectionId;

   // ── UNPAIRED STATE — no connection_id available yet ───────────────────
   // Stay alive on chart so the relay can write bootstrap.json later.
   // OnTimer will detect a newly written manifest (via RelayClient_Timer)
   // and transition to STATE_CONFIG_LOADING automatically.
   if(StringLen(g_cfg.connection_id) == 0 || g_cfg.connection_id == "pending")
   {
      g_ea_state = STATE_UNPAIRED;
      Print("⚠️ [INIT] UNPAIRED — waiting for bootstrap.json provisioning");

      // ATR handle still useful for zone calculation once we get a config
      s_atr_handle = iATR(_Symbol, PERIOD_D1, 14);
      EventSetTimer(1);

      SE_DrawMatrixHUD(g_cfg, "UNPAIRED", C'120,80,160',
                       0.0, 0.0, 0.0, false, false, 0, false);
      ChartRedraw(0);
      return INIT_SUCCEEDED;  // NOT INIT_FAILED — stay on chart
   }

   // ── 4. Cloud config overlay via Next.js dashboard ────────────────────
   // Uses install_token from bootstrap manifest as Bearer auth — no secrets in inputs
   g_ea_state = STATE_CONFIG_LOADING;
   if(StringLen(i_frontendUrl) > 0)
   {
      bool fetched = CFG_FetchAndApplyCloudConfig(g_cfg, i_frontendUrl, g_cfg.connection_id,
                                                   RelayClient_GetInstallToken());
      if(fetched)
      {
         string val_err = "";
         if(CFG_ValidateConfig(g_cfg, val_err))
         {
            g_cfg_loaded          = true;
            g_ea_state            = STATE_READY;
            s_cfg_retry_count     = 0;
            s_locked_conn_id      = g_cfg.connection_id;
            s_last_valid_cfg_time = TimeCurrent();
            if(StringLen(i_frontendUrl) > 0)
               TE_InitAuditContext(i_frontendUrl, g_cfg.connection_id, RelayClient_GetInstallToken());
         }
         else
         {
            Print("⛔ [INIT] Config validation failed: ", val_err, " — retrying in OnTimer");
            // Stay in STATE_CONFIG_LOADING — OnTimer will retry
         }
      }
      // else: fetch failed — stay in STATE_CONFIG_LOADING, OnTimer will retry
   }
   else
   {
      // No frontend URL — use inputs only. Still validate to protect real money.
      string val_err = "";
      if(CFG_ValidateConfig(g_cfg, val_err))
      {
         g_cfg_loaded          = true;
         g_ea_state            = STATE_READY;
         s_locked_conn_id      = g_cfg.connection_id;
         s_last_valid_cfg_time = TimeCurrent();
         // no audit context when running without cloud URL
      }
      else
      {
         Print("⛔ [INIT] Input config invalid: ", val_err, " — will not trade");
         g_ea_state = STATE_CONFIG_LOADING;  // wait for user to fix inputs (via cloud)
      }
   }

   // ── 5. ATR indicator handle (reused every timer tick) ─────────────────
   s_atr_handle = iATR(_Symbol, PERIOD_D1, 14);
   if(s_atr_handle == INVALID_HANDLE)
      Print("⚠️ [INIT] ATR handle failed — using price-based fallback");

   // ── 6. Initial zone and invalidation calculation ───────────────────────
   RecalcZone();

   // ── 7. One-second timer (HUD + relay heartbeat) ───────────────────────
   EventSetTimer(1);

   // ── 8. Initial chart draw ─────────────────────────────────────────────
   string init_status = (g_ea_state == STATE_READY) ? "ASLEEP" : "LOADING";
   color  init_col    = GetStatusColor(init_status);

   if(g_cfg.show_struct)
   {
      if(s_zone_valid)
         SE_DrawBattlefieldZones(g_cfg, s_zone_high, s_zone_low, s_calc_inval);
      SE_DrawSMCStructure(g_cfg);
   }
   SE_DrawMatrixHUD(g_cfg, init_status, init_col,
                    s_calc_inval, 0.0, 0.0, false, false, 0, false);
   SE_DrawTopLedger(g_cfg);
   ChartRedraw(0);

   CFG_Print(g_cfg);
   Print("✅ [INIT] ", s_ea_version, " | ", _Symbol,
         " | state=", EnumToString(g_ea_state),
         " | bias=",  g_cfg.bias,
         " | pivot=", DoubleToString(g_cfg.pivot, _Digits));

   return INIT_SUCCEEDED;
}

//==========================================================================
// OnDeinit
//==========================================================================
void OnDeinit(const int reason)
{
   RelayClient_Deinit();
   SE_CleanupObjects();
   EventKillTimer();
   if(s_atr_handle != INVALID_HANDLE)
   {
      IndicatorRelease(s_atr_handle);
      s_atr_handle = INVALID_HANDLE;
   }
}

//==========================================================================
// OnTick
//==========================================================================
void OnTick()
{
   // ── Relay: push tick + flush queue (always) ───────────────────────────
   RelayClient_Tick(s_ea_version);

   // ── Button flags (always) ─────────────────────────────────────────────
   TE_PollButtonFlags(g_cfg);

   // ── ALWAYS: manage / EOD close regardless of EA state ────────────────
   // We NEVER abandon a live trade, even if config becomes invalid mid-session.
   bool has_pos = (RE_CountOpenPositions(g_cfg) > 0);
   bool is_eod  = RE_IsEodReached(g_cfg);

   if(is_eod && has_pos)
   {
      Print("🕰️ [EOD] Closing all at ", TimeToString(TimeCurrent()));
      TE_CloseAllPositions(g_cfg);
      return;
   }

   if(has_pos)
   {
      TE_ManageOpenPositions(g_cfg);
      return;   // no new entries while in trade
   }

   // ── NEW ENTRY GATE 1: state machine ───────────────────────────────────
   if(g_ea_state != STATE_READY) return;

   // ── NEW ENTRY GATE 2: secondary validation (defence-in-depth) ────────
   // Never rely on a single validation point for real-money decisions.
   string _v = "";
   if(!CFG_ValidateConfig(g_cfg, _v) || g_cfg.pivot <= 0.0) return;

   // ── Evaluate entry conditions ─────────────────────────────────────────
   bool sl_cooling = RE_CheckHistoricalStopLoss(g_cfg);
   bool max_hit    = (RE_CountTodayTrades(g_cfg) >= g_cfg.max_trades);
   bool in_session = RE_CheckTradingSessions(g_cfg);
   bool in_zone    = IsInsideZone();

   // ── Entry gates ───────────────────────────────────────────────────────
   if(!in_session)      return;   // outside all sessions
   if(sl_cooling)       return;   // cooling down after SL
   if(max_hit)          return;   // daily limit reached
   if(is_eod)           return;   // past EOD cutoff
   if(!s_zone_valid)    return;   // no valid zone yet
   if(!in_zone)         return;   // price not inside entry zone
   if(g_cfg.bias == "Neutral") return;   // no directional bias
   if(g_cfg.pivot == te_last_traded_pivot) return;  // already traded this level

   // ── Fire entry ───────────────────────────────────────────────────────
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);

   if(g_cfg.bias == "Long")
      TE_TryEntryLong(g_cfg, ask, s_zone_low,  s_calc_inval);
   else if(g_cfg.bias == "Short")
      TE_TryEntryShort(g_cfg, bid, s_zone_high, s_calc_inval);
}

//==========================================================================
// OnTimer  (fires every 1 second)
//==========================================================================
void OnTimer()
{
   // ── Relay heartbeat (flushes queues + retries bootstrap if UNPAIRED) ─
   // RC_MaybeSyncControlPlane inside RelayClient_Timer retries bootstrap
   // every 10 s automatically when rc_control_plane_ready == false.
   RelayClient_Timer(s_ea_version);

   // ── UNPAIRED: check if relay has now resolved a connection_id ─────────
   if(g_ea_state == STATE_UNPAIRED)
   {
      string new_conn = RelayClient_GetConnectionId();
      bool resolved = (StringLen(new_conn) > 0 && new_conn != "pending" &&
                       new_conn != g_cfg.connection_id);
      if(!resolved && StringLen(i_connectionId) > 0 && i_connectionId != "pending")
      {
         new_conn = i_connectionId;
         resolved = true;
      }
      if(resolved)
      {
         g_cfg.connection_id = new_conn;
         g_ea_state = STATE_CONFIG_LOADING;
         s_last_cfg_poll    = 0;   // force immediate fetch on next pass
         s_cfg_retry_count  = 0;
         Print("✅ [TIMER] UNPAIRED → CONFIG_LOADING.  conn=", new_conn);
      }
      // Still UNPAIRED — show message, skip everything  else
      SE_BeginFrame();
      SE_DrawMatrixHUD(g_cfg, "UNPAIRED", C'120,80,160',
                       0.0, 0.0, 0.0, false, false, 0, false);
      if(SE_NeedsRedraw()) ChartRedraw(0);
      return;
   }

   // ── CONFIG_LOADING / ERROR: retry fetching + validating config ────────
   // Retry interval: 10 s for first 5 attempts, then 60 s.
   // After 10 consecutive failures → STATE_ERROR (no trading, alert on HUD)
   if(g_ea_state == STATE_CONFIG_LOADING || g_ea_state == STATE_ERROR)
   {
      int retry_interval = (s_cfg_retry_count < 5) ? 10 : 60;
      if(TimeCurrent() - s_last_cfg_poll >= retry_interval)
      {
         s_last_cfg_poll = TimeCurrent();

         bool fetched = false;
         IFX_EaConfig tmp_cfg = g_cfg;   // work on a copy — never apply invalid data to g_cfg
         if(StringLen(i_frontendUrl) > 0 && StringLen(g_cfg.connection_id) > 0)
            fetched = CFG_FetchAndApplyCloudConfig(tmp_cfg, i_frontendUrl, g_cfg.connection_id,
                                                    RelayClient_GetInstallToken());

         if(fetched)
         {
            string val_err = "";
            if(CFG_ValidateConfig(tmp_cfg, val_err))
            {
               g_cfg                   = tmp_cfg;  // apply only after validation passes
               g_cfg_loaded            = true;
               g_ea_state              = STATE_READY;
               s_cfg_retry_count       = 0;
               s_last_cfg_poll         = TimeCurrent();
               s_locked_conn_id        = g_cfg.connection_id;
               s_last_valid_cfg_time   = TimeCurrent();
               s_hot_reload_fail_count = 0;
               RecalcZone();
               if(StringLen(i_frontendUrl) > 0)
                  TE_InitAuditContext(i_frontendUrl, g_cfg.connection_id, RelayClient_GetInstallToken());
               Print("✅ [TIMER] Config loaded and validated — STATE_READY");
            }
            else
            {
               s_cfg_retry_count++;
               Print("⛔ [TIMER] Config validation failed (attempt ", s_cfg_retry_count, "): ", val_err);
               if(s_cfg_retry_count >= 10) g_ea_state = STATE_ERROR;
            }
         }
         else
         {
            s_cfg_retry_count++;
            if(s_cfg_retry_count >= 10) g_ea_state = STATE_ERROR;
         }
      }

      // HUD while waiting
      string wait_status = (g_ea_state == STATE_ERROR) ? "CONFIG_ERROR" : "LOADING";
      SE_BeginFrame();
      SE_DrawMatrixHUD(g_cfg, wait_status, GetStatusColor(wait_status),
                       0.0, 0.0, 0.0, false, false, 0, false);
      if(SE_NeedsRedraw()) ChartRedraw(0);
      return;
   }

   // ── STATE_DEAD: fatal stop — HUD shows DEAD, no trading ──────────────
   if(g_ea_state == STATE_DEAD)
   {
      SE_BeginFrame();
      SE_DrawMatrixHUD(g_cfg, "DEAD", C'60,60,60',
                       0.0, 0.0, 0.0, false, false, 0, false);
      if(SE_NeedsRedraw()) ChartRedraw(0);
      return;
   }

   // ── STATE_READY: normal operation ────────────────────────────────────

   // ── Scheduled Discord daily report ───────────────────────────────────
   TE_CheckScheduledReport(g_cfg);

   // ── Recalculate zone (cheap — no tick copy, just uses stored ATR) ────
   RecalcZone();

   // ── Apply deferred config (queued while trade was active) ────────────
   if(g_has_pending_cfg && RE_CountOpenPositions(g_cfg) == 0)
   {
      g_cfg                   = g_pending_cfg;
      g_has_pending_cfg       = false;
      s_last_valid_cfg_time   = TimeCurrent();
      s_hot_reload_fail_count = 0;
      RecalcZone();
      Print("✅ [TIMER] Deferred config applied after trade closed");
   }

   // ── Bootstrap lock: detect re-provisioning to a different account ─────
   // If the relay manager re-writes bootstrap.json for a different connection,
   // we must re-fetch config immediately rather than trading on stale identity.
   string live_conn = RelayClient_GetConnectionId();
   if(StringLen(live_conn) > 0 && live_conn != "pending" &&
      StringLen(s_locked_conn_id) > 0 && live_conn != s_locked_conn_id)
   {
      Print("⚠️ [TIMER] Bootstrap connection_id changed: ", s_locked_conn_id,
            " → ", live_conn, " — forcing config re-fetch");
      g_cfg.connection_id     = live_conn;
      s_locked_conn_id        = live_conn;
      s_last_cfg_poll         = 0;     // force immediate re-fetch
      s_hot_reload_fail_count = 0;
      g_has_pending_cfg       = false;
   }

   // ── Config stale timeout (only when cloud sync is enabled) ───────────
   // If no successful config validation in >5 min → stop trading.
   // This catches prolonged backend outages silently burning through retries.
   if(s_last_valid_cfg_time > 0 && StringLen(i_frontendUrl) > 0 &&
      TimeCurrent() - s_last_valid_cfg_time > 300)
   {
      Print("⛔ [TIMER] Config stale >5min without valid refresh — STATE_DEAD");
      g_ea_state = STATE_DEAD;
      SE_BeginFrame();
      SE_DrawMatrixHUD(g_cfg, "DEAD", C'60,60,60',
                       0.0, 0.0, 0.0, false, false, 0, false);
      if(SE_NeedsRedraw()) ChartRedraw(0);
      return;
   }

   // ── Hot-reload cloud config every 60 s ───────────────────────────────
   // Uses a TEMP COPY — g_cfg is never written with unvalidated data.
   // Config is deferred (queued) while a trade is active (version lock).
   // Tiered failure: 3 = warning, 5 = STATE_DEAD.
   if(StringLen(i_frontendUrl) > 0 && TimeCurrent() - s_last_cfg_poll >= 60)
   {
      s_last_cfg_poll = TimeCurrent();
      IFX_EaConfig tmp_cfg = g_cfg;   // defensive copy
      bool fetched = CFG_FetchAndApplyCloudConfig(tmp_cfg, i_frontendUrl, g_cfg.connection_id,
                                                   RelayClient_GetInstallToken());
      if(fetched)
      {
         string val_err = "";
         if(CFG_ValidateConfig(tmp_cfg, val_err))
         {
            s_hot_reload_fail_count = 0;
            s_last_valid_cfg_time   = TimeCurrent();
            bool in_trade = (RE_CountOpenPositions(g_cfg) > 0);
            if(in_trade)
            {
               g_pending_cfg    = tmp_cfg;   // defer — apply after trade closes
               g_has_pending_cfg = true;
               Print("ℹ️ [TIMER] Config updated — deferred (trade active)");
            }
            else
            {
               g_cfg            = tmp_cfg;   // safe to apply now
               g_has_pending_cfg = false;
               RecalcZone();
            }
         }
         else
         {
            // Server sent data that fails validation — keep current safe config
            s_hot_reload_fail_count++;
            Print("⚠️ [TIMER] Hot-reload invalid (", s_hot_reload_fail_count, "/5): ", val_err);
            if(s_hot_reload_fail_count >= 5)
            {
               Print("⛔ [TIMER] 5 consecutive invalid server configs — STATE_DEAD");
               g_ea_state = STATE_DEAD;
               return;
            }
         }
      }
      else
      {
         s_hot_reload_fail_count++;
         if(s_hot_reload_fail_count == 3)
            Print("⚠️ [TIMER] Hot-reload failing (3 consecutive) — check backend connectivity");
         if(s_hot_reload_fail_count >= 5)
         {
            Print("⛔ [TIMER] 5 consecutive fetch failures — STATE_DEAD");
            g_ea_state = STATE_DEAD;
            return;
         }
         // else: silent retry — keep trading on last valid config
      }
   }

   // ── Gather live state for HUD ─────────────────────────────────────────
   bool has_pos    = (PositionsTotal() > 0);
   bool sl_cooling = RE_CheckHistoricalStopLoss(g_cfg);
   bool max_hit    = (RE_CountTodayTrades(g_cfg) >= g_cfg.max_trades);
   bool in_session = RE_CheckTradingSessions(g_cfg);
   bool is_eod     = RE_IsEodReached(g_cfg);
   bool in_zone    = IsInsideZone();
   int  daily_cnt  = RE_CountTodayTrades(g_cfg);

   string hud_status = GetHudStatus(in_session, in_zone, has_pos, sl_cooling, max_hit, is_eod);
   color  hud_col    = GetStatusColor(hud_status);

   // ── Redraw HUD (dirty-flag prevents unnecessary ChartRedraw calls) ───
   SE_BeginFrame();

   SE_DrawMatrixHUD(
      g_cfg,
      hud_status,      hud_col,
      s_calc_inval,
      TE_GetLiveSL(g_cfg),
      TE_GetLiveLots(g_cfg),
      in_zone,
      te_be_secured,
      daily_cnt,
      te_report_sent_today
   );

   SE_DrawTopLedger(g_cfg);

   if(g_cfg.show_struct)
   {
      if(s_zone_valid)
         SE_DrawBattlefieldZones(g_cfg, s_zone_high, s_zone_low, s_calc_inval);
      SE_DrawSMCStructure(g_cfg);
   }

   if(SE_NeedsRedraw()) ChartRedraw(0);

   // ── Phase 4: command polling (every 5 s) ──────────────────────────────
   if(StringLen(i_frontendUrl) > 0 && TimeCurrent() - s_last_cmd_poll >= 5)
   {
      s_last_cmd_poll = TimeCurrent();
      CMD_PollAndExecute(i_frontendUrl, g_cfg.connection_id, RelayClient_GetInstallToken());
   }

   // ── Phase 4: live-state push (every 15 s) ─────────────────────────────
   if(StringLen(i_frontendUrl) > 0 && TimeCurrent() - s_last_hud_push >= 15)
   {
      s_last_hud_push = TimeCurrent();
      HUD_PushLiveState(i_frontendUrl, g_cfg.connection_id, RelayClient_GetInstallToken(),
                        hud_status, in_zone, te_be_secured, daily_cnt);
   }
   // ── Phase 5: closed-trade audit scan (every 60 s) ──────────────────────
   if(StringLen(i_frontendUrl) > 0 && TimeCurrent() - s_last_audit_check >= 60)
   {
      s_last_audit_check = TimeCurrent();
      TE_AuditScanClosedTrades(g_cfg);
   }}

//==========================================================================
// OnChartEvent — button clicks handled by TradeExecutor flags
//==========================================================================
void OnChartEvent(const int id, const long &lparam, const double &dparam, const string &sparam)
{
   TE_HandleChartEvent(id, lparam, dparam, sparam);
}
//+------------------------------------------------------------------+
