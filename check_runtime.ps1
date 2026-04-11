Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -Path $Root

function Get-DotEnvMap {
    $map = @{}
    $dotenvPath = Join-Path $Root '.env'
    if (-not (Test-Path $dotenvPath)) {
        return $map
    }

    foreach ($line in Get-Content $dotenvPath) {
        if ($line -match '^\s*#' -or $line -notmatch '=') {
            continue
        }

        if ($line -match '^\s*([^#=][^=]*)=(.*)$') {
            $name = $matches[1].Trim()
            $value = $matches[2].Trim()
            if ($value.Length -ge 2) {
                if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
                    $value = $value.Substring(1, $value.Length - 2)
                }
            }
            $map[$name] = $value
        }
    }

    return $map
}

function Get-ConfigValue {
    param(
        [hashtable]$Map,
        [string]$Name,
        [string]$Default = ''
    )

    if ($Map.ContainsKey($Name) -and -not [string]::IsNullOrWhiteSpace($Map[$Name])) {
        return [string]$Map[$Name]
    }
    return $Default
}

function Get-LogicalPythonProcesses {
    param([string[]]$Needles)

    $matches = @(Get-CimInstance Win32_Process |
        Where-Object {
            if ($_.Name -notlike 'python*') {
                return $false
            }

            $commandLine = (($_.CommandLine -or '') -replace '\\', '/').ToLowerInvariant()
            foreach ($needle in $Needles) {
                if ($commandLine.Contains($needle.ToLowerInvariant())) {
                    return $true
                }
            }
            return $false
        })

    if ($matches.Count -eq 0) {
        return @()
    }

    $matchedIds = @{}
    foreach ($proc in $matches) {
        $matchedIds[[int]$proc.ProcessId] = $true
    }

    $launcherIds = @{}
    foreach ($proc in $matches) {
        $parentId = [int]$proc.ParentProcessId
        if ($matchedIds.ContainsKey($parentId)) {
            $launcherIds[$parentId] = $true
        }
    }

    return @($matches | Where-Object { -not $launcherIds.ContainsKey([int]$_.ProcessId) })
}

function Invoke-JsonHealthCheck {
    param(
        [string]$Url,
        [hashtable]$Headers = @{}
    )

    try {
        $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Headers $Headers $Url
        $body = $null
        if ($response.Content) {
            try {
                $body = $response.Content | ConvertFrom-Json
            } catch {
                $body = $response.Content
            }
        }

        return [pscustomobject]@{
            Ok = $true
            StatusCode = [int]$response.StatusCode
            Body = $body
            Error = $null
        }
    } catch {
        $statusCode = $null
        if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
            $statusCode = [int]$_.Exception.Response.StatusCode
        }

        return [pscustomobject]@{
            Ok = $false
            StatusCode = $statusCode
            Body = $null
            Error = $_.Exception.Message
        }
    }
}

function Get-ControlPlaneTerminalHostStatus {
    param(
        [hashtable]$Config,
        [string]$HostName
    )

    $supabaseUrl = Get-ConfigValue -Map $Config -Name 'SUPABASE_URL'
    $serviceRoleKey = Get-ConfigValue -Map $Config -Name 'SUPABASE_SERVICE_ROLE_KEY'
    if ([string]::IsNullOrWhiteSpace($supabaseUrl) -or [string]::IsNullOrWhiteSpace($serviceRoleKey)) {
        return [pscustomobject]@{
            Ok = $false
            Error = 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env'
            Host = $null
            LastSeenAgeSec = $null
            IsStale = $true
        }
    }

    $encodedHostName = [System.Uri]::EscapeDataString($HostName)
    $url = ($supabaseUrl.TrimEnd('/') + "/rest/v1/terminal_hosts?select=id,host_name,status,last_seen_at,metadata,updated_at,capacity,host_type&host_name=eq.$encodedHostName&order=updated_at.desc&limit=1")
    $headers = @{
        'apikey' = $serviceRoleKey
        'Authorization' = "Bearer $serviceRoleKey"
        'Accept' = 'application/json'
    }

    $response = Invoke-JsonHealthCheck -Url $url -Headers $headers
    if (-not $response.Ok) {
        return [pscustomobject]@{
            Ok = $false
            Error = $response.Error
            Host = $null
            LastSeenAgeSec = $null
            IsStale = $true
        }
    }

    $hostRow = $null
    if ($response.Body -is [System.Array]) {
        if ($response.Body.Count -gt 0) {
            $hostRow = $response.Body[0]
        }
    } elseif ($response.Body) {
        $hostRow = $response.Body
    }

    if (-not $hostRow) {
        return [pscustomobject]@{
            Ok = $true
            Error = $null
            Host = $null
            LastSeenAgeSec = $null
            IsStale = $true
        }
    }

    $lastSeenAgeSec = $null
    $isStale = $true
    if ($hostRow.PSObject.Properties['last_seen_at'] -and $hostRow.last_seen_at) {
        try {
            $lastSeen = [DateTimeOffset]::Parse([string]$hostRow.last_seen_at)
            $lastSeenAgeSec = [math]::Round(((Get-Date).ToUniversalTime() - $lastSeen.UtcDateTime).TotalSeconds, 0)
            $pollSec = [double](Get-ConfigValue -Map $Config -Name 'TERMINAL_MANAGER_POLL_SEC' -Default '10')
            $staleAfterSec = [math]::Max(45, [math]::Ceiling($pollSec * 3))
            $isStale = ($lastSeenAgeSec -gt $staleAfterSec)
        } catch {
            $isStale = $true
        }
    }

    return [pscustomobject]@{
        Ok = $true
        Error = $null
        Host = $hostRow
        LastSeenAgeSec = $lastSeenAgeSec
        IsStale = $isStale
    }
}

$config = Get-DotEnvMap
$controlPlaneUrl = Get-ConfigValue -Map $config -Name 'CONTROL_PLANE_URL' -Default 'https://ifx-mt5-portal-production.up.railway.app'
$controlPlaneUrl = $controlPlaneUrl.TrimEnd('/')
$relayUrl = Get-ConfigValue -Map $config -Name 'EA_BACKEND_RELAY_URL' -Default ($controlPlaneUrl + '/api/mt5')
$relayUrl = $relayUrl.TrimEnd('/')
$eaSourcePath = Get-ConfigValue -Map $config -Name 'IFX_EA_SOURCE_PATH' -Default (Join-Path $Root 'IFX_Railway_Bridge_v1.ex5')
$terminalsDir = Get-ConfigValue -Map $config -Name 'MT5_TERMINALS_DIR' -Default 'C:\mt5system\terminals'
$managerHostName = Get-ConfigValue -Map $config -Name 'TERMINAL_MANAGER_HOST_NAME' -Default $env:COMPUTERNAME
$expectedEaName = Split-Path -Leaf $eaSourcePath

$legacyRuntimeProcs = @(Get-LogicalPythonProcesses @('price_relay.py', 'main.py supervisor', 'main.py scheduler', 'job_worker.py'))
$relayHealth = Invoke-JsonHealthCheck -Url ($relayUrl + '/health')
$managerHostState = Get-ControlPlaneTerminalHostStatus -Config $config -HostName $managerHostName

$terminalProcMap = @{}
foreach ($proc in Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'") {
    if (-not [string]::IsNullOrWhiteSpace($proc.ExecutablePath)) {
        $terminalProcMap[$proc.ExecutablePath.ToLowerInvariant()] = $proc
    }
}

$terminalStates = @()
if (Test-Path $terminalsDir) {
    foreach ($dir in Get-ChildItem $terminalsDir -Directory -ErrorAction SilentlyContinue) {
        $terminalExe = Join-Path $dir.FullName 'terminal64.exe'
        $installedEa = Join-Path $dir.FullName (Join-Path 'MQL5\Experts\IFX' $expectedEaName)
        $installedEaDir = Join-Path $dir.FullName 'MQL5\Experts\IFX'
        $bootstrapJson = Join-Path $dir.FullName 'MQL5\Files\ifx\bootstrap.json'
        $presetPath = Join-Path $dir.FullName 'MQL5\Presets\ifx_connection.set'
        $startupIni = Join-Path $dir.FullName 'startup.ini'
        $installedEaNames = ''
        $startupExpert = ''
        if (Test-Path $installedEaDir) {
            $installedEaNames = @(
                Get-ChildItem $installedEaDir -File -ErrorAction SilentlyContinue |
                    Select-Object -ExpandProperty Name
            ) -join ', '
        }
        if (Test-Path $startupIni) {
            $startupExpert = @(
                Get-Content $startupIni -ErrorAction SilentlyContinue |
                    Where-Object { $_ -match '^Expert=' } |
                    Select-Object -First 1 |
                    ForEach-Object { ($_ -replace '^Expert=', '').Trim() }
            ) -join ''
        }
        $terminalStates += [pscustomobject]@{
            ConnectionId = $dir.Name
            Running = $terminalProcMap.ContainsKey($terminalExe.ToLowerInvariant())
            TerminalExe = Test-Path $terminalExe
            ExpectedEaPresent = Test-Path $installedEa
            StartupExpert = $startupExpert
            InstalledEa = $installedEaNames
            BootstrapPresent = Test-Path $bootstrapJson
            PresetPresent = Test-Path $presetPath
        }
    }
}

$criticalFindings = @()
$warningFindings = @()

if (-not (Test-Path $eaSourcePath)) {
    $criticalFindings += "Configured EA source is missing: $eaSourcePath"
}

if (-not $managerHostState.Ok) {
    $criticalFindings += "Terminal manager heartbeat lookup failed: $($managerHostState.Error)"
} elseif (-not $managerHostState.Host) {
    $criticalFindings += "Terminal manager host '$managerHostName' is not registered in control-plane state."
} elseif ($managerHostState.Host.status -ne 'online') {
    $criticalFindings += "Terminal manager host '$managerHostName' status is '$($managerHostState.Host.status)'."
} elseif ($managerHostState.IsStale) {
    $criticalFindings += "Terminal manager host '$managerHostName' heartbeat is stale."
}

if (-not $relayHealth.Ok) {
    $criticalFindings += "Railway relay health check failed: $($relayHealth.Error)"
}

if ($legacyRuntimeProcs.Count -gt 0) {
    $warningFindings += "Deprecated local runtime processes still running: $($legacyRuntimeProcs.Count)"
}

$brokenTerminals = @($terminalStates | Where-Object { -not $_.TerminalExe -or -not $_.ExpectedEaPresent -or -not $_.BootstrapPresent -or -not $_.PresetPresent })
if ($brokenTerminals.Count -gt 0) {
    $warningFindings += "Managed terminals with incomplete EA bootstrap state: $($brokenTerminals.Count)"
}

$overallStatus = 'OK'
$statusColor = 'Green'
if ($criticalFindings.Count -gt 0) {
    $overallStatus = 'CRITICAL'
    $statusColor = 'Red'
} elseif ($warningFindings.Count -gt 0) {
    $overallStatus = 'WARNING'
    $statusColor = 'Yellow'
}

Write-Host '=== IFX Runtime Truth Check ===' -ForegroundColor Cyan
Write-Host ("Status: {0}" -f $overallStatus) -ForegroundColor $statusColor
Write-Host ''

Write-Host 'Live path:' -ForegroundColor Cyan
Write-Host ("  control plane: {0}" -f $controlPlaneUrl)
Write-Host ("  relay:         {0}" -f $relayUrl)
Write-Host ("  EA source:     {0}" -f $eaSourcePath)
Write-Host ("  terminals dir: {0}" -f $terminalsDir)
Write-Host ''

Write-Host 'Terminal manager:' -ForegroundColor Cyan
if (-not $managerHostState.Ok) {
    Write-Host ("  heartbeat lookup failed: {0}" -f $managerHostState.Error) -ForegroundColor Red
} elseif (-not $managerHostState.Host) {
    Write-Host ("  host '{0}' not registered" -f $managerHostName) -ForegroundColor Red
} else {
    $hostStatusColor = if ($managerHostState.IsStale -or $managerHostState.Host.status -ne 'online') { 'Red' } else { 'Green' }
    $lastSeenText = if ($null -ne $managerHostState.LastSeenAgeSec) { "$($managerHostState.LastSeenAgeSec)s ago" } else { 'unknown' }
    Write-Host ("  host={0} id={1} status={2} last_seen={3}" -f $managerHostName, $managerHostState.Host.id, $managerHostState.Host.status, $lastSeenText) -ForegroundColor $hostStatusColor
}
Write-Host ''

Write-Host 'Railway relay:' -ForegroundColor Cyan
if ($relayHealth.Ok) {
    $uptime = $null
    if ($relayHealth.Body -is [pscustomobject]) {
        if ($relayHealth.Body.PSObject.Properties['uptime_s']) {
            $uptime = $relayHealth.Body.uptime_s
        }
    } elseif ($relayHealth.Body -is [hashtable]) {
        if ($relayHealth.Body.ContainsKey('uptime_s')) {
            $uptime = $relayHealth.Body['uptime_s']
        }
    }
    if ($null -ne $uptime) {
        Write-Host ("  healthy (HTTP {0}, uptime_s={1})" -f $relayHealth.StatusCode, $uptime) -ForegroundColor Green
    } else {
        Write-Host ("  healthy (HTTP {0})" -f $relayHealth.StatusCode) -ForegroundColor Green
    }
} else {
    Write-Host ("  unhealthy ({0})" -f $relayHealth.Error) -ForegroundColor Red
}
Write-Host ''

Write-Host 'Managed terminals:' -ForegroundColor Cyan
if ($terminalStates.Count -eq 0) {
    Write-Host '  none provisioned under the configured terminals directory yet' -ForegroundColor Yellow
} else {
    $terminalStates |
    Select-Object ConnectionId, Running, StartupExpert, TerminalExe, ExpectedEaPresent, BootstrapPresent, PresetPresent, InstalledEa |
        Format-Table -AutoSize
}
Write-Host ''

Write-Host 'Deprecated local runtime:' -ForegroundColor Cyan
if ($legacyRuntimeProcs.Count -eq 0) {
    Write-Host '  none detected' -ForegroundColor Green
} else {
    $legacyRuntimeProcs | Select-Object ProcessId, CommandLine | Format-Table -AutoSize
}
Write-Host ''

if ($criticalFindings.Count -gt 0) {
    Write-Host 'Critical findings:' -ForegroundColor Red
    foreach ($finding in $criticalFindings) {
        Write-Host ("  - {0}" -f $finding) -ForegroundColor Red
    }
    Write-Host ''
}

if ($warningFindings.Count -gt 0) {
    Write-Host 'Warnings:' -ForegroundColor Yellow
    foreach ($finding in $warningFindings) {
        Write-Host ("  - {0}" -f $finding) -ForegroundColor Yellow
    }
    Write-Host ''
}

if ($criticalFindings.Count -gt 0) {
    exit 2
}

if ($warningFindings.Count -gt 0) {
    exit 1
}

exit 0
