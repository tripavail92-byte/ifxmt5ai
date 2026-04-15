//+------------------------------------------------------------------+
//|                                          IFX_Scratch_Probe_v1.mq5 |
//| Minimal probe EA: only Print() and FileWrite() from OnInit().    |
//+------------------------------------------------------------------+
#property strict

input string BackendRelayUrl = "https://ifx-mt5-portal-production.up.railway.app/api/mt5";
input string ConnectionId = "";
input string SigningSecret = "";
input bool   EnableLocalFractalSignals = true;
input int    StructurePivotWindow = 2;
input int    StructureBarsToScan = 120;
input bool   LogFractalSignals = true;

int OnInit()
{
   int handle = FileOpen("scratch_probe.txt", FILE_READ | FILE_WRITE | FILE_TXT | FILE_ANSI, 0, CP_UTF8);
   if(handle == INVALID_HANDLE)
      handle = FileOpen("scratch_probe.txt", FILE_WRITE | FILE_TXT | FILE_ANSI, 0, CP_UTF8);

   if(handle != INVALID_HANDLE)
   {
      FileSeek(handle, 0, SEEK_END);
      FileWriteString(handle,
                      TimeToString(TimeLocal(), TIME_DATE | TIME_SECONDS)
                      + " | scratch probe OnInit symbol=" + _Symbol
                      + " connection=" + ConnectionId + "\r\n");
      FileClose(handle);
   }

   Print("[SCRATCH_PROBE] OnInit symbol=", _Symbol,
         " connected=", (int)TerminalInfoInteger(TERMINAL_CONNECTED),
         " login=", (int)AccountInfoInteger(ACCOUNT_LOGIN),
         " connection=", ConnectionId,
         " file_ok=", handle != INVALID_HANDLE);
   return INIT_SUCCEEDED;
}

void OnTick()
{
}

void OnTimer()
{
}

void OnDeinit(const int reason)
{
   Print("[SCRATCH_PROBE] OnDeinit reason=", reason, " symbol=", _Symbol);
}