$terminalDir = 'C:\mt5system\terminals\final-clean-manual'
$terminalExe = Join-Path $terminalDir 'terminal64.exe'

Get-Process terminal64 -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -eq $terminalExe } |
  Stop-Process -Force -ErrorAction SilentlyContinue

Start-Process -FilePath $terminalExe -ArgumentList '/portable' -WorkingDirectory $terminalDir
