$terminalDir = 'C:\mt5system\terminals\final-clean-manual'
$terminalExe = Join-Path $terminalDir 'terminal64.exe'
$startupIni = Join-Path $terminalDir 'startup_reenable_ea.ini'

@'
[Common]
Login=260437559
Password=Awais123!!
Server=Exness-MT5Trial15
KeepPrivate=1

[Charts]
ProfileLast=Default

[Experts]
AllowLiveTrading=1
AllowDllImport=0
Enabled=1
Account=0
Profile=0

[StartUp]
Expert=IFX\IFX_Railway_Bridge_v1
ExpertParameters=ifx_connection.set
Symbol=EURUSDm
Period=M1
ShutdownTerminal=0
'@ | Set-Content -Path $startupIni -Encoding UTF8

Get-Process terminal64 -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -eq $terminalExe } |
  Stop-Process -Force -ErrorAction SilentlyContinue

Start-Process -FilePath $terminalExe -ArgumentList '/portable', "/config:$startupIni" -WorkingDirectory $terminalDir
