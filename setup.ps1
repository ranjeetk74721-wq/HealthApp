$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backend = Join-Path $root "backend"
$frontend = Join-Path $root "frontend"

Write-Host "Setting up ClinicQueue development dependencies..."

$venv = Join-Path $backend ".venv"
if (-not (Test-Path $venv)) {
    python -m venv $venv
}

$python = Join-Path $venv "Scripts\python.exe"
& $python -m pip install --upgrade pip
& $python -m pip install -r (Join-Path $backend "requirements-core.txt")

if (-not (Test-Path (Join-Path $backend ".env"))) {
    Copy-Item (Join-Path $backend ".env.example") (Join-Path $backend ".env")
}
if (-not (Test-Path (Join-Path $frontend ".env"))) {
    Copy-Item (Join-Path $frontend ".env.example") (Join-Path $frontend ".env")
}

Push-Location $frontend
try {
    npm ci --ignore-scripts --no-audit --no-fund
} finally {
    Pop-Location
}

Write-Host "Setup complete. Start the backend with: .\backend\.venv\Scripts\python.exe -m uvicorn server:app --reload --app-dir backend"
Write-Host "Start the frontend with: npm --prefix frontend run start"