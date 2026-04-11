param(
    [int]$Port = 5000,
    [string]$VenvPath = ".venv-no-docker"
)

$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

if (-not (Test-Path $VenvPath)) {
    python -m venv $VenvPath
}

$pythonExe = Join-Path $PSScriptRoot "$VenvPath\Scripts\python.exe"
$readyMarker = Join-Path $PSScriptRoot "$VenvPath\.ifx_no_docker_ready"

if (-not (Test-Path $readyMarker)) {
    & $pythonExe -m pip install --upgrade pip
    & $pythonExe -m pip install -r requirements.txt
    & $pythonExe -m pip install fastapi "uvicorn[standard]" aiohttp redis pydantic
    New-Item -ItemType File -Path $readyMarker -Force | Out-Null
}

$env:CONTROL_PLANE_PORT = "$Port"

Write-Host "Starting IFX control plane on port $Port ..." -ForegroundColor Cyan
& $pythonExe -m uvicorn runtime.control_plane:app --host 0.0.0.0 --port $Port