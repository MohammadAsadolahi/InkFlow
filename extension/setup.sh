#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
#  InkFlow – One-command setup
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
echo -e "${CYAN}║          InkFlow – Setup Wizard            ║${NC}"
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

DB_PORT="${INKFLOW_DB_PORT:-5434}"
DB_PASSWORD="${INKFLOW_DB_PASSWORD:-inkflow_dev}"

# Check if port is already in use by another service
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "inkflow-inkflow-db"; then
    ok "InkFlow database already running"
else
    INKFLOW_DB_PORT="$DB_PORT" INKFLOW_DB_PASSWORD="$DB_PASSWORD" docker compose up -d 2>&1 | grep -v "^$"
    
    # Wait for healthy
    info "Waiting for database to be ready..."
    RETRIES=30
    until docker exec inkflow-inkflow-db-1 pg_isready -U inkflow &>/dev/null 2>&1; do
        RETRIES=$((RETRIES - 1))
        if [ "$RETRIES" -le 0 ]; then
            fail "Database did not become ready in time. Check: docker logs inkflow-inkflow-db-1"
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
VSIX_FILE="inkflow-$(node -p "require('./package.json').version").vsix"
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

DB_URL="postgres://inkflow:${DB_PASSWORD}@localhost:${DB_PORT}/inkflow"

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
            # Check if inkflow settings already exist
            if grep -q "inkflow.database" "$SETTINGS_FILE" 2>/dev/null; then
                ok "InkFlow database settings already configured"
            else
                # Use node to safely merge JSON settings
                node -e "
                    const fs = require('fs');
                    const path = '$SETTINGS_FILE'.replace(/\\\\/g, '/');
                    let settings = {};
                    try { settings = JSON.parse(fs.readFileSync(path, 'utf8')); } catch {}
                    settings['inkflow.database.host'] = 'localhost';
                    settings['inkflow.database.port'] = $DB_PORT;
                    settings['inkflow.database.name'] = 'inkflow';
                    settings['inkflow.database.user'] = 'inkflow';
                    fs.writeFileSync(path, JSON.stringify(settings, null, 4) + '\n');
                " 2>/dev/null && ok "VS Code settings updated" || warn "Could not update settings automatically"
            fi
        else
            # Create settings file
            echo "{
    \"inkflow.database.host\": \"localhost\",
    \"inkflow.database.port\": $DB_PORT,
    \"inkflow.database.name\": \"inkflow\",
    \"inkflow.database.user\": \"inkflow\"
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
echo -e "  ${CYAN}Database:${NC}  postgresql://localhost:${DB_PORT}/inkflow"
echo -e "  ${CYAN}VSIX:${NC}      $SCRIPT_DIR/$VSIX_FILE"
echo ""
echo -e "  ${YELLOW}Next steps:${NC}"
echo -e "  1. Restart VS Code (or reload window: Ctrl+Shift+P → 'Reload Window')"
echo -e "  2. When prompted, enter the database password: ${CYAN}${DB_PASSWORD}${NC}"
echo -e "  3. Use Copilot Chat normally — InkFlow captures everything automatically"
echo -e "  4. Check status: Ctrl+Shift+P → 'InkFlow: Show Status'"
echo ""
echo -e "  ${YELLOW}View your captured chats:${NC}"
echo -e "  docker exec -it inkflow-inkflow-db-1 psql -U inkflow -c \\"SELECT id, title, turn_count FROM sessions ORDER BY last_modified_at DESC LIMIT 10;\\""
echo ""
