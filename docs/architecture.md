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

> **New in current version:** `SimopsService` (schedule conflict detection + incompatibility matrix), compliance document ingestion pipeline (`src/ingest.ts`), and `RiskScoringService.computeSummary()` (aggregate matrix summary with confidence scoring).

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

RiskScoringService.computeSummary(scoredHazards[])
        │
        ├─ counts           { critical, high, medium, low }
        ├─ totalMatrixSum   Σ(likelihood × severity)
        ├─ averageRiskScore totalMatrixSum / n
        ├─ dominantRiskLevel  highest level present
        ├─ rulesApplied     count of hazards with ruleApplied = true
        │
        ├─ overallAdvice    tiered string:
        │     critical → "STOP WORK — ..."
        │     high     → "HOLD — ..."
        │     medium   → "CAUTION — ..."
        │     low      → "PROCEED — ..."
        │
        ├─ confidenceScore (0.0–0.95)
        │     base 0.55
        │     + 0.10 if rulesApplied/n ≥ 0.3
        │     + 0.10 if all hazards have DPR reference
        │     + 0.10 if n ≥ 5  (+0.05 if n ≥ 8)
        │     - 0.15 if n < 3  (too sparse)
        │     - 0.05 if coefficient of variation > 0.6
        │
        └─ confidenceInterval { lower, upper, level: "95%" }
              mean ± 1.96 × (σ / √n)
```

This enforces the "rules constrain" principle — AI-generated severity values cannot fall below the regulatory minimums for critical hazard types.

---

## SIMOPS engine

```
SimopsService.checkSimops(request, permits[])
        │
        ├─ Schedule conflict detection:
        │     For each permit with same workType + overlapping workArea:
        │       Check date overlap: max(start1,start2) < min(end1,end2)
        │       → scheduleConflicts[]
        │
        ├─ Incompatibility matrix check:
        │     For each permit, lookup (requestWorkType, permitWorkType)
        │     in INCOMPATIBLE_PAIRS table (bidirectional)
        │     → simopsFlags[] { permitId, severity, reason }
        │
        ├─ overallRisk = max severity across all conflicts + flags
        │     none | medium | high | critical
        │
        └─ summary string for approver display
```

**Known incompatible pairs (bidirectional):**

| Work type A | Work type B | Severity |
|---|---|---|
| Hot Work | Confined Space Entry | critical |
| Hot Work | Gas Testing / Gas Work | critical |
| Hot Work | H₂S / Toxic Gas Work | critical |
| Radiography / NDT | any concurrent work | high |
| Blasting / Explosives | any concurrent work | critical |
| Excavation / Trenching | Underground Services | high |

---

## Vector database structure

Three Qdrant collections are used:

### `permito_regulations`

Populated by `pnpm seed`. Source: `workTypeRiskData.json` (40+ work type risk profiles).

```
Payload schema:
  workType: string
  permitType: string
  riskCategory: string
  hazards: string[]
  controlMeasures: string[]
  recommendation: string
  inherentLikelihood: number
  inherentImpact: number
  energyLevel: string
  residualRisk: string
```

### `permito_incidents`

Populated by `pnpm seed`. Source: 17 synthetic historical incidents (defined in `seed.ts`).

```
Payload schema:
  description: string
  workType: string
  hazard_names: string[]
  outcome: "critical" | "high" | "medium"
  lessons_learned: string
  location: string
```

### `permito_compliance_docs`

Populated by `pnpm ingest`. Source: PDFs in `compliance_docs/`.

```
Payload schema:
  content: string         — chunked text (1400 chars, 180-char overlap)
  sourceFile: string      — original PDF filename
  chunkIndex: number      — chunk sequence number within file
  totalChunks: number     — total chunks for this file
  pageHint: string        — estimated page location (e.g. "~p.3/45")
  ingestedAt: string      — ISO timestamp
```

Deduplication: each chunk is identified by a SHA-256 hash of its content converted to a numeric ID. Re-running `pnpm ingest` upserts the same IDs — no duplicate points are created.

**Ingestion pipeline options:**

```bash
pnpm ingest                           # ingest all PDFs in compliance_docs/
pnpm ingest -- --file IOGP_510.pdf    # single file
pnpm ingest -- --clean                # drop collection and re-ingest all
pnpm ingest -- --clean-file           # delete old chunks per file, then re-ingest
```

Vector dimensions: **3072** (Google `gemini-embedding-001`) for all three collections.

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
├── seed.ts                     Qdrant collection seeder (regulations + incidents)
├── ingest.ts                   Compliance PDF ingestion pipeline
├── run_tool.ts                 Manual tool test runner
│
├── schemas/index.ts            Zod schemas (source of truth for all types)
│                               JobContext, Hazard, RiskScore, Permit,
│                               ValidationResult, ComplianceResult, TokenUsage
│
├── tools/
│   ├── hazard_suggest.ts       MCP tool → HazardService.suggestHazards()
│   ├── risk_assess.ts          MCP tool → RiskScoringService.scoreHazards() + computeSummary()
│   ├── compliance_check.ts     MCP tool → chatCompletion() (inline)
│   ├── permit_validate.ts      MCP tool → ValidationService.validatePermit()
│   └── anomaly_detect.ts       MCP tool → ValidationService.anomalyDetection()
│
├── services/
│   ├── hazardService.ts        RAG pipeline (embed → vector search → Gemini → parse)
│   ├── riskScoringService.ts   Risk matrix + severity floors + computeSummary (confidence)
│   ├── simopsService.ts        SIMOPS conflict detection + incompatibility matrix
│   ├── validationService.ts    4-layer validation (rule/semantic/compliance/anomaly)
│   ├── embeddingService.ts     Google Gemini SDK wrapper (embedText, chatCompletion)
│   └── vectorService.ts        Qdrant wrapper (searchRegulations, searchIncidents, searchComplianceDocs)
│
└── api/
    ├── server.ts               Hono app + @hono/node-server bootstrap
    ├── middleware/
    │   └── errorHandler.ts     ZodError → 400, Error → 500
    └── routes/
        ├── tools.ts            6 tool endpoints (HAZARD_SUGGEST, RISK_ASSESS, COMPLIANCE_CHECK,
        │                                         PERMIT_VALIDATE, ANOMALY_DETECT, SIMOPS_CHECK)
        └── agent.ts            4 agent endpoints (full-assessment, quick-assess, simops-assess,
                                                   GET tools)
```

---

## Dependency graph

```
MCP Tools / REST Routes
        │
        ▼
   Services (business logic)
        │
        ├──► hazardService      ──► embeddingService ──► Google Gemini API
        │                       ──► vectorService    ──► Qdrant (regulations + incidents)
        ├──► riskScoringService  (pure, no external deps)
        ├──► simopsService       (pure, no external deps)
        ├──► validationService  ──► embeddingService (layers 2 & 3)
        ├──► embeddingService   ──► Google Gemini API
        ├──► vectorService      ──► Qdrant REST API
        └──► schemas/index.ts   (Zod — shared type definitions)

ingest.ts (script, not a service)
        │
        ├──► embeddingService   ──► Google Gemini API
        └──► Qdrant REST API    (permito_compliance_docs collection)
```

No circular dependencies. Services do not import from tools or routes.
