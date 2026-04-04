@echo off
REM Create permanent Cloudflare tunnel with API token

setlocal enabledelayedexpansion

cd /d C:\mt5system

REM Load API token from .env
for /f "usebackq tokens=2 delims==" %%a in (`findstr "CLOUDFLARE_API_TOKEN" .env`) do (
    set "CLOUDFLARE_API_TOKEN=%%a"
)

echo API Token loaded
echo.

echo Killing old cloudflared...
taskkill /IM cloudflared.exe /F >nul 2>&1
timeout /t 2 /nobreak >nul

echo.
echo Creating permanent tunnel 'ifx-trading'...
echo (Authenticating with your Cloudflare account)
echo.

REM Try to create the tunnel
cloudflared.exe tunnel create ifx-trading

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ✓✓✓ TUNNEL CREATED SUCCESSFULLY! ✓✓✓
    echo.
    timeout /t 3 /nobreak
    
    echo.
    echo Listing tunnels:
    cloudflared.exe tunnel list
    
    echo.
    echo Checking credentials folder:
    dir "%USERPROFILE%\.cloudflared\" /b
    
) else (
    echo.
    echo ✗ Error creating tunnel
    echo.
)

pause
