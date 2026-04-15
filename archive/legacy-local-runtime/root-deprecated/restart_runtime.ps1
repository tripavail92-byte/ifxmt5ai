param(
    [switch]$PreserveRelaySourceLock
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -Path $Root

& (Join-Path $Root 'start_runtime_headless.ps1') @PSBoundParameters
