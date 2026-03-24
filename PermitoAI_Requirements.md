# PermitoAI Requirements Document

## Executive Summary

**Context:** Safety-critical permit-to-work system with HIRA/JSA, DPR/ISO-aligned compliance  
**Guiding Principle:** _AI assists, rules constrain, humans decide, logs remember._

**Regulatory Framework:**
- DPR Nigeria (Department of Petroleum Resources)
- IOGP (International Association of Oil & Gas Producers)
- ISO 45001

---

## Project Timeline

### Sprint 2 (Weeks 1-4): Hazard Identification & Risk Assessment
Core focus on AI-powered hazard suggestion and risk assessment capabilities.

### Sprint 3 (Weeks 5-8): Approvals, Validation, and Intelligent Routing
Implementation of multi-layer validation, compliance checking, and workflow automation.

---

## System Architecture

### Core Features

1. **AI-Powered Hazard Suggestion Engine**
   - Automatically suggest hazards based on job activity and context
   - Historical incident analysis and pattern matching
   - Industry best practice recommendations
   
2. **Automated Compliance Checking**
   - Real-time validation against DPR, IOGP, and ISO standards
   - Intelligent routing based on risk levels and competency requirements
   
3. **Multi-Layer Validation System**
   - Layer 1: Fast rule-based checks (< 100ms)
   - Layer 2: AI semantic analysis (2-3 seconds)
   - Layer 3: Standards compliance (ISO/HIRA/DPR)
   - Layer 4: Anomaly detection

4. **Risk Matrix with Explainability**
   - Rule-bounded severity floors for critical hazards
   - Audit-ready rationale for all risk assessments
   - Aggregate matrix summary: totalMatrixSum, averageRiskScore, dominantRiskLevel
   - Confidence scoring (0–1) and 95% confidence interval per assessment

5. **SIMOPS (Simultaneous Operations) Conflict Detection** ✅ *Implemented*
   - Schedule conflict detection: same work type + area + overlapping dates
   - Incompatibility matrix: flags dangerous work type combinations (e.g. Hot Work + Confined Space Entry)
   - SIMOPS assess workflow: conflict check → parallel hazard suggestion → risk scoring → AI safety briefing
   - Recommendation: HOLD / PROCEED WITH CONTROLS / SAFE TO PROCEED

6. **Compliance Document Ingestion Pipeline** ✅ *Implemented*
   - Batched PDF ingestion from `compliance_docs/` directory
   - Smart text chunking (paragraph-aware, sentence-boundary splits, 1400-char chunks with 180-char overlap)
   - Deduplication via SHA-256 content hash as Qdrant point ID (re-runs are idempotent)
   - Per-file clean mode and full collection reset options
   - Stored in `permito_compliance_docs` Qdrant collection, searchable via `vectorService.searchComplianceDocs()`

---

## Technical Implementation

### Stage 1: Vector Embeddings & Contextual Retrieval

**Architecture:**
- Store Nigerian DPR regulations and IOGP incident data in Vector DB (Pinecone/Milvius)
- Implement contextual retrieval for relevant safety protocols

**Example Flow:**
```
User Input: "Welding on a 10-meter platform"
System Retrieves: "Work at Height" + "Hot Work" protocols
```

**Implementation:**
- Use ChatOpenAI with `withStructuredOutput` in LangChain.js
- Input: Job Description + Retrieved Safety Documentation
- Output: Structured array of HazardSchema objects

### Stage 2: Hazard Identification & Risk Assessment

**Core Components:**

#### Hazard Suggestion Engine

**System Instruction:**
```
You are an expert HSE AI assistant specialized in Nigerian oil & gas operations.
You are trained on IOGP safety standards and Nigerian DPR regulations.

Your role is to identify workplace hazards and suggest appropriate controls based on:
- Job type and context
- Historical incident data
- Industry best practices
- Nigerian regulatory requirements

Always prioritize worker safety and compliance. Provide specific, actionable recommendations.
```

**Prompt Template:**
```
Analyze this permit-to-work scenario and identify hazards:

JOB CONTEXT:
- Job Type: ${context.jobType}
- Location: ${context.location}
- Environment: ${context.environment}
- Equipment: ${context.equipment.join(', ')}
- Contractor: ${context.contractor?.name} (Tier ${context.contractor?.tier})

SIMILAR HISTORICAL INCIDENTS:
${incidentSummary || 'No similar incidents found.'}

TASK:
Generate 5-10 potential hazards for this job. For each hazard, provide:
1. name: Clear hazard description
2. category: One of [chemical, physical, biological, ergonomic]
3. likelihood: Rating 1-5 (1=rare, 5=almost certain)
4. severity: Rating 1-5 (1=negligible, 5=catastrophic)
5. recommendedControls: Array of specific control measures
6. dprReference: Nigerian DPR regulation reference (if applicable)
7. explanation: Brief rationale for why this hazard is relevant

CRITICAL FOCUS AREAS:
- H₂S exposure in sour gas fields
- Confined space entry hazards
- Hot work in hydrocarbon environments
- SIMOPS (Simultaneous Operations) conflicts
- Dropped objects on offshore platforms

Return ONLY valid JSON array of hazards. No markdown, no explanations outside the JSON.
```

**Example Output:**
```json
[
  {
    "name": "H₂S gas exposure",
    "category": "chemical",
    "likelihood": 4,
    "severity": 5,
    "recommendedControls": [
      "Continuous gas monitoring",
      "Escape breathing apparatus",
      "Wind direction monitoring"
    ],
    "dprReference": "DPR EGASPIN Section 5.2.3",
    "explanation": "Sour gas field environment presents high H₂S risk requiring constant monitoring"
  }
]
```

#### Vector Similarity (Missed Hazard Guardrail)

**Purpose:** Catch rare but historical risks by analyzing similar past permits

**Implementation:**
```typescript
embedding = embed(jobDescription + context)
// Query top-K similar jobs
// Merge discovered hazards with AI-suggested ones
```

**Benefit:** Provides safety net for edge cases not caught by primary AI analysis

#### Risk Scoring Engine

**Data Structure:**
```typescript
interface RiskScore {
  likelihood: 1 | 2 | 3 | 4 | 5;  // ML-predicted
  severity: 1 | 2 | 3 | 4 | 5;    // Rule-bounded
  risk: number;                    // likelihood × severity
}
```

**Rule-Based Constraints:**
```typescript
// Example: Critical hazards have minimum severity
if (hazard === "H2S") {
  severity = Math.max(severity, 4);
}
```

#### Explainability Layer (Audit-Critical)

Each hazard assessment must answer:
- **Why suggested?** - Rule trace and regulatory basis
- **Why this likelihood?** - ML feature importance (SHAP values)
- **Why this severity?** - Similar job evidence and historical data

**Display Format:**
> "High H₂S risk due to sour field location and 3 incidents in similar jobs (2024-2025)."

**Critical Configuration:**
- **Temperature Setting:** 0 (consistency over creativity in safety contexts)
- **Explainability:** Every risk score includes rationale citing specific incidents or regulations
- **Usage Rule:** Only add suggestions if confidence ≥ defined threshold
- **User Control:** All suggestions remain editable by permit creator

### Stage 3: Approvals & Validation

**Multi-Agent Validation Architecture:**

1. **Agent A (Compliance)**
   - Validates against ISO/DPR standards
   - Checks regulatory requirement fulfillment
   
2. **Agent B (Competency)**
   - Cross-references user ID with training database
   - Verifies certification and authorization levels
   
3. **Agent C (SIMOPS)** ✅ *Implemented*
   - Checks for overlapping permit schedules (same work type + area + overlapping dates)
   - Identifies incompatible simultaneous work type combinations via a rule-based matrix
   - Full workflow available at `POST /api/v1/agent/simops-assess`

**Anomaly Detection:**
- Compare current permit against baseline "Good" permits using cosine similarity
- Flag if similarity score < 0.7
- Detect duplicate permits, identical readings, copy-pasted risk assessments

**Techniques:**
- Isolation Forest for outlier detection
- Similarity thresholds for fraud prevention

**Approver AI Support:**

Approvers receive intelligent summaries:
- Consolidated risk overview
- Similar past permits analysis
- Suggested mitigations with historical context

**Example:**
> "Similar permits delayed due to missing fire watch certification."

---

## Critical Safety Guardrails

### Human-in-the-Loop (HITL)

**Core Principle:** AI recommends, humans authorize

- AI provides: "Recommend Approval" or "Flag for Review"
- **Never:** Finalize High-Risk permits without manual signature
- All critical decisions require human oversight

### Traceability & Audit Compliance

**Required Logging:**
- `prompt_tokens` and `completion_tokens` for each AI interaction
- Complete reasoning chain and decision rationale
- Timestamp and user identity for all approvals
- DPR auditor-ready documentation trail

### Hallucination Prevention

**Checklist Validator:**
- Verify AI hasn't invented non-existent safety equipment
- Cross-reference suggestions against actual inventory
- Flag discrepancies for human review

### Bias Mitigation

**Intelligent Routing:**
- Monitor for bottlenecks in specific teams
- Prevent routing bias based on historical delay data
- Ensure equitable distribution of review workload

---

## Testing & Quality Assurance

### Validation Checklist

- [ ] H₂S detection accuracy in sour gas fields
- [ ] Confined space hazards correctly identified
- [x] SIMOPS conflicts properly flagged (schedule + incompatibility matrix)
- [ ] DPR regulatory references accurate and current
- [ ] Explanation quality reviewed by HSE expert
- [ ] Response time < 3 seconds for all AI operations
- [ ] Graceful degradation on API failure (fallback to rule-based)
- [ ] Hallucination checks pass for all equipment recommendations
- [ ] Bias metrics within acceptable thresholds

---

## Technical Debt & Risk Management

### Known Limitations

1. **API Dependency:** System requires fallback mechanisms for AI service outages
2. **Training Data Currency:** Regular updates required for evolving regulations
3. **Edge Case Coverage:** Continuous monitoring needed for rare scenarios

### Mitigation Strategies

- Implement rule-based fallbacks for critical safety functions
- Quarterly review of DPR regulation changes
- User feedback loop for missed hazard scenarios
- Regular retraining on incident database updates

---

## Appendix: Data Schemas

### HazardSchema
```typescript
interface Hazard {
  name: string;
  category: 'chemical' | 'physical' | 'biological' | 'ergonomic';
  likelihood: 1 | 2 | 3 | 4 | 5;
  severity: 1 | 2 | 3 | 4 | 5;
  recommendedControls: string[];
  dprReference?: string;
  explanation: string;
}
```

### RiskScore
```typescript
interface RiskScore {
  likelihood: 1 | 2 | 3 | 4 | 5;
  severity: 1 | 2 | 3 | 4 | 5;
  risk: number; // likelihood × severity
  rationale: string;
  historicalEvidence?: string[];
}
```

### RiskMatrixSummary
```typescript
interface RiskMatrixSummary {
  counts: { critical: number; high: number; medium: number; low: number };
  totalMatrixSum: number;          // Σ(likelihood × severity)
  averageRiskScore: number;        // mean risk score
  dominantRiskLevel: RiskLevel;    // highest level present
  rulesApplied: number;            // hazards with severity raised by safety rule
  overallAdvice: string;           // STOP WORK | HOLD | CAUTION | PROCEED
  confidenceScore: number;         // 0.0–0.95
  confidenceInterval: { lower: number; upper: number; level: "95%" };
}
```

### PermitRequest (SIMOPS)
```typescript
interface PermitRequest {
  startDate: string;        // ISO date or datetime
  endDate: string;
  workType: string;
  workArea?: string | null; // nullable — omit to skip schedule conflict matching
}
```

### ExistingPermit (SIMOPS)
```typescript
interface ExistingPermit {
  id: number | string;
  status: string;
  workType: string;
  workArea?: string | null;
  startDate: string;
  endDate: string;
  type?: string;
  jobType?: string;
}
```

---

**Document Version:** 1.1
**Last Updated:** March 2026
**Status:** Active Development
