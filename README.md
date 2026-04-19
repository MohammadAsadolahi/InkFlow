<p align="center">
  <img src="https://img.shields.io/badge/InkFlow-v0.1.0-blue?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNmZmZmZmYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMTIgMTlsNy03IDMgMyAtNyA3LTMtM3oiLz48cGF0aCBkPSJNMTggMTNsLTEuNS03LjVMMiAybDMuNSAxNC41TDEzIDE4bDUtNXoiLz48cGF0aCBkPSJNMiAybDcuNTg2IDcuNTg2Ii8+PGNpcmNsZSBjeD0iMTEiIGN5PSIxMSIgcj0iMiIvPjwvc3ZnPg==" alt="InkFlow Version"/>
  <img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="MIT License"/>
  <img src="https://img.shields.io/badge/VS_Code-1.100+-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white" alt="VS Code"/>
  <img src="https://img.shields.io/badge/PostgreSQL-17-336791?style=for-the-badge&logo=postgresql&logoColor=white" alt="PostgreSQL"/>
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript"/>
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React"/>
  <img src="https://img.shields.io/badge/Docker-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker"/>
</p>

<h1 align="center">
  🖋️ InkFlow
</h1>

<h3 align="center">
  <em>Real-time, lossless capture &amp; analytics for every GitHub Copilot Chat conversation</em>
</h3>

<p align="center">
  <strong>Never lose a Copilot conversation again.</strong><br/>
  InkFlow watches your VS Code Copilot Chat sessions in real time, captures every mutation — every keystroke, every AI response, every tool call, every file edit — and stores it all in a local PostgreSQL database with a beautiful web dashboard for search, analysis, and audit.
</p>

<br/>

<p align="center">
  <a href="#-features">Features</a> •
  <a href="#-architecture">Architecture</a> •
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-dashboard">Dashboard</a> •
  <a href="#-real-world-use-cases">Use Cases</a> •
  <a href="#%EF%B8%8F-configuration">Configuration</a> •
  <a href="#-tech-stack">Tech Stack</a> •
  <a href="#-contributing">Contributing</a> •
  <a href="#-license">License</a>
</p>

---

## 🔍 The Problem

GitHub Copilot Chat is an incredible productivity tool — but **conversations are ephemeral**. Once you close a session, that valuable context, those debugging breakthroughs, those architectural decisions, the AI's chain-of-thought reasoning... it's all **gone**.

GitHub's own audit logs [only track license and settings changes](https://docs.github.com/en/copilot/managing-copilot/managing-github-copilot-in-your-organization/reviewing-audit-logs-for-copilot-business) — **not the actual conversation content**. There is no built-in way to:

- 🔎 **Search** across all your past Copilot conversations
- 📊 **Analyze** how your team uses AI-assisted coding
- 🛡️ **Audit** what code AI suggested and what was accepted
- 🧠 **Preserve** institutional knowledge from AI interactions
- 📈 **Measure** developer productivity with AI tools

**InkFlow solves all of this.**

---

## ✨ Features

### 🔴 Real-Time Capture
```
File System Events → Watcher → Parser → Processor → PostgreSQL
         ↓              ↓          ↓           ↓
    fs.watch()      Debounce    JSONL      Materialize
                   (300ms)    Replay    Turns & Parts
```
Every mutation is captured the instant it happens — streaming tokens, thinking blocks, tool invocations, file edits, forks, and deletions.

### 🧬 Lossless Event Sourcing
- **Immutable raw event log** — every JSONL mutation is stored as-is, forever
- **Full state reconstruction** — replay any conversation to any point in time
- **Fork detection** — automatically identifies when users regenerate or branch off responses
- **Content versioning** — tracks every edit to every message through `message_versions`

### 🌐 Multi-User & Multi-Workspace
- Shared PostgreSQL instance across your entire team
- Per-user identity tracking (`userId`, `displayName`, `machineId`)
- Multi-workspace support — monitors all your VS Code projects simultaneously
- Multi-variant support — works with VS Code Stable, Insiders, Exploration, and VSCodium

### 🛡️ Privacy & Security First
- **Local-first** — data never leaves your infrastructure
- **Optional content redaction** — strip sensitive information before storage
- **Configurable retention** — automatic data expiration policies
- **Soft deletes everywhere** — nothing is ever truly lost, full audit trail maintained

### 📊 Rich Web Dashboard
A full-featured React SPA with real-time analytics, deep search, and session exploration — [see Dashboard section below](#-dashboard).

### 💪 Battle-Tested Resilience
- **Write-ahead queue (WAL)** — events persist to disk before DB commit, surviving crashes
- **Crash recovery** — orphaned events from crashed instances are automatically reprocessed
- **File rewrite detection** — SHA-256 header hashing detects when VS Code compacts files
- **Deduplication** — event hash-based uniqueness prevents double processing
- **Rate limiting** — Windows `fs.watch()` infinite-loop workaround built in

---

## 🏗️ Architecture

InkFlow consists of three components working together:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           YOUR MACHINE(S)                                   │
│                                                                             │
│  ┌──────────────────────────────────┐    ┌────────────────────────────────┐  │
│  │    VS Code Extension (Watcher)   │    │     Web Dashboard (React)     │  │
│  │                                  │    │                                │  │
│  │  ┌────────────┐  ┌────────────┐  │    │  📊 Dashboard    🔍 Search    │  │
│  │  │ Discovery  │→ │ fs.watch() │  │    │  📋 Sessions     👥 Users     │  │
│  │  │ (Scan VS   │  │ (Monitor   │  │    │  📄 Turn Detail               │  │
│  │  │  Code dirs)│  │  .jsonl)   │  │    │                                │  │
│  │  └────────────┘  └─────┬──────┘  │    └───────────────┬────────────────┘  │
│  │                        │         │                    │                   │
│  │  ┌─────────────────────▼──────┐  │    ┌───────────────▼────────────────┐  │
│  │  │    Event Processor         │  │    │     Express API Server         │  │
│  │  │  ┌───────────────────────┐ │  │    │                                │  │
│  │  │  │ • Parse JSONL         │ │  │    │  /api/sessions  /api/turns     │  │
│  │  │  │ • Detect forks        │ │  │    │  /api/stats     /api/search    │  │
│  │  │  │ • Filter noise        │ │  │    │  /api/users     /api/filters   │  │
│  │  │  │ • Materialize turns   │ │  │    │                                │  │
│  │  │  └───────────────────────┘ │  │    └───────────────┬────────────────┘  │
│  │  └─────────────┬──────────────┘  │                    │                   │
│  │                │                 │                    │                   │
│  │  ┌─────────────▼──────────────┐  │                    │                   │
│  │  │  Write-Ahead Queue (WAL)   │  │                    │                   │
│  │  │  (Disk-backed resilience)  │  │                    │                   │
│  │  └─────────────┬──────────────┘  │                    │                   │
│  │                │                 │                    │                   │
│  └────────────────┼─────────────────┘                    │                   │
│                   │                                      │                   │
│                   └──────────────┬────────────────────────┘                   │
│                                 │                                            │
│                   ┌─────────────▼─────────────┐                              │
│                   │       PostgreSQL 17        │                              │
│                   │                            │                              │
│                   │  raw_events (immutable log) │                             │
│                   │  sessions / turns / parts  │                              │
│                   │  messages / versions        │                             │
│                   │  workspaces / users         │                             │
│                   │  watch_state / instances    │                             │
│                   └────────────────────────────┘                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Data Pipeline

```
 VS Code Chat File (.jsonl)
         │
         ▼
 ① DISCOVER — Scan VS Code storage dirs for chat session files
         │
         ▼
 ② WATCH — fs.watch() with debounce, rate-limiting, rewrite detection
         │
         ▼
 ③ READ — Read new bytes from last known offset (crash-safe resume)
         │
         ▼
 ④ PARSE — Parse JSONL entries (Kind 0-3 mutations)
         │    Kind 0: Full state replacement
         │    Kind 1: Set nested property
         │    Kind 2: Truncate array then push (forks!)
         │    Kind 3: Delete property
         │
         ▼
 ⑤ FILTER — Remove keystroke noise (inputState patches)
         │
         ▼
 ⑥ QUEUE — Write-ahead to disk for durability
         │
         ▼
 ⑦ STORE — Immutable raw events (dedup via SHA-256 hash)
         │
         ▼
 ⑧ MATERIALIZE — Sessions → Turns → Turn Parts
         │              (user↔AI exchanges with typed response pieces)
         │
         ▼
 ⑨ TRACK — Update watch state for next resume
```

---

## 🚀 Quick Start

### Prerequisites

- **VS Code** 1.100+ with GitHub Copilot Chat
- **Docker** & **Docker Compose** (recommended) — or PostgreSQL 17+ installed locally
- **Node.js** 20+ (for development)

### 1. Start the Database & Dashboard

```bash
# Clone the repository
git clone https://github.com/inkflow/inkflow.git
cd inkflow

# Start PostgreSQL + Web Dashboard with Docker
docker-compose up -d
```

The dashboard will be available at **http://localhost:3700**

### 2. Install the VS Code Extension

```bash
cd extension

# Install dependencies
npm install

# Build the extension
npm run build

# Package and install (or use F5 in VS Code to launch Extension Development Host)
```

> **Tip:** For development, press `F5` in VS Code with the extension folder open to launch the Extension Development Host with InkFlow active.

### 3. Configure (Optional)

Add to your VS Code `settings.json`:

```jsonc
{
    // Database connection (defaults match docker-compose)
    "inkflow.database.host": "localhost",
    "inkflow.database.port": 5434,
    "inkflow.database.name": "inkflow",
    "inkflow.database.user": "inkflow",
    "inkflow.database.password": "inkflow_dev",

    // Your identity (for multi-user setups)
    "inkflow.identity.userId": "your@email.com",
    "inkflow.identity.displayName": "Your Name"
}
```

### 4. Start Chatting

Open Copilot Chat in VS Code and start a conversation. InkFlow will automatically:

1. 🔍 Discover your chat session files
2. 👁️ Watch for changes in real time
3. 💾 Capture every mutation to PostgreSQL
4. 📊 Make everything searchable in the dashboard

---

## 📊 Dashboard

The web dashboard provides a comprehensive view of all captured Copilot Chat interactions.

### Overview Dashboard

> **At a Glance:** Total sessions, turns, parts, users, workspaces, and 24-hour activity metrics. See part-kind distribution (AI text vs. thinking vs. tool calls vs. file edits) and recent activity trends over 30 days.

| Metric | Description |
|--------|-------------|
| 📋 **Sessions** | Total conversations tracked across all workspaces |
| 🔄 **Turns** | Individual request→response exchanges |
| 🧩 **Parts** | Atomic response pieces (text, thinking, tools, edits, refs) |
| 👥 **Users** | Contributing developers |
| 📁 **Workspaces** | Monitored VS Code projects |
| ⏰ **24h Activity** | Sessions created in the last 24 hours |

### Session Explorer

Browse, filter, sort, and search through all captured sessions:

- **Filter** by workspace, user, or date range
- **Sort** by last modified, created date, turn count, or title
- **Search** across titles, custom titles, and session UUIDs
- **Paginate** through results (25 per page)

### Session Detail View

Deep-dive into any session with a turn-by-turn breakdown:

```
┌─────────────────────────────────────────────────┐
│  Session: "Refactor authentication module"       │
│  Project: my-app  ·  User: alice  ·  12 turns   │
├─────────────────────────────────────────────────┤
│                                                  │
│  Turn 1  ──────────────────────────  14:23:01    │
│  👤 "Can you help me refactor the auth module?"  │
│  🤖 ├── 💭 Thinking (analyzing codebase...)     │
│     ├── 🔧 Tool: read_file (src/auth.ts)        │
│     ├── 🔧 Tool: read_file (src/middleware.ts)   │
│     ├── 💬 "I'll restructure the auth module..." │
│     └── ✏️ File Edit: src/auth.ts (+42 -18)     │
│                                                  │
│  Turn 2  ──────────────────────────  14:25:33    │
│  👤 "Now add unit tests for the new structure"   │
│  🤖 ├── 💭 Thinking (planning test strategy...) │
│     ├── 💬 "I'll create comprehensive tests..."  │
│     └── ✏️ File Edit: test/auth.test.ts (+87)   │
│                                                  │
│  Turn 3  🔀 FORK ──────────────────  14:28:15   │
│  👤 "Actually, try a different approach..."      │
│  ...                                             │
└─────────────────────────────────────────────────┘
```

Each turn part is **color-coded by type**:
- 🟣 **Violet** — Thinking / chain-of-thought reasoning
- 🟡 **Amber** — Tool invocations (file reads, searches, terminal)
- 🟢 **Emerald** — File edits and code changes
- 🔵 **Blue** — AI text responses
- ⚪ **Gray** — References, code block URIs, progress messages

### Advanced Search

Search across **all conversations** with powerful multi-field filtering:

- **Free-text** search across user prompts, AI responses, tool output, and file content
- **Filter** by user, workspace, model ID, agent ID, part kind, and date range
- **Results** include session context, matching turn/part, and content snippets with direct links

### User Management

Track all contributing developers with session counts, turn counts, machine IDs, and activity timelines.

---

## 🌍 Real-World Use Cases

InkFlow addresses critical needs that are emerging as AI-assisted coding becomes mainstream across the software industry.

### 🏢 Enterprise Compliance & Audit

> *"The audit log does not include client session data, such as the prompts a user sends to Copilot locally."* — [GitHub Docs](https://docs.github.com/en/copilot/managing-copilot/managing-github-copilot-in-your-organization/reviewing-audit-logs-for-copilot-business)

GitHub's built-in audit logs only track license assignments and settings changes — **not conversation content**. Organizations subject to **SOC 2**, **ISO 27001**, **HIPAA**, or **FedRAMP** compliance need to demonstrate governance over AI-generated code. InkFlow fills this critical gap by providing:

- **Complete audit trail** of every AI interaction, prompt, and suggestion
- **Immutable event log** that cannot be tampered with (append-only, hash-verified)
- **Retention policies** aligned with compliance requirements
- **User attribution** linking every AI interaction to a specific developer

**Who needs this:** Financial services, healthcare, government contractors, defense, and any enterprise with strict code provenance requirements.

### 📈 Developer Productivity Analytics

McKinsey research shows that [developers complete tasks up to 2x faster](https://www.mckinsey.com/capabilities/mckinsey-digital/our-insights/unleashing-developer-productivity-with-generative-ai) with generative AI tools — but measuring this impact requires data. InkFlow enables engineering leaders to:

- **Quantify AI adoption** — How many conversations per developer per day? Which workspaces use Copilot most?
- **Measure response quality** — Track the ratio of thinking-to-output, regeneration frequency (forks), and conversation length
- **Identify power users** — Find team members who have mastered effective AI prompting to mentor others
- **Benchmark productivity** — Compare AI usage patterns across teams, projects, and time periods
- **Track trends** — 30-day activity charts show adoption curves and usage patterns

**Who needs this:** Engineering managers, VP Engineering, CTOs measuring ROI of GitHub Copilot investment.

### 🧠 Knowledge Management & Institutional Memory

AI conversations contain valuable institutional knowledge that is lost when sessions close:

- **Architectural decisions** — "Why did we choose this database schema?" The AI-assisted discussion is preserved
- **Debugging sessions** — Complex bug investigations with step-by-step AI reasoning are fully searchable
- **Onboarding accelerator** — New team members can search past conversations to understand codebase decisions
- **Pattern library** — Search across all "how to" conversations to build a team knowledge base
- **Cross-project learning** — Find how a problem was solved in one project and apply it to another

**Who needs this:** Engineering teams of any size that want to preserve and share AI-assisted development knowledge.

### 🔒 Security Review & Incident Response

When a security incident involves AI-generated code, organizations need to answer: *What exactly did the AI suggest? What was the developer's prompt? Was the vulnerable code AI-generated or human-written?*

- **Code provenance** — Trace any piece of code back to the exact AI conversation that generated it
- **Prompt forensics** — Review what developers asked the AI during a specific time window
- **Tool call audit** — See exactly which files the AI read, which terminal commands it ran
- **Post-incident analysis** — Full-text search across all conversations for security-relevant terms

**Who needs this:** Security teams, DevSecOps, incident response teams, and organizations in regulated industries.

### 📜 Intellectual Property Governance

As [legal and regulatory frameworks evolve](https://www.mckinsey.com/capabilities/mckinsey-digital/our-insights/unleashing-developer-productivity-with-generative-ai) around AI-generated content, organizations need to track the provenance of AI-assisted code:

- **IP documentation** — Maintain a record of which code was AI-generated vs. human-written
- **License compliance** — Track what code snippets the AI referenced or suggested
- **Legal defensibility** — Provide evidence of the development process in IP disputes
- **Policy enforcement** — Verify that developers follow organizational AI usage policies

**Who needs this:** Legal teams, open-source compliance officers, and organizations with IP-sensitive codebases.

### 🎓 Training & Coaching Optimization

Research participants [noted that prompt quality improves](https://www.mckinsey.com/capabilities/mckinsey-digital/our-insights/unleashing-developer-productivity-with-generative-ai) significantly with practice and shared learnings. InkFlow enables data-driven training:

- **Prompt quality analysis** — Compare effective vs. ineffective prompting patterns across the team
- **Identify training needs** — Find developers who struggle with AI tools (high fork rates, short sessions)
- **Best practice extraction** — Surface the most productive conversation patterns for training materials
- **Coaching insights** — Mentors can review mentees' AI interactions to provide targeted guidance
- **Workshop content** — Use real anonymized conversations as training examples

**Who needs this:** Tech leads, engineering coaches, L&D teams, and organizations investing in AI literacy.

### 🔬 AI Research & Model Evaluation

For teams evaluating different AI models or building custom AI tooling:

- **Model comparison** — Track which model IDs produce the longest thinking, most tool calls, or best results
- **Agent analysis** — Compare performance of different Copilot agents (code, terminal, workspace)
- **Conversation patterns** — Study how developers interact with AI at scale
- **Quality metrics** — Analyze the distribution of part kinds (thinking, code, tools) across sessions

**Who needs this:** AI/ML teams, developer experience researchers, and organizations evaluating AI tooling investments.

---

## ⚙️ Configuration

### VS Code Extension Settings

All settings are under the `inkflow.*` namespace in VS Code settings:

<details>
<summary><strong>🗄️ Database Configuration</strong></summary>

```jsonc
{
    "inkflow.database.host": "localhost",       // PostgreSQL host
    "inkflow.database.port": 5434,              // PostgreSQL port
    "inkflow.database.name": "inkflow",         // Database name
    "inkflow.database.user": "inkflow",         // Database user
    "inkflow.database.password": "inkflow_dev", // Database password
    "inkflow.database.ssl": false               // Enable SSL/TLS
}
```

Override everything with a single connection string:
```bash
export INKFLOW_DATABASE_URL="postgres://user:pass@host:5432/inkflow?sslmode=require"
```
</details>

<details>
<summary><strong>👤 Identity (Multi-User)</strong></summary>

```jsonc
{
    "inkflow.identity.userId": "alice@example.com",
    "inkflow.identity.displayName": "Alice Chen"
}
```
</details>

<details>
<summary><strong>👁️ Watcher</strong></summary>

```jsonc
{
    "inkflow.watcher.enabled": true,
    "inkflow.watcher.debounceMs": 300,                        // 50–5000ms
    "inkflow.watcher.watchVariants": ["stable", "insiders"],  // VS Code variants to monitor
    "inkflow.watcher.periodicScanSeconds": 30                 // Belt-and-suspenders scan interval
}
```
</details>

<details>
<summary><strong>🔇 Ingestion</strong></summary>

```jsonc
{
    "inkflow.ingestion.filterInputState": true   // Filter keystroke noise (10+ events/sec)
}
```
</details>

<details>
<summary><strong>🔐 Privacy</strong></summary>

```jsonc
{
    "inkflow.privacy.redactContent": false        // Redact sensitive content before storage
}
```
</details>

<details>
<summary><strong>🗓️ Retention</strong></summary>

```jsonc
{
    "inkflow.retention.maxAgeDays": null           // null = keep forever, or set a number
}
```
</details>

<details>
<summary><strong>📤 Export</strong></summary>

```jsonc
{
    "inkflow.export.defaultFormat": "markdown",    // markdown | html | json
    "inkflow.export.includeMetadata": true,
    "inkflow.export.includeForks": true,
    "inkflow.export.includeDeleted": false
}
```
</details>

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `INKFLOW_DATABASE_URL` | Full PostgreSQL connection string (overrides all DB settings) | — |
| `INKFLOW_DB_PASSWORD` | Database password for docker-compose | `inkflow_dev` |
| `INKFLOW_DB_PORT` | Exposed database port | `5434` |
| `INKFLOW_API_PORT` | Dashboard API port | `3700` |
| `PORT` | Backend server port | `3700` |
| `NODE_ENV` | Node environment | `development` |

---

## 🛠️ Tech Stack

### Extension (VS Code Plugin)
| Technology | Purpose |
|-----------|---------|
| **TypeScript** | Primary language |
| **porsager/postgres** | PostgreSQL driver (pure JS, zero native deps) |
| **esbuild** | Ultra-fast bundler |
| **Vitest** | Unit + E2E testing |
| **Node.js crypto** | SHA-256 hashing for deduplication |

### Backend & Dashboard
| Technology | Purpose |
|-----------|---------|
| **React 19** | UI framework |
| **React Router 7** | Client-side routing |
| **Tailwind CSS 4** | Utility-first styling |
| **Express 5** | API server |
| **pg** | PostgreSQL client |
| **Lucide React** | Icon library |
| **date-fns** | Date formatting |
| **Vite 6** | Build tool & dev server |

### Infrastructure
| Technology | Purpose |
|-----------|---------|
| **PostgreSQL 17** | Primary data store |
| **Docker + Compose** | Containerized deployment |
| **tsx** | TypeScript execution for server |

---

## 🗃️ Database Schema

InkFlow uses a carefully designed PostgreSQL schema optimized for append-heavy writes and analytical reads:

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   raw_events     │     │    sessions      │     │     turns        │
│ (immutable log)  │     │                  │     │                  │
│                  │     │  session_uuid    │◄────│  session_id      │
│  event_hash  ◄───┼──┐  │  workspace_id ──►│     │  turn_index      │
│  kind (0-3)      │  │  │  user_id ───────►│     │  user_text       │
│  raw_content     │  │  │  title           │     │  model_id        │
│  byte_offset     │  │  │  turn_count      │     │  is_fork         │
│  session_file    │  │  │  fork_count      │     │  agent_id        │
└──────────────────┘  │  └──────────────────┘     └────────┬─────────┘
                      │                                     │
                      │  ┌──────────────────┐     ┌────────▼─────────┐
                      │  │    workspaces    │     │   turn_parts     │
                      │  │                  │     │                  │
                      │  │  storage_hash    │     │  part_index      │
                      │  │  variant         │     │  kind            │
                      │  │  folder_uri      │     │  content         │
                      │  └──────────────────┘     │  raw_json        │
                      │                           └──────────────────┘
                      │  ┌──────────────────┐
                      │  │     users        │     ┌──────────────────┐
                      │  │                  │     │  watch_state     │
                      │  │  user_uid        │     │                  │
                      │  │  display_name    │     │  file_path       │
                      │  │  machine_id      │     │  last_byte_offset│
                      │  └──────────────────┘     │  header_hash     │
                      │                           └──────────────────┘
                      │  ┌──────────────────┐
                      └──│ message_versions │
                         │                  │
                         │  version         │
                         │  content_hash    │
                         │  change_type     │
                         └──────────────────┘
```

### Turn Part Kinds
| Kind | Description | Example |
|------|-------------|---------|
| `(null)` | AI text response | "Here's how to refactor..." |
| `thinking` | Chain-of-thought reasoning | "Let me analyze the codebase..." |
| `toolInvocationSerialized` | Tool calls | `read_file`, `run_in_terminal` |
| `textEditGroup` | File edits | Changes to `src/auth.ts` |
| `inlineReference` | Code references | Links to files/symbols |
| `codeblockUri` | Code block URIs | Source file associations |
| `progressMessage` | Progress updates | "Searching workspace..." |
| `confirmation` | Confirmations | User approval prompts |
| `command` | VS Code commands | Editor actions |

---

## 🧪 Development

```bash
# Extension development
cd extension
npm install
npm test                    # Run unit tests
npm run test:e2e            # Run end-to-end tests

# Backend development
cd backend
npm install
npm run dev                 # Start with hot reload (API + Vite)

# Full stack with Docker
docker-compose up -d        # Start PostgreSQL + Dashboard
# Then F5 in VS Code to launch extension
```

### Project Structure

```
inkflow/
├── extension/              # VS Code extension
│   ├── src/
│   │   ├── extension.ts    # Entry point
│   │   ├── config.ts       # Settings management
│   │   ├── types.ts        # TypeScript types
│   │   ├── db/             # Database layer
│   │   ├── discovery/      # Chat file discovery
│   │   ├── parser/         # JSONL parsing & replay
│   │   ├── processor/      # Event processing pipeline
│   │   ├── utils/          # Hashing utilities
│   │   └── watcher/        # File system watcher
│   └── test/               # Unit & integration tests
├── backend/                # Web dashboard
│   ├── server/             # Express API
│   │   └── routes/         # REST endpoints
│   └── src/                # React frontend
│       ├── pages/          # Dashboard, Sessions, Search, Users
│       ├── components/     # Reusable UI components
│       └── lib/            # API client
└── docker-compose.yml      # One-command deployment
```

---

## 🤝 Contributing

Contributions are welcome! Whether it's bug fixes, new features, documentation improvements, or use case stories — we'd love your input.

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Commit** your changes (`git commit -m 'Add amazing feature'`)
4. **Push** to the branch (`git push origin feature/amazing-feature`)
5. **Open** a Pull Request

### Areas We'd Love Help With

- 📊 Additional dashboard visualizations and charts
- 🔌 Export integrations (Slack, Notion, Confluence)
- 🧪 Expanding test coverage
- 📚 Documentation and tutorials
- 🌐 Internationalization (i18n)
- 🎨 Dashboard UI/UX improvements

---

## 📝 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgments

- [GitHub Copilot](https://github.com/features/copilot) for the AI coding assistance that inspired this tool
- [VS Code](https://code.visualstudio.com/) for the extensibility platform
- The JSONL mutation format is based on VS Code's internal `objectMutationLog.ts` implementation

---

<p align="center">
  <strong>InkFlow</strong> — Because every conversation with AI deserves to be remembered.
</p>

<p align="center">
  <sub>Built with ❤️ for developers who believe in transparency, accountability, and the power of preserved knowledge.</sub>
</p>
