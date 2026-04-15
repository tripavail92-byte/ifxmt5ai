//+------------------------------------------------------------------+
//|  IFX_TradeExecutor.mqh                                           |
//|  Phase 2B — Entry execution, position management, Discord        |
//|                                                                  |
//|  Provides:                                                        |
//|    TE_TryEntryLong()           — Buy order with partial split    |
//|    TE_TryEntryShort()          — Sell order with partial split   |
//|    TE_ManageOpenPositions()    — TP1 detection, BE, auto-RR fill |
//|    TE_SendDiscordAlert()       — POST to Discord webhook         |
//|    TE_SendDailyReport()        — Win/loss summary to Discord     |
//|    TE_HandleChartEvent()       — Button handler (flags)          |
//|    TE_CloseAllPositions()      — EOD / emergency close           |
//|                                                                  |
//|  Depends on: IFX_Config.mqh, IFX_RiskEngine.mqh                 |
//+------------------------------------------------------------------+
#ifndef IFX_TRADE_EXECUTOR_MQH
#define IFX_TRADE_EXECUTOR_MQH

#property strict
#include "IFX_Config.mqh"
#include "IFX_StructureEngine.mqh"
#include "IFX_RiskEngine.mqh"
#include <Trade\Trade.mqh>

//==========================================================================
// GLOBALS & FLAGS
//==========================================================================

CTrade te_trade;

bool te_tp1_hit                = false;     // TP1 partially taken
bool te_be_secured             = false;     // BE has been moved
double te_last_traded_pivot    = 0.0;       // used to prevent re-entry at same level
bool te_req_discord_long       = false;     // chart button flags
bool te_req_discord_short      = false;
bool te_req_discord_report     = false;
bool te_report_sent_today      = false;
datetime te_last_report_day    = 0;

// ── Phase 5: cloud audit context ──────────────────────────────────────────
string   te_audit_url         = "";         // frontend_url + /api/ea/trade-audit
string   te_audit_conn_id     = "";         // connection_id for this EA instance
string   te_audit_token       = "";         // install token for X-IFX-INSTALL-TOKEN header
datetime te_last_audit_scan   = 0;          // last time we scanned history for closed deals

//──────────────────────────────────────────────────────────────────────────
// TE_InitAuditContext — call once after config is loaded (STATE_READY).
// Stores the cloud endpoint and auth token so audit helpers can use them.
//──────────────────────────────────────────────────────────────────────────
void TE_InitAuditContext(const string frontend_url, const string conn_id, const string install_token)
{
   te_audit_url     = frontend_url + "/api/ea/trade-audit";
   te_audit_conn_id = conn_id;
   te_audit_token   = install_token;
   te_last_audit_scan = TimeCurrent();
   Print("✅ [AUDIT] Context initialised — endpoint=", te_audit_url);
}

//──────────────────────────────────────────────────────────────────────────
// TE_AuditPushOpen — POST a trade-open event to cloud immediately after fill.
// broker_ticket from te_trade.ResultDeal() — call right after TE_SendOrder().
//──────────────────────────────────────────────────────────────────────────
void TE_AuditPushOpen(const string side,   double entry_price, double sl,
                      double tp,           double volume,       const string reason)
{
   if(StringLen(te_audit_url) == 0 || StringLen(te_audit_conn_id) == 0) return;

   ulong broker_ticket = te_trade.ResultDeal();

   string j = "{";
   j += "\"connection_id\":\"" + te_audit_conn_id + "\",";
   j += "\"symbol\":\""        + _Symbol          + "\",";
   j += "\"side\":\""          + side             + "\",";
   j += "\"entry\":"           + DoubleToString(entry_price, _Digits) + ",";
   j += "\"sl\":"              + DoubleToString(sl,          _Digits) + ",";
   j += "\"tp\":"              + DoubleToString(tp,          _Digits) + ",";
   j += "\"volume\":"          + DoubleToString(volume, 2)            + ",";
   j += "\"broker_ticket\":\"" + IntegerToString((long)broker_ticket) + "\",";
   j += "\"status\":\"open\",";
   j += "\"decision_reason\":\"" + reason + "\"";
   j += "}";

   uchar post_data[], result[];
   string resp_headers;
   StringToCharArray(j, post_data, 0, StringLen(j), CP_UTF8);
   string headers = "Content-Type: application/json\r\nX-IFX-INSTALL-TOKEN: " + te_audit_token + "\r\n";
   int code = WebRequest("POST", te_audit_url, headers, 5000, post_data, result, resp_headers);
   if(code < 200 || code >= 300)
      Print("⚠️ [AUDIT] trade-open push failed code=", code, " ticket=", broker_ticket);
   else
      Print("📋 [AUDIT] trade-open pushed ticket=", broker_ticket, " side=", side);
}

//──────────────────────────────────────────────────────────────────────────
// TE_AuditScanClosedTrades — scans deal history since last call.
// Call from OnTimer every 60 s in STATE_READY.
// Detects any DEAL_ENTRY_OUT (TP/SL/manual close) and posts to cloud.
//──────────────────────────────────────────────────────────────────────────
void TE_AuditScanClosedTrades(const IFX_EaConfig &cfg)
{
   if(StringLen(te_audit_url) == 0 || StringLen(te_audit_conn_id) == 0) return;

   datetime scan_from     = te_last_audit_scan;
   datetime scan_to       = TimeCurrent();
   te_last_audit_scan     = scan_to;

   if(!HistorySelect(scan_from, scan_to)) return;

   int total = HistoryDealsTotal();
   for(int i = 0; i < total; i++)
   {
      ulong deal = HistoryDealGetTicket(i);
      if(HistoryDealGetString(deal,  DEAL_SYMBOL) != _Symbol)         continue;
      if(HistoryDealGetInteger(deal, DEAL_ENTRY)  != DEAL_ENTRY_OUT)  continue;
      long magic = HistoryDealGetInteger(deal, DEAL_MAGIC);
      if(magic < cfg.base_magic || magic > cfg.base_magic + 50)       continue;

      double pnl     = HistoryDealGetDouble(deal,  DEAL_PROFIT);
      double price   = HistoryDealGetDouble(deal,  DEAL_PRICE);
      double volume  = HistoryDealGetDouble(deal,  DEAL_VOLUME);
      long   dtype   = HistoryDealGetInteger(deal, DEAL_TYPE);
      string comment = HistoryDealGetString(deal,  DEAL_COMMENT);

      // side: the deal type on close is opposite to position type
      string side = (dtype == DEAL_TYPE_SELL) ? "buy_close" : "sell_close";

      // Determine close reason from deal comment
      string reason = "closed";
      string cmtLow = comment;
      StringToLower(cmtLow);
      if(StringFind(cmtLow, "sl")  >= 0) reason = "stop_loss";
      else if(StringFind(cmtLow, "tp")  >= 0) reason = "take_profit";
      else if(StringFind(cmtLow, "eod") >= 0) reason = "eod_close";

      string j = "{";
      j += "\"connection_id\":\"" + te_audit_conn_id                 + "\",";
      j += "\"symbol\":\""        + _Symbol                          + "\",";
      j += "\"side\":\""          + side                             + "\",";
      j += "\"entry\":"           + DoubleToString(price, _Digits)   + ",";
      j += "\"volume\":"          + DoubleToString(volume, 2)        + ",";
      j += "\"broker_ticket\":\"" + IntegerToString((long)deal)      + "\",";
      j += "\"status\":\"closed\",";
      j += "\"decision_reason\":\"" + reason + "\",";
      j += "\"payload\":{\"pnl\":" + DoubleToString(pnl, 2) + "}";
      j += "}";

      uchar post_data[], result[];
      string resp_headers;
      StringToCharArray(j, post_data, 0, StringLen(j), CP_UTF8);
      string headers = "Content-Type: application/json\r\nX-IFX-INSTALL-TOKEN: " + te_audit_token + "\r\n";
      int code = WebRequest("POST", te_audit_url, headers, 5000, post_data, result, resp_headers);
      if(code >= 200 && code < 300)
         Print("📋 [AUDIT] trade-close pushed deal=", deal, " reason=", reason, " pnl=", DoubleToString(pnl, 2));
      else
         Print("⚠️ [AUDIT] trade-close push failed code=", code, " deal=", deal);
   }
}

//==========================================================================
// SECTION A — DISCORD HELPERS
//==========================================================================

void TE_SendDiscordAlert(const IFX_EaConfig &cfg, const string msg)
{
   if(StringLen(cfg.discord_url) == 0) return;

   uchar post_data[];
   string payload = "{\"content\": \"" + msg + "\"}";
   StringToCharArray(payload, post_data, 0, StringLen(payload), CP_UTF8);

   uchar result[];
   string resp_headers = "";
   int status = WebRequest("POST", cfg.discord_url, "Content-Type: application/json\r\n", 5000, post_data, result, resp_headers);

   if(status < 0)
      Print("⚠️ [DISCORD] WebRequest error: ", GetLastError(), " | URL len=", StringLen(cfg.discord_url));
}

void TE_SendDailyReport(const IFX_EaConfig &cfg)
{
   if(!HistorySelect(StringToTime(TimeToString(TimeCurrent(), TIME_DATE) + " 00:00"), TimeCurrent())) return;

   int wins = 0, losses = 0;
   double gross_profit = 0.0, gross_loss = 0.0;

   int total = HistoryDealsTotal();
   for(int i = 0; i < total; i++)
   {
      ulong ticket = HistoryDealGetTicket(i);
      if(HistoryDealGetString(ticket, DEAL_SYMBOL) != _Symbol) continue;
      if(HistoryDealGetInteger(ticket, DEAL_ENTRY) != DEAL_ENTRY_OUT) continue;
      long magic = HistoryDealGetInteger(ticket, DEAL_MAGIC);
      if(magic < cfg.base_magic || magic > cfg.base_magic + 50) continue;

      double pnl = HistoryDealGetDouble(ticket, DEAL_PROFIT);
      if(pnl > 0) { wins++;   gross_profit += pnl; }
      else        { losses++; gross_loss   += pnl; }
   }

   double net = gross_profit + gross_loss;
   string msg = "📊 **IFX Daily Report** | " + _Symbol + "\\n";
   msg += "Trades: " + IntegerToString(wins + losses) + " | W: " + IntegerToString(wins) + " L: " + IntegerToString(losses) + "\\n";
   msg += "Net P&L: " + (net >= 0 ? "+$" : "-$") + DoubleToString(MathAbs(net), 2) + "\\n";
   msg += "Gross Profit: $" + DoubleToString(gross_profit, 2) + " | Gross Loss: -$" + DoubleToString(MathAbs(gross_loss), 2);

   TE_SendDiscordAlert(cfg, msg);
   te_report_sent_today = true;
   te_last_report_day   = StringToTime(TimeToString(TimeCurrent(), TIME_DATE) + " 00:00");
   Print("✅ [DISCORD] Daily report sent");
}

// Reset report flag at start of each new day
void TE_ResetDailyFlags()
{
   datetime today_midnight = StringToTime(TimeToString(TimeCurrent(), TIME_DATE) + " 00:00");
   if(te_last_report_day != today_midnight)
   {
      te_report_sent_today = false;
   }
}

// Check if scheduled report should fire now
void TE_CheckScheduledReport(const IFX_EaConfig &cfg)
{
   TE_ResetDailyFlags();
   if(te_report_sent_today) return;

   MqlDateTime mdt;
   TimeToStruct(TimeCurrent(), mdt);
   if(mdt.hour == cfg.report_hour && mdt.min == cfg.report_min)
      TE_SendDailyReport(cfg);
}

//==========================================================================
// SECTION B — FILLED ORDER HELPERS
//==========================================================================

bool TE_SendOrder(ENUM_ORDER_TYPE type, double lots, double price, double sl, double tp, int magic, const string comment)
{
   te_trade.SetExpertMagicNumber(magic);
   int live_spread = (int)SymbolInfoInteger(_Symbol, SYMBOL_SPREAD);
   int dyn_dev = (live_spread > 0) ? live_spread * 2 : 50;
   te_trade.SetDeviationInPoints(dyn_dev);

   uint filling = (uint)SymbolInfoInteger(_Symbol, SYMBOL_FILLING_MODE);
   if((filling & SYMBOL_FILLING_FOK) != 0)
      te_trade.SetTypeFilling(ORDER_FILLING_FOK);
   else if((filling & SYMBOL_FILLING_IOC) != 0)
      te_trade.SetTypeFilling(ORDER_FILLING_IOC);
   else
      te_trade.SetTypeFilling(ORDER_FILLING_RETURN);

   bool res;
   if(type == ORDER_TYPE_BUY)
      res = te_trade.Buy(lots, _Symbol, price, sl, tp, comment);
   else
      res = te_trade.Sell(lots, _Symbol, price, sl, tp, comment);

   if(!res)
   {
      // Retry with RETURN filling
      te_trade.SetTypeFilling(ORDER_FILLING_RETURN);
      if(type == ORDER_TYPE_BUY)
         res = te_trade.Buy(lots, _Symbol, price, sl, tp, comment);
      else
         res = te_trade.Sell(lots, _Symbol, price, sl, tp, comment);
   }

   if(!res) Print("❌ [TE] Order failed: ", te_trade.ResultRetcodeDescription(), " type=", EnumToString(type), " lots=", lots);
   return res;
}

//==========================================================================
// SECTION C — ENTRY EXECUTION
//==========================================================================

// Attempt a LONG entry.
// entry_price: ask price
// stop_loss:   exact precomputed stop from the v9.30 dynamic stop engine
// trigger_pivot: structure level used for duplicate-entry lock
// Returns true if at least one fill succeeded.
bool TE_TryEntryLong(
   IFX_EaConfig  &cfg,  // non-const: auto-RR modifies tp1/tp2
   double         entry_price,
   double         stop_loss,
   double         trigger_pivot)
{
   double sl_raw = NormalizeDouble(stop_loss, _Digits);

   double sl_dist = entry_price - sl_raw;
   if(sl_dist <= 0.0)
   {
      Print("⚠️ [TE] Long SL invalid (dist=", sl_dist, ")");
      return false;
   }

   if(cfg.min_rr > 0.0 && cfg.tp2 > 0.0)
   {
      double rr2 = (cfg.tp2 - entry_price) / sl_dist;
      if(rr2 < cfg.min_rr)
      {
         Print("⚠️ [TE] Long RR too low (", DoubleToString(rr2, 2), " < ", cfg.min_rr, ")");
         return false;
      }
   }

   RE_CalculateAutoRR(cfg, entry_price, sl_dist, +1);

   double total_lots  = RE_CalculateLots(cfg, entry_price, sl_raw);
   double lot_step    = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   if(lot_step <= 0.0) lot_step = 0.01;
   double min_lot     = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);

   bool success = false;
   if(cfg.use_partial && total_lots >= min_lot * 2.0)
   {
      // Split: partial exit at TP1, remainder at TP2
      double lot1 = NormalizeDouble(total_lots * (cfg.tp1_pct / 100.0), 2);
      double lot2 = NormalizeDouble(total_lots - lot1, 2);
      lot1 = MathMax(min_lot, MathFloor(lot1 / lot_step) * lot_step);
      lot2 = MathMax(min_lot, MathFloor(lot2 / lot_step) * lot_step);

      bool r1 = TE_SendOrder(ORDER_TYPE_BUY, lot1, entry_price, sl_raw, cfg.tp1, cfg.base_magic,     "IFX-L1");
      bool r2 = TE_SendOrder(ORDER_TYPE_BUY, lot2, entry_price, sl_raw, cfg.tp2, cfg.base_magic + 1, "IFX-L2");
      success = r1 || r2;
   }
   else
   {
      // Single position
      total_lots = MathMax(min_lot, MathFloor(total_lots / lot_step) * lot_step);
      success = TE_SendOrder(ORDER_TYPE_BUY, total_lots, entry_price, sl_raw, cfg.tp2, cfg.base_magic, "IFX-L");
   }

   if(success)
   {
      te_last_traded_pivot = trigger_pivot;
      te_tp1_hit           = false;
      te_be_secured        = false;
      string msg = "🟢 **LONG ENTRY** | " + _Symbol +
                   " | Entry: " + DoubleToString(entry_price, _Digits) +
                   " | SL: "    + DoubleToString(sl_raw, _Digits) +
                   " | TP1: "   + DoubleToString(cfg.tp1, _Digits) +
                   " | TP2: "   + DoubleToString(cfg.tp2, _Digits) +
                   " | Lots: "  + DoubleToString(total_lots, 2);
      TE_SendDiscordAlert(cfg, msg);
      // Phase 5: push open audit to cloud
      TE_AuditPushOpen("buy", entry_price, sl_raw, cfg.tp2, total_lots,
                       "zone_entry_long|pivot=" + DoubleToString(cfg.pivot, _Digits));
   }

   return success;
}

// Attempt a SHORT entry.  Mirror of TryEntryLong.
bool TE_TryEntryShort(
   IFX_EaConfig  &cfg,
   double         entry_price,
   double         stop_loss,
   double         trigger_pivot)
{
   double sl_raw = NormalizeDouble(stop_loss, _Digits);

   double sl_dist = sl_raw - entry_price;
   if(sl_dist <= 0.0)
   {
      Print("⚠️ [TE] Short SL invalid (dist=", sl_dist, ")");
      return false;
   }

   if(cfg.min_rr > 0.0 && cfg.tp2 > 0.0)
   {
      double rr2 = (entry_price - cfg.tp2) / sl_dist;
      if(rr2 < cfg.min_rr)
      {
         Print("⚠️ [TE] Short RR too low (", DoubleToString(rr2, 2), " < ", cfg.min_rr, ")");
         return false;
      }
   }

   RE_CalculateAutoRR(cfg, entry_price, sl_dist, -1);

   double total_lots  = RE_CalculateLots(cfg, entry_price, sl_raw);
   double lot_step    = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   if(lot_step <= 0.0) lot_step = 0.01;
   double min_lot     = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);

   bool success = false;
   if(cfg.use_partial && total_lots >= min_lot * 2.0)
   {
      double lot1 = NormalizeDouble(total_lots * (cfg.tp1_pct / 100.0), 2);
      double lot2 = NormalizeDouble(total_lots - lot1, 2);
      lot1 = MathMax(min_lot, MathFloor(lot1 / lot_step) * lot_step);
      lot2 = MathMax(min_lot, MathFloor(lot2 / lot_step) * lot_step);

      bool r1 = TE_SendOrder(ORDER_TYPE_SELL, lot1, entry_price, sl_raw, cfg.tp1, cfg.base_magic,     "IFX-S1");
      bool r2 = TE_SendOrder(ORDER_TYPE_SELL, lot2, entry_price, sl_raw, cfg.tp2, cfg.base_magic + 1, "IFX-S2");
      success = r1 || r2;
   }
   else
   {
      total_lots = MathMax(min_lot, MathFloor(total_lots / lot_step) * lot_step);
      success = TE_SendOrder(ORDER_TYPE_SELL, total_lots, entry_price, sl_raw, cfg.tp2, cfg.base_magic, "IFX-S");
   }

   if(success)
   {
      te_last_traded_pivot = trigger_pivot;
      te_tp1_hit           = false;
      te_be_secured        = false;
      string msg = "🔴 **SHORT ENTRY** | " + _Symbol +
                   " | Entry: " + DoubleToString(entry_price, _Digits) +
                   " | SL: "    + DoubleToString(sl_raw, _Digits) +
                   " | TP1: "   + DoubleToString(cfg.tp1, _Digits) +
                   " | TP2: "   + DoubleToString(cfg.tp2, _Digits) +
                   " | Lots: "  + DoubleToString(total_lots, 2);
      TE_SendDiscordAlert(cfg, msg);
      // Phase 5: push open audit to cloud
      TE_AuditPushOpen("sell", entry_price, sl_raw, cfg.tp2, total_lots,
                       "zone_entry_short|pivot=" + DoubleToString(cfg.pivot, _Digits));
   }

   return success;
}

//==========================================================================
// SECTION D — POSITION MANAGEMENT
//==========================================================================

// Manages open positions for the current symbol using the original v9.30 flow:
//   1. Detect TP1 completion from surviving TP2-only position set
//   2. Trigger BE after TP1 or after tf_be structure confirmation
//   3. Move SL to exact entry when broker stop/freeze levels allow it
void TE_ManageOpenPositions(const IFX_EaConfig &cfg)
{
   double total_open_lots = 0.0;
   bool tp1_exists = false;
   bool tp2_exists = false;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(PositionGetString(ticket, POSITION_SYMBOL) != _Symbol) continue;
      long magic = PositionGetInteger(ticket, POSITION_MAGIC);
      if(magic < cfg.base_magic || magic > cfg.base_magic + 50) continue;

      double tp = PositionGetDouble(ticket, POSITION_TP);
      if(cfg.tp1 > 0.0 && tp == cfg.tp1)
         tp1_exists = true;
      if(cfg.tp2 > 0.0 && tp == cfg.tp2)
         tp2_exists = true;
      total_open_lots += PositionGetDouble(ticket, POSITION_VOLUME);
   }

   if(cfg.use_partial && cfg.tp1 > 0.0 && tp2_exists && !tp1_exists && !te_tp1_hit)
   {
      te_tp1_hit = true;
      TE_SendDiscordAlert(cfg, "✅ VIP PROFIT SECURED | Broker successfully executed TP1 split-order.");
   }

   bool trigger_be = false;
   if(cfg.be_after_tp1 && te_tp1_hit)
      trigger_be = true;

   if(cfg.use_be && !trigger_be && tp2_exists)
   {
      double ref_entry = 0.0;
      long ref_type = -1;
      datetime ref_time = 0;

      for(int i = PositionsTotal() - 1; i >= 0; i--)
      {
         ulong ticket = PositionGetTicket(i);
         if(PositionGetString(ticket, POSITION_SYMBOL) != _Symbol) continue;
         long magic = PositionGetInteger(ticket, POSITION_MAGIC);
         if(magic < cfg.base_magic || magic > cfg.base_magic + 50) continue;

         ref_entry = PositionGetDouble(ticket, POSITION_PRICE_OPEN);
         ref_type = PositionGetInteger(ticket, POSITION_TYPE);
         ref_time = (datetime)PositionGetInteger(ticket, POSITION_TIME);
         break;
      }

      if(ref_type != -1)
      {
         double be_close[];
         ArraySetAsSeries(be_close, true);

         if(CopyClose(_Symbol, cfg.tf_be, 0, 1, be_close) > 0)
         {
            double be_ph, be_pl;
            datetime t_ph, t_pl;
            SE_GetActiveStructure(cfg.tf_be, cfg.pivot_len, cfg.smc_lookback, be_ph, be_pl, t_ph, t_pl);

            if(ref_type == POSITION_TYPE_BUY && be_ph != EMPTY_VALUE && be_ph > ref_entry && be_close[0] > ref_entry && t_ph > ref_time)
               trigger_be = true;
            if(ref_type == POSITION_TYPE_SELL && be_pl != EMPTY_VALUE && be_pl < ref_entry && be_close[0] < ref_entry && t_pl > ref_time)
               trigger_be = true;
         }
      }
   }

   if(trigger_be)
      te_be_secured = true;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(PositionGetString(ticket, POSITION_SYMBOL) != _Symbol) continue;
      long magic = PositionGetInteger(ticket, POSITION_MAGIC);
      if(magic < cfg.base_magic || magic > cfg.base_magic + 50) continue;

      double entry = PositionGetDouble(ticket, POSITION_PRICE_OPEN);
      long type = PositionGetInteger(ticket, POSITION_TYPE);
      double sl = PositionGetDouble(ticket, POSITION_SL);
      double tp = PositionGetDouble(ticket, POSITION_TP);

      if(cfg.use_auto_rr && (cfg.tp1 == 0.0 || cfg.tp2 == 0.0))
      {
         double risk = MathAbs(entry - sl);
         if(type == POSITION_TYPE_BUY)
         {
            cfg.tp1 = NormalizeDouble(entry + (risk * cfg.auto_rr1), _Digits);
            cfg.tp2 = NormalizeDouble(entry + (risk * cfg.auto_rr2), _Digits);
         }
         else if(type == POSITION_TYPE_SELL)
         {
            cfg.tp1 = NormalizeDouble(entry - (risk * cfg.auto_rr1), _Digits);
            cfg.tp2 = NormalizeDouble(entry - (risk * cfg.auto_rr2), _Digits);
         }
      }

      if(te_be_secured)
      {
         double new_sl = NormalizeDouble(entry, _Digits);
         if(MathAbs(sl - new_sl) > _Point * 2)
         {
            long stop_level_points = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL);
            long freeze_level_points = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_FREEZE_LEVEL);
            double required_buffer = MathMax(stop_level_points, freeze_level_points) * _Point;
            double current_price = (type == POSITION_TYPE_BUY) ? SymbolInfoDouble(_Symbol, SYMBOL_BID) : SymbolInfoDouble(_Symbol, SYMBOL_ASK);

            if(MathAbs(current_price - new_sl) > required_buffer && (tp == 0.0 || MathAbs(current_price - tp) > required_buffer))
            {
               te_trade.SetExpertMagicNumber((int)magic);
               te_trade.PositionModify(ticket, new_sl, tp);
            }
         }
      }
   }

   if(total_open_lots <= 0.0)
   {
      te_be_secured = false;
      te_tp1_hit = false;
   }
}

//==========================================================================
// SECTION E — CLOSE ALL POSITIONS
//==========================================================================

void TE_CloseAllPositions(const IFX_EaConfig &cfg)
{
   te_trade.SetExpertMagicNumber(cfg.base_magic);
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(PositionGetString(ticket, POSITION_SYMBOL) != _Symbol) continue;
      long magic = PositionGetInteger(ticket, POSITION_MAGIC);
      if(magic < cfg.base_magic || magic > cfg.base_magic + 50) continue;

      te_trade.SetExpertMagicNumber(magic);
      if(!te_trade.PositionClose(ticket, 30))
         Print("⚠️ [TE] Close failed: ", te_trade.ResultRetcodeDescription(), " ticket=", ticket);
   }
}

//==========================================================================
// SECTION F — CHART BUTTON EVENT HANDLER
//==========================================================================

// Call from OnChartEvent(). Sets flags consumed on next tick.
void TE_HandleChartEvent(const int id, const long lparam, const double dparam, const string sparam)
{
   if(id != CHARTEVENT_OBJECT_CLICK) return;

   if(sparam == "IFX_BTN_LONG")
   {
      te_req_discord_long = true;
      ObjectSetInteger(0, "IFX_BTN_LONG", OBJPROP_STATE, false);
   }
   else if(sparam == "IFX_BTN_SHORT")
   {
      te_req_discord_short = true;
      ObjectSetInteger(0, "IFX_BTN_SHORT", OBJPROP_STATE, false);
   }
   else if(sparam == "IFX_BTN_REP")
   {
      te_req_discord_report = true;
      ObjectSetInteger(0, "IFX_BTN_REP", OBJPROP_STATE, false);
   }
}

// Poll pending button flags — call from OnTick().
void TE_PollButtonFlags(const IFX_EaConfig &cfg)
{
   if(te_req_discord_long)
   {
      TE_SendDiscordAlert(cfg, "📢 Manual: LONG bias on " + _Symbol);
      te_req_discord_long = false;
   }
   if(te_req_discord_short)
   {
      TE_SendDiscordAlert(cfg, "📢 Manual: SHORT bias on " + _Symbol);
      te_req_discord_short = false;
   }
   if(te_req_discord_report)
   {
      TE_SendDailyReport(cfg);
      te_req_discord_report = false;
   }
}

//==========================================================================
// SECTION G — DIAGNOSTICS
//==========================================================================

double TE_GetLiveLots(const IFX_EaConfig &cfg)
{
   double total = 0.0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(PositionGetString(ticket, POSITION_SYMBOL) != _Symbol) continue;
      long magic = PositionGetInteger(ticket, POSITION_MAGIC);
      if(magic < cfg.base_magic || magic > cfg.base_magic + 50) continue;
      total += PositionGetDouble(ticket, POSITION_VOLUME);
   }
   return total;
}

double TE_GetLiveSL(const IFX_EaConfig &cfg)
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(PositionGetString(ticket, POSITION_SYMBOL) != _Symbol) continue;
      if(PositionGetInteger(ticket, POSITION_MAGIC) == cfg.base_magic)
         return PositionGetDouble(ticket, POSITION_SL);
   }
   return 0.0;
}

#endif // IFX_TRADE_EXECUTOR_MQH
//+------------------------------------------------------------------+
