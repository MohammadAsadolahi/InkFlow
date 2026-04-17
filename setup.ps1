<#
.SYNOPSIS
    InkFlow - One-command setup for Windows
.DESCRIPTION
    1. Checks prerequisites (Docker, Node.js, VS Code CLI)
    2. Starts PostgreSQL via Docker Compose
    3. Builds the extension and packages it as .vsix
    4. Installs the .vsix into VS Code
    5. Configures VS Code settings for the database connection
.EXAMPLE
    .\setup.ps1
#>

$ErrorActionPreference = "Stop"

function Write-Info { param([string]$msg) Write-Host "[INFO]  $msg" -ForegroundColor Cyan }
function Write-Ok { param([string]$msg) Write-Host "[OK]    $msg" -ForegroundColor Green }
function Write-Warn { param([string]$msg) Write-Host "[WARN]  $msg" -ForegroundColor Yellow }
function Write-Fail { param([string]$msg) Write-Host "[FAIL]  $msg" -ForegroundColor Red; exit 1 }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "         InkFlow - Setup Wizard            " -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""

# -- Step 1: Check prerequisites --
Write-Info "Checking prerequisites..."

# Docker
$dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
if (-not $dockerCmd) {
    Write-Fail "Docker is not installed. Install Docker Desktop: https://www.docker.com/products/docker-desktop"
}
try {
    docker info 2>$null | Out-Null
}
catch {
    Write-Fail "Docker is not running. Please start Docker Desktop and try again."
}
Write-Ok "Docker is running"

# Node.js
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Fail "Node.js is not installed. Install Node.js 20+: https://nodejs.org"
}
$nodeVer = (node -v) -replace 'v', '' -split '\.' | Select-Object -First 1
if ([int]$nodeVer -lt 18) {
    Write-Fail "Node.js 18+ required, found $(node -v)"
}
Write-Ok "Node.js $(node -v)"

# VS Code CLI
$CodeCmd = $null
if (Get-Command code -ErrorAction SilentlyContinue) {
    $CodeCmd = "code"
}
elseif (Get-Command code-insiders -ErrorAction SilentlyContinue) {
    $CodeCmd = "code-insiders"
}
else {
    Write-Warn "VS Code CLI not found in PATH."
    Write-Warn "Extension will be built but you will need to install it manually."
}
if ($CodeCmd) {
    Write-Ok "VS Code CLI: $CodeCmd"
}

# -- Step 2: Start PostgreSQL --
Write-Host ""
Write-Info "Starting PostgreSQL database..."

$DbPort = if ($env:INKFLOW_DB_PORT) { $env:INKFLOW_DB_PORT } else { "5434" }
$DbPassword = if ($env:INKFLOW_DB_PASSWORD) { $env:INKFLOW_DB_PASSWORD } else { "inkflow_dev" }

$running = docker ps --format '{{.Names}}' 2>$null
if ($running -match "inkflow-inkflow-db") {
    Write-Ok "InkFlow database already running"
}
else {
    $env:INKFLOW_DB_PORT = $DbPort
    $env:INKFLOW_DB_PASSWORD = $DbPassword
    docker compose up -d 2>&1 | Where-Object { $_ -ne "" }

    Write-Info "Waiting for database to be ready..."
    $retries = 30
    do {
        Start-Sleep -Seconds 1
        $retries--
        if ($retries -le 0) {
            Write-Fail "Database did not become ready in time. Check: docker logs inkflow-inkflow-db-1"
        }
        docker exec inkflow-inkflow-db-1 pg_isready -U inkflow 2>$null | Out-Null
    } while ($LASTEXITCODE -ne 0)
    Write-Ok "PostgreSQL is ready on port $DbPort"
}

# -- Step 3: Install dependencies and build --
Write-Host ""
Write-Info "Installing dependencies..."
npm install --silent 2>&1 | Select-Object -Last 1
Write-Ok "Dependencies installed"

Write-Info "Building extension..."
node esbuild.js --production
Write-Ok "Build complete"

Write-Info "Packaging VSIX..."
$pkgJson = Get-Content package.json -Raw | ConvertFrom-Json
$version = $pkgJson.version
$vsixFile = "inkflow-$version.vsix"
npx vsce package --no-dependencies --allow-missing-repository 2>&1 | Select-Object -Last 1

if (-not (Test-Path $vsixFile)) {
    Write-Fail "VSIX file not found: $vsixFile"
}
Write-Ok "Packaged: $vsixFile"

# -- Step 4: Install extension --
Write-Host ""
if ($CodeCmd) {
    Write-Info "Installing extension into VS Code..."
    & $CodeCmd --install-extension $vsixFile --force 2>&1 | Where-Object { $_ -match "install|Install" }
    Write-Ok "Extension installed"
}
else {
    Write-Warn "Install the extension manually:"
    Write-Warn "  1. Open VS Code"
    Write-Warn "  2. Ctrl+Shift+P -> Extensions: Install from VSIX..."
    Write-Warn "  3. Select: $ScriptDir\$vsixFile"
}

# -- Step 5: Configure VS Code settings --
Write-Host ""
Write-Info "Configuring VS Code settings..."

$settingsDir = "$env:APPDATA\Code\User"
if (Test-Path $settingsDir) {
    $settingsFile = Join-Path $settingsDir "settings.json"
    if (Test-Path $settingsFile) {
        $content = Get-Content $settingsFile -Raw
        if ($content -match "inkflow\.database") {
            Write-Ok "InkFlow database settings already configured"
        }
        else {
            try {
                $settings = $content | ConvertFrom-Json
                $settings | Add-Member -NotePropertyName "inkflow.database.host" -NotePropertyValue "localhost" -Force
                $settings | Add-Member -NotePropertyName "inkflow.database.port" -NotePropertyValue ([int]$DbPort) -Force
                $settings | Add-Member -NotePropertyName "inkflow.database.name" -NotePropertyValue "inkflow" -Force
                $settings | Add-Member -NotePropertyName "inkflow.database.user" -NotePropertyValue "inkflow" -Force
                $settings | ConvertTo-Json -Depth 100 | Set-Content $settingsFile -Encoding UTF8
                Write-Ok "VS Code settings updated"
            }
            catch {
                Write-Warn "Could not update settings automatically"
            }
        }
    }
    else {
        $newSettings = @"
{
    "inkflow.database.host": "localhost",
    "inkflow.database.port": $DbPort,
    "inkflow.database.name": "inkflow",
    "inkflow.database.user": "inkflow"
}
"@
        $newSettings | Set-Content $settingsFile -Encoding UTF8
        Write-Ok "VS Code settings created"
    }
}

# -- Done --
Write-Host ""
Write-Host "=========================================" -ForegroundColor Green
Write-Host "         Setup Complete!                 " -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Database:  postgresql://localhost:${DbPort}/inkflow" -ForegroundColor Cyan
Write-Host "  VSIX:      $ScriptDir\$vsixFile" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor Yellow
Write-Host "  1. Restart VS Code (or Ctrl+Shift+P -> Reload Window)"
Write-Host "  2. When prompted, enter the database password: $DbPassword" -ForegroundColor Cyan
Write-Host "  3. Use Copilot Chat normally - InkFlow captures everything automatically"
Write-Host "  4. Check status: Ctrl+Shift+P -> InkFlow: Show Status"
Write-Host ""
Write-Host "  View your captured chats:" -ForegroundColor Yellow
Write-Host "  docker exec -it inkflow-inkflow-db-1 psql -U inkflow -c ""SELECT id, title, turn_count FROM sessions ORDER BY last_modified_at DESC LIMIT 10;"""
Write-Host ""
