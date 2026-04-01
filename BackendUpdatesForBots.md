# BackendUpdatesForBots.md — ePTW Backend Change List for AI Features

> Accurate as of 2026-04-01. Based on reading the actual ePTW backend code at `/home/hp/Desktop/Software Projects/ePTW-backend`.

---

## STATUS SUMMARY

| Item | Status |
|------|--------|
| 9 proxy endpoints in `agent.controller.ts` | ✅ Done |
| 9 routes registered in `api.ts` | ✅ Done |
| `submittedAt` / `approvedAt` in Permit model | ✅ Done |
| `submittedAt` set on submit transition | ✅ Done (permits.controller.ts:499) |
| `approvedAt` set on approve transition | ✅ Done (permits.controller.ts:400) |
| DB migration for `submitted_at` / `approved_at` | ✅ Done (migration created) |
| `signatures`, `isolationSections` on Permit model | ✅ Already present |
| `getRiskAssessmentByWorkType` data function | ✅ Already present |
| `create_and_submit_permit` audit action handled in PermitoAI fraud check | ✅ Fixed |

**Remaining required work: 1 item (role auth on new endpoints)**

---

## 1. REQUIRED — Add Auth Guards to New Agent Endpoints

**Problem:** The 9 new agent routes in `api.ts` are currently registered **without** `...withRole(...)` guards. The existing two agent routes also have no auth, so this mirrors the current pattern — but for fraud and analytics endpoints that expose sensitive data, auth should be enforced.

**Current state (api.ts lines 644–708):**
```ts
router.post("/agent/permits/:id/recommend-routing",
  routeWrapper(...AgentController.recommendRouting...)
);
// No ...withRole() call — unauthenticated
```

**Fix:** Wrap all new agent routes with at minimum `...withRole(["Super Admin", "Admin", "HSE Manager"])`:

```ts
// Feature 1 — open to approvers and above
router.post(
  "/agent/permits/:id/recommend-routing",
  ...withRole(["Super Admin", "Admin", "HSE Manager"]),
  routeWrapper(...)
);
router.post(
  "/agent/permits/:id/pre-submission-check",
  ...withRole(["Super Admin", "Admin", "HSE Manager", "Requestor"]),
  routeWrapper(...)
);

// Feature 2 — restricted to Admin/Super Admin only (fraud data is sensitive)
router.get(
  "/agent/fraud/permits/:id/check",
  ...withRole(["Super Admin", "Admin"]),
  routeWrapper(...)
);
router.get(
  "/agent/fraud/users/:id/anomaly-report",
  ...withRole(["Super Admin", "Admin"]),
  routeWrapper(...)
);
router.get(
  "/agent/fraud/scan",
  ...withRole(["Super Admin", "Admin"]),
  routeWrapper(...)
);

// Feature 3 — Admin and above (analytics are company/facility-wide)
router.get(
  "/agent/analytics/trends",
  ...withRole(["Super Admin", "Admin", "HSE Manager"]),
  routeWrapper(...)
);
// ... same for predictions, incident-correlation, compliance-report
```

**Priority: High** — fraud and analytics endpoints expose all permit + audit data.

---

## 2. REQUIRED — Run the DB Migration on Production (RDS)

**File created:** `src/database/migrations/20260401000000-add-ai-timestamp-fields-to-permits.js`

The Permit model declares `submitted_at` and `approved_at` but no migration existed for them. In development `sequelize.sync({ alter: true })` adds them automatically, but **the RDS production DB will not have these columns** until the migration is run.

```bash
npx sequelize-cli db:migrate
```

Without these columns, `fraudBatchScan` and all analytics queries that read `submittedAt`/`approvedAt` will return null for all permits.

---

## 3. RECOMMENDED — Scope `facilityId` Checks in Analytics/Fraud to the Logged-in User

**Problem:** `fraudBatchScan`, `analyticsTrends`, etc. accept `facilityId` as a query param but don't validate that the requesting user belongs to that facility (only Super Admins should cross facilities).

**Example fix in `fraudBatchScan`:**
```ts
// After the existing facilityId check:
const user = req.user; // from JWT middleware
if (user.role !== "Super Admin" && user.facility_id !== Number(facilityId)) {
  throw new AppError("Access denied: you can only scan your own facility", 403);
}
```

Same pattern applies to `analyticsTrends`, `analyticsPredictions`, `analyticsIncidentCorrelation`.

`analyticsComplianceReport` uses `companyId` — same check: non-Super-Admins should only see their own company.

**Priority: Medium** — currently any authenticated user can view any facility's fraud/analytics data.

---

## 4. RECOMMENDED — Broaden `similarPermits` Query to Include More Statuses

**Current code** in `fraudCheckPermit` (agent.controller.ts):
```ts
const similarPermits = await Permit.findAll({
  where: {
    issuerId: permit.issuerId,
    id: { [Op.ne]: id },
    workArea: permit.workArea,         // exact match only
    startDate: { [Op.lte]: permit.endDate },
    endDate:   { [Op.gte]: permit.startDate },
  },
  // No status filter — returns draft, submitted, approved, etc.
});
```

**Issue 1:** `workArea` is an exact match — `"Process Area A"` won't match `"Process Areas"`. Add `{ [Op.like]: `%${permit.workArea}%` }` or restrict to same workType as well.

**Issue 2:** No status filter. Draft permits shouldn't count as near-duplicates. Add:
```ts
status: { [Op.in]: ["submitted", "approved", "active"] }
```

---

## 5. NICE TO HAVE — Pagination on Analytics Queries

`buildAnalyticsPayload` fetches `limit: 500` permits, which is fine for most facilities. For very large facilities this may not capture the full date range.

**Fix:** Accept a `page` query param and allow callers to paginate through permit batches, or increase limit to 1000 with a warning log when the limit is hit:

```ts
if ((permits as any[]).length === 500) {
  logger.warn(`[analytics] Permit query for facility ${facilityId} hit the 500-record limit — results may be incomplete`);
}
```

---

## 6. NICE TO HAVE — Push Notification REST Endpoint

The `notifyUser`, `notifyRole` functions exist internally. A REST wrapper is already stubbed at line 710 of `api.ts`:

```ts
router.post("/internal/notify", ...withRole(["Super Admin", "Admin"]), ...);
```

Confirm this is fully implemented and test it. The bot and frontend can use it to alert approvers when routing recommendations are ready or fraud is detected.

---

## COMPLETE PICTURE — All 9 Proxy Flows

| Frontend calls backend | Backend fetches from DB | Backend posts to PermitoAI |
|------------------------|------------------------|---------------------------|
| `POST /api/agent/permits/:id/recommend-routing` | Permit, Users + queue counts, Active permits, RiskOptions | `/api/v1/agent/routing/recommend` |
| `POST /api/agent/permits/:id/pre-submission-check` | Permit, RiskOptions | `/api/v1/agent/routing/pre-submission-check` |
| `GET /api/agent/fraud/permits/:id/check` | Permit, AuditLogs, UserRoles map, SimilarPermits | `/api/v1/agent/fraud/permit-check` |
| `GET /api/agent/fraud/users/:id/anomaly-report` | User, AuditLogs (last 30d) | `/api/v1/agent/fraud/user-anomaly` |
| `GET /api/agent/fraud/scan?facilityId=` | All permits in facility, AuditLogs, UserRoles map | `/api/v1/agent/fraud/scan` |
| `GET /api/agent/analytics/trends?facilityId=` | Permits (lightweight projection, 500 max), AuditLogs | `/api/v1/agent/analytics/trends` |
| `GET /api/agent/analytics/predictions?facilityId=` | Same as trends | `/api/v1/agent/analytics/predictions` |
| `GET /api/agent/analytics/incident-correlation?facilityId=` | Same as trends | `/api/v1/agent/analytics/incident-correlation` |
| `GET /api/agent/analytics/compliance-report?companyId=` | All permits across company (1000 max), AuditLogs | `/api/v1/agent/analytics/compliance-report` |

---

## AUDIT ACTIONS CONFIRMED IN CODEBASE

These are what the fraud bot will see in `audit_logs.action`:

| Action string | When emitted |
|--------------|-------------|
| `create_permit` | Draft permit created |
| `create_and_submit_permit` | Permit created + submitted in one step |
| `submit_permit` | Existing draft submitted |
| `approve_permit` | Permit approved |
| `sign_permit` | Signature added (approve or close flows) |
| `reject_permit` | Permit rejected → back to draft |
| `close_permit` | Permit closed by approver |
| `close_out_permit` | Permit closed out (completion flow) |
| `suspend_permit` | Permit suspended |
| `extend_permit` | Permit extended |
| `assign_isolator` / `assign_verifier` | Isolation personnel assigned |

> Note: PermitoAI's fraud check handles both `submit_permit` AND `create_and_submit_permit` for the audit trail check (fixed in fraud.ts).
