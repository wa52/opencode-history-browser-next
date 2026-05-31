$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = "python"
$port = if ($env:PORT) { $env:PORT } else { "8765" }

Write-Host "Starting OpenCode History Browser..."
Write-Host "URL: http://127.0.0.1:$port"
& $python "$root\app.py"
