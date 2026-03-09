# System Architecture

---

## Overview

PermitoAI has two independent server processes that can run concurrently:

```
┌─────────────────────────────────────────────────────────┐
│                      PermitoAI                          │
│                                                         │
│   ┌──────────────────┐    ┌──────────────────────────┐  │
│   │   MCP Server     │    │      REST API Server     │  │
│   │   (port 3000)    │    │      (port 4000)         │  │
│   │   FastMCP        │    │      Hono                │  │
│   │   stdio / HTTP   │    │      @hono/node-server   │  │
│   └────────┬─────────┘    └───────────┬──────────────┘  │
│            │                          │                  │
│            └──────────┬───────────────┘                  │
│                       │                                  │
│              ┌────────▼────────┐                         │
│              │    Services     │                         │
│              │  ─────────────  │                         │
│              │  HazardService  │                         │
│              │  RiskScoring    │                         │
│              │  Validation     │                         │
│              │  Embedding      │                         │
│              │  Vector         │                         │
│              └────────┬────────┘                         │
│                       │                                  │
│          ┌────────────┴────────────┐                     │
│          │                         │                    │
│   ┌──────▼──────┐         ┌────────▼────────┐           │
│   │  Google     │         │     Qdrant      │           │
│   │  Gemini API │         │  Vector DB      │           │
│   │  (AI + EMB) │         │  (RAG store)    │           │
│   └─────────────┘         └─────────────────┘           │
└─────────────────────────────────────────────────────────┘
```

Both servers share the same service layer — no logic is duplicated.

---

## Request flow: hazard suggestion

```
Client Request (JobContext)
        │
        ▼
HazardService.suggestHazards()
        │
        ├─ embedText(jobType + location + equipment + description)
        │         │
        │         ▼
        │   Google Gemini Embeddings API
        │   (gemini-embedding-001, 3072-dim vector)
        │
        ├─ VectorService.searchRegulations(vector)    ┐
        │                                             │ parallel
        └─ VectorService.searchIncidents(vector)      ┘
                  │
                  ▼
           Qdrant top-K nearest neighbours
           (permito_regulations + permito_incidents collections)
                  │
                  ▼
        buildHazardPrompt(context, regulations, incidents)
                  │
                  ▼
        chatCompletion([system, user])
                  │
                  ▼
        Google Gemini (gemini-2.0-flash, temp=0, JSON mode)
                  │
                  ▼
        Parse + validate with Zod (HazardSchema[])
                  │
                  ▼
        mergeIncidentHazards()
        (missed hazard guardrail — adds any incidents the AI missed)
                  │
                  ▼
        HazardSuggestionResult { hazards, tokens, regulationsUsed, incidentsUsed }
```

---

## Request flow: permit validation (4 layers)

```
ValidationService.validatePermit(context, hazards)
        │
        ├── Layer 1: ruleBasedChecks()               [sync, < 100ms]
        │     - Min 1 hazard
        │     - High-risk jobs require ≥ 3 hazards
        │     - Every hazard has ≥ 1 control
        │     - Severity ≥ 4 requires DPR reference
        │     - Equipment list not empty
        │
        ├── Layer 2: semanticAnalysis()               [async, 2-3s]
        │     - Gemini AI checks logical consistency
        │     - Identifies missing obvious hazards
        │     ↕ (parallel with Layer 3)
        ├── Layer 3: complianceCheck()                [async, 2-3s]
        │     - Gemini AI validates DPR/ISO/IOGP
        │
        └── Layer 4: anomalyDetection()               [sync, < 10ms]
              - Duplicate hazard names
              - Copy-paste ratings detection
              - All-low-risk understatement
              - Identical controls across hazards
```

Layers 2 and 3 run in parallel via `Promise.all()` to minimise total latency.

---

## Risk scoring engine

```
RiskScoringService.scoreHazards(hazards[])
        │
        For each hazard:
        │
        ├─ Lookup hazard name against CRITICAL_HAZARD_RULES
        │     (case-insensitive substring match)
        │
        ├─ If rule found AND AI severity < minSeverity:
        │     severity = minSeverity   ← rule overrides AI
        │     ruleApplied = true
        │
        ├─ risk = likelihood × severity
        │
        ├─ riskLevel = classifyRisk(risk)
        │     ≥ 15 → critical
        │     ≥ 10 → high
        │     ≥  5 → medium
        │      < 5 → low
        │
        └─ rationale = explanation + rule adjustment note + DPR reference
```

This enforces the "rules constrain" principle — AI-generated severity values cannot fall below the regulatory minimums for critical hazard types.

---

## Vector database structure

Two Qdrant collections are populated by `pnpm seed`:

### `permito_regulations`

Source: `workTypeRiskData.json` (40+ work type risk profiles)

```
Payload schema:
  workType: string
  permitType: string
  riskCategory: string
  hazards: string[]
  controlMeasures: string[]
  regulations: string[]
```

### `permito_incidents`

Source: 17 synthetic historical incidents (defined in `seed.ts`)

```
Payload schema:
  description: string
  hazards: string
  hazard_names: string[]
  lessons: string
  location: string
  severity: "critical" | "high"
```

Vector dimensions: **3072** (Google `gemini-embedding-001`).

---

## AI configuration

| Setting | Value | Reason |
|---|---|---|
| Model | `gemini-2.0-flash` | Speed vs. capability balance for safety-critical use |
| Temperature | `0` | Deterministic, consistent output — safety contexts require reproducibility |
| Response format | JSON mode (`application/json`) | Structured output for all tool calls |
| Embedding model | `gemini-embedding-001` | High-dimensional (3072) for precise regulation retrieval |
| Embedding dimensions | `3072` | Configured for maximum recall in regulation similarity search |

---

## Graceful degradation

### Qdrant unavailable

If the vector database is down or returns an error during `embedText()`, `HazardService` catches the error and falls back to `suggestWithoutVectors()` — calling Gemini AI directly with an empty regulation and incident context. Hazard quality is reduced but the service remains available.

### Gemini unavailable

- Layer 2 (semantic analysis) and Layer 3 (compliance check) in `ValidationService` both catch errors and return a passing result with an explanatory note: `"Semantic analysis unavailable — skipped."` / `"Compliance check unavailable — skipped."`. Layer 1 and Layer 4 are not AI-dependent.
- REST API routes propagate errors to the global `errorHandler` middleware, returning `{ success: false, error: message }` with HTTP 500.

---

## Source file map

```
src/
├── index.ts                    MCP server bootstrap
├── config.ts                   env vars with defaults
├── seed.ts                     Qdrant collection seeder
├── run_tool.ts                 Manual tool test runner
│
├── schemas/index.ts            Zod schemas (source of truth for all types)
│                               JobContext, Hazard, RiskScore, Permit,
│                               ValidationResult, ComplianceResult, TokenUsage
│
├── tools/
│   ├── hazard_suggest.ts       MCP tool → HazardService.suggestHazards()
│   ├── risk_assess.ts          MCP tool → RiskScoringService.scoreHazards()
│   ├── compliance_check.ts     MCP tool → chatCompletion() (inline)
│   ├── permit_validate.ts      MCP tool → ValidationService.validatePermit()
│   └── anomaly_detect.ts       MCP tool → ValidationService.anomalyDetection()
│
├── services/
│   ├── hazardService.ts        RAG pipeline (embed → vector search → Gemini → parse)
│   ├── riskScoringService.ts   Risk matrix + rule-based severity floors
│   ├── validationService.ts    4-layer validation (rule/semantic/compliance/anomaly)
│   ├── embeddingService.ts     Google Gemini SDK wrapper (embedText, chatCompletion)
│   └── vectorService.ts        Qdrant REST client wrapper (searchRegulations, searchIncidents)
│
└── api/
    ├── server.ts               Hono app + @hono/node-server bootstrap
    ├── middleware/
    │   └── errorHandler.ts     ZodError → 400, Error → 500
    └── routes/
        ├── tools.ts            5 tool endpoints (call same services as MCP tools)
        └── agent.ts            3 agent endpoints (orchestrated multi-step pipelines)
```

---

## Dependency graph

```
MCP Tools / REST Routes
        │
        ▼
   Services (business logic)
        │
        ├──► embeddingService   ──► Google Gemini API
        ├──► vectorService      ──► Qdrant REST API
        └──► schemas/index.ts   (Zod — shared type definitions)
```

No circular dependencies. Services do not import from tools or routes.
