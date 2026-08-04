# NOVA.ai

All-in-one Virtual AI Assistant platform built using a modular, type-safe monorepo architecture.

---

## 1. System Architecture

NOVA.ai follows the **State-Isolated Service-Oriented Architecture (SISOA)** pattern. The system decouples client-facing environments from backend API logic and database adapters to ensure modularity and reliability.

```
                            ┌───────────────────────────────────┐
                            │          NOVA.ai CLIENTS          │
                            │  Tauri (Desktop) / Expo (Mobile)  │
                            └────────────────┬──────────────────┘
                                             │
                                   HTTP / WebSockets / Push
                                             │
                                             ▼
                            ┌───────────────────────────────────┐
                            │        API GATEWAY SERVICE        │
                            │         (packages/gateway)        │
                            └────────────────┬──────────────────┘
                                             │
                                    Local Shared Imports
                                             │
                                             ▼
                            ┌───────────────────────────────────┐
                            │         SHARED LIBRARIES          │
                            │         (packages/shared)         │
                            │  Config, SQLite, LanceDB, LLM     │
                            └───────────────────────────────────┘
```

### Monorepo Workspace Structure

- **`apps/`**: Client application shells.
  - **`apps/desktop`**: Desktop companion application built on Tauri 2.0 & Rust.
  - **`apps/mobile`**: Mobile assistant interface built on React Native & Expo.
- **`packages/`**: Backend libraries and services.
  - **`packages/gateway`**: The central Fastify API server, coordinating agent sessions, data analytics, and external webhooks.
  - **`packages/shared`**: Configuration managers, database managers, and shared utilities.
  - **`packages/channels`**: Third-party messaging integration adapters (Telegram, WhatsApp).
  - **`packages/cli`**: Text-based terminal interface.

---

## 2. Component Design

### A. Configuration & Persistence (`packages/shared`)
- **Configuration Validator (`src/config.ts`)**: Uses Zod schemas to parse and validate settings stored in `~/.nova/nova.json` (such as local model routing, STT/TTS settings, and channel tokens).
- **SQLite Database Manager (`src/db/sqlite.ts`)**: Encapsulates relational queries for profile facts, visitor events, marketing leads, active tenants, and transaction logs. Integrates an automatic fallback to local JSON storage if native libraries are missing.
- **Vector Database Manager (`src/db/lancedb.ts`)**: Manages high-dimensionality text embeddings for Retrieval-Augmented Generation (RAG) and document scanning.

### B. Core Backend Services (`packages/gateway`)
- **Authentication Manager (`auth.ts`)**: Handles HS256-signed JWT token issuance and scrypt-based password hashing.
- **Session Manager (`session.ts`)**: Maintains user conversations and triggers manual takeover alerts if support keywords are detected.
- **Swarm Coordinator (`swarm.ts`)**: Coordinates workers (`ScraperWorker`, `CrmWorker`, `SearchWorker`) to execute parallel tasks.
- **Copilot Safeguard (`copilot.ts`)**: Intercepts shell executions and files operations, suspending them until manual user confirmation is received.

---

## 3. Workflows

### A. Conversational Escalation Flow
```
[Customer Client]              [Session Manager]            [Heartbeat / Mobile]
       │                               │                             │
       │─── POST /api/widget/chat ────>│                             │
       │    "Need a human agent"       │                             │
       │                               │ (Scan prompt for keywords)  │
       │                               │ [MATCH: "human agent"]       │
       │                               │                             │
       │                               │─── Set manual takeover ────>│
       │                               │    flag = true              │
       │                               │                             │
       │                               │─── Dispatch alert telemetry ──> (Expo Push)
       │                               │                                 "Takeover req!"
       │<─── Returns Response ─────────│                             │
       │    "Connecting representative"│                             │
```

### B. Desktop Guard Intercept Flow
```
[AI Agent / LLM]             [Copilot Controller]            [Desktop Tray UI]
       │                               │                             │
       │─── requestCommand(bash) ─────>│                             │
       │                               │ (Intercept & pause thread)  │
       │                               │                             │
       │                               │─── Push approval request ──>│
       │                               │    (Renders alert dialog)   │
       │                               │                             │
       │                               │<─── User clicks Approve ────│
       │                               │                             │
       │                               │ (Resume execution thread)   │
       │<─── Command execution success─│                             │
```

---

## 4. Verification & Testing

Verify that all modules and integration components are functioning correctly by compiling the TypeScript packages and executing the test runner:

```bash
# Build all packages
pnpm run build

# Run the test suite across every workspace package
pnpm test

# Or run a single package suite
pnpm --filter @nova/shared run test
pnpm --filter @nova/gateway run test
```

Coverage for a package can be inspected with the built-in Node.js reporter:

```bash
cd packages/gateway && node --test --experimental-test-coverage dist/services/*.test.js
```

---

## 5. Architectural Improvement Roadmap

The following design enhancements are mapped for subsequent releases:

1. **Configuration Layer**:
   - Add dynamic configuration file-watching via `fs.watch` to reload properties at runtime.
   - Introduce schema migration resolvers to ensure backward-compatibility for client configurations.
2. **Relational Persistence**:
   - Enforce SQLite Write-Ahead Logging (WAL) mode to improve parallel write concurrency.
   - Transition to cached prepared statements to optimize frequent analytics recording queries.
3. **Semantic Querying**:
   - Implement semantic caching on the vector database queries to minimize external embedding API cost.
   - Add hybrid search queries merging vector distance measurements with BM25 keyword matching.
4. **Gateway & API**:
   - Register auto-generating OpenAPI/Swagger documentation routes.
   - Transition API logs to structured JSON formatters using `Pino`.
5. **Agent Coordination**:
   - Introduce Task Dependency Graphs (DAGs) to coordinate and execute worker swarms in parallel.
   - Enforce execution timeouts and pass detailed execution parameters to manual copilot approval gateways.
