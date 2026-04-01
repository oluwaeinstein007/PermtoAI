# BotUpdates.md — AI Bot Integration Specification

> This document defines everything the AI bot needs from the ePTW backend to power three core AI features:
> 1. **Intelligent Permit Routing & Decision Recommendation Engine**
> 2. **Fraud & Consistency Checks (Behavioral Anomaly Detection)**
> 3. **Trend Analytics & Predictive Incident Correlation Reporting**

---

## 1. SYSTEM OVERVIEW

**Backend**: Node.js + Express.js (TypeScript)  
**Database**: PostgreSQL via Sequelize ORM (AWS RDS)  
**Base URL**: `http://localhost:8050/api`  
**Auth**: JWT Bearer tokens (`Authorization: Bearer <token>`)  
**AI Integration Point**: `POST /api/agent/*` (proxies to `PERMITO_AI_URL`)  

The bot connects to this backend as a privileged internal service (Super Admin or dedicated `Bot` role). All data flows through existing REST APIs or directly via DB queries for heavy analytics.

---

## 2. FEATURE 1 — INTELLIGENT PERMIT ROUTING & DECISION RECOMMENDATION ENGINE

### 2.1 What It Does
- Analyses a new/submitted permit and recommends the right approver(s) and routing path
- Suggests missing risk controls, work type classification, and permit type
- Flags incomplete or poorly formed permits before submission
- Checks for scheduling conflicts (SIMOPS) between concurrent permits

### 2.2 Data the Bot Needs

#### Permit Data (at submission time)
**API**: `GET /api/permits/:id`  
**Key Fields**:
| Field | Type | Purpose |
|-------|------|---------|
| `type` | STRING | Permit type (e.g., "Hot Work Permit", "CSE Permit") |
| `workType` | STRING | Specific work type (e.g., "Hot Work - Welding/Cutting") |
| `workArea` | STRING | Physical work area |
| `jobType` | STRING | Job category |
| `severity` | STRING | Risk severity: Low / Moderate / High / Severe |
| `likelihood` | STRING | Probability: Low / Unlikely / Likely / Very likely |
| `hazards` | JSON array | List of identified hazards |
| `controlMeasures` | JSON array | Proposed control measures |
| `isolationMethod` | STRING | Isolation technique required |
| `isolationSections` | JSON array | Equipment isolation details |
| `startDate`, `endDate` | DATE | Permit validity window |
| `activeDays` | JSON array | Days the work is active |
| `workShift` | STRING | Shift (Day / Night) |
| `companyId`, `facilityId` | INTEGER | Scoping identifiers |
| `status` | STRING | Current workflow state |
| `issuerId` | INTEGER | Requestor user ID |
| `attachments` | JSON array | Uploaded documents |

#### Work Type Risk Reference Data
**API**: `GET /api/risk-assessment-options?workType=<type>`  
Returns pre-configured hazard lists, control measures, inherent risk scores, and energy level for each of 20+ work types. Used to cross-check what controls are missing from a submitted permit.

#### Active & Pending Permits (for conflict detection)
**API**: `GET /api/permits?status=active&facilityId=<id>`  
**API**: `GET /api/permits?status=submitted&facilityId=<id>`  
Returns all currently active or pending permits at the same facility for SIMOPS analysis.

#### Available Approvers by Role
**API**: `GET /api/admin/users?facility_id=<id>`  
Filter users by role to find available HSE Managers, Supervisors, Isolation Managers, Gas Testers at the permit's facility.

**Role → Routing Responsibility**:
| Role | Routing Responsibility |
|------|----------------------|
| `HSE Manager` | Primary permit approver for most types |
| `Supervisor` | Can approve certain lower-risk permit types |
| `Isolation Manager` | Required when `isolationSections` are present |
| `Gas Tester` | Required for confined space / hot work permits |
| `Admin` | Override authority |

#### Approver Workload Data
**API**: `GET /api/permits?approverId=<userId>&status=submitted`  
Used to check if a potential approver already has a heavy queue — enables workload balancing in routing recommendations.

### 2.3 Routing Logic Inputs the Bot Must Evaluate
1. `workType` → maps to required roles and appropriate permit type
2. `severity` + `likelihood` → maps to risk matrix → determines urgency and escalation
3. `isolationSections` present? → Isolation Manager required in approval chain
4. `hazards` contains toxic gas / confined space indicator? → Gas Tester required
5. Active permits in same `workArea` overlapping `startDate`/`endDate`? → SIMOPS conflict
6. Approver current open permit count → workload balancing across available approvers

### 2.4 Existing AI Hooks (Already Live)

**SIMOPS Check**:
```
POST /api/agent/permits/scheduling/check-conflicts
Body: { "startDate", "endDate", "workType", "workArea" }
```
Proxies to `PERMITO_AI_URL/api/v1/agent/simops-assess`. Timeout: 120 seconds.

**Full Risk Assessment**:
```
POST /api/agent/full-assessment
Body: { "workType": "Confined Space Entry" }
```
Returns hazards, controls, risk rating, recommendations for a given work type.

### 2.5 New Endpoints to Build for Feature 1

#### `POST /api/agent/permits/:id/recommend-routing`
Returns recommended approvers and routing path for a specific permit.
```json
// Response
{
  "recommendedApprovers": [
    { "userId": 5, "name": "Jane Doe", "role": "HSE Manager", "currentQueue": 2 }
  ],
  "routingPath": ["HSE Manager", "Isolation Manager"],
  "missingControls": ["Gas Test Required", "Fire Watch Not Listed"],
  "riskRating": "EXTREME",
  "simopsConflicts": [],
  "confidence": 0.91
}
```

#### `POST /api/agent/permits/:id/pre-submission-check`
Validates permit completeness and flags issues before submission.
```json
// Response
{
  "ready": false,
  "issues": [
    { "field": "controlMeasures", "message": "Missing Gas Test for Hot Work permit" },
    { "field": "isolationPlan", "message": "P&ID document not attached" }
  ],
  "suggestions": ["Add fire watch to control measures", "Attach isolation P&ID"]
}
```

---

## 3. FEATURE 2 — FRAUD & CONSISTENCY CHECKS (BEHAVIORAL ANOMALY DETECTION)

### 3.1 What It Does
- Detects abnormal patterns in permit creation, approval, and signature activity
- Flags users who approve their own permits or act outside their role boundaries
- Identifies duplicate or near-duplicate permits filed by the same user
- Detects unusual time-of-day or frequency spikes in permit activity
- Cross-checks that signatures, roles, and timestamps are internally consistent

### 3.2 Data the Bot Needs

#### Audit Logs (Primary Source)
**API**: `GET /api/audit-logs`  
**Table**: `audit_logs`
| Field | Type | Purpose |
|-------|------|---------|
| `action` | STRING | What happened (e.g., "approve_permit", "assign_isolator") |
| `userId` | INTEGER | Who performed the action |
| `permitId` | INTEGER | Which permit was affected |
| `metadata` | JSON | Additional context |
| `created_at` | DATE | When the action occurred |

**Bot uses audit_logs to detect**:
- Same `userId` issuing and approving the same `permitId`
- Actions performed outside normal working hours
- Unusually high action frequency from one user (e.g., 50 approvals in 1 hour)
- Missing expected audit entries (e.g., permit approved with no `submit_permit` entry before it)

#### Signature Metadata (Chain-of-Custody Validation)
**API**: `GET /api/permits/:id/signatures`  
**Field on Permit**: `signatures` (JSON array)
```json
// Each signature entry:
{
  "userId": 5,
  "userName": "John Smith",
  "userEmail": "john@example.com",
  "role": "HSE Manager",
  "timestamp": "2026-04-01T09:00:00Z",
  "ipAddress": "192.168.1.1",
  "userAgent": "Mozilla/5.0...",
  "signedAt": "2026-04-01T09:00:05Z",
  "signatureType": "approver"
}
```

**Anomaly patterns to detect**:
- `issuerSignature.userId === approverSignature.userId` → Self-approval fraud
- `signatureType` does not match user's actual role from `GET /api/admin/users/:id`
- Two signatures with identical `ipAddress` and `userAgent` within milliseconds → bot/automation fraud
- `signedAt` timestamp precedes `issuedAt` or `created_at` → timestamp tampering
- Same `ipAddress` across multiple different `userId` values on the same permit → credential sharing

#### User Role Verification
**API**: `GET /api/admin/users/:id`  
Returns `{ role_id, roleInfo: { name } }` — cross-checked against the role claimed in signature metadata.

#### Permit Similarity (Duplicate Detection)
**API**: `GET /api/permits?issuerId=<userId>&workArea=<area>&status=submitted`  
Query recent permits from the same user in the same area with overlapping dates.  
**Fields to compare for near-duplicates**:
- `workType`, `workArea`, `jobType`
- `startDate`, `endDate` (overlap)
- `hazards` (array overlap ≥ 80%)
- `controlMeasures` (array overlap ≥ 80%)

#### Isolation Section Consistency
**Field on Permit**: `isolationSections` (JSON array)  
| Check | Rule |
|-------|------|
| Same person cannot isolate and verify | `isolatorId !== verifierId` |
| Same person cannot restore and verify | `restoredById !== verifiedById` |
| Timestamps must be sequential | `isolatorConfirmedAt` < `verifierApprovedAt` |
| Equipment must exist | `equipmentId` must match a record in `common_equipment` |

### 3.3 Behavioral Baseline Metrics (Bot Computes from History)
| Metric | Computation |
|--------|-------------|
| Avg permits created per day | Count(`create_permit` audit actions) / days active per user |
| Typical approval time | Avg(`approvedAt` - `submittedAt`) per approver |
| Normal working hours | Mode of `HOUR(created_at)` per userId |
| Role adherence score | % of audit actions matching role-permitted action list |

**Anomaly threshold**: Deviations > 2 standard deviations from per-user baseline → flagged.

### 3.4 New Endpoints to Build for Feature 2

#### `GET /api/agent/fraud/permits/:id/check`
Runs all consistency checks on a single permit.
```json
// Response
{
  "permitId": 42,
  "flagged": true,
  "severity": "HIGH",
  "anomalies": [
    {
      "type": "SELF_APPROVAL",
      "description": "issuerId (5) matches approverId (5)",
      "affectedFields": ["issuerId", "approverId"]
    },
    {
      "type": "SIGNATURE_ROLE_MISMATCH",
      "description": "User signed as 'HSE Manager' but actual role is 'Requestor'",
      "userId": 7
    }
  ]
}
```

#### `GET /api/agent/fraud/users/:id/anomaly-report`
Returns behavioral anomaly report for a specific user.
```json
// Response
{
  "userId": 5,
  "flagged": true,
  "anomalies": [
    { "type": "HIGH_FREQUENCY", "description": "45 approvals in 1 hour (baseline: 3/hour)" },
    { "type": "OFF_HOURS_ACTIVITY", "description": "Activity at 02:30 AM (usual: 08:00–18:00)" }
  ],
  "riskScore": 0.87
}
```

#### `GET /api/agent/fraud/scan?facilityId=<id>&from=<date>&to=<date>`
Batch anomaly scan across all permits and users in a facility within a date range.

---

## 4. FEATURE 3 — TREND ANALYTICS & PREDICTIVE INCIDENT CORRELATION REPORTING

### 4.1 What It Does
- Generates trend reports on permit volume, type distribution, approval times, rejection rates
- Predicts high-risk periods (dates / shifts / areas) based on historical patterns
- Correlates permit data with incident risk factors (hazard types, work areas, shifts)
- Produces executive-level dashboards with predictive safety insights

### 4.2 Data the Bot Needs

#### Permit Summary Stats
**API**: `GET /api/permits/summary` → counts: active, pending, expiring soon  
**API**: `GET /api/permits/stats` → status / work area distribution  
**API**: `GET /api/permits/calendar` → date-based permit view for time-series

#### All Permits (Batch Analysis)
**API**: `GET /api/permits?page=1&limit=500&facilityId=<id>`

**Key fields for trend analysis**:
| Field | Trend Use |
|-------|-----------|
| `type` | Permit type frequency distribution |
| `workType` | Work category trends |
| `workArea` | High-activity area identification |
| `status` | Approval / rejection rate over time |
| `severity`, `likelihood` | Risk escalation trends |
| `hazards` | Most common hazard types |
| `controlMeasures` | Control coverage gaps |
| `created_at` | Time-series volume analysis |
| `startDate`, `endDate` | Shift / day-of-week patterns |
| `workShift` | Day vs Night shift risk comparison |
| `activeDays` | Day-of-week distribution |
| `closed_at` | Permit lifecycle duration |
| `rejectionReason` | Common rejection causes |
| `suspensionReason` | Work interruption causes |
| `companyId`, `facilityId` | Company / facility benchmarking |
| `completionChecklist` | Checklist completion rates |
| `isolationSections` | Isolation complexity patterns |

#### Audit Log Timeline
**API**: `GET /api/audit-logs`  
Used to compute time spent in each workflow stage (draft → submitted → approved → active → closed) and identify bottleneck stages.

### 4.3 Key Computed Metrics
| Metric | Formula |
|--------|---------|
| Approval Rate | `approved` / `submitted` × 100 |
| Rejection Rate | `rejected` / `submitted` × 100 |
| Avg Approval Time | Mean(`approvedAt` − `submittedAt`) |
| Permit Cycle Time | Mean(`closed_at` − `created_at`) for closed permits |
| Suspension Rate | `suspended` / `active` × 100 |
| High Risk Ratio | (severity=Severe OR likelihood=Very likely) / total |
| Area Risk Score | Σ(severity_weight × likelihood_weight) / permits_in_area |
| Hazard Frequency | Count(hazard_X) / total_permits × 100 per hazard |
| Control Coverage | Avg(actual controls / recommended controls) per work type |
| Isolation Completion | verified_isolations / assigned_isolations × 100 |

### 4.4 Predictive Model Inputs
| Prediction Target | Input Features |
|-------------------|---------------|
| Permit approval time | workType, severity, likelihood, hazard count, day of week |
| Rejection probability | workArea, control completeness, missing attachments, issuer history |
| High-risk date windows | Historical permit density, past rejections, shift patterns |
| Likely hazard types | workType, workArea, equipment involved |
| Compliance risk score | completionChecklist % completion, signature delays |

### 4.5 New Endpoints to Build for Feature 3

#### `GET /api/agent/analytics/trends?facilityId=<id>&from=<date>&to=<date>`
```json
// Response
{
  "period": { "from": "2026-01-01", "to": "2026-03-31" },
  "permitVolume": [
    { "month": "2026-01", "total": 42, "approved": 38, "rejected": 4 }
  ],
  "topHazards": [
    { "hazard": "Fire", "count": 28, "percentage": 66.7 }
  ],
  "riskTrend": [
    { "month": "2026-01", "avgRiskScore": 3.2 }
  ],
  "approvalTimeAvgHours": 18.4,
  "topWorkAreas": [
    { "workArea": "Process Areas", "count": 15, "avgSeverity": "High" }
  ]
}
```

#### `GET /api/agent/analytics/predictions?facilityId=<id>`
```json
// Response
{
  "highRiskPeriods": [
    {
      "dateRange": "2026-04-14 to 2026-04-18",
      "reason": "3 overlapping hot work permits predicted",
      "riskScore": 0.89
    }
  ],
  "predictedBottlenecks": [
    { "stage": "Approval", "estimatedDelayHours": 24, "affectedRole": "HSE Manager" }
  ],
  "recommendedActions": [
    "Schedule additional HSE Manager coverage week of April 14",
    "Pre-stage gas testing equipment for predicted CSE permits"
  ]
}
```

#### `GET /api/agent/analytics/incident-correlation?facilityId=<id>`
```json
// Response
{
  "correlations": [
    {
      "factor": "Night shift permits with >3 hazards",
      "incidentRisk": "HIGH",
      "historicalRate": 0.34,
      "sampleSize": 29
    }
  ],
  "topRiskCombinations": [
    {
      "workType": "Confined Space Entry",
      "workArea": "Process Areas",
      "shift": "Night",
      "riskMultiplier": 2.3
    }
  ]
}
```

#### `GET /api/agent/analytics/compliance-report?companyId=<id>&from=<date>&to=<date>`
Executive-level compliance summary across all facilities in a company.

---

## 5. AUTHENTICATION & BOT ACCESS

### Bot Service Account
The bot authenticates as a Super Admin to access cross-company data.

**Login**:
```
POST /api/login
Body: { "email": "<bot-service-email>", "password": "<bot-service-password>" }
```

Use the returned JWT in all subsequent requests:
```
Authorization: Bearer <token>
```

**Required permissions**:
- Read all permits (any user, any company)
- Read all audit logs
- Read all users
- Write to `/api/agent/*` endpoints
- No permit creation or modification (read-heavy service)

---

## 6. DATABASE DIRECT ACCESS (For Heavy Analytics)

For aggregations over large permit datasets that are impractical via REST, the bot queries PostgreSQL directly.

**Production DB**:
- Host: `eptw-db.cqxg4ikoskd8.us-east-1.rds.amazonaws.com`
- Port: `5432`
- Database: `eptw`
- SSL: Required

### Key SQL Patterns

#### Permit Volume by Month
```sql
SELECT
  DATE_TRUNC('month', created_at) AS month,
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE status = 'approved') AS approved,
  COUNT(*) FILTER (WHERE status = 'rejected') AS rejected
FROM permits
WHERE facility_id = $1
  AND created_at BETWEEN $2 AND $3
GROUP BY 1
ORDER BY 1;
```

#### Top Hazard Frequencies
```sql
SELECT
  hazard_item AS hazard,
  COUNT(*) AS frequency
FROM permits,
  LATERAL jsonb_array_elements_text(hazards::jsonb) AS hazard_item
WHERE facility_id = $1
GROUP BY 1
ORDER BY 2 DESC
LIMIT 10;
```

#### Approval Time Distribution
```sql
SELECT
  p.id,
  p.work_type,
  p.work_area,
  EXTRACT(EPOCH FROM (
    MAX(a.created_at) FILTER (WHERE a.action = 'approve_permit')
    - MIN(a.created_at) FILTER (WHERE a.action = 'submit_permit')
  )) / 3600 AS approval_hours
FROM permits p
JOIN audit_logs a ON a.permit_id = p.id
WHERE p.facility_id = $1
GROUP BY p.id
HAVING MAX(a.created_at) FILTER (WHERE a.action = 'approve_permit') IS NOT NULL;
```

#### User Action Frequency (Anomaly Detection)
```sql
SELECT
  user_id,
  action,
  DATE_TRUNC('hour', created_at) AS hour_bucket,
  COUNT(*) AS action_count
FROM audit_logs
WHERE created_at >= NOW() - INTERVAL '7 days'
GROUP BY 1, 2, 3
HAVING COUNT(*) > 10
ORDER BY 4 DESC;
```

#### Self-Approval Detection
```sql
SELECT
  p.id AS permit_id,
  p.issuer_id,
  p.approver_id,
  u1.name AS issuer_name,
  u2.name AS approver_name
FROM permits p
JOIN users u1 ON u1.id = p.issuer_id
JOIN users u2 ON u2.id = p.approver_id
WHERE p.issuer_id = p.approver_id
  AND p.status IN ('approved', 'active', 'closed');
```

#### Isolation Same-Person Isolate & Verify
```sql
SELECT
  p.id AS permit_id,
  s.value->>'isolatorId' AS isolator_id,
  s.value->>'verifierId' AS verifier_id
FROM permits p,
  LATERAL jsonb_array_elements(isolation_sections::jsonb) AS s(value)
WHERE (s.value->>'isolatorId') = (s.value->>'verifierId')
  AND s.value->>'isolatorId' IS NOT NULL;
```

---

## 7. KEY MODELS SUMMARY

### `permits` — Columns Used by the Bot
| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER UNSIGNED | PK |
| `type` | VARCHAR | Permit type |
| `status` | VARCHAR | draft / submitted / approved / active / closed / rejected |
| `work_type` | VARCHAR | Specific work activity |
| `work_area` | VARCHAR | Physical location |
| `job_type` | VARCHAR | Job category |
| `severity` | VARCHAR | Low / Moderate / High / Severe |
| `likelihood` | VARCHAR | Low / Unlikely / Likely / Very likely |
| `hazards` | JSON | Array of hazard strings |
| `control_measures` | JSON | Array of control strings |
| `isolation_sections` | JSON | Array of IsolationSection objects |
| `signatures` | JSON | Array of SignatureMetadata objects |
| `issuer_id` | INTEGER UNSIGNED | FK → users.id |
| `approver_id` | INTEGER UNSIGNED | FK → users.id |
| `closed_by_id` | INTEGER UNSIGNED | FK → users.id |
| `company_id` | INTEGER UNSIGNED | FK → companies.id |
| `facility_id` | INTEGER UNSIGNED | FK → facilities.id |
| `work_shift` | VARCHAR | Day / Night |
| `active_days` | JSON | Array of day name strings |
| `start_date` | TIMESTAMP | Work start |
| `end_date` | TIMESTAMP | Work end |
| `expires_at` | TIMESTAMP | Permit expiry |
| `suspension_reason` | VARCHAR | Reason if suspended |
| `rejection_reason` | VARCHAR | Reason if rejected |
| `completion_checklist` | JSON | CompletionChecklist object |
| `closed_at` | TIMESTAMP | Permit closure time |
| `created_at` | TIMESTAMP | Record creation |

### `audit_logs` — Key Columns
| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER UNSIGNED | PK |
| `action` | VARCHAR | Action name (no `updated_at` — only `created_at`) |
| `user_id` | INTEGER UNSIGNED | FK → users.id |
| `permit_id` | INTEGER UNSIGNED | FK → permits.id (nullable) |
| `metadata` | JSON | Extra context |
| `created_at` | TIMESTAMP | When action occurred |

### `users` — Key Columns
| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER | PK |
| `name` | VARCHAR | Full name |
| `email` | VARCHAR | Unique |
| `role_id` | INTEGER UNSIGNED | FK → roles.id (authoritative role) |
| `company_id` | INTEGER | FK → companies.id |
| `facility_id` | INTEGER | FK → facilities.id |
| `suspended_at` | TIMESTAMP | NULL = active user |
| `deleted_at` | TIMESTAMP | NULL = not deleted (paranoid soft delete) |

### `roles` — Seeded Values
| id | name |
|----|------|
| 1 | Super Admin |
| 2 | Admin |
| 3 | HSE Manager |
| 4 | Supervisor |
| 5 | Isolation Manager |
| 6 | Gas Tester |
| 7 | Requestor |

---

## 8. EXISTING AI ENDPOINTS (Already Live)

| Endpoint | Method | Purpose | External Target |
|----------|--------|---------|----------------|
| `/api/agent/permits/scheduling/check-conflicts` | POST | SIMOPS conflict check | `PERMITO_AI_URL/api/v1/agent/simops-assess` |
| `/api/agent/full-assessment` | POST | Full risk assessment by work type | `PERMITO_AI_URL/api/v1/agent/full-assessment` |

Both have a 120-second timeout. Errors: network failure → 502, timeout → 504.

---

## 9. NEW ENDPOINTS SUMMARY (All Three Features)

| Endpoint | Method | Feature | Priority |
|----------|--------|---------|----------|
| `/api/agent/permits/:id/recommend-routing` | POST | Feature 1 | High |
| `/api/agent/permits/:id/pre-submission-check` | POST | Feature 1 | High |
| `/api/agent/fraud/permits/:id/check` | GET | Feature 2 | High |
| `/api/agent/fraud/users/:id/anomaly-report` | GET | Feature 2 | Medium |
| `/api/agent/fraud/scan` | GET | Feature 2 | Medium |
| `/api/agent/analytics/trends` | GET | Feature 3 | High |
| `/api/agent/analytics/predictions` | GET | Feature 3 | Medium |
| `/api/agent/analytics/incident-correlation` | GET | Feature 3 | Medium |
| `/api/agent/analytics/compliance-report` | GET | Feature 3 | Low |

**All new endpoints must**:
- Require `Authorization: Bearer <token>` (Admin or Bot role)
- Accept `facilityId` query param for scoping
- Accept `from` and `to` ISO 8601 date strings for time-range filtering
- Return `{ data: ... }` envelope consistent with existing API format

---

## 10. PUSH NOTIFICATIONS (Bot → Users)

The bot can trigger real-time alerts using the existing push notification service functions already in the codebase.

| Function | Use |
|----------|-----|
| `notifyUser(userId, payload)` | Alert a single user |
| `notifyUsers(userIds[], payload)` | Batch alert multiple users |
| `notifyRole(role, companyId, payload)` | Alert all users with a given role |

**Alert payload format**:
```json
{
  "title": "Anomaly Detected",
  "body": "Permit #42 flagged for self-approval. Review required.",
  "icon": "/icons/alert.png",
  "data": {
    "permitId": 42,
    "alertType": "FRAUD",
    "severity": "HIGH"
  }
}
```

**Bot notification use cases**:
- Fraud anomaly detected → notify Admin
- Routing recommendation ready → notify issuer
- High-risk period predicted → notify HSE Manager
- Permit approaching expiry → notify approver

---

## 11. ENVIRONMENT VARIABLES THE BOT NEEDS

```bash
# Backend URL
EPTW_BACKEND_URL=http://localhost:8050/api

# Bot service account (Super Admin)
BOT_EMAIL=bot@eptw-system.internal
BOT_PASSWORD=<secure_password>

# Direct DB access for heavy analytics
DB_HOST=eptw-db.cqxg4ikoskd8.us-east-1.rds.amazonaws.com
DB_PORT=5432
DB_DATABASE=eptw
DB_USERNAME=postgres
DB_PASSWORD=<password>
DB_SSL=true

# External AI service (already configured in backend .env)
PERMITO_AI_URL=http://68.183.32.193:4000
```

---

## 12. IMPORTANT CONSTRAINTS & GOTCHAS

1. **No `updated_at` on audit_logs** — table has `created_at` only. Always use `created_at` for time-series queries on audit data.
2. **JSON fields need casting in raw SQL** — `hazards::jsonb`, `isolation_sections::jsonb`, etc. Use `jsonb_array_elements` / `jsonb_array_elements_text` for array expansion.
3. **Paranoid deletes on users** — always include `WHERE deleted_at IS NULL` in user queries or Sequelize `paranoid: true` will handle it automatically.
4. **Dual role fields** — users have both a legacy string `role` column and a FK `role_id`. Always join to `roles` table via `role_id` for authoritative role data; do not trust the `role` string column.
5. **No `submittedAt` column on permits** — infer submission time from `audit_logs` where `action = 'submit_permit'` for the given `permit_id`.
6. **Column naming** — Sequelize model uses camelCase (`issuerId`) but the DB column is snake_case (`issuer_id`). Use snake_case in all raw SQL.
7. **Permit visibility scoping** — filter by `facility_id` for facility-level analytics; only Super Admin can query cross-facility without scoping.
8. **External AI service timeout** — 120 seconds. Bot must handle `504` gracefully and implement exponential backoff retry.
9. **CORS** — backend allows `origin: "*"`, so the bot can call from any host without additional configuration.
10. **IsolationSection identities are strings in JSON** — `isolatorId` and `verifierId` stored as string numbers inside JSON; compare with `CAST` or string comparison in SQL.
