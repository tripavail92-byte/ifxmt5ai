Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$mutex = $null
foreach ($mutexName in @('Global\IFXRelayWatchdogLock', 'Local\IFXRelayWatchdogLock')) {
    try {
        $mutex = New-Object System.Threading.Mutex($false, $mutexName)
        break
    } catch {
    }
}

if ($null -ne $mutex) {
    if (-not $mutex.WaitOne(0)) {
        exit 0
    }
}

try {

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Log = Join-Path $Root 'logs\watchdog.log'
$RuntimeLogDir = Join-Path $Root 'runtime\logs'
$VenvPython = Join-Path $Root '.venv\Scripts\python.exe'
$MarketDataHealthUrl = 'http://127.0.0.1:8082/health'
$LogMaxBytes = 512000
$RelayHealthUrl = 'http://127.0.0.1:8083/health'
$RelayPublicHealthUrl = 'https://relay.myifxacademy.com/health'
$StartRelayScript = Join-Path $Root 'start_relay_agent.ps1'

function Write-Log {
    param([string]$Msg, [string]$Level = 'INFO')
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "$ts [$Level] $Msg"
    Add-Content -Path $Log -Value $line
    Write-Host $line
}

function Get-DotEnvValues {
    param([string]$Path)

    $values = @{}
    if (-not (Test-Path $Path)) {
        return $values
    }

    foreach ($line in Get-Content $Path) {
        if ($line -match '^\s*#' -or $line -notmatch '=') {
            continue
        }

        $parts = $line.Split('=', 2)
        if ($parts.Count -ne 2) {
            continue
        }

        $key = $parts[0].Trim()
        $value = $parts[1].Trim().Trim('"', "'")
        if ($key) {
            $values[$key] = $value
        }
    }

    return $values
}

function Get-RelayProcesses {
    Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
        Where-Object {
            $_.CommandLine -match 'new_price_relay_multitenant\.py'
        }
}

function Get-MarketDataProcesses {
    Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
        Where-Object {
            $_.CommandLine -match 'runtime\\price_relay\.py|price_relay\.py'
        }
}

function Get-RelayRoots {
    param([array]$Processes)

    $processIds = @($Processes | ForEach-Object { $_.ProcessId })
    return @(
        $Processes | Where-Object {
            $_.ParentProcessId -notin $processIds
        }
    )
}

function Stop-Processes {
    param(
        [array]$Processes,
        [string]$Reason
    )

    foreach ($proc in ($Processes | Sort-Object ProcessId -Unique)) {
        try {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
            Write-Log ("Stopped PID {0} ({1}) - {2}" -f $proc.ProcessId, $proc.Name, $Reason) 'WARN'
        } catch {
            Write-Log ("Failed stopping PID {0}: {1}" -f $proc.ProcessId, $_.Exception.Message) 'WARN'
        }
    }
}

function Test-RelayHealth {
    try {
        $resp = Invoke-RestMethod -Uri $RelayHealthUrl -TimeoutSec 5 -ErrorAction Stop
        return ($resp.status -eq 'healthy')
    } catch {
        return $false
    }
}

function Test-MarketDataHealth {
    try {
        $resp = Invoke-RestMethod -Uri $MarketDataHealthUrl -TimeoutSec 5 -ErrorAction Stop
        return (@('healthy', 'ok') -contains $resp.status)
    } catch {
        return $false
    }
}

function Test-PublicRelayHealth {
    try {
        $resp = Invoke-RestMethod -Uri $RelayPublicHealthUrl -TimeoutSec 10 -ErrorAction Stop
        return ($resp.status -eq 'healthy')
    } catch {
        return $false
    }
}

function Wait-RelayHealthy {
    param([int]$TimeoutSeconds = 30)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-RelayHealth) {
            return $true
        }
        Start-Sleep -Seconds 2
    }

    return $false
}

function Wait-MarketDataHealthy {
    param([int]$TimeoutSeconds = 30)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-MarketDataHealth) {
            return $true
        }
        Start-Sleep -Seconds 2
    }

    return $false
}

function Start-MarketDataRelay {
    if (-not (Test-Path $VenvPython)) {
        throw "Venv python not found: $VenvPython"
    }

    if (-not (Test-Path $RuntimeLogDir)) {
        New-Item -ItemType Directory -Path $RuntimeLogDir -Force | Out-Null
    }

    $stdoutLog = Join-Path $RuntimeLogDir 'watchdog_marketdata_stdout.log'
    $stderrLog = Join-Path $RuntimeLogDir 'watchdog_marketdata_stderr.log'

    Start-Process -FilePath $VenvPython `
        -WorkingDirectory $Root `
        -ArgumentList 'runtime\price_relay.py' `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutLog `
        -RedirectStandardError $stderrLog | Out-Null

    Write-Log 'Started local market-data relay process'
}

function Start-ManagedRelay {
    $envValues = Get-DotEnvValues -Path (Join-Path $Root '.env')
    $agentBaseUrl = if ($envValues.ContainsKey('AGENT_BASE_URL')) { $envValues['AGENT_BASE_URL'] } else { 'https://relay.myifxacademy.com' }
    $controlPlaneUrl = if ($envValues.ContainsKey('CONTROL_PLANE_URL')) { $envValues['CONTROL_PLANE_URL'] } else { 'https://ifx-control-plane-production.up.railway.app' }
    $redisUrl = if ($envValues.ContainsKey('REDIS_URL')) { $envValues['REDIS_URL'] } elseif ($envValues.ContainsKey('REDIS_PUBLIC_URL')) { $envValues['REDIS_PUBLIC_URL'] } else { '' }

    $args = @(
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Hidden',
        '-File', $StartRelayScript,
        '-AgentBaseUrl', $agentBaseUrl,
        '-ControlPlaneUrl', $controlPlaneUrl
    )

    if ($redisUrl) {
        $args += @('-RedisUrl', $redisUrl)
    }

    Start-Process powershell.exe -ArgumentList $args -WorkingDirectory $Root | Out-Null
    Write-Log "Started managed multitenant relay process"
}

$logDir = Split-Path $Log
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

if ((Test-Path $Log) -and (Get-Item $Log).Length -gt $LogMaxBytes) {
    Move-Item $Log "$Log.old" -Force
}

Write-Log '--- watchdog tick ---'

$allRelayProcesses = @(Get-RelayProcesses)
$marketDataProcesses = @(Get-MarketDataProcesses)
$marketDataRoots = @(Get-RelayRoots -Processes $marketDataProcesses)
$newRelayProcesses = @($allRelayProcesses | Where-Object { $_.CommandLine -match 'new_price_relay_multitenant\.py' })
$newRelayRoots = @(Get-RelayRoots -Processes $newRelayProcesses)

if ($marketDataRoots.Count -gt 1) {
    Stop-Processes -Processes $marketDataProcesses -Reason 'duplicate local market-data relay trees detected'
    Start-Sleep -Seconds 2
    $marketDataProcesses = @()
    $marketDataRoots = @()
}

if ($newRelayRoots.Count -gt 1) {
    Stop-Processes -Processes $newRelayProcesses -Reason 'duplicate multitenant relay trees detected'
    Start-Sleep -Seconds 2
    $newRelayProcesses = @()
    $newRelayRoots = @()
}

$marketDataOk = Test-MarketDataHealth
if (-not $marketDataOk) {
    if ($marketDataProcesses.Count -gt 0) {
        Stop-Processes -Processes $marketDataProcesses -Reason 'unhealthy local market-data relay'
        Start-Sleep -Seconds 2
    }

    Start-MarketDataRelay
    $marketDataOk = Wait-MarketDataHealthy -TimeoutSeconds 30
}

if ($marketDataOk) {
    Write-Log 'Local market-data relay OK on http://127.0.0.1:8082/health'
} else {
    Write-Log 'Local market-data relay failed health check after restart attempt' 'ERROR'
}

$relayOk = Test-RelayHealth
if (-not $relayOk) {
    if ($newRelayProcesses.Count -gt 0) {
        Stop-Processes -Processes $newRelayProcesses -Reason 'unhealthy multitenant relay'
        Start-Sleep -Seconds 2
    }

    Start-ManagedRelay
    $relayOk = Wait-RelayHealthy -TimeoutSeconds 30
}

if ($relayOk -and $marketDataOk) {
    Write-Log 'Relay OK on http://127.0.0.1:8083/health'
} elseif ($relayOk) {
    Write-Log 'Multitenant relay is up, but local market-data relay is unavailable' 'ERROR'
} else {
    Write-Log 'Relay failed health check after restart attempt' 'ERROR'
}

try {
    $cfService = Get-Service cloudflared -ErrorAction Stop
    if ($cfService.Status -ne 'Running') {
        Start-Service cloudflared -ErrorAction Stop
        Write-Log 'Started cloudflared service'
        Start-Sleep -Seconds 5
    }
} catch {
    Write-Log ("Cloudflared service check failed: {0}" -f $_.Exception.Message) 'WARN'
}

if ($relayOk -and $marketDataOk) {
    $publicRelayOk = Test-PublicRelayHealth
    if ($publicRelayOk) {
        Write-Log 'Public relay HTTPS OK on https://relay.myifxacademy.com/health'
    } else {
        Write-Log 'Public relay HTTPS failed; restarting cloudflared service' 'WARN'
        try {
            Restart-Service cloudflared -Force -ErrorAction Stop
            Start-Sleep -Seconds 8
            if (Test-PublicRelayHealth) {
                Write-Log 'Public relay HTTPS recovered after cloudflared restart'
            } else {
                Write-Log 'Public relay HTTPS still failing after cloudflared restart' 'ERROR'
            }
        } catch {
            Write-Log ("Cloudflared restart failed: {0}" -f $_.Exception.Message) 'ERROR'
        }
    }
}

Write-Log '--- watchdog done ---'
} finally {
    if ($null -ne $mutex) {
        $mutex.ReleaseMutex() | Out-Null
        $mutex.Dispose()
    }
}