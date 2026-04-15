//+------------------------------------------------------------------+
//| IFX_Scratch_Flow_v1.mq5                                          |
//| Minimal scratch EA for control-plane flow validation             |
//+------------------------------------------------------------------+
#property strict
#property version   "0.1"
#property description "Minimal IFX scratch EA for register-only flow validation"

input string  BackendRelayUrl = "https://ifx-mt5-portal-production.up.railway.app/api/mt5";
input string  ConnectionId = "";
input string  SigningSecret = "";
input bool    EnableLocalFractalSignals = true;
input int     StructurePivotWindow = 2;
input int     StructureBarsToScan = 120;
input bool    LogFractalSignals = true;
string g_chart_status = "Scratch register not started";
string g_install_token = "";
string g_register_url = "";
int g_register_attempts = 0;
int g_last_register_http = -1;
int g_last_register_error = 0;
datetime g_last_attempt_at = 0;
bool g_runtime_armed = false;

void AppendScratchLogToPath(const string relative_path, const string message, const int flags)
{
   int handle = FileOpen(relative_path, flags | FILE_READ | FILE_WRITE | FILE_TXT | FILE_ANSI, 0, CP_UTF8);
   if(handle == INVALID_HANDLE)
      handle = FileOpen(relative_path, flags | FILE_WRITE | FILE_TXT | FILE_ANSI, 0, CP_UTF8);
   if(handle == INVALID_HANDLE)
      return;

   FileSeek(handle, 0, SEEK_END);
   FileWriteString(handle, TimeToString(TimeLocal(), TIME_DATE | TIME_SECONDS) + " | " + message + "\r\n");
   FileClose(handle);
}

void AppendScratchLog(const string message)
{
   AppendScratchLogToPath("scratch_flow.log", message, 0);
   AppendScratchLogToPath("scratch_flow_common.log", message, FILE_COMMON);
}

string TrimSpaces(const string text)
{
   string out = text;
   StringTrimLeft(out);
   StringTrimRight(out);
   return out;
}

string EscapeJson(const string text)
{
   string out = text;
   StringReplace(out, "\\", "\\\\");
   StringReplace(out, "\"", "\\\"");
   StringReplace(out, "\r", "\\r");
   StringReplace(out, "\n", "\\n");
   return out;
}

int FindMatchingJsonToken(const string json, const int start, const ushort open_ch, const ushort close_ch)
{
   int depth = 0;
   bool in_string = false;

   for(int i = start; i < StringLen(json); i++)
   {
      ushort ch = StringGetCharacter(json, i);
      if(ch == '"' && (i == 0 || StringGetCharacter(json, i - 1) != '\\'))
      {
         in_string = !in_string;
         continue;
      }
      if(in_string)
         continue;
      if(ch == open_ch)
         depth++;
      else if(ch == close_ch)
      {
         depth--;
         if(depth == 0)
            return i;
      }
   }

   return -1;
}

string JsonExtractStringAfter(const string json, const int from_pos, const string key)
{
   string marker = "\"" + key + "\"";
   int key_pos = StringFind(json, marker, from_pos);
   if(key_pos < 0)
      return "";

   int colon_pos = StringFind(json, ":", key_pos + StringLen(marker));
   if(colon_pos < 0)
      return "";

   int start = StringFind(json, "\"", colon_pos + 1);
   if(start < 0)
      return "";

   start++;
   string value = "";
   for(int i = start; i < StringLen(json); i++)
   {
      ushort ch = StringGetCharacter(json, i);
      if(ch == '"' && StringGetCharacter(json, i - 1) != '\\')
         return value;

      uchar c[] = {(uchar)ch};
      value += CharArrayToString(c);
   }

   return "";
}

string JsonExtractObjectAfter(const string json, const int from_pos, const string key)
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

string JsonExtractArrayAfter(const string json, const int from_pos, const string key)
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
      return "";

   return StringSubstr(json, start, finish - start + 1);
}

int JsonExtractIntAfter(const string json, const int from_pos, const string key, const int fallback)
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

   string digits = "";
   for(int i = start; i < StringLen(json); i++)
   {
      ushort ch = StringGetCharacter(json, i);
      if((ch >= '0' && ch <= '9') || ch == '-')
      {
         uchar c[] = {(uchar)ch};
         digits += CharArrayToString(c);
      }
      else if(StringLen(digits) > 0)
      {
         break;
      }
      else
      {
         break;
      }
   }

   if(StringLen(digits) == 0)
      return fallback;

   return (int)StringToInteger(digits);
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

bool LoadScratchBootstrap()
{
   string manifest = "";
   if(!ReadTextFileUtf8("ifx\\bootstrap.json", manifest))
      return false;

   int control_pos = StringFind(manifest, "\"control_plane\"");
   g_install_token = JsonExtractStringAfter(manifest, 0, "install_token");
   g_register_url = JsonExtractStringAfter(manifest, control_pos, "register_url");
   return (StringLen(g_install_token) > 0 && StringLen(g_register_url) > 0);
}

string ControlPlaneBaseUrl()
{
   string url = BackendRelayUrl;
   int api_pos = StringFind(url, "/api/mt5");
   if(api_pos >= 0)
      return StringSubstr(url, 0, api_pos);
   return url;
}

string BuildRegisterUrl()
{
   if(StringLen(g_register_url) > 0)
      return g_register_url;
   return ControlPlaneBaseUrl() + "/api/ea/register";
}

void RunRegisterProbe()
{
   g_register_attempts++;
   g_last_attempt_at = TimeLocal();
   string url = BuildRegisterUrl();
   string token = TrimSpaces(g_install_token);
   if(StringLen(token) == 0)
      token = TrimSpaces(SigningSecret);
   if(StringLen(ConnectionId) == 0 || StringLen(token) == 0)
   {
      g_last_register_http = -1;
      g_last_register_error = -1;
      g_chart_status = StringFormat("Scratch register\nAttempt: %d\nURL: %s\nERR: missing ConnectionId or SigningSecret", g_register_attempts, url);
      Comment(g_chart_status);
      AppendScratchLog("register skipped missing connection or token");
      return;
   }

   string account_login = IntegerToString((int)AccountInfoInteger(ACCOUNT_LOGIN));
   string terminal_path = EscapeJson(TerminalInfoString(TERMINAL_DATA_PATH));
   string body = "{";
   body += "\"connection_id\":\"" + EscapeJson(ConnectionId) + "\",";
   body += "\"terminal_path\":\"" + terminal_path + "\",";
   body += "\"ea_version\":\"scratch-register-0.1\",";
   body += "\"metadata\":{";
   body += "\"account_login\":\"" + EscapeJson(account_login) + "\",";
   body += "\"terminal_path\":\"" + terminal_path + "\"";
   body += "}}";

   string headers = "Content-Type: application/json\r\nX-IFX-INSTALL-TOKEN: " + token + "\r\n";
   uchar request_body[];
   StringToCharArray(body, request_body, 0, WHOLE_ARRAY, CP_UTF8);
   if(ArraySize(request_body) > 0)
      ArrayResize(request_body, ArraySize(request_body) - 1);
   uchar result[];
   string result_headers = "";

   ResetLastError();
   int status = WebRequest("POST", url, headers, 5000, request_body, result, result_headers);
   int err = GetLastError();
   g_last_register_http = status;
   g_last_register_error = err;
   string response = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   string snippet = response;
   StringReplace(snippet, "\r", " ");
   StringReplace(snippet, "\n", " ");
   if(StringLen(snippet) > 180)
      snippet = StringSubstr(snippet, 0, 180);

   g_chart_status = StringFormat("Scratch register\nAttempt: %d\nURL: %s\nHTTP: %d\nERR: %d\nBODY: %s", g_register_attempts, url, status, err, snippet);
   Comment(g_chart_status);
   AppendScratchLog("register status=" + IntegerToString(status) + " err=" + IntegerToString(err) + " url=" + url + " body=" + snippet);
}

int OnInit()
{
   LoadScratchBootstrap();
   g_chart_status = "Scratch register pending\nAttempt: 0\nURL: " + BuildRegisterUrl();
   Comment(g_chart_status);
   EventSetTimer(5);
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   AppendScratchLog("OnDeinit reason=" + IntegerToString(reason));
}

void OnTick()
{
   if(g_runtime_armed)
      return;

   g_runtime_armed = true;
   AppendScratchLog("OnTick armed url=" + BuildRegisterUrl());
   RunRegisterProbe();
}

void OnTimer()
{
   if(!g_runtime_armed)
      return;

   if(g_last_register_http == 200 && g_last_register_error == 0)
      return;

   RunRegisterProbe();
}