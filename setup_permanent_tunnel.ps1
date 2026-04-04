# Setup permanent named Cloudflare tunnel
# This creates a fixed tunnel that persists across restarts

Write-Host "=== Setting up permanent Cloudflare tunnel ==="

# Kill any existing cloudflared processes
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

# Create the named tunnel (idempotent - won't error if exists)
Write-Host "`n1. Creating named tunnel 'ifx-trading'..."
$output = & cloudflared tunnel create ifx-trading 2>&1
Write-Host $output

# Get the tunnel credentials file
$credPath = "$env:USERPROFILE\.cloudflared\*.json"
$creds = Get-ChildItem $credPath -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "*ifx-trading*" } | Select-Object -First 1

if ($creds) {
    Write-Host "`n2. Tunnel credentials found: $($creds.FullName)"
    
    # Create config file for tunnel
    Write-Host "`n3. Creating tunnel configuration..."
    $configPath = "$env:USERPROFILE\.cloudflared\config.yml"
    $config = @"
tunnel: ifx-trading
credentials-file: $($creds.FullName)

ingress:
  - hostname: api.myifxacademy.com
    service: http://localhost:8082
  - service: http_status:404
"@
    
    $config | Set-Content $configPath -Force
    Write-Host "Config created at: $configPath"
    
    # Show what was created
    Write-Host "`n4. Tunnel details:"
    cloudflared tunnel list
    
    Write-Host "`n✓ Permanent tunnel 'ifx-trading' created!"
    Write-Host "   Permanent URL: https://api.myifxacademy.com"
    
} else {
    Write-Host "✗ Error: Could not find tunnel credentials"
    exit 1
}
