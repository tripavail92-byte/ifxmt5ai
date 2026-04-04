@echo off
REM Setup Permanent Cloudflare Tunnel for IFX Trading
REM This script creates a named tunnel with fixed DNS and persistent credentials

SETLOCAL ENABLEDELAYEDEXPANSION

echo ======================================
echo Permanent Cloudflare Tunnel Setup
echo ======================================

REM Kill any existing cloudflared processes
echo.
echo 1. Stopping existing cloudflared processes...
taskkill /IM cloudflared.exe /F >nul 2>&1
timeout /t 2 /nobreak >nul

REM Create the named tunnel
echo.
echo 2. Creating permanent tunnel 'ifx-trading'...
cd /d C:\mt5system
cloudflared tunnel create ifx-trading --output %USERPROFILE%\.cloudflared\ifx-trading.json

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ERROR: Failed to create tunnel. Check your CLOUDFLARE_API_TOKEN
    pause
    exit /b 1
)

REM Create config file for the tunnel
echo.
echo 3. Creating tunnel configuration...

if not exist "%USERPROFILE%\.cloudflared\" mkdir "%USERPROFILE%\.cloudflared"

(
    echo tunnel: ifx-trading
    echo credentials-file: %USERPROFILE%\.cloudflared\ifx-trading.json
    echo.
    echo ingress:
    echo   - hostname: api.myifxacademy.com
    echo     service: http://localhost:8082
    echo   - service: http_status:404
) > "%USERPROFILE%\.cloudflared\config.yml"

echo Config file created

REM Display tunnel info
echo.
echo 4. Tunnel Information:
cloudflared tunnel list

REM Display the DNS name
echo.
echo 5. Getting tunnel DNS name...
for /f "tokens=*" %%a in ('cloudflared tunnel list ^| findstr "ifx-trading"') do (
    echo %%a
)

REM Create the authentication token on Cloudflare (optional - for automated setup)
echo.
echo 6. Setting up DNS routing...
REM This would typically be done via Cloudflare API, but for now we note the tunnel ID

echo.
echo ==================================
echo ✓ Permanent Tunnel Created!
echo ==================================
echo.
echo Tunnel Name: ifx-trading
echo Credentials: %USERPROFILE%\.cloudflared\ifx-trading.json
echo Config: %USERPROFILE%\.cloudflared\config.yml
echo.
echo Next steps:
echo 1. Run: cloudflared tunnel route dns ifx-trading api.myifxacademy.com
echo 2. Update Railway env vars with the permanent URL
echo 3. Run: cloudflared tunnel run ifx-trading
echo.
pause
