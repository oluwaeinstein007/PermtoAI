# PermitoAI

AI-powered permit-to-work management system for Nigerian oil & gas operations.

> **Guiding Principle:** *AI assists, rules constrain, humans decide, logs remember.*

---

## Overview

PermitoAI is a safety-critical backend system that combines AI reasoning with deterministic rule enforcement to automate hazard identification, risk scoring, and regulatory compliance validation for permit-to-work (PTW) workflows.

It is designed for compliance with:
- **DPR EGASPIN** — Nigerian Department of Petroleum Resources regulations
- **ISO 45001** — Occupational Health & Safety Management Systems
- **IOGP** — International Association of Oil & Gas Producers safety standards

---

## Quick Start

### Prerequisites

| Requirement | Version / Notes |
|---|---|
| Node.js | ≥ 18 |
| pnpm | ≥ 10 |
| Qdrant | Local (`docker-compose up`) or cloud instance |
| Google AI API key | Gemini access required |
| pdftotext | `sudo apt install poppler-utils` (for compliance ingestion) |

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment

Create a `.env` file in the project root:

```env
# Google Gemini (required)
GOOGLE_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-2.5-flash-lite          # or gemini-2.0-flash, gemini-2.5-pro
GOOGLE_EMBEDDING_MODEL=gemini-embedding-001
EMBEDDING_DIMENSIONS=3072
EMBEDDING_VECTOR_SIZE=3072                  # alias — either form is accepted
EMBEDDING_PROVIDER=google

# Qdrant vector database (required)
# QDRANT_URL and QDRANT_HOST are both accepted — use whichever suits your client
QDRANT_HOST=http://localhost:6333           # local Qdrant
# QDRANT_HOST=https://your-cluster.cloud.qdrant.io   # Qdrant Cloud
QDRANT_KEY=your_qdrant_api_key             # leave empty for local Qdrant

# Collection names (QDRANT_COLLECTION and QDRANT_COLLECTION_NAME are both accepted)
QDRANT_COLLECTION=permitoai                # regulations & work-type risk data
QDRANT_INCIDENTS_COLLECTION=permito_incidents
QDRANT_COMPLIANCE_COLLECTION=permito_compliance_docs

# Safety thresholds (optional — shown with defaults)
HAZARD_CONFIDENCE_THRESHOLD=0.7
ANOMALY_SIMILARITY_THRESHOLD=0.7
MAX_HAZARD_SUGGESTIONS=10
AI_TEMPERATURE=0

# Server ports (optional)
PORT=3000        # MCP HTTP server
API_PORT=4000    # REST API server
```

> **Qdrant Cloud:** Set `QDRANT_HOST` to your cluster URL and `QDRANT_KEY` to your API key. The system uses `QDRANT_HOST` or `QDRANT_URL` interchangeably.

### 3. Seed the vector database

Populates Qdrant with DPR/IOGP regulations (40+ work types) and 17 synthetic historical incidents. **Must be run before starting the servers.**

```bash
pnpm seed
```

This creates/recreates two collections:
- `permitoai` (or whatever `QDRANT_COLLECTION` is set to) — work-type risk profiles
- `permito_incidents` — historical incident records

### 4. Ingest compliance documents (strongly recommended)

Chunks, embeds, and stores PDFs from `compliance_docs/` into Qdrant. Powers grounded compliance checking via RAG.

```bash
# Ingest all PDFs in compliance_docs/
pnpm ingest

# Single file
pnpm ingest -- --file IOGP_510.pdf

# Rebuild the collection from scratch (drop + re-ingest all)
pnpm ingest -- --clean

# Re-ingest a single file (deletes its old chunks first)
pnpm ingest -- --clean-file --file IOGP_510.pdf
```

Ingest is **idempotent** — re-running without `--clean` or `--clean-file` will upsert the same chunk IDs without creating duplicates.

### 5. Start the servers

```bash
# REST API server (port 4000)
pnpm api

# MCP server — stdio transport (for Claude Desktop / claude-code)
pnpm start

# MCP server — HTTP transport (port 3000)
pnpm start:http
```

Both servers can run simultaneously. They share the same service layer.

---

## Project Structure

```
PermitoAI/
├── src/
│   ├── index.ts                    # MCP server entry point
│   ├── config.ts                   # Environment configuration
│   ├── seed.ts                     # Qdrant database seeder
│   ├── run_tool.ts                 # Tool test harness
│   │
│   ├── schemas/
│   │   └── index.ts                # Zod schemas (JobContext, Hazard, Permit, etc.)
│   │
│   ├── tools/                      # MCP tool definitions
│   │   ├── hazard_suggest.ts       # HAZARD_SUGGEST
│   │   ├── risk_assess.ts          # RISK_ASSESS
│   │   ├── compliance_check.ts     # COMPLIANCE_CHECK
│   │   ├── permit_validate.ts      # PERMIT_VALIDATE
│   │   └── anomaly_detect.ts       # ANOMALY_DETECT
│   │
│   ├── services/                   # Business logic
│   │   ├── hazardService.ts        # AI hazard suggestion + RAG
│   │   ├── riskScoringService.ts   # Risk matrix + rule constraints + computeSummary
│   │   ├── simopsService.ts        # SIMOPS conflict detection + incompatibility matrix
│   │   ├── validationService.ts    # Multi-layer permit validation
│   │   ├── embeddingService.ts     # Google Gemini wrapper
│   │   └── vectorService.ts        # Qdrant query wrapper (regulations, incidents, compliance docs)
│   │
│   └── api/                        # REST API layer
│       ├── server.ts               # Hono HTTP server (port 4000)
│       ├── middleware/
│       │   └── errorHandler.ts     # Global error handling
│       └── routes/
│           ├── tools.ts            # Tool endpoints (6 tools including SIMOPS_CHECK)
│           └── agent.ts            # Agent workflow endpoints (full, quick, simops-assess)
│
├── compliance_docs/                # PDF source documents for ingestion
│   ├── IOGP_510.pdf
│   ├── SAFETY-REGULATIONS.pdf
│   └── ...
│
├── docs/
│   ├── api.md                      # REST API reference
│   ├── mcp.md                      # MCP integration guide
│   └── architecture.md             # System architecture
│
├── workTypeRiskData.json           # Risk data for 40+ work types (seed source)
├── PermitoAI.postman_collection.json
├── PermitoAI_Requirements.md
└── package.json
```

---

## Tools

PermitoAI exposes six AI tools, available via both **REST API** and **MCP**:

### HAZARD_SUGGEST
Identifies 5–10 workplace hazards for a job context using AI + vector retrieval of regulations and historical incidents.

**Input:** `JobContext` (job type, location, environment, equipment, contractor, description)
**Output:** Array of hazards with categories, likelihood/severity, controls, DPR references

### RISK_ASSESS
Scores hazards using the risk matrix (likelihood × severity) with rule-based severity floor constraints. Returns an aggregate `summary` with confidence scoring.

**Input:** `Hazard[]`
**Output:** Scored hazards with risk levels, plus `summary` containing `totalMatrixSum`, `averageRiskScore`, `dominantRiskLevel`, `overallAdvice`, `confidenceScore` (0–1), and a `confidenceInterval` (95%)

**Enforced severity minimums:**

| Hazard | Min. Severity |
|---|---|
| H₂S / Hydrogen sulfide | 4 |
| Confined space entry | 4 |
| Fall from height | 4 |
| Hydrocarbon release / Fire | 4 |
| Electrocution / Radiation | 4 |
| Work at height / Hot work | 3 |
| Dropped objects | 3 |
| Explosion / Asphyxiation | 5 |

### COMPLIANCE_CHECK
Validates a permit against three regulatory frameworks using Gemini AI.

**Input:** `JobContext` + `Hazard[]`
**Output:** Per-standard compliance status with findings and recommendations

### PERMIT_VALIDATE
Runs four validation layers sequentially:

| Layer | Type | Speed | Purpose |
|---|---|---|---|
| 1 — Rule-based | Synchronous | < 100ms | Minimum hazards, controls present, DPR refs |
| 2 — Semantic | AI (async) | 2–3s | Logical consistency, completeness |
| 3 — Compliance | AI (async) | 2–3s | DPR/ISO/IOGP standards |
| 4 — Anomaly | Synchronous | < 10ms | Copy-paste detection, duplicates |

**Input:** `JobContext` + `Hazard[]`
**Output:** Pass/fail per layer with specific issues, overall recommendation

### ANOMALY_DETECT
Detects fraud patterns and copy-paste in hazard assessments (rule-based, deterministic).

**Checks:** duplicate hazard names, identical likelihood/severity across all hazards, all-low-risk classification, identical controls across all hazards.

**Input:** `Hazard[]`
**Output:** Issue list with confidence score (0.9)

### SIMOPS_CHECK
Detects two types of conflict for a new permit request against a list of existing permits.

1. **Schedule conflicts** — same work type, overlapping area, overlapping dates
2. **Incompatibility flags** — dangerous work type pairs (e.g. Hot Work + Confined Space Entry → critical)

**Input:** `{ request: PermitRequest, permits: ExistingPermit[] }`
**Output:** `conflicts`, `simopsFlags`, `overallRisk`, `summary`

`workArea` in the request is nullable — omit to check incompatibilities only.

---

## Agent Workflows

Higher-level workflows that chain multiple tools:

### `full-assessment`
Complete pipeline: **HAZARD_SUGGEST → RISK_ASSESS → COMPLIANCE_CHECK + PERMIT_VALIDATE** (last two run in parallel).

Takes a single `JobContext` and returns all step results plus an overall recommendation. `riskAssess.summary` now includes confidence scoring.

### `quick-assess`
Fast pipeline: **HAZARD_SUGGEST → RISK_ASSESS** only.

Returns `requiresFullAssessment: true` if critical or high risks are detected. `riskSummary` now includes full confidence fields.

### `simops-assess`
Full SIMOPS pipeline: **SIMOPS_CHECK → HAZARD_SUGGEST (parallel for each conflicting type) → RISK_ASSESS → AI safety briefing**.

Returns `recommendation` (`HOLD` / `PROCEED WITH CONTROLS` / `SAFE TO PROCEED`), conflict details, and a structured safety briefing with per-conflict mitigations.

---

## API Endpoints

The REST API runs on port `4000` by default. See [docs/api.md](docs/api.md) for the full reference.

```
GET  /api/v1/health
POST /api/v1/tools/hazard-suggest
POST /api/v1/tools/risk-assess
POST /api/v1/tools/compliance-check
POST /api/v1/tools/permit-validate
POST /api/v1/tools/anomaly-detect
POST /api/v1/tools/simops-check
GET  /api/v1/agent/tools
POST /api/v1/agent/full-assessment
POST /api/v1/agent/quick-assess
POST /api/v1/agent/simops-assess
```

Import `PermitoAI.postman_collection.json` into Postman to test all endpoints with pre-built example bodies.

---

## MCP Integration

PermitoAI is an MCP server compatible with Claude and any MCP client. See [docs/mcp.md](docs/mcp.md) for integration details.

```bash
# Stdio (Claude Desktop / claude-code)
pnpm start

# HTTP stream (custom MCP clients)
pnpm start:http
# MCP endpoint: http://localhost:3000/mcp
```

---

## Technology Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js + TypeScript (ES2022) |
| MCP framework | FastMCP |
| REST framework | Hono + @hono/node-server |
| AI provider | Google Gemini (gemini-2.0-flash) |
| Embeddings | Google gemini-embedding-001 (3072-dim) |
| Vector database | Qdrant |
| Schema validation | Zod v4 |
| Package manager | pnpm |

---

## Safety Design

PermitoAI is designed for safety-critical environments. Key decisions:

- **Temperature = 0** — Deterministic AI output. Consistency over creativity in safety contexts.
- **Rule-bounded AI** — Severity constraints override AI predictions for critical hazards.
- **Human-in-the-loop** — System never finalises high-risk permits. All outputs are recommendations requiring human sign-off.
- **Graceful degradation** — If vector DB is unavailable, hazard suggestion falls back to AI-only without RAG.
- **Audit trail** — Every AI call returns `promptTokens` and `completionTokens` for logging and cost tracking.

---

## Scripts

```bash
pnpm start         # Start MCP server (stdio transport)
pnpm start:http    # Start MCP server (HTTP, port 3000)
pnpm api           # Start REST API server (port 4000)
pnpm seed          # Seed Qdrant with regulations and incident data
pnpm ingest        # Ingest compliance PDFs from compliance_docs/
```
