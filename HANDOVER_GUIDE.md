# NOVA.ai Developer Handover & Onboarding Guide

Welcome to the **NOVA.ai** codebase! This document provides a complete onboarding reference detailing every module, configuration structure, system lifecycle, and execution workflow within this repository. 

---

## 1. Project Overview & Design Philosophy

NOVA.ai is a multi-channel, agent-driven assistant platform designed for personal productivity and business operations. It follows a **State-Isolated Service-Oriented Architecture (SISOA)** pattern. The core backend processes logic inside a centralized gateway, importing modular modules from a shared packages library.

---

## 2. Directory Tree Map

```
NOVA.ai/
├── apps/                               # Client Application Shells
│   ├── desktop/                        # Tauri 2.0 & Rust desktop assistant overlay
│   │   ├── src/                        # UI React components
│   │   └── src-tauri/                  # Rust system APIs, tray configs, system hooks
│   └── mobile/                         # React Native Expo console application
│       ├── App.js                      # Core React Native dashboard layout
│       └── package.json                # Mobile configurations & dependencies
│
├── packages/                           # Shared Packages & Microservices
│   ├── cli/                            # Command Line Interface execution shell
│   ├── channels/                       # Social messaging adapters (Telegram, WhatsApp)
│   │   └── src/index.ts                # Telegraf routing & WhatsApp bot bindings
│   ├── shared/                         # Core database layers and config validators
│   │   ├── src/config.ts               # Zod validation schema for ~/.nova/nova.json
│   │   ├── src/db/sqlite.ts            # SQLite client logs (Facts, Leads, Sales, Tenants)
│   │   └── src/db/lancedb.ts           # LanceDB Semantic Vector Store manager
│   ├── gateway/                        # Fastify API Gateway Server & Agents Engine
│   │   ├── src/server.ts               # Route registers, rate limiters, and Helmet headers
│   │   └── src/services/               # Gateway background microservices
│   │       ├── auth.ts                 # JWT generation and scrypt password hashing
│   │       ├── session.ts              # Conversational states & takeover intercepts
│   │       ├── swarm.ts                # Swarm coordinator & worker agent dispatchers
│   │       ├── copilot.ts              # Desktop command interception approval gates
│   │       ├── tools.ts                # Tools executed by AI workers (SCRUD, scraping)
│   │       ├── compliance.ts           # Static checks verifying .env and API keys security
│   │       ├── limiter.ts              # IP bucket rate limiting manager
│   │       ├── analytics.ts            # Sales, visitor, and funnel metric calculations
│   │       ├── logger.ts               # Secure logger redacting sensitive credentials
│   │       ├── queue.ts                # BullMQ/Redis message queue fallbacks
│   │       ├── heartbeat.ts            # Telemetry heartbeat alerts connection pool
│   │       └── cron.ts                 # Background task scheduling managers
│   └── widget-client/                  # Embedded widget frontend loader script
│
├── package.json                        # Monorepo root configuration
├── pnpm-workspace.yaml                 # Monorepo workspaces definition
├── tsconfig.json                       # Global TypeScript compiler rules
└── README.md                           # Quickstart guide
```

---

## 3. The 10 Logical Layers of NOVA.ai

The system is organized into ten interdependent layers:

```
                  ┌───────────────────────────────────────────┐
  User Interface  │ Layer 1: Client Frontends (Tauri / Expo)  │
                  └─────────────────────┬─────────────────────┘
                                        ▼
                  ┌───────────────────────────────────────────┐
  Inbound Routes  │ Layer 2: Channel Adapters (Telegram / WA) │
                  ├───────────────────────────────────────────┤
                  │ Layer 3: API Gateway & Router (Fastify)   │
                  └─────────────────────┬─────────────────────┘
                                        ▼
                  ┌───────────────────────────────────────────┐
  State & Auth    │ Layer 4: Session & Conversation Manager   │
                  ├───────────────────────────────────────────┤
                  │ Layer 5: Cryptography & Authentication    │
                  └─────────────────────┬─────────────────────┘
                                        ▼
                  ┌───────────────────────────────────────────┐
  Orchestration   │ Layer 6: Swarm Orchestrator & Workers     │
                  ├───────────────────────────────────────────┤
                  │ Layer 7: Guardrails & Copilot Safeguards  │
                  └─────────────────────┬─────────────────────┘
                                        ▼
                  ┌───────────────────────────────────────────┐
  Data & Query    │ Layer 8: Structured DB Manager (SQLite)   │
                  ├───────────────────────────────────────────┤
                  │ Layer 9: Unstructured Semantic Memory     │
                  └─────────────────────┬─────────────────────┘
                                        ▼
  Background      ┌───────────────────────────────────────────┐
  Scheduling      │ Layer 10: Task Queues & Heartbeats (Bull) │
                  └───────────────────────────────────────────┘
```

### Layer 1: Client Frontend Interfaces
- **Desktop (`apps/desktop`)**: Manages keyboard overlays, native speech hooks, and task confirmation modals. Built using Tauri 2.0 and Rust.
- **Mobile (`apps/mobile`)**: Native iOS/Android console built on Expo. Allows business owners to view visitor metrics, sales logs, and manually takeover customer chatbot conversations.
- **Widget (`packages/widget-client`)**: An embeddable JS script that injects the chat window onto business websites.

### Layer 2: Social Integration Channels
- Parses and standardizes events from third-party APIs (e.g. Telegram via Telegraf, WhatsApp Webhook). Maps incoming text directly to the Session Manager.

### Layer 3: API Routing & Gateway
- A Fastify server (`packages/gateway/src/server.ts`) hosting API endpoints. Automatically registers Helmet-standard security headers, configures CORS, and applies bucket-rate limiting on public paths.

### Layer 4: Session & Context Management
- Stateful conversation pools (`session.ts`) tracking messaging history, active tokens, and manual overrides. Automatically scans inputs for support indicators (e.g. "representative", "manager") to halt AI responses and notify owners.

### Layer 5: Cryptography & Auth Access
- Manages security verification. Generates HS256-signed JWTs to secure business analytics dashboards and hashes passwords securely using standard `scrypt` cryptography.

### Layer 6: Swarm Orchestration Engine
- The coordinate-worker coordinator (`swarm.ts`) parses complex tasks using a reasoning model, plans subtask steps, delegates work to specialized agents (`ScraperWorker`, `CrmWorker`, `SearchWorker`), and runs isolated tool operations.

### Layer 7: Execution Guards & Compliance Gates
- Intercepts local desktop system actions. Runs static security compliance checks dynamically, verifying that secrets are not committed or logged in plaintext.

### Layer 8: Relational Persistence
- Handles transactional logging and telemetry datasets using SQLite (`sqlite.ts`). Implements automatic local JSON fallbacks if native binary modules fail to build.

### Layer 9: Semantic Vector Memory
- Resolves high-dimensional vector embeddings (`lancedb.ts`) for Retrieval-Augmented Generation (RAG) and document searches, mapping them to filesystem indexes.

### Layer 10: Asynchronous Tasks & Queues
- Handles message queues and scheduling using BullMQ (`queue.ts`) and background cron tasks (`cron.ts`). Dispatches real-time push events through WebSockets and telemetry listeners.

---

## 4. Key Developer Workflows

### Running the Environment
Ensure your local developer dependencies are installed, then compile and run the gateway:

```bash
# Install package dependencies
pnpm install

# Build the workspace
pnpm run build

# Start the dev gateway
pnpm run dev
```

### Running Tests
The project prioritizes Test-Driven Development (TDD). Tests run using Node's native test runner without relying on third-party runner binaries:

```bash
# Execute the suite
node --test packages/gateway/dist/services/analytics.test.js packages/gateway/dist/services/compliance.test.js packages/gateway/dist/services/copilot.test.js packages/gateway/dist/services/instagram.test.js packages/gateway/dist/services/swarm.test.js
```

---

## 5. Next Developer Roadmap Goals

If you are picking up work on the codebase today, prioritize the following architectural enhancements:
1. **Dynamic Configuration Watching**: Set up file watchers on `~/.nova/nova.json` using `fs.watch` to refresh config states dynamically.
2. **SQLite Performance Optimization**: Enable Write-Ahead Logging (`PRAGMA journal_mode = WAL;`) and utilize pre-compiled prepared statements for dashboard metrics.
3. **OpenAPI / Swagger Documentation**: Implement automated Swagger routers inside Fastify to document the REST interfaces.
4. **Structured JSON Logs**: Integrate `Pino` logging outputs to unify application logging formatting.
