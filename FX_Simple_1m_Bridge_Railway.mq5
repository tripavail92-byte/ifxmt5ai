#property strict
#property version   "2.0"
#property description "Dynamic 1M Candle Bridge - Monitors symbols based on LIVE setups (Railway)"

//====================== INPUTS ======================
input string ConnectionId = "2c412421-13a7-4c4f-bfae-6caa98e1aebd";
input string SigningSecret = "d72fc15ed048bb68f3c9a5e3ef6338dbbf3d6d21d2b763b0b1c75aee1d561165";
input string BackendUrl = "https://backend-production-39a3.up.railway.app/api/v1";
input int CheckIntervalSeconds = 5;  // How often to check for candle closes
input int PriceBroadcastSeconds = 2;  // How often to send price updates
input int SymbolUpdateIntervalSeconds = 60;  // How often to refresh monitored symbols from backend

//====================== GLOBALS ======================
// Symbols to broadcast prices for (all symbols frontend needs)
string g_priceSymbols[] = {"EURUSDm", "USDJPYm", "USDCADm", "NZDUSDm", "GBPUSDm", "XAUUSDm", "USDCHFm", "USOILm", "BTCUSDm", "ETHUSDm", "AUDUSDm", "EURGBPm"};

// Dynamic candle monitoring - updated from backend based on LIVE setups
string g_monitoredSymbols[];  // Symbols to monitor for candles (dynamic)
datetime g_lastCandleCheck[];  // Last candle time for each monitored symbol
datetime g_lastSymbolUpdate = 0;  // Last time we updated monitored symbols
datetime g_lastPriceBroadcast = 0;
bool g_useFallbackSymbols = true;  // Use fallback if backend fails

//====================== INIT ======================
int OnInit()
{
   Print("=== Dynamic 1M Candle Bridge v2.0 (Railway) ===");
   Print("Backend: ", BackendUrl);
   Print("Update interval: ", SymbolUpdateIntervalSeconds, " seconds");
   
   // Initialize with fallback symbols (all price symbols)
   InitializeFallbackSymbols();
   
   // Try to fetch monitored symbols from backend immediately
   UpdateMonitoredSymbols();
   
   // Set timer (in seconds, not milliseconds)
   EventSetTimer(CheckIntervalSeconds);
   
   Print("✅ Initialized. Monitoring ", ArraySize(g_monitoredSymbols), " symbols");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   Comment("");
}

void InitializeFallbackSymbols()
{
   // Use all price symbols as fallback
   ArrayResize(g_monitoredSymbols, ArraySize(g_priceSymbols));
   ArrayResize(g_lastCandleCheck, ArraySize(g_priceSymbols));
   
   for(int i = 0; i < ArraySize(g_priceSymbols); i++)
   {
      g_monitoredSymbols[i] = g_priceSymbols[i];
      g_lastCandleCheck[i] = 0;
      
      // Ensure symbol is in Market Watch
      SymbolSelect(g_monitoredSymbols[i], true);
   }
   
   Print("✅ Initialized with ", ArraySize(g_monitoredSymbols), " fallback symbols");
}

//====================== TIMER ======================
void OnTimer()
{
   datetime now = TimeCurrent();
   
   // Update monitored symbols from backend periodically
   if(now - g_lastSymbolUpdate >= SymbolUpdateIntervalSeconds)
   {
      UpdateMonitoredSymbols();
      g_lastSymbolUpdate = now;
   }
   
   // Check all monitored symbols for candle closes (BATCHED)
   string symbolsToSend[];
   ArrayResize(symbolsToSend, 0);
   for(int i = 0; i < ArraySize(g_monitoredSymbols); i++)
   {
      if(CheckForNewCandle(g_monitoredSymbols[i], g_lastCandleCheck[i]))
      {
         int n = ArraySize(symbolsToSend);
         ArrayResize(symbolsToSend, n + 1);
         symbolsToSend[n] = g_monitoredSymbols[i];
      }
   }
   if(ArraySize(symbolsToSend) > 0)
   {
      if(SendCandlesBatch(symbolsToSend, 2))
      {
         Print("✅ [CANDLES] Batch sent ", ArraySize(symbolsToSend), " symbols");
      }
      else
      {
         Print("⚠️ [CANDLES] Batch failed, falling back to per-symbol");
         for(int j = 0; j < ArraySize(symbolsToSend); j++)
         {
            if(SendCandles(symbolsToSend[j], 2))
               Print("✅ [", symbolsToSend[j], "] Sent 2 candles to backend");
            else
               Print("❌ [", symbolsToSend[j], "] Failed to send candles");
         }
      }
   }
   
   // Broadcast prices at configured interval
   if(now - g_lastPriceBroadcast >= PriceBroadcastSeconds)
   {
      SendPrices();
      g_lastPriceBroadcast = now;
   }
   
   UpdateComment();
}

//====================== SYMBOL MANAGEMENT ======================
void UpdateMonitoredSymbols()
{
   // Fetch monitored symbols from backend
   string url = BackendUrl + "/mt5/monitored-symbols";
   
   uchar result[];
   string resultHeaders = "";
   uchar emptyData[];
   ArrayResize(emptyData, 0);
   
   ResetLastError();
   int httpStatus = WebRequest("GET", url, "", 5000, emptyData, result, resultHeaders);
   
   if(httpStatus != 200)
   {
      int err = GetLastError();
      if(!g_useFallbackSymbols)
      {
         Print("⚠️ [SYMBOLS] Failed to fetch monitored symbols (HTTP ", httpStatus, ", error=", err, "), using fallback");
         InitializeFallbackSymbols();
         g_useFallbackSymbols = true;
      }
      return;
   }
   
   // Parse JSON response
   string response = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   
   // Extract symbols array from JSON (simple parsing)
   int symbolsPos = StringFind(response, "\"symbols\":");
   if(symbolsPos < 0)
   {
      Print("⚠️ [SYMBOLS] Invalid response format, using fallback");
      if(!g_useFallbackSymbols)
      {
         InitializeFallbackSymbols();
         g_useFallbackSymbols = true;
      }
      return;
   }
   
   // Find the array content between [ and ]
   int arrayStart = StringFind(response, "[", symbolsPos);
   int arrayEnd = StringFind(response, "]", arrayStart);
   
   if(arrayStart < 0 || arrayEnd < 0)
   {
      Print("⚠️ [SYMBOLS] Cannot parse symbols array, using fallback");
      if(!g_useFallbackSymbols)
      {
         InitializeFallbackSymbols();
         g_useFallbackSymbols = true;
      }
      return;
   }
   
   string arrayContent = StringSubstr(response, arrayStart + 1, arrayEnd - arrayStart - 1);
   
   // Extract symbol count from JSON
   int countPos = StringFind(response, "\"count\":");
   int liveSetupsPos = StringFind(response, "\"live_setups\":");
   int symbolCount = 0;
   int liveSetups = 0;
   
   if(countPos > 0)
   {
      string countStr = StringSubstr(response, countPos + 8, 10);
      int commaPos = StringFind(countStr, ",");
      if(commaPos > 0)
         countStr = StringSubstr(countStr, 0, commaPos);
      symbolCount = (int)StringToInteger(countStr);
   }
   
   if(liveSetupsPos > 0)
   {
      string setupsStr = StringSubstr(response, liveSetupsPos + 15, 10);
      int bracePos = StringFind(setupsStr, "}");
      if(bracePos > 0)
         setupsStr = StringSubstr(setupsStr, 0, bracePos);
      liveSetups = (int)StringToInteger(setupsStr);
   }
   
   // If no LIVE setups, use fallback
   if(symbolCount == 0 || liveSetups == 0)
   {
      Print("ℹ️ [SYMBOLS] No LIVE setups found, using fallback (all price symbols)");
      if(!g_useFallbackSymbols)
      {
         InitializeFallbackSymbols();
         g_useFallbackSymbols = true;
      }
      return;
   }
   
   // Parse symbols from array (simple split by comma)
   string newSymbols[];
   int newSymbolCount = 0;
   
   // Remove quotes and spaces, split by comma
   string cleaned = arrayContent;
   StringReplace(cleaned, "\"", "");
   StringReplace(cleaned, " ", "");
   
   // Split by comma
   while(true)
   {
      int commaPos = StringFind(cleaned, ",");
      if(commaPos < 0)
      {
         // Last symbol
         if(StringLen(cleaned) > 0)
         {
            ArrayResize(newSymbols, newSymbolCount + 1);
            newSymbols[newSymbolCount] = cleaned;
            newSymbolCount++;
         }
         break;
      }
      
      string sym = StringSubstr(cleaned, 0, commaPos);
      if(StringLen(sym) > 0)
      {
         ArrayResize(newSymbols, newSymbolCount + 1);
         newSymbols[newSymbolCount] = sym;
         newSymbolCount++;
      }
      
      cleaned = StringSubstr(cleaned, commaPos + 1);
   }
   
   if(newSymbolCount == 0)
   {
      Print("⚠️ [SYMBOLS] Parsed 0 symbols, using fallback");
      if(!g_useFallbackSymbols)
      {
         InitializeFallbackSymbols();
         g_useFallbackSymbols = true;
      }
      return;
   }
   
   // Update monitored symbols
   ArrayResize(g_monitoredSymbols, newSymbolCount);
   ArrayResize(g_lastCandleCheck, newSymbolCount);
   
   for(int i = 0; i < newSymbolCount; i++)
   {
      // If this is a new symbol, initialize its last check time
      bool isNew = true;
      for(int j = 0; j < ArraySize(g_monitoredSymbols); j++)
      {
         if(g_monitoredSymbols[j] == newSymbols[i])
         {
            isNew = false;
            break;
         }
      }
      
      g_monitoredSymbols[i] = newSymbols[i];
      
      if(isNew)
         g_lastCandleCheck[i] = 0;  // Reset for new symbols
      
      // Ensure symbol is in Market Watch
      SymbolSelect(g_monitoredSymbols[i], true);
   }
   
   g_useFallbackSymbols = false;
   Print("✅ [SYMBOLS] Updated: monitoring ", newSymbolCount, " symbols for ", liveSetups, " LIVE setups");
   
   // Print monitored symbols
   string symbolList = "";
   for(int i = 0; i < ArraySize(g_monitoredSymbols); i++)
   {
      if(i > 0) symbolList += ", ";
      symbolList += g_monitoredSymbols[i];
   }
   Print("   Symbols: ", symbolList);
}

//====================== CORE LOGIC ======================
bool CheckForNewCandle(const string symbol, datetime &lastCheck)
{
   // Get current M1 bar time using iTime
   ResetLastError();
   datetime currentBarTime = iTime(symbol, PERIOD_M1, 0);
   int err = GetLastError();
   
   // If the series isn't loaded/synced yet, iTime can return 0 or a very old bar.
   // Kick the series by calling CopyRates and use the returned bar time.
   if(currentBarTime == 0)
   {
      MqlRates warmup[];
      ArraySetAsSeries(warmup, true);
      ResetLastError();
      int copied = CopyRates(symbol, PERIOD_M1, 0, 2, warmup);
      int copyErr = GetLastError();
      if(copied > 0)
         currentBarTime = warmup[0].time;
      else
      {
         Print("⚠️ [", symbol, "] iTime returned 0 and CopyRates failed, error=", err, ", copyErr=", copyErr);
         return false;
      }
   }
   
   // Check if bar is stale (more than 10 minutes old)
   datetime now = TimeCurrent();
   int ageSeconds = (int)(now - currentBarTime);
   
   if(ageSeconds > 600)  // 10 minutes
   {
      // Try to check series synchronization
      bool synced = (bool)SeriesInfoInteger(symbol, PERIOD_M1, SERIES_SYNCHRONIZED);
      long bars = SeriesInfoInteger(symbol, PERIOD_M1, SERIES_BARS_COUNT);
      
      // Attempt one refresh before giving up.
      MqlRates warmup[];
      ArraySetAsSeries(warmup, true);
      ResetLastError();
      int copied = CopyRates(symbol, PERIOD_M1, 0, 2, warmup);
      int copyErr = GetLastError();
      if(copied > 0)
      {
         currentBarTime = warmup[0].time;
         ageSeconds = (int)(now - currentBarTime);
      }

      if(ageSeconds > 600)
      {
         Print("⚠️ [", symbol, "] Bar is stale: current_bar=", TimeToString(currentBarTime),
               " now=", TimeToString(now), " age=", ageSeconds, "s synced=", synced,
               " bars=", bars, " copyErr=", copyErr);
      
         // Still update lastCheck to avoid spam, but don't send
         lastCheck = currentBarTime;
         return false;
      }
   }
   
   // First run - initialize
   if(lastCheck == 0)
   {
      Print("🟢 [", symbol, "] First check: current_bar=", TimeToString(currentBarTime), " age=", ageSeconds, "s");
      lastCheck = currentBarTime;
      return false;
   }
   
   // Check if we have a new candle (bar time changed)
   if(currentBarTime > lastCheck)
   {
      Print("🕐 [", symbol, "] NEW CANDLE DETECTED: last=", TimeToString(lastCheck), 
            " current=", TimeToString(currentBarTime));
      
      // Update last check
      lastCheck = currentBarTime;
      return true;
   }

   return false;
}

bool SendCandlesBatch(const string &symbols[], int count)
{
   int symbolCount = ArraySize(symbols);
   if(symbolCount <= 0)
      return false;

   // Build JSON payload
   string json = "{";
   json += "\"connection_id\":\"" + ConnectionId + "\",";
   json += "\"timestamp\":" + IntegerToString((long)TimeGMT()) + ",";
   json += "\"candles\":[";

   int added = 0;
   for(int s = 0; s < symbolCount; s++)
   {
      string symbol = symbols[s];
      MqlRates rates[];
      ArraySetAsSeries(rates, true);

      ResetLastError();
      int copied = CopyRates(symbol, PERIOD_M1, 0, count, rates);
      int err = GetLastError();

      if(copied <= 0)
      {
         Print("❌ [", symbol, "] CopyRates failed (batch): error=", err);
         continue;
      }

      int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);

      if(added > 0)
         json += ",";

      json += "{";
      json += "\"symbol\":\"" + symbol + "\",";
      json += "\"timeframe\":\"1m\",";
      json += "\"candles\":[";

      for(int i = 0; i < copied; i++)
      {
         if(i > 0) json += ",";

         json += "{";
         json += "\"time\":" + IntegerToString((long)rates[i].time) + ",";
         json += "\"open\":" + DoubleToString(rates[i].open, digits) + ",";
         json += "\"high\":" + DoubleToString(rates[i].high, digits) + ",";
         json += "\"low\":" + DoubleToString(rates[i].low, digits) + ",";
         json += "\"close\":" + DoubleToString(rates[i].close, digits) + ",";
         json += "\"tick_volume\":" + IntegerToString(rates[i].tick_volume) + ",";
         json += "\"real_volume\":" + IntegerToString(rates[i].real_volume);
         json += "}";
      }

      json += "]}";
      added++;
   }

   json += "]}";

   if(added <= 0)
      return false;

   // Send to backend
   string url = BackendUrl + "/mt5/historical-candles/batch";

   // Build HMAC signature
   string ts = IntegerToString((long)TimeGMT() * 1000);
   string nonce = IntegerToString((long)GetTickCount64());
   string path = "/api/v1/mt5/historical-candles/batch";

   string bodyHash = Sha256Hex(json);
   string stringToSign = "POST\n" + path + "\n" + ts + "\n" + nonce + "\n" + bodyHash;
   string signature = HmacSha256Hex(SigningSecret, stringToSign);

   string headers = "Content-Type: application/json\r\n";
   headers += "X-IFX-CONN-ID: " + ConnectionId + "\r\n";
   headers += "X-IFX-TS: " + ts + "\r\n";
   headers += "X-IFX-NONCE: " + nonce + "\r\n";
   headers += "X-IFX-SIGNATURE: " + signature + "\r\n";

   uchar post[];
   StringToCharArray(json, post, 0, WHOLE_ARRAY, CP_UTF8);
   if(ArraySize(post) > 0)
      ArrayResize(post, ArraySize(post) - 1);

   uchar result[];
   string resultHeaders = "";

   ResetLastError();
   int httpStatus = WebRequest("POST", url, headers, 5000, post, result, resultHeaders);

   if(httpStatus >= 200 && httpStatus < 300)
      return true;

   string response = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   Print("❌ [CANDLES-BATCH] HTTP ", httpStatus, ": ", response);
   return false;
}

bool SendCandles(const string symbol, int count)
{
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   
   ResetLastError();
   int copied = CopyRates(symbol, PERIOD_M1, 0, count, rates);
   int err = GetLastError();
   
   if(copied <= 0)
   {
      Print("❌ [", symbol, "] CopyRates failed: error=", err);
      return false;
   }
   
   // Build JSON payload
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   
   string json = "{";
   json += "\"connection_id\":\"" + ConnectionId + "\",";
   json += "\"symbol\":\"" + symbol + "\",";
   json += "\"timeframe\":\"1m\",";
   json += "\"count\":" + IntegerToString(copied) + ",";
   json += "\"candles\":[";
   
   for(int i = 0; i < copied; i++)
   {
      if(i > 0) json += ",";
      
      json += "{";
      json += "\"time\":" + IntegerToString((long)rates[i].time) + ",";
      json += "\"open\":" + DoubleToString(rates[i].open, digits) + ",";
      json += "\"high\":" + DoubleToString(rates[i].high, digits) + ",";
      json += "\"low\":" + DoubleToString(rates[i].low, digits) + ",";
      json += "\"close\":" + DoubleToString(rates[i].close, digits) + ",";
      json += "\"tick_volume\":" + IntegerToString(rates[i].tick_volume) + ",";
      json += "\"real_volume\":" + IntegerToString(rates[i].real_volume);
      json += "}";
   }
   
   json += "]}";
   
   // Send to backend
   string url = BackendUrl + "/mt5/historical-candles";
   
   // Build HMAC signature
   string ts = IntegerToString((long)TimeGMT() * 1000);
   string nonce = IntegerToString((long)GetTickCount64());
   string path = "/api/v1/mt5/historical-candles";
   
   string bodyHash = Sha256Hex(json);
   string stringToSign = "POST\n" + path + "\n" + ts + "\n" + nonce + "\n" + bodyHash;
   string signature = HmacSha256Hex(SigningSecret, stringToSign);
   
   string headers = "Content-Type: application/json\r\n";
   headers += "X-IFX-CONN-ID: " + ConnectionId + "\r\n";
   headers += "X-IFX-TS: " + ts + "\r\n";
   headers += "X-IFX-NONCE: " + nonce + "\r\n";
   headers += "X-IFX-SIGNATURE: " + signature + "\r\n";
   
   uchar post[];
   StringToCharArray(json, post, 0, WHOLE_ARRAY, CP_UTF8);
   if(ArraySize(post) > 0)
      ArrayResize(post, ArraySize(post) - 1);
   
   uchar result[];
   string resultHeaders = "";
   
   ResetLastError();
   int httpStatus = WebRequest("POST", url, headers, 5000, post, result, resultHeaders);
   
   if(httpStatus >= 200 && httpStatus < 300)
      return true;
   
   string response = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   Print("❌ HTTP ", httpStatus, ": ", response);
   return false;
}

bool SendPrices()
{
   // Build price snapshot JSON with all symbols
   string json = "{";
   json += "\"connection_id\":\"" + ConnectionId + "\",";
   json += "\"timestamp\":" + IntegerToString((long)TimeGMT()) + ",";
   json += "\"symbols\":[";
   
   int validCount = 0;
   int totalSymbols = ArraySize(g_priceSymbols);
   
   for(int i = 0; i < totalSymbols; i++)
   {
      string symbol = g_priceSymbols[i];
      MqlTick tick;
      
      // Try to get tick data for this symbol
      if(!SymbolInfoTick(symbol, tick))
         continue;  // Skip symbols without data
      
      if(tick.bid <= 0 || tick.ask <= 0)
         continue;  // Skip invalid prices
      
      int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
      
      // Add comma between symbols
      if(validCount > 0)
         json += ",";
      
      json += "{";
      json += "\"symbol\":\"" + symbol + "\",";
      json += "\"bid\":" + DoubleToString(tick.bid, digits) + ",";
      json += "\"ask\":" + DoubleToString(tick.ask, digits);
      json += "}";
      
      validCount++;
   }
   
   json += "]}";
   
   if(validCount == 0)
   {
      Print("⚠️ [PRICES] No valid prices available");
      return false;
   }
   
   // Send to backend
   string url = BackendUrl + "/mt5/price-snapshot";
   
   // Build HMAC signature
   string ts = IntegerToString((long)TimeGMT() * 1000);
   string nonce = IntegerToString((long)GetTickCount64());
   string path = "/api/v1/mt5/price-snapshot";
   
   string bodyHash = Sha256Hex(json);
   string stringToSign = "POST\n" + path + "\n" + ts + "\n" + nonce + "\n" + bodyHash;
   string signature = HmacSha256Hex(SigningSecret, stringToSign);
   
   string headers = "Content-Type: application/json\r\n";
   headers += "X-IFX-CONN-ID: " + ConnectionId + "\r\n";
   headers += "X-IFX-TS: " + ts + "\r\n";
   headers += "X-IFX-NONCE: " + nonce + "\r\n";
   headers += "X-IFX-SIGNATURE: " + signature + "\r\n";
   
   uchar post[];
   StringToCharArray(json, post, 0, WHOLE_ARRAY, CP_UTF8);
   if(ArraySize(post) > 0)
      ArrayResize(post, ArraySize(post) - 1);
   
   uchar result[];
   string resultHeaders = "";
   
   ResetLastError();
   int httpStatus = WebRequest("POST", url, headers, 5000, post, result, resultHeaders);
   
   if(httpStatus >= 200 && httpStatus < 300)
   {
      static int broadcastCount = 0;
      broadcastCount++;
      // Log every 10th broadcast to avoid spam
      if(broadcastCount % 10 == 0)
         Print("💰 [PRICES] Broadcast #", broadcastCount, ": ", validCount, " symbols");
      return true;
   }
   
   string response = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   Print("❌ [PRICES] HTTP ", httpStatus, ": ", response);
   return false;
}

void UpdateComment()
{
   string msg = "Dynamic 1M Bridge v2.0 (Railway)\n";
   msg += "Checking every " + IntegerToString(CheckIntervalSeconds) + " seconds\n";
   msg += "Monitoring " + IntegerToString(ArraySize(g_monitoredSymbols)) + " symbols";
   if(g_useFallbackSymbols)
      msg += " (FALLBACK)";
   msg += "\n\n";
   
   datetime now = TimeCurrent();
   
   // Show status for monitored symbols (limit to first 5 to avoid clutter)
   int displayCount = (int)MathMin(5, ArraySize(g_monitoredSymbols));
   for(int i = 0; i < displayCount; i++)
   {
      datetime barTime = iTime(g_monitoredSymbols[i], PERIOD_M1, 0);
      int age = barTime > 0 ? (int)(now - barTime) : -1;
      
      msg += g_monitoredSymbols[i] + ": ";
      if(barTime > 0)
         msg += "age=" + IntegerToString(age) + "s";
      else
         msg += "NO DATA";
      msg += "\n";
   }
   
   if(ArraySize(g_monitoredSymbols) > 5)
      msg += "... +" + IntegerToString(ArraySize(g_monitoredSymbols) - 5) + " more\n";
   
   Comment(msg);
}

//====================== CRYPTO HELPERS ======================
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
      uchar k = 0;
      if(i < ArraySize(key))
         k = key[i];
      ipad[i] = (uchar)(k ^ 0x36);
      opad[i] = (uchar)(k ^ 0x5C);
   }

   uchar msg[];
   StringToCharArray(message, msg, 0, WHOLE_ARRAY, CP_UTF8);
   if(ArraySize(msg) > 0)
      ArrayResize(msg, ArraySize(msg) - 1);

   uchar inner[];
   ArrayResize(inner, 64 + ArraySize(msg));
   for(int i = 0; i < 64; i++)
      inner[i] = ipad[i];
   for(int i = 0; i < ArraySize(msg); i++)
      inner[64 + i] = msg[i];

   uchar innerHash[];
   if(CryptEncode(CRYPT_HASH_SHA256, inner, emptyKey, innerHash) <= 0)
      return "";

   uchar outer[];
   ArrayResize(outer, 64 + ArraySize(innerHash));
   for(int i = 0; i < 64; i++)
      outer[i] = opad[i];
   for(int i = 0; i < ArraySize(innerHash); i++)
      outer[64 + i] = innerHash[i];

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
