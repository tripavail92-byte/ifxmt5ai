//+------------------------------------------------------------------+
//|  IFX_StructureEngine.mqh                                         |
//|  Phase 2B — SMC structure detection + chart drawing              |
//|                                                                  |
//|  Provides:                                                        |
//|    SE_GetActiveStructure()  — SMC pivot high/low detection       |
//|    SE_DrawBattlefieldZones() — entry zone + TP/inval lines       |
//|    SE_DrawSMCStructure()    — BOS/SMS overlay on chart           |
//|    SE_CleanupObjects()      — remove all IFX_ chart objects      |
//|                                                                  |
//|  Depends on: IFX_Config.mqh (for IFX_EaConfig struct)           |
//+------------------------------------------------------------------+
#ifndef IFX_STRUCTURE_ENGINE_MQH
#define IFX_STRUCTURE_ENGINE_MQH

#property strict
#include "IFX_Config.mqh"

//==========================================================================
// UI COLORS (matches original Pine matrix palette)
//==========================================================================
color SE_c_red    = C'220,53,69';
color SE_c_green  = C'40,167,69';
color SE_c_orange = C'253,126,20';
color SE_c_gray   = C'108,117,125';
color SE_c_dark   = C'33,37,41';
color SE_c_purple = C'111,66,193';

//==========================================================================
// GLOBALS
//==========================================================================
bool se_ui_needs_redraw = false;
datetime se_last_smc_bar = 0;

//==========================================================================
// SECTION A — ACTIVE STRUCTURE DETECTION
// Exact port of GetActiveStructure() from finaleabyahsan.txt
//==========================================================================

// Returns the active pivot high/low using the same SMC state-machine logic
// as the original v9.30 brain.
void SE_GetActiveStructure(
   ENUM_TIMEFRAMES tf,
   int             pivot_len,
   int             smc_lookback,
   double         &out_ph,
   double         &out_pl,
   datetime       &out_t_ph,
   datetime       &out_t_pl)
{
   double h[], l[], c[];
   datetime t[];
   ArraySetAsSeries(h, true);
   ArraySetAsSeries(l, true);
   ArraySetAsSeries(c, true);
   ArraySetAsSeries(t, true);

   int lookback = smc_lookback;
   int copied_h = CopyHigh (_Symbol, tf, 0, lookback, h);
   int copied_l = CopyLow  (_Symbol, tf, 0, lookback, l);
   int copied_c = CopyClose(_Symbol, tf, 0, lookback, c);
   int copied_t = CopyTime (_Symbol, tf, 0, lookback, t);

   if(copied_h <= pivot_len * 2 || copied_l <= pivot_len * 2
      || copied_c <= pivot_len * 2 || copied_t <= pivot_len * 2)
   {
      out_ph = EMPTY_VALUE; out_pl = EMPTY_VALUE;
      out_t_ph = 0;         out_t_pl = 0;
      return;
   }

   int alb = (int)MathMin(copied_h, MathMin(copied_l, MathMin(copied_c, copied_t)));

   double   active_ph = EMPTY_VALUE, active_pl = EMPTY_VALUE;
   datetime t_act_ph  = 0,           t_act_pl  = 0;

   // PROXIMITY SEARCH: walk newest-to-oldest (i=0 is newest since ArraySetAsSeries=true).
   // Capture the nearest qualified pivot and stop searching as soon as both are found.
   // This is more responsive than a full BOS state-machine — the nearest structural
   // floor/ceiling is the level the market is currently interacting with.
   for(int i = pivot_len; i < alb - pivot_len; i++)
   {
      bool isPH = true, isPL = true;
      for(int j = i - pivot_len; j <= i + pivot_len; j++)
      {
         if(j == i) continue;
         if(h[j] > h[i]) isPH = false;
         if(l[j] < l[i]) isPL = false;
      }
      if(isPH && active_ph == EMPTY_VALUE) { active_ph = h[i]; t_act_ph = t[i]; }
      if(isPL && active_pl == EMPTY_VALUE) { active_pl = l[i]; t_act_pl = t[i]; }
      if(active_ph != EMPTY_VALUE && active_pl != EMPTY_VALUE) break;
   }

   out_ph   = active_ph;   out_pl   = active_pl;
   out_t_ph = t_act_ph;    out_t_pl = t_act_pl;
}

//==========================================================================
// SECTION B — DRAWING PRIMITIVES
//==========================================================================

void SE_DrawLine(const string name, double price, color col, int style)
{
   if(ObjectFind(0, name) < 0)
   {
      ObjectCreate(0, name, OBJ_HLINE, 0, 0, 0);
      ObjectSetInteger(0, name, OBJPROP_COLOR, col);
      ObjectSetInteger(0, name, OBJPROP_STYLE, style);
      se_ui_needs_redraw = true;
   }
   if(ObjectGetDouble(0, name, OBJPROP_PRICE, 0) != price)
   {
      ObjectSetDouble(0, name, OBJPROP_PRICE, 0, price);
      se_ui_needs_redraw = true;
   }
}

void SE_DrawText(const string name, const string text, datetime t, double price, color col, ENUM_ANCHOR_POINT anchor)
{
   if(ObjectFind(0, name) < 0)
   {
      ObjectCreate(0, name, OBJ_TEXT, 0, t, price);
      ObjectSetInteger(0, name, OBJPROP_FONTSIZE, 8);
      ObjectSetInteger(0, name, OBJPROP_COLOR, col);
      ObjectSetString (0, name, OBJPROP_TEXT, text);
      ObjectSetInteger(0, name, OBJPROP_ANCHOR, anchor);
      se_ui_needs_redraw = true;
   }
   else
   {
      if(ObjectGetInteger(0, name, OBJPROP_TIME,  0) != t)     { ObjectSetInteger(0, name, OBJPROP_TIME,  0, t);    se_ui_needs_redraw = true; }
      if(ObjectGetDouble (0, name, OBJPROP_PRICE, 0) != price) { ObjectSetDouble (0, name, OBJPROP_PRICE, 0, price); se_ui_needs_redraw = true; }
      if(ObjectGetString (0, name, OBJPROP_TEXT)      != text)  { ObjectSetString (0, name, OBJPROP_TEXT, text);       se_ui_needs_redraw = true; }
   }
}

void SE_DrawTrendLine(const string name, datetime t1, double p1, datetime t2, double p2, color col, int style)
{
   if(ObjectFind(0, name) < 0)
   {
      ObjectCreate(0, name, OBJ_TREND, 0, t1, p1, t2, p2);
      ObjectSetInteger(0, name, OBJPROP_COLOR, col);
      ObjectSetInteger(0, name, OBJPROP_STYLE, style);
      ObjectSetInteger(0, name, OBJPROP_RAY_RIGHT, false);
      se_ui_needs_redraw = true;
   }
   else if(ObjectGetInteger(0, name, OBJPROP_TIME, 1) != t2)
   {
      ObjectSetInteger(0, name, OBJPROP_TIME, 1, t2);
      se_ui_needs_redraw = true;
   }
}

//==========================================================================
// SECTION C — BATTLEFIELD ZONES (entry zone + levels)
//==========================================================================

void SE_DrawBattlefieldZones(
   const IFX_EaConfig &cfg,
   double zone_high,
   double zone_low,
   double inval_price)
{
   if(cfg.pivot == 0.0) return;

   // Entry zone rectangle
   string zName = "IFX_Entry_Zone";
   if(ObjectFind(0, zName) < 0) ObjectCreate(0, zName, OBJ_RECTANGLE, 0, 0, 0);
   ObjectSetInteger(0, zName, OBJPROP_TIME,  0, iTime(_Symbol, PERIOD_D1, 0));
   ObjectSetDouble (0, zName, OBJPROP_PRICE, 0, zone_high);
   ObjectSetInteger(0, zName, OBJPROP_TIME,  1, TimeCurrent() + (86400 * 2));
   ObjectSetDouble (0, zName, OBJPROP_PRICE, 1, zone_low);
   ObjectSetInteger(0, zName, OBJPROP_COLOR, clrMidnightBlue);
   ObjectSetInteger(0, zName, OBJPROP_BACK,  true);

   SE_DrawLine("IFX_Zone_Top", zone_high,    clrDodgerBlue,    STYLE_SOLID);
   SE_DrawLine("IFX_Zone_Bot", zone_low,     clrOrange,        STYLE_SOLID);
   SE_DrawLine("IFX_Inval",    inval_price,  clrRed,           STYLE_DOT);

   datetime anchor = iTime(_Symbol, cfg.tf_engine, 0) + (PeriodSeconds(cfg.tf_engine) * 3);

   if(cfg.tp1 > 0)
   {
      SE_DrawLine("IFX_TP1", cfg.tp1, clrMediumSeaGreen, STYLE_DASH);
      SE_DrawText("IFX_TP1_TXT", "TP1", anchor, cfg.tp1, clrMediumSeaGreen, ANCHOR_LOWER);
   }
   else { ObjectDelete(0, "IFX_TP1"); ObjectDelete(0, "IFX_TP1_TXT"); }

   if(cfg.tp2 > 0)
   {
      SE_DrawLine("IFX_TP2", cfg.tp2, clrMediumSeaGreen, STYLE_DASH);
      SE_DrawText("IFX_TP2_TXT", "TP2", anchor, cfg.tp2, clrMediumSeaGreen, ANCHOR_LOWER);
   }
   else { ObjectDelete(0, "IFX_TP2"); ObjectDelete(0, "IFX_TP2_TXT"); }
}

//==========================================================================
// SECTION D — SMC STRUCTURE OVERLAY (BOS / SMS lines)
//==========================================================================

void SE_DrawStructureLines(const IFX_EaConfig &cfg)
{
   double ph, pl;
   datetime tph, tpl;
   SE_GetActiveStructure(cfg.tf_engine, cfg.pivot_len, cfg.smc_lookback, ph, pl, tph, tpl);

   datetime anchor = iTime(_Symbol, cfg.tf_engine, 0) + (PeriodSeconds(cfg.tf_engine) * 3);

   if(ph != EMPTY_VALUE)
   {
      SE_DrawLine("IFX_STR_PH", ph, clrCrimson, STYLE_SOLID);
      SE_DrawText("IFX_STR_PH_TXT", "PH / BOS", anchor, ph, clrCrimson, ANCHOR_LOWER);
   }
   if(pl != EMPTY_VALUE)
   {
      SE_DrawLine("IFX_STR_PL", pl, clrMediumSeaGreen, STYLE_SOLID);
      SE_DrawText("IFX_STR_PL_TXT", "PL / SMS", anchor, pl, clrMediumSeaGreen, ANCHOR_UPPER);
   }
}

void SE_DrawSMCStructure(const IFX_EaConfig &cfg)
{
   SE_DrawStructureLines(cfg);
   ObjectsDeleteAll(0, "IFX_SMC_");

   int lookback = cfg.smc_lookback;
   double h[], l[], c[];
   datetime t[];

   int ch = CopyHigh (_Symbol, cfg.tf_engine, 0, lookback, h);
   int cl = CopyLow  (_Symbol, cfg.tf_engine, 0, lookback, l);
   int cc = CopyClose(_Symbol, cfg.tf_engine, 0, lookback, c);
   int ct = CopyTime (_Symbol, cfg.tf_engine, 0, lookback, t);

   if(ch <= 0 || cl <= 0 || cc <= 0 || ct <= 0) return;

   int actual = (int)MathMin(ch, MathMin(cl, MathMin(cc, ct)));
   if(actual < lookback) lookback = actual;

   ArraySetAsSeries(h, true); ArraySetAsSeries(l, true);
   ArraySetAsSeries(c, true); ArraySetAsSeries(t, true);

   int pLen = cfg.pivot_len;
   int ph_bos_count = 0, pl_bos_count = 0;

   for(int i = pLen; i < lookback - pLen; i++)
   {
      // Pivot High → BOS
      bool isPH = true;
      for(int j = i - pLen; j <= i + pLen; j++)
      {
         if(j == i) continue;
         if(h[j] >= h[i]) { isPH = false; break; }
      }
      if(isPH)
      {
         for(int k = i - 1; k >= 0; k--)
         {
            if(c[k] > h[i])
            {
               if(ph_bos_count < 3)
               {
                  string name = "IFX_SMC_PH_" + IntegerToString(t[i]);
                  SE_DrawTrendLine(name, t[i], h[i], t[k], h[i], clrMediumSeaGreen, STYLE_DASH);
                  SE_DrawText(name + "_txt", "BOS", t[k + (i - k) / 2], h[i], clrMediumSeaGreen, ANCHOR_LOWER);
                  ph_bos_count++;
               }
               break;
            }
         }
      }

      // Pivot Low → BOS
      bool isPL = true;
      for(int j = i - pLen; j <= i + pLen; j++)
      {
         if(j == i) continue;
         if(l[j] <= l[i]) { isPL = false; break; }
      }
      if(isPL)
      {
         for(int k = i - 1; k >= 0; k--)
         {
            if(c[k] < l[i])
            {
               if(pl_bos_count < 3)
               {
                  string name = "IFX_SMC_PL_" + IntegerToString(t[i]);
                  SE_DrawTrendLine(name, t[i], l[i], t[k], l[i], clrCrimson, STYLE_DASH);
                  SE_DrawText(name + "_txt", "BOS", t[k + (i - k) / 2], l[i], clrCrimson, ANCHOR_UPPER);
                  pl_bos_count++;
               }
               break;
            }
         }
      }
   }
}

//==========================================================================
// SECTION E — HUD CELL DRAWING PRIMITIVES
//==========================================================================

void SE_DrawTableCell(const string id, const string text, int x, int y, int w, int h, color bgCol, color txtCol)
{
   string bg  = "HUD_BG_"  + id;
   string txt = "HUD_TXT_" + id;

   if(ObjectFind(0, bg) < 0)
   {
      ObjectCreate(0, bg, OBJ_RECTANGLE_LABEL, 0, 0, 0);
      ObjectSetInteger(0, bg, OBJPROP_BORDER_TYPE, BORDER_FLAT);
      ObjectSetInteger(0, bg, OBJPROP_CORNER,     CORNER_LEFT_UPPER);
      ObjectSetInteger(0, bg, OBJPROP_XDISTANCE,  x);
      ObjectSetInteger(0, bg, OBJPROP_YDISTANCE,  y);
      ObjectSetInteger(0, bg, OBJPROP_XSIZE,      w);
      ObjectSetInteger(0, bg, OBJPROP_YSIZE,      h);
      se_ui_needs_redraw = true;
   }
   if(ObjectGetInteger(0, bg, OBJPROP_BGCOLOR) != bgCol)
      { ObjectSetInteger(0, bg, OBJPROP_BGCOLOR, bgCol); se_ui_needs_redraw = true; }

   if(ObjectFind(0, txt) < 0)
   {
      ObjectCreate(0, txt, OBJ_LABEL, 0, 0, 0);
      ObjectSetInteger(0, txt, OBJPROP_ANCHOR,    ANCHOR_CENTER);
      ObjectSetInteger(0, txt, OBJPROP_CORNER,    CORNER_LEFT_UPPER);
      ObjectSetInteger(0, txt, OBJPROP_FONTSIZE,  8);
      ObjectSetString (0, txt, OBJPROP_FONT,      "Arial");
      ObjectSetInteger(0, txt, OBJPROP_XDISTANCE, x + (w / 2));
      ObjectSetInteger(0, txt, OBJPROP_YDISTANCE, y + (h / 2) - 6);
      se_ui_needs_redraw = true;
   }
   if(ObjectGetString (0, txt, OBJPROP_TEXT)  != text)    { ObjectSetString (0, txt, OBJPROP_TEXT,  text);    se_ui_needs_redraw = true; }
   if(ObjectGetInteger(0, txt, OBJPROP_COLOR) != txtCol)  { ObjectSetInteger(0, txt, OBJPROP_COLOR, txtCol);  se_ui_needs_redraw = true; }
}

void SE_DrawTableCornerCell(const string id, const string text, int x_dist, int y_dist, int w, int h, color bgCol, color txtCol)
{
   string bg  = "LDG_BG_"  + id;
   string txt = "LDG_TXT_" + id;

   if(ObjectFind(0, bg) < 0)
   {
      ObjectCreate(0, bg, OBJ_RECTANGLE_LABEL, 0, 0, 0);
      ObjectSetInteger(0, bg, OBJPROP_BORDER_TYPE, BORDER_FLAT);
      ObjectSetInteger(0, bg, OBJPROP_CORNER,      CORNER_RIGHT_UPPER);
      ObjectSetInteger(0, bg, OBJPROP_XDISTANCE,   x_dist);
      ObjectSetInteger(0, bg, OBJPROP_YDISTANCE,   y_dist);
      ObjectSetInteger(0, bg, OBJPROP_XSIZE,        w);
      ObjectSetInteger(0, bg, OBJPROP_YSIZE,        h);
      se_ui_needs_redraw = true;
   }
   if(ObjectGetInteger(0, bg, OBJPROP_BGCOLOR) != bgCol)
      { ObjectSetInteger(0, bg, OBJPROP_BGCOLOR, bgCol); se_ui_needs_redraw = true; }

   if(ObjectFind(0, txt) < 0)
   {
      ObjectCreate(0, txt, OBJ_LABEL, 0, 0, 0);
      ObjectSetInteger(0, txt, OBJPROP_ANCHOR,    ANCHOR_CENTER);
      ObjectSetInteger(0, txt, OBJPROP_CORNER,    CORNER_RIGHT_UPPER);
      ObjectSetInteger(0, txt, OBJPROP_FONTSIZE,  8);
      ObjectSetString (0, txt, OBJPROP_FONT,      "Arial");
      ObjectSetInteger(0, txt, OBJPROP_XDISTANCE, x_dist + (w / 2));
      ObjectSetInteger(0, txt, OBJPROP_YDISTANCE, y_dist + (h / 2) - 6);
      se_ui_needs_redraw = true;
   }
   if(ObjectGetString (0, txt, OBJPROP_TEXT)  != text)    { ObjectSetString (0, txt, OBJPROP_TEXT,  text);    se_ui_needs_redraw = true; }
   if(ObjectGetInteger(0, txt, OBJPROP_COLOR) != txtCol)  { ObjectSetInteger(0, txt, OBJPROP_COLOR, txtCol);  se_ui_needs_redraw = true; }
}

//==========================================================================
// SECTION F — MATRIX HUD
//==========================================================================

void SE_CreateUIButton(const string name, const string text, int x, int y, color bg_col)
{
   if(ObjectFind(0, name) >= 0) return;
   ObjectCreate(0, name, OBJ_BUTTON, 0, 0, 0);
   ObjectSetInteger(0, name, OBJPROP_XDISTANCE, x);
   ObjectSetInteger(0, name, OBJPROP_YDISTANCE, y);
   ObjectSetInteger(0, name, OBJPROP_XSIZE,     75);
   ObjectSetInteger(0, name, OBJPROP_YSIZE,     25);
   ObjectSetString (0, name, OBJPROP_TEXT,      text);
   ObjectSetInteger(0, name, OBJPROP_BGCOLOR,   bg_col);
   ObjectSetInteger(0, name, OBJPROP_COLOR,     clrWhite);
   ObjectSetInteger(0, name, OBJPROP_FONTSIZE,  8);
   ObjectSetInteger(0, name, OBJPROP_STATE,     false);
}

// SE_DrawMatrixHUD — full HUD renderer.
// Parameters match the live state variables from the trading state.
void SE_DrawMatrixHUD(
   const IFX_EaConfig &cfg,
   const string        status_txt,
   color               status_col,
   double              calc_inval,
   double              live_sl,
   double              live_lots,
   bool                is_inside_zone,
   bool                is_be_secured,
   int                 daily_trades_count,
   bool                report_sent_today)
{
   int start_x = 20;
   int start_y = 30;
   int row_h   = 22;
   int col1_w  = 160;
   int col2_w  = 180;

   SE_DrawTableCell("hdr1", "IFX BOT: " + _Symbol, start_x, start_y, col1_w, row_h, SE_c_dark, clrWhite);
   SE_DrawTableCell("hdr2", status_txt, start_x + col1_w, start_y, col2_w, row_h, status_col, clrWhite);

   int r = 1;
   SE_DrawTableCell("r1c1", "Engine Timeframe", start_x, start_y + (r*row_h), col1_w, row_h, SE_c_gray, clrWhite);
   SE_DrawTableCell("r1c2", EnumToString(cfg.tf_engine), start_x + col1_w, start_y + (r*row_h), col2_w, row_h, SE_c_purple, clrWhite);

   r = 2;
   color biasCol = SE_c_gray;
   if(cfg.bias == "Long")  biasCol = SE_c_green;
   else if(cfg.bias == "Short") biasCol = SE_c_red;
   SE_DrawTableCell("r2c1", "Master Bias", start_x, start_y + (r*row_h), col1_w, row_h, SE_c_gray, clrWhite);
   {
      string bias_disp;
      if(cfg.bias == "Long")       bias_disp = "\U0001F402 " + IntegerToString(cfg.confidence) + "% BULLISH";
      else if(cfg.bias == "Short") bias_disp = "\U0001F43B " + IntegerToString(cfg.confidence) + "% BEARISH";
      else                         bias_disp = "\u2696\ufe0f "  + IntegerToString(cfg.confidence) + "% NEUTRAL";
      SE_DrawTableCell("r2c2", bias_disp, start_x + col1_w, start_y + (r*row_h), col2_w, row_h, biasCol, clrWhite);
   }

   r = 3;
   SE_DrawTableCell("r3c1", "Invalidation (" + EnumToString(cfg.tf_boss) + ")", start_x, start_y + (r*row_h), col1_w, row_h, SE_c_gray, clrWhite);
   SE_DrawTableCell("r3c2", DoubleToString(calc_inval, 5), start_x + col1_w, start_y + (r*row_h), col2_w, row_h, SE_c_orange, clrWhite);

   r = 4;
   string sl_txt = (live_sl > 0) ? DoubleToString(live_sl, 5) : "Pending Trigger";
   SE_DrawTableCell("r4c1", "Hard Stop Loss", start_x, start_y + (r*row_h), col1_w, row_h, SE_c_gray, clrWhite);
   SE_DrawTableCell("r4c2", sl_txt, start_x + col1_w, start_y + (r*row_h), col2_w, row_h, SE_c_red, clrWhite);

   r = 5;
   SE_DrawTableCell("r5c1", "Origin Rule", start_x, start_y + (r*row_h), col1_w, row_h, SE_c_gray, clrWhite);
   SE_DrawTableCell("r5c2", is_inside_zone ? "Inside Zone" : "Outside Zone", start_x + col1_w, start_y + (r*row_h), col2_w, row_h, is_inside_zone ? SE_c_green : SE_c_red, clrWhite);

   r = 6;
   string rr_txt;
   if(cfg.use_auto_rr)
      rr_txt = "TP1: " + DoubleToString(cfg.auto_rr1, 1) + "R | TP2: " + DoubleToString(cfg.auto_rr2, 1) + "R";
   else if(cfg.tp1 > 0)
      rr_txt = "TP1: " + DoubleToString(cfg.tp1, 5) + " | TP2: " + DoubleToString(cfg.tp2, 5);
   else
      rr_txt = "Waiting for Parameters...";
   SE_DrawTableCell("r6c1", "Expected RR", start_x, start_y + (r*row_h), col1_w, row_h, SE_c_gray, clrWhite);
   SE_DrawTableCell("r6c2", rr_txt, start_x + col1_w, start_y + (r*row_h), col2_w, row_h, SE_c_green, clrWhite);

   r = 7;
   SE_DrawTableCell("r7c1", "Risk Status (BE Tracker)", start_x, start_y + (r*row_h), col1_w, row_h, SE_c_gray, clrWhite);
   SE_DrawTableCell("r7c2", is_be_secured ? "Free Ride" : "---", start_x + col1_w, start_y + (r*row_h), col2_w, row_h, is_be_secured ? SE_c_purple : SE_c_gray, clrWhite);

   r = 8;
   SE_DrawTableCell("r8c1", "Position Size (" + DoubleToString(cfg.risk_pct, 1) + "% Risk)", start_x, start_y + (r*row_h), col1_w, row_h, SE_c_gray, clrWhite);
   SE_DrawTableCell("r8c2", DoubleToString(live_lots, 2) + " Lots", start_x + col1_w, start_y + (r*row_h), col2_w, row_h, SE_c_purple, clrWhite);

   r = 9;
   SE_DrawTableCell("r9c1", "Daily Trades (" + IntegerToString(cfg.max_trades) + " Max)", start_x, start_y + (r*row_h), col1_w, row_h, SE_c_gray, clrWhite);
   SE_DrawTableCell("r9c2", IntegerToString(daily_trades_count) + " / " + IntegerToString(cfg.max_trades), start_x + col1_w, start_y + (r*row_h), col2_w, row_h, (daily_trades_count >= cfg.max_trades) ? SE_c_red : SE_c_green, clrWhite);

   r = 10;
   SE_DrawTableCell("r10c1", "Report Status", start_x, start_y + (r*row_h), col1_w, row_h, SE_c_gray, clrWhite);
   SE_DrawTableCell("r10c2", report_sent_today ? "✅ SENT" : "⏳ PENDING", start_x + col1_w, start_y + (r*row_h), col2_w, row_h, report_sent_today ? SE_c_green : SE_c_orange, clrWhite);

   int btn_y = start_y + ((r + 1) * row_h) + 10;
   SE_CreateUIButton("IFX_BTN_LONG",  "🟢 T-LONG",   start_x,        btn_y, clrDarkGreen);
   SE_CreateUIButton("IFX_BTN_SHORT", "🔴 T-SHORT",  start_x + 80,   btn_y, clrDarkRed);
   SE_CreateUIButton("IFX_BTN_REP",   "🟦 T-REPORT", start_x + 160,  btn_y, clrNavy);
}

//==========================================================================
// SECTION G — TOP LEDGER (last 4 closed trades)
//==========================================================================

int se_last_ledger_deals = -1;

void SE_DrawTopLedger(const IFX_EaConfig &cfg)
{
   if(!HistorySelect(TimeCurrent() - 604800, TimeCurrent())) return;

   int current_deals = HistoryDealsTotal();
   if(current_deals == se_last_ledger_deals) return;
   se_last_ledger_deals = current_deals;

   int start_y = 30;
   int row_h   = 22;
   int base_x  = 20;
   int w_pnl = 80, w_entry = 80, w_dir = 50, w_trade = 60;
   int x_pnl = base_x;
   int x_entry = x_pnl  + w_pnl;
   int x_dir   = x_entry + w_entry;
   int x_trade = x_dir   + w_dir;

   SE_DrawTableCornerCell("lg_h1", "Trade", x_trade, start_y, w_trade, row_h, SE_c_dark, clrWhite);
   SE_DrawTableCornerCell("lg_h2", "Dir",   x_dir,   start_y, w_dir,   row_h, SE_c_dark, clrWhite);
   SE_DrawTableCornerCell("lg_h3", "Entry", x_entry, start_y, w_entry, row_h, SE_c_dark, clrWhite);
   SE_DrawTableCornerCell("lg_h4", "PnL ($)", x_pnl, start_y, w_pnl,  row_h, SE_c_dark, clrWhite);

   double net_prof = 0.0;
   int printed = 0;

   for(int i = current_deals - 1; i >= 0 && printed < 4; i--)
   {
      ulong ticket = HistoryDealGetTicket(i);
      if(HistoryDealGetString(ticket,  DEAL_SYMBOL) != _Symbol) continue;
      if(HistoryDealGetInteger(ticket, DEAL_ENTRY)  != DEAL_ENTRY_OUT) continue;
      int m_id = (int)HistoryDealGetInteger(ticket, DEAL_MAGIC);
      if(m_id < cfg.base_magic || m_id > cfg.base_magic + 50) continue;

      double pnl    = HistoryDealGetDouble(ticket, DEAL_PROFIT);
      net_prof     += pnl;
      string dir    = (HistoryDealGetInteger(ticket, DEAL_TYPE) == DEAL_TYPE_BUY) ? "Buy" : "Sell";
      string pnl_s  = (pnl >= 0 ? "+$" : "-$") + DoubleToString(MathAbs(pnl), 2);
      color pnl_col = (pnl >= 0) ? SE_c_green : SE_c_red;

      int r       = printed + 1;
      int y_pos   = start_y + (r * row_h);
      SE_DrawTableCornerCell("lg_r" + IntegerToString(r) + "_1", "#" + IntegerToString(r), x_trade, y_pos, w_trade, row_h, SE_c_gray, clrWhite);
      SE_DrawTableCornerCell("lg_r" + IntegerToString(r) + "_2", dir, x_dir, y_pos, w_dir, row_h, SE_c_gray, clrWhite);
      SE_DrawTableCornerCell("lg_r" + IntegerToString(r) + "_3", DoubleToString(HistoryDealGetDouble(ticket, DEAL_PRICE), 5), x_entry, y_pos, w_entry, row_h, SE_c_gray, clrWhite);
      SE_DrawTableCornerCell("lg_r" + IntegerToString(r) + "_4", pnl_s, x_pnl, y_pos, w_pnl, row_h, pnl_col, clrWhite);
      printed++;
   }

   while(printed < 4)
   {
      int r = printed + 1;
      int y_pos = start_y + (r * row_h);
      SE_DrawTableCornerCell("lg_r" + IntegerToString(r) + "_1", "-", x_trade, y_pos, w_trade, row_h, SE_c_gray, clrWhite);
      SE_DrawTableCornerCell("lg_r" + IntegerToString(r) + "_2", "-", x_dir,   y_pos, w_dir,   row_h, SE_c_gray, clrWhite);
      SE_DrawTableCornerCell("lg_r" + IntegerToString(r) + "_3", "-", x_entry, y_pos, w_entry, row_h, SE_c_gray, clrWhite);
      SE_DrawTableCornerCell("lg_r" + IntegerToString(r) + "_4", "-", x_pnl,   y_pos, w_pnl,   row_h, SE_c_gray, clrWhite);
      printed++;
   }

   int w_tot = w_trade + w_dir + w_entry;
   SE_DrawTableCornerCell("lg_tot1", "TOTAL NET PROFIT:", x_entry, start_y + (5 * row_h), w_tot, row_h, clrWhite, clrBlack);
   SE_DrawTableCornerCell("lg_tot2", (net_prof >= 0 ? "+$" : "-$") + DoubleToString(MathAbs(net_prof), 2),
      x_pnl, start_y + (5 * row_h), w_pnl, row_h, (net_prof >= 0) ? SE_c_green : SE_c_red, clrWhite);
}

//==========================================================================
// SECTION H — TICK-LEVEL REDRAW GATE + CLEANUP
//==========================================================================

// Call at start of OnTimer to reset dirty flag; call ChartRedraw() if it's true after all draws.
void SE_BeginFrame()  { se_ui_needs_redraw = false; }
bool SE_NeedsRedraw() { return se_ui_needs_redraw; }

// Called from OnDeinit to remove all chart objects created by this module
void SE_CleanupObjects()
{
   ObjectsDeleteAll(0, "IFX_");
   ObjectsDeleteAll(0, "HUD_");
   ObjectsDeleteAll(0, "LDG_");
}

#endif // IFX_STRUCTURE_ENGINE_MQH
//+------------------------------------------------------------------+
