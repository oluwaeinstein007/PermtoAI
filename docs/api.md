# REST API Reference

PermitoAI REST API — port `4000` by default (configurable via `API_PORT` env var).

All requests and responses use `Content-Type: application/json`. All responses include a top-level `success` boolean.

---

## Base URL

```
http://localhost:4000
```

---

## Error responses

| Code | When |
|---|---|
| `400` | Request body fails Zod schema validation |
| `404` | Route does not exist |
| `500` | Service error (AI API failure, internal exception) |

```json
// 400 — validation failure
{
  "success": false,
  "error": "Invalid request body",
  "details": ["jobType: Required", "equipment: Expected array, received string"]
}

// 500 — service error
{
  "success": false,
  "error": "No text returned from Gemini"
}
```

---

## Health

### `GET /api/v1/health`

Returns server status.

**Response**

```json
{
  "success": true,
  "status": "ok",
  "service": "PermitoAI REST API",
  "version": "1.0.0",
  "timestamp": "2026-03-05T10:00:00.000Z",
  "tools": ["HAZARD_SUGGEST", "RISK_ASSESS", "COMPLIANCE_CHECK", "PERMIT_VALIDATE", "ANOMALY_DETECT"]
}
```

---

## Tools

Direct wrappers for each MCP tool. Each endpoint mirrors the corresponding tool exactly.

---

### `POST /api/v1/tools/hazard-suggest`

Identifies 5–10 workplace hazards for a job context using Gemini AI + vector-based retrieval of DPR/IOGP regulations and historical incidents.

**Request body — `JobContext`**

```json
{
  "jobType": "Hot Work",
  "location": "Bonny Terminal, Rivers State",
  "environment": "Onshore crude oil processing facility near active gas flares",
  "equipment": ["Welding machine", "Angle grinder", "Gas detector", "Fire extinguisher"],
  "contractor": {
    "name": "SafeWeld Nigeria Ltd",
    "tier": 2
  },
  "description": "Welding repair work on crude oil pipeline flange. Adjacent hydrocarbon lines remain live."
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `jobType` | string | Yes | Type of job, e.g. `"Hot Work"`, `"Confined Space Entry"` |
| `location` | string | Yes | Work location |
| `environment` | string | Yes | Environmental conditions, e.g. `"Offshore platform"` |
| `equipment` | string[] | Yes | Equipment being used |
| `contractor.name` | string | No | Contractor company name |
| `contractor.tier` | 1\|2\|3 | No | Contractor tier (1 = highest) |
| `description` | string | No | Free-text job description |

**Response**

```json
{
  "success": true,
  "hazardCount": 7,
  "hazards": [
    {
      "name": "Hydrocarbon vapour ignition",
      "category": "chemical",
      "likelihood": 3,
      "severity": 5,
      "recommendedControls": [
        "Continuous gas monitoring with audible alarm",
        "Hot work permit with area isolation",
        "Fire watch posted throughout operation"
      ],
      "dprReference": "DPR EGASPIN Section 5.2.3",
      "explanation": "Adjacent live crude lines create significant vapour accumulation risk during welding."
    }
  ],
  "metadata": {
    "regulationsUsed": 5,
    "incidentsUsed": 3,
    "promptTokens": 1240,
    "completionTokens": 890
  }
}
```

| Field | Description |
|---|---|
| `hazards[].category` | `"chemical"` \| `"physical"` \| `"biological"` \| `"ergonomic"` |
| `hazards[].likelihood` | 1–5 integer (1 = rare, 5 = almost certain) |
| `hazards[].severity` | 1–5 integer (1 = negligible, 5 = catastrophic) |
| `hazards[].dprReference` | DPR regulation ref, e.g. `"DPR EGASPIN Section 5.2.3"` (may be absent) |
| `metadata.regulationsUsed` | Number of regulation vectors retrieved from Qdrant |
| `metadata.incidentsUsed` | Number of incident vectors retrieved from Qdrant |

---

### `POST /api/v1/tools/risk-assess`

Scores hazards using the risk matrix (`likelihood × severity`). Applies rule-based severity floor constraints for critical hazards — AI predictions cannot fall below these minimums.

**Severity floor constraints:**

| Hazard keyword | Min. severity |
|---|---|
| H₂S / hydrogen sulfide | 4 |
| Confined space | 4 |
| Fall from height | 4 |
| Hydrocarbon release / Fire | 4 |
| Electrocution / Radiation | 4 |
| Work at height / Hot work | 3 |
| Dropped object | 3 |
| Explosion / Asphyxiation | 5 |

**Request body**

```json
{
  "hazards": [
    {
      "name": "H2S Exposure",
      "category": "chemical",
      "likelihood": 3,
      "severity": 2,
      "recommendedControls": [
        "Personal H2S monitor worn at all times",
        "SCBA available on standby"
      ],
      "dprReference": "DPR EGASPIN Section 4.1.2",
      "explanation": "Sour gas field operations carry inherent H2S risk."
    }
  ]
}
```

**Response**

```json
{
  "success": true,
  "summary": {
    "critical": 1,
    "high": 1,
    "medium": 2,
    "low": 0
  },
  "rulesApplied": 1,
  "scoredHazards": [
    {
      "hazardName": "H2S Exposure",
      "category": "chemical",
      "likelihood": 3,
      "severity": 4,
      "riskScore": 12,
      "riskLevel": "high",
      "rationale": "Sour gas field operations carry inherent H2S risk. Severity adjusted from 2 to 4 by safety rule constraint. Reference: DPR EGASPIN Section 4.1.2.",
      "ruleApplied": true,
      "controls": ["Personal H2S monitor worn at all times", "SCBA available on standby"]
    }
  ]
}
```

**Risk level thresholds:**

| Score | Level |
|---|---|
| ≥ 15 | `critical` |
| ≥ 10 | `high` |
| ≥ 5 | `medium` |
| < 5 | `low` |

---

### `POST /api/v1/tools/compliance-check`

Validates the permit against three regulatory frameworks using Gemini AI as a regulatory compliance expert.

**Request body**

```json
{
  "jobContext": {
    "jobType": "Confined Space Entry",
    "location": "Forcados Export Terminal, Delta State",
    "environment": "Crude oil storage tank — inert atmosphere",
    "equipment": ["SCBA", "4-gas monitor", "Rescue tripod"],
    "contractor": { "name": "Apex Industrial", "tier": 1 }
  },
  "hazards": [
    {
      "name": "Oxygen-deficient atmosphere",
      "category": "chemical",
      "likelihood": 4,
      "severity": 5,
      "recommendedControls": ["Continuous O2 monitoring", "SCBA worn by all entrants"],
      "dprReference": "DPR EGASPIN Section 6.4.1",
      "explanation": "Nitrogen purging displaces oxygen."
    }
  ]
}
```

**Response**

```json
{
  "success": true,
  "overallCompliant": false,
  "standards": [
    {
      "standard": "DPR EGASPIN",
      "compliant": true,
      "findings": [],
      "recommendations": ["Ensure rescue equipment is tested within 30 days"]
    },
    {
      "standard": "ISO 45001",
      "compliant": false,
      "findings": ["No documented emergency rescue drill within last 6 months"],
      "recommendations": ["Conduct confined space rescue drill before entry"]
    },
    {
      "standard": "IOGP",
      "compliant": true,
      "findings": [],
      "recommendations": []
    }
  ],
  "metadata": {
    "promptTokens": 980,
    "completionTokens": 640
  }
}
```

---

### `POST /api/v1/tools/permit-validate`

Runs four sequential validation layers on a permit. Layers 2 and 3 run in parallel to reduce latency.

**Request body** — same shape as `compliance-check`:

```json
{
  "jobContext": { ... },
  "hazards": [ ... ]
}
```

**Response**

```json
{
  "success": true,
  "recommendation": "Flag for Review",
  "allPassed": false,
  "totalIssues": 2,
  "layers": [
    {
      "layer": "rule_based",
      "passed": true,
      "issueCount": 0,
      "issues": [],
      "confidence": 1.0,
      "details": null
    },
    {
      "layer": "semantic",
      "passed": false,
      "issueCount": 1,
      "issues": ["SIMOPS conflict not assessed — adjacent hydrocarbon lines remain live"],
      "confidence": 0.85,
      "details": null
    },
    {
      "layer": "compliance",
      "passed": false,
      "issueCount": 1,
      "issues": ["ISO 45001 requires documented risk assessment sign-off by HSE Officer"],
      "confidence": 0.9,
      "details": null
    },
    {
      "layer": "anomaly",
      "passed": true,
      "issueCount": 0,
      "issues": [],
      "confidence": 0.9,
      "details": null
    }
  ]
}
```

| `recommendation` value | Meaning |
|---|---|
| `"Recommend Approval"` | All four layers passed |
| `"Flag for Review"` | One or more layers failed — human review required |

**Rule-based checks (Layer 1):**
- At least 1 hazard must be identified
- High-risk job types (hot work, confined space, work at height, diving, radiography) require ≥ 3 hazards
- Every hazard must have at least one control measure
- Hazards with severity ≥ 4 must include a DPR reference
- Equipment list must not be empty

---

### `POST /api/v1/tools/anomaly-detect`

Detects suspicious patterns in hazard assessments. Fully deterministic — no AI calls.

**Request body**

```json
{
  "hazards": [
    {
      "name": "Generic hazard 1",
      "category": "physical",
      "likelihood": 2,
      "severity": 2,
      "recommendedControls": ["Wear PPE", "Follow procedures"],
      "explanation": "Standard risk."
    },
    {
      "name": "Generic hazard 2",
      "category": "physical",
      "likelihood": 2,
      "severity": 2,
      "recommendedControls": ["Wear PPE", "Follow procedures"],
      "explanation": "Standard risk."
    }
  ]
}
```

**Response**

```json
{
  "success": true,
  "anomaliesDetected": true,
  "issueCount": 2,
  "issues": [
    "All hazards have identical likelihood and severity ratings — possible copy-paste. Review individually.",
    "All hazards share identical control measures — controls should be hazard-specific."
  ],
  "confidence": 0.9
}
```

**Anomaly checks performed:**

| Check | Trigger condition |
|---|---|
| Duplicate hazard names | Same name appears more than once |
| Copy-paste ratings | All hazards have identical `likelihood` AND `severity` (requires > 2 hazards) |
| Understated risk | All hazards classify as `low` risk (requires > 3 hazards) |
| Generic controls | All hazards share identical control measure sets (requires > 2 hazards) |

---

## Agent

Orchestrated workflows that chain multiple tools in a single request.

---

### `GET /api/v1/agent/tools`

Lists all available tools and workflows with endpoint paths, descriptions, and input schemas.

**Response** — see [Tools](#tools) section above for structure.

---

### `POST /api/v1/agent/full-assessment`

Complete four-step permit pipeline in a single request.

**Execution order:**
1. `HAZARD_SUGGEST` — identify hazards
2. `RISK_ASSESS` — score hazards
3. `COMPLIANCE_CHECK` + `PERMIT_VALIDATE` — run in parallel

**Request body** — `JobContext` only (hazards are generated by step 1):

```json
{
  "jobType": "Confined Space Entry",
  "location": "QIT Terminal, Imo State",
  "environment": "Crude oil pipeline pig trap — sour service, H2S present",
  "equipment": ["SCBA", "4-gas monitor", "Rescue tripod", "Non-sparking tools"],
  "contractor": { "name": "Pioneer Pipeline Services", "tier": 1 },
  "description": "Retrieval of stuck pig. H2S at 180 ppm at trap opening."
}
```

**Response**

```json
{
  "success": true,
  "jobContext": { ... },
  "recommendation": "Flag for Review",
  "steps": {
    "hazardSuggest": {
      "hazardCount": 8,
      "hazards": [ ... ],
      "metadata": {
        "regulationsUsed": 5,
        "incidentsUsed": 3,
        "promptTokens": 1400,
        "completionTokens": 920
      }
    },
    "riskAssess": {
      "summary": { "critical": 2, "high": 3, "medium": 2, "low": 1 },
      "rulesApplied": 3,
      "scoredHazards": [ ... ]
    },
    "complianceCheck": {
      "overallCompliant": false,
      "standards": [ ... ],
      "metadata": { "promptTokens": 980, "completionTokens": 640 }
    },
    "permitValidate": {
      "allPassed": false,
      "totalIssues": 3,
      "layers": [ ... ]
    }
  }
}
```

> Typical latency: 15–30 seconds (multiple sequential + parallel AI calls).

---

### `POST /api/v1/agent/quick-assess`

Two-step pipeline for rapid initial screening.

**Execution order:**
1. `HAZARD_SUGGEST`
2. `RISK_ASSESS`

**Request body** — same as `full-assessment` (JobContext).

**Response**

```json
{
  "success": true,
  "jobContext": { ... },
  "recommendation": "Requires Full Assessment",
  "requiresFullAssessment": true,
  "hazardCount": 6,
  "riskSummary": {
    "critical": 1,
    "high": 2,
    "medium": 2,
    "low": 1
  },
  "hazards": [ ... ],
  "scoredHazards": [ ... ],
  "metadata": {
    "regulationsUsed": 4,
    "incidentsUsed": 2
  }
}
```

| `recommendation` value | Condition |
|---|---|
| `"Requires Full Assessment"` | Any `critical` or `high` risk detected |
| `"Proceed with Caution"` | All risks are `medium` or `low` |

> Typical latency: 8–12 seconds.

---

## Data schemas

### JobContext

```typescript
{
  jobType: string            // e.g. "Hot Work", "Confined Space Entry"
  location: string           // Work location
  environment: string        // Environmental conditions
  equipment: string[]        // Equipment list (must not be empty for validation)
  contractor?: {
    name: string
    tier: 1 | 2 | 3          // 1 = highest tier
  }
  description?: string       // Free-text job description
}
```

### Hazard

```typescript
{
  name: string
  category: "chemical" | "physical" | "biological" | "ergonomic"
  likelihood: 1 | 2 | 3 | 4 | 5    // 1 = rare, 5 = almost certain
  severity: 1 | 2 | 3 | 4 | 5      // 1 = negligible, 5 = catastrophic
  recommendedControls: string[]
  dprReference?: string              // e.g. "DPR EGASPIN Section 5.2.3"
  explanation: string
}
```
