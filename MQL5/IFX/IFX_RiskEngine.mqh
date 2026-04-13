//+------------------------------------------------------------------+
//|  IFX_RiskEngine.mqh                                              |
//|  Phase 2B — Position sizing, trade counting, session filtering   |
//|                                                                  |
//|  Provides:                                                        |
//|    RE_CountOpenPositions()     — count open trades for symbol    |
//|    RE_CountTodayTrades()       — count entries since midnight    |
//|    RE_CalculateLots()          — equity-based lot sizing         |
//|    RE_CalculateAutoRR()        — set TP1/TP2 from R×multiplier  |
//|    RE_CheckTradingSessions()   — session window gate             |
//|    RE_CheckHistoricalStopLoss()— SL cooldown guard               |
//|                                                                  |
//|  Depends on: IFX_Config.mqh                                      |
//+------------------------------------------------------------------+
#ifndef IFX_RISK_ENGINE_MQH
#define IFX_RISK_ENGINE_MQH

#property strict
#include "IFX_Config.mqh"

//==========================================================================
// SECTION A — POSITION COUNTING
//==========================================================================

// Count open positions for the current symbol within the magic number range.
// Magic range: base_magic to base_magic+50 (accounts for partial split positions).
int RE_CountOpenPositions(const IFX_EaConfig &cfg)
{
   int count = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(PositionGetString(ticket, POSITION_SYMBOL) != _Symbol) continue;
      long magic = PositionGetInteger(ticket, POSITION_MAGIC);
      if(magic < cfg.base_magic || magic > cfg.base_magic + 50) continue;
      count++;
   }
   return count;
}

// Count entries made today (since midnight server time).
// Scans deal history for DEAL_ENTRY_IN matching this symbol and magic range.
int RE_CountTodayTrades(const IFX_EaConfig &cfg)
{
   datetime midnight = StringToTime(TimeToString(TimeCurrent(), TIME_DATE) + " 00:00");
   if(!HistorySelect(midnight, TimeCurrent())) return 0;

   int count = 0;
   int total = HistoryDealsTotal();
   for(int i = 0; i < total; i++)
   {
      ulong ticket = HistoryDealGetTicket(i);
      if(HistoryDealGetString(ticket,  DEAL_SYMBOL) != _Symbol) continue;
      if(HistoryDealGetInteger(ticket, DEAL_ENTRY)  != DEAL_ENTRY_IN) continue;
      long magic = HistoryDealGetInteger(ticket, DEAL_MAGIC);
      if(magic < cfg.base_magic || magic > cfg.base_magic + 50) continue;
      count++;
   }
   return count;
}

//==========================================================================
// SECTION B — LOT SIZE CALCULATION
//==========================================================================

// Equity-based lot sizing using tick size / tick value ratio.
// Matches the original CalculateLots() logic exactly.
// sl_dist = absolute price distance from entry to stop loss
double RE_CalculateLots(const IFX_EaConfig &cfg, double entry_price, double sl_price)
{
   double sl_dist = MathAbs(entry_price - sl_price);
   if(sl_dist <= 0.0) return SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);

   double tick_size  = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   double tick_value = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   if(tick_size <= 0.0 || tick_value <= 0.0)
   {
      Print("⚠️ [RISK] Invalid tick data for lot calc on ", _Symbol);
      return SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   }

   double equity       = cfg.strict_risk ? AccountInfoDouble(ACCOUNT_EQUITY) : AccountInfoDouble(ACCOUNT_BALANCE);
   double risk_amount  = equity * (cfg.risk_pct / 100.0);
   double ticks_at_risk = sl_dist / tick_size;
   double raw_lots      = risk_amount / (ticks_at_risk * tick_value);

   double min_lot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double max_lot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double step_lot = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);

   if(step_lot <= 0.0) step_lot = 0.01;
   raw_lots = MathFloor(raw_lots / step_lot) * step_lot;
   raw_lots = MathMax(min_lot, MathMin(max_lot, raw_lots));

   return NormalizeDouble(raw_lots, 2);
}

//==========================================================================
// SECTION C — AUTO RR CALCULATION
//==========================================================================

// Calculate TP1 and TP2 prices from the R-multiple multipliers.
// This replicates CalculateAutoRR() from the original — modifies cfg's tp1/tp2.
// direction: +1 for Long, -1 for Short
// sl_dist should be the absolute price distance (entry - SL, already positive)
void RE_CalculateAutoRR(IFX_EaConfig &cfg, double entry_price, double sl_dist, int direction)
{
   if(!cfg.use_auto_rr || sl_dist <= 0.0) return;

   if(direction > 0)  // Long
   {
      cfg.tp1 = NormalizeDouble(entry_price + sl_dist * cfg.auto_rr1, _Digits);
      cfg.tp2 = NormalizeDouble(entry_price + sl_dist * cfg.auto_rr2, _Digits);
   }
   else               // Short
   {
      cfg.tp1 = NormalizeDouble(entry_price - sl_dist * cfg.auto_rr1, _Digits);
      cfg.tp2 = NormalizeDouble(entry_price - sl_dist * cfg.auto_rr2, _Digits);
   }
}

//==========================================================================
// SECTION D — SESSION GATE
//==========================================================================

// Returns true if current broker time falls within an enabled session window.
// Uses string H:MM or HH:MM format for start/end.
// NOTE: All times compared using minutes since midnight for DST-safe arithmetic.

int RE_TimeStringToMinutes(const string t)
{
   string parts[];
   int n = StringSplit(t, ':', parts);
   if(n < 2) return -1;
   return (int)(StringToInteger(parts[0]) * 60 + StringToInteger(parts[1]));
}

bool RE_IsInWindow(int cur_min, int start_min, int end_min)
{
   if(start_min == end_min) return false;
   if(start_min < end_min)
      return (cur_min >= start_min && cur_min < end_min);
   else
      // overnight session (e.g. 22:00 → 03:00)
      return (cur_min >= start_min || cur_min < end_min);
}

bool RE_CheckTradingSessions(const IFX_EaConfig &cfg)
{
   MqlDateTime mdt;
   TimeToStruct(TimeCurrent(), mdt);
   int cur_min = mdt.hour * 60 + mdt.min;

   if(cfg.use_asia)
   {
      int s = RE_TimeStringToMinutes(cfg.asia_start);
      int e = RE_TimeStringToMinutes(cfg.asia_end);
      if(s >= 0 && e >= 0 && RE_IsInWindow(cur_min, s, e)) return true;
   }

   if(cfg.use_lon)
   {
      int s = RE_TimeStringToMinutes(cfg.lon_start);
      int e = RE_TimeStringToMinutes(cfg.lon_end);
      if(s >= 0 && e >= 0 && RE_IsInWindow(cur_min, s, e)) return true;
   }

   if(cfg.use_ny)
   {
      int s = RE_TimeStringToMinutes(cfg.ny_start);
      int e = RE_TimeStringToMinutes(cfg.ny_end);
      if(s >= 0 && e >= 0 && RE_IsInWindow(cur_min, s, e)) return true;
   }

   return false;
}

//==========================================================================
// SECTION E — HISTORICAL SL COOLDOWN CHECK
//==========================================================================

// Returns true if the last closed trade for this symbol was an SL hit
// and the cooldown period has not yet elapsed.
// This prevents re-entry immediately after being stopped out.
bool RE_CheckHistoricalStopLoss(const IFX_EaConfig &cfg)
{
   if(!cfg.use_dead_sl) return false;
   if(cfg.sl_cooldown_min <= 0) return false;

   if(!HistorySelect(TimeCurrent() - (86400 * 7), TimeCurrent())) return false;

   int total = HistoryDealsTotal();
   for(int i = total - 1; i >= 0; i--)
   {
      ulong ticket = HistoryDealGetTicket(i);
      if(HistoryDealGetString(ticket,  DEAL_SYMBOL) != _Symbol) continue;
      if(HistoryDealGetInteger(ticket, DEAL_ENTRY)  != DEAL_ENTRY_OUT) continue;
      long magic = HistoryDealGetInteger(ticket, DEAL_MAGIC);
      if(magic < cfg.base_magic || magic > cfg.base_magic + 50) continue;

      // Found the most recent exit for this EA on this symbol
      int reason = (int)HistoryDealGetInteger(ticket, DEAL_REASON);
      if(reason == DEAL_REASON_SL)
      {
         datetime close_time = (datetime)HistoryDealGetInteger(ticket, DEAL_TIME);
         int elapsed_sec     = (int)(TimeCurrent() - close_time);
         int cooldown_sec    = cfg.sl_cooldown_min * 60;

         if(elapsed_sec < cooldown_sec)
         {
            int remaining_min = (cooldown_sec - elapsed_sec) / 60;
            Print("🛑 [RISK] SL cooldown — blocked for ", remaining_min, " more minutes");
            return true;   // still cooling down
         }
      }
      return false;  // last exit was not an SL, or cooldown elapsed
   }

   return false;
}

//==========================================================================
// SECTION F — EOD CHECK
//==========================================================================

// Returns true if current time is PAST the EOD cutoff.
// When true, the EA should close all positions and stop trading.
bool RE_IsEodReached(const IFX_EaConfig &cfg)
{
   if(!cfg.use_eod) return false;
   int eod_min = RE_TimeStringToMinutes(cfg.eod_time);
   if(eod_min < 0) return false;
   MqlDateTime mdt;
   TimeToStruct(TimeCurrent(), mdt);
   int cur_min = mdt.hour * 60 + mdt.min;
   return (cur_min >= eod_min);
}

#endif // IFX_RISK_ENGINE_MQH
//+------------------------------------------------------------------+
