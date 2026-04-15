$terminalDir = 'C:\mt5system\terminals\final-clean-manual'
$terminalExe = Join-Path $terminalDir 'terminal64.exe'
$startupIni = Join-Path $terminalDir 'startup_first_run.ini'

@'
[Common]
Login=260437559
Password=Awais123!!
Server=Exness-MT5Trial15
KeepPrivate=1

[Charts]
ProfileLast=Default
'@ | Set-Content -Path $startupIni -Encoding UTF8

Get-Process terminal64 -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -eq $terminalExe } |
  Stop-Process -Force -ErrorAction SilentlyContinue

Start-Process -FilePath $terminalExe -ArgumentList '/portable', "/config:$startupIni" -WorkingDirectory $terminalDir
