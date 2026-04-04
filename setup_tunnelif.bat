@echo off
REM Use existing named tunnel 'tunnelif'

setlocal enabledelayedexpansion

cd /d C:\mt5system

echo ========================================
echo Setting up existing tunnel: tunnelif
echo ========================================

REM Load API token from .env
for /f "usebackq tokens=2 delims==" %%a in (`findstr "CLOUDFLARE_API_TOKEN" .env`) do (
    set "CLOUDFLARE_API_TOKEN=%%a"
)

echo.
echo 1. Stopping old cloudflared processes...
taskkill /IM cloudflared.exe /F >nul 2>&1
timeout /t 2 /nobreak >nul

echo.
echo 2. Getting tunnel credentials for 'tunnelif'...
.\cloudflared.exe tunnel list

echo.
echo 3. Creating tunnel config file...
if not exist "%USERPROFILE%\.cloudflared\" mkdir "%USERPROFILE%\.cloudflared"

(
    echo tunnel: tunnelif
    echo credentials-file: %USERPROFILE%\.cloudflared\tunnelif.json
    echo.
    echo ingress:
    echo   - hostname: api.myifxacademy.com
    echo     service: http://localhost:8082
    echo   - service: http_status:404
) > "%USERPROFILE%\.cloudflared\config.yml"

echo Config created at: %USERPROFILE%\.cloudflared\config.yml

echo.
echo 4. Listing configured tunnels...
.\cloudflared.exe tunnel list | findstr "tunnelif"

echo.
echo ========================================
echo ✓ Ready to start named tunnel 'tunnelif'
echo ========================================
echo.
echo To start the tunnel permanently, run:
echo   .\cloudflared.exe tunnel run tunnelif
echo.
pause
