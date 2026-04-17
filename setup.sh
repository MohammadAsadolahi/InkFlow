#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
#  Snich – One-command setup
#
#  Usage:   ./setup.sh
#
#  What it does:
#    1. Checks prerequisites (Docker, Node.js, VS Code CLI)
#    2. Starts PostgreSQL via Docker Compose
#    3. Builds the extension & packages it as .vsix
#    4. Installs the .vsix into VS Code
#    5. Configures VS Code settings for the database connection
#    6. Prints next steps
# ──────────────────────────────────────────────────────────────
set -euo pipefail

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()  { echo -e "${CYAN}[INFO]${NC}  $1"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $1"; }
fail()  { echo -e "${RED}[FAIL]${NC}  $1"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║          Snich – Setup Wizard            ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""

# ── Step 1: Check prerequisites ──
info "Checking prerequisites..."

# Docker
if ! command -v docker &>/dev/null; then
    fail "Docker is not installed. Please install Docker Desktop: https://www.docker.com/products/docker-desktop"
fi
if ! docker info &>/dev/null 2>&1; then
    fail "Docker is not running. Please start Docker Desktop and try again."
fi
ok "Docker is running"

# Node.js
if ! command -v node &>/dev/null; then
    fail "Node.js is not installed. Please install Node.js 20+: https://nodejs.org"
fi
NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    fail "Node.js 18+ required, found v$(node -v)"
fi
ok "Node.js $(node -v)"

# VS Code CLI
CODE_CMD=""
if command -v code &>/dev/null; then
    CODE_CMD="code"
elif command -v code-insiders &>/dev/null; then
    CODE_CMD="code-insiders"
else
    warn "VS Code CLI ('code') not found in PATH."
    warn "The extension will be built but you'll need to install it manually."
    warn "To add it: VS Code → Cmd/Ctrl+Shift+P → 'Shell Command: Install code command in PATH'"
fi
if [ -n "$CODE_CMD" ]; then
    ok "VS Code CLI: $CODE_CMD"
fi

# ── Step 2: Start PostgreSQL ──
echo ""
info "Starting PostgreSQL database..."

DB_PORT="${SNICH_DB_PORT:-5434}"
DB_PASSWORD="${SNICH_DB_PASSWORD:-snich_dev}"

# Check if port is already in use by another service
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "snich-snich-db"; then
    ok "Snich database already running"
else
    SNICH_DB_PORT="$DB_PORT" SNICH_DB_PASSWORD="$DB_PASSWORD" docker compose up -d 2>&1 | grep -v "^$"
    
    # Wait for healthy
    info "Waiting for database to be ready..."
    RETRIES=30
    until docker exec snich-snich-db-1 pg_isready -U snich &>/dev/null 2>&1; do
        RETRIES=$((RETRIES - 1))
        if [ "$RETRIES" -le 0 ]; then
            fail "Database did not become ready in time. Check: docker logs snich-snich-db-1"
        fi
        sleep 1
    done
    ok "PostgreSQL is ready on port $DB_PORT"
fi

# ── Step 3: Install dependencies & build ──
echo ""
info "Installing dependencies..."
npm install --silent 2>&1 | tail -1
ok "Dependencies installed"

info "Building extension..."
node esbuild.js --production
ok "Build complete"

info "Packaging VSIX..."
VSIX_FILE="snich-$(node -p "require('./package.json').version").vsix"
npx vsce package --no-dependencies --allow-missing-repository 2>&1 | tail -1
if [ ! -f "$VSIX_FILE" ]; then
    fail "VSIX file not found: $VSIX_FILE"
fi
ok "Packaged: $VSIX_FILE"

# ── Step 4: Install extension ──
echo ""
if [ -n "$CODE_CMD" ]; then
    info "Installing extension into VS Code..."
    $CODE_CMD --install-extension "$VSIX_FILE" --force 2>&1 | grep -i "install"
    ok "Extension installed"
else
    warn "Install the extension manually:"
    warn "  1. Open VS Code"
    warn "  2. Ctrl+Shift+P → 'Extensions: Install from VSIX...'"
    warn "  3. Select: $SCRIPT_DIR/$VSIX_FILE"
fi

# ── Step 5: Configure VS Code settings ──
echo ""
info "Configuring VS Code settings..."

DB_URL="postgres://snich:${DB_PASSWORD}@localhost:${DB_PORT}/snich"

# Set the environment variable for the current user's VS Code
# We use VS Code settings since env vars don't persist for GUI apps
if [ -n "$CODE_CMD" ]; then
    # Configure the database connection via VS Code settings
    $CODE_CMD --status &>/dev/null 2>&1 || true

    # Write settings using the VS Code CLI isn't directly supported,
    # so we provide the user with instructions or write settings.json
    SETTINGS_DIR=""
    if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "win32" || "$OSTYPE" == "cygwin" ]]; then
        SETTINGS_DIR="$APPDATA/Code/User"
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        SETTINGS_DIR="$HOME/Library/Application Support/Code/User"
    else
        SETTINGS_DIR="$HOME/.config/Code/User"
    fi

    if [ -d "$SETTINGS_DIR" ]; then
        SETTINGS_FILE="$SETTINGS_DIR/settings.json"
        if [ -f "$SETTINGS_FILE" ]; then
            # Check if snich settings already exist
            if grep -q "snich.database" "$SETTINGS_FILE" 2>/dev/null; then
                ok "Snich database settings already configured"
            else
                # Use node to safely merge JSON settings
                node -e "
                    const fs = require('fs');
                    const path = '$SETTINGS_FILE'.replace(/\\\\/g, '/');
                    let settings = {};
                    try { settings = JSON.parse(fs.readFileSync(path, 'utf8')); } catch {}
                    settings['snich.database.host'] = 'localhost';
                    settings['snich.database.port'] = $DB_PORT;
                    settings['snich.database.name'] = 'snich';
                    settings['snich.database.user'] = 'snich';
                    fs.writeFileSync(path, JSON.stringify(settings, null, 4) + '\n');
                " 2>/dev/null && ok "VS Code settings updated" || warn "Could not update settings automatically"
            fi
        else
            # Create settings file
            echo "{
    \"snich.database.host\": \"localhost\",
    \"snich.database.port\": $DB_PORT,
    \"snich.database.name\": \"snich\",
    \"snich.database.user\": \"snich\"
}" > "$SETTINGS_FILE"
            ok "VS Code settings created"
        fi
    fi
fi

# ── Done ──
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║          Setup Complete! 🎉              ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${CYAN}Database:${NC}  postgresql://localhost:${DB_PORT}/snich"
echo -e "  ${CYAN}VSIX:${NC}      $SCRIPT_DIR/$VSIX_FILE"
echo ""
echo -e "  ${YELLOW}Next steps:${NC}"
echo -e "  1. Restart VS Code (or reload window: Ctrl+Shift+P → 'Reload Window')"
echo -e "  2. When prompted, enter the database password: ${CYAN}${DB_PASSWORD}${NC}"
echo -e "  3. Use Copilot Chat normally — Snich captures everything automatically"
echo -e "  4. Check status: Ctrl+Shift+P → 'Snich: Show Status'"
echo ""
echo -e "  ${YELLOW}View your captured chats:${NC}"
echo -e "  docker exec -it snich-snich-db-1 psql -U snich -c \\"SELECT id, title, turn_count FROM sessions ORDER BY last_modified_at DESC LIMIT 10;\\""
echo ""
