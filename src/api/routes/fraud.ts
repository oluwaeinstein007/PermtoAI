import { Hono } from "hono";
import { z } from "zod";
import { chatCompletion } from "../../services/embeddingService.js";

const fraudRouter = new Hono();

// ─── Shared schemas ───────────────────────────────────────────────────────────

const SignatureSchema = z.object({
  userId: z.union([z.number(), z.string()]),
  userName: z.string().optional(),
  userEmail: z.string().optional(),
  role: z.string().optional(),
  timestamp: z.string().optional(),
  ipAddress: z.string().optional(),
  userAgent: z.string().optional(),
  signedAt: z.string().optional(),
  signatureType: z.string().optional(),
});

const IsolationSectionSchema = z.object({
  isolatorId: z.union([z.number(), z.string()]).nullish(),
  verifierId: z.union([z.number(), z.string()]).nullish(),
  restoredById: z.union([z.number(), z.string()]).nullish(),
  verifiedById: z.union([z.number(), z.string()]).nullish(),
  isolatorConfirmedAt: z.string().nullish(),
  verifierApprovedAt: z.string().nullish(),
  equipmentId: z.union([z.number(), z.string()]).nullish(),
});

const AuditLogSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  action: z.string(),
  userId: z.union([z.number(), z.string()]),
  permitId: z.union([z.number(), z.string()]).nullish(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  created_at: z.string(),
});

type Anomaly = {
  type: string;
  description: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  affectedFields?: string[];
  userId?: unknown;
};

const SEVERITY_ORDER = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

function maxSeverity(anomalies: Anomaly[]): "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
  if (anomalies.length === 0) return "NONE";
  return anomalies.reduce<"LOW" | "MEDIUM" | "HIGH" | "CRITICAL">((max, a) => {
    return SEVERITY_ORDER.indexOf(a.severity) > SEVERITY_ORDER.indexOf(max) ? a.severity : max;
  }, "LOW");
}

// ─── POST /api/v1/agent/fraud/permit-check ────────────────────────────────────
// Runs all consistency and fraud checks on a single permit.
// Rule layer: self-approval, signature role mismatch, credential sharing,
//             timestamp tampering, isolation self-verify, missing audit trail,
//             near-duplicate detection.
// AI layer:   contextual anomaly enrichment + overall risk score.
const PermitCheckBodySchema = z.object({
  permit: z.object({
    id: z.union([z.number(), z.string()]),
    issuerId: z.union([z.number(), z.string()]).nullish(),
    approverId: z.union([z.number(), z.string()]).nullish(),
    status: z.string().optional(),
    type: z.string().optional(),
    workType: z.string().optional(),
    workArea: z.string().nullish(),
    created_at: z.string().optional(),
    startDate: z.string().nullish(),
    signatures: z.array(SignatureSchema).default([]),
    isolationSections: z.array(IsolationSectionSchema).default([]),
  }),
  auditLogs: z.array(AuditLogSchema).default([]),
  // Map of userId → actual role name (sourced from GET /api/admin/users/:id)
  userRoles: z.record(z.string(), z.string()).default({}),
  // Recent permits from the same issuer in the same area (for duplicate check)
  similarPermits: z.array(z.record(z.string(), z.unknown())).default([]),
});

fraudRouter.post("/permit-check", async (c) => {
  const body = await c.req.json();
  const { permit, auditLogs, userRoles, similarPermits } = PermitCheckBodySchema.parse(body);

  console.log(`[API] fraud/permit-check — permitId=${permit.id}`);

  const anomalies: Anomaly[] = [];

  // Check 1: Self-approval
  if (
    permit.issuerId != null &&
    permit.approverId != null &&
    String(permit.issuerId) === String(permit.approverId)
  ) {
    anomalies.push({
      type: "SELF_APPROVAL",
      description: `issuerId (${permit.issuerId}) matches approverId (${permit.approverId})`,
      affectedFields: ["issuerId", "approverId"],
      severity: "HIGH",
    });
  }

  // Check 2: Signature role mismatch
  for (const sig of permit.signatures) {
    const actualRole = userRoles[String(sig.userId)];
    if (actualRole && sig.role && actualRole.toLowerCase() !== sig.role.toLowerCase()) {
      anomalies.push({
        type: "SIGNATURE_ROLE_MISMATCH",
        description: `User ${sig.userId} signed as '${sig.role}' but actual role is '${actualRole}'`,
        userId: sig.userId,
        severity: "HIGH",
      });
    }
  }

  // Check 3: Credential sharing — same IP+UserAgent, different userId, close timestamps
  const byIpAgent = new Map<string, typeof permit.signatures>();
  for (const sig of permit.signatures) {
    if (sig.ipAddress && sig.userAgent) {
      const key = `${sig.ipAddress}::${sig.userAgent}`;
      if (!byIpAgent.has(key)) byIpAgent.set(key, []);
      byIpAgent.get(key)!.push(sig);
    }
  }
  for (const sigs of byIpAgent.values()) {
    const uniqueUsers = new Set(sigs.map((s) => String(s.userId)));
    if (uniqueUsers.size > 1) {
      const times = sigs
        .map((s) => (s.signedAt ? new Date(s.signedAt).getTime() : 0))
        .filter(Boolean);
      const spread = times.length > 1 ? Math.max(...times) - Math.min(...times) : 0;
      if (spread < 60_000) {
        anomalies.push({
          type: "CREDENTIAL_SHARING",
          description: `Multiple users (${[...uniqueUsers].join(", ")}) signed from the same IP/device within ${spread}ms`,
          severity: "HIGH",
        });
      }
    }
  }

  // Check 4: Timestamp tampering — signature before permit creation
  if (permit.created_at) {
    const createdTs = new Date(permit.created_at).getTime();
    for (const sig of permit.signatures) {
      if (sig.signedAt) {
        const signedTs = new Date(sig.signedAt).getTime();
        if (signedTs < createdTs) {
          anomalies.push({
            type: "TIMESTAMP_TAMPERING",
            description: `Signature by user ${sig.userId} (${sig.signedAt}) predates permit creation (${permit.created_at})`,
            userId: sig.userId,
            affectedFields: ["signedAt", "created_at"],
            severity: "CRITICAL",
          });
        }
      }
    }
  }

  // Check 5: Isolation section integrity
  for (const section of permit.isolationSections) {
    if (
      section.isolatorId != null &&
      section.verifierId != null &&
      String(section.isolatorId) === String(section.verifierId)
    ) {
      anomalies.push({
        type: "ISOLATION_SELF_VERIFY",
        description: `Same person (userId ${section.isolatorId}) is both isolator and verifier`,
        affectedFields: ["isolatorId", "verifierId"],
        severity: "HIGH",
      });
    }

    if (
      section.restoredById != null &&
      section.verifiedById != null &&
      String(section.restoredById) === String(section.verifiedById)
    ) {
      anomalies.push({
        type: "RESTORATION_SELF_VERIFY",
        description: `Same person (userId ${section.restoredById}) is both restorer and verifier`,
        affectedFields: ["restoredById", "verifiedById"],
        severity: "HIGH",
      });
    }

    if (section.isolatorConfirmedAt && section.verifierApprovedAt) {
      const isolTs = new Date(section.isolatorConfirmedAt).getTime();
      const verTs = new Date(section.verifierApprovedAt).getTime();
      if (isolTs > verTs) {
        anomalies.push({
          type: "ISOLATION_TIMESTAMP_SEQUENCE",
          description: `Verifier approved (${section.verifierApprovedAt}) before isolator confirmed (${section.isolatorConfirmedAt})`,
          affectedFields: ["isolatorConfirmedAt", "verifierApprovedAt"],
          severity: "MEDIUM",
        });
      }
    }
  }

  // Check 6: Missing expected audit trail
  const approvedOrActive = permit.status === "approved" || permit.status === "active";
  if (approvedOrActive && auditLogs.length > 0) {
    const hasSubmit = auditLogs.some(
      (l) =>
        (l.action === "submit_permit" || l.action === "create_and_submit_permit") &&
        String(l.permitId) === String(permit.id)
    );
    if (!hasSubmit) {
      anomalies.push({
        type: "MISSING_AUDIT_TRAIL",
        description: "Permit is approved/active but has no 'submit_permit' or 'create_and_submit_permit' audit entry",
        affectedFields: ["audit_logs"],
        severity: "MEDIUM",
      });
    }
  }

  // Check 7: Near-duplicate detection
  if (similarPermits.length > 0) {
    anomalies.push({
      type: "POTENTIAL_DUPLICATE",
      description: `${similarPermits.length} near-duplicate permit(s) found from the same issuer in the same work area`,
      severity: "MEDIUM",
    });
  }

  // AI enrichment — contextual fraud analysis
  const aiResult = await chatCompletion([
    {
      role: "system",
      content: `You are a fraud and compliance analyst for an industrial permit-to-work system.
Review the permit data and audit trail for anomalies not caught by rule-based checks.
Return JSON with:
- "additionalAnomalies": Array<{ type: string, description: string, severity: "LOW"|"MEDIUM"|"HIGH"|"CRITICAL" }>
- "overallRiskScore": number (0.0–1.0) — probability this permit contains fraudulent activity
- "summary": string — brief fraud assessment narrative`,
    },
    {
      role: "user",
      content: `PERMIT FRAUD CHECK
Permit ID: ${permit.id}
Status: ${permit.status ?? "unknown"}
Work Type: ${permit.workType ?? "?"}, Area: ${permit.workArea ?? "?"}
Issuer ID: ${permit.issuerId ?? "?"}, Approver ID: ${permit.approverId ?? "?"}
Signatures (${permit.signatures.length}): ${JSON.stringify(permit.signatures).slice(0, 600)}
Isolation Sections: ${permit.isolationSections.length}
Audit Logs (${auditLogs.length} entries, showing last 15): ${JSON.stringify(auditLogs.slice(-15)).slice(0, 800)}

Rule-based anomalies already found: ${anomalies.length}
${anomalies.map((a) => `- [${a.severity}] ${a.type}: ${a.description}`).join("\n")}

Identify additional fraud patterns or anomalies.`,
    },
  ]);

  let aiOutput: {
    additionalAnomalies: Anomaly[];
    overallRiskScore: number;
    summary: string;
  };
  try {
    aiOutput = JSON.parse(aiResult.content);
  } catch {
    aiOutput = {
      additionalAnomalies: [],
      overallRiskScore: anomalies.length > 0 ? Math.min(anomalies.length * 0.15, 0.95) : 0.05,
      summary: aiResult.content,
    };
  }

  const allAnomalies = [...anomalies, ...(aiOutput.additionalAnomalies ?? [])];
  const flagged = allAnomalies.length > 0;
  const severity = maxSeverity(allAnomalies);

  console.log(
    `[API] fraud/permit-check complete — flagged=${flagged}, severity=${severity}, anomalies=${allAnomalies.length}`
  );

  return c.json({
    success: true,
    data: {
      permitId: permit.id,
      flagged,
      severity,
      riskScore: aiOutput.overallRiskScore ?? (anomalies.length * 0.15),
      summary: aiOutput.summary,
      anomalies: allAnomalies,
    },
    metadata: {
      promptTokens: aiResult.promptTokens,
      completionTokens: aiResult.completionTokens,
    },
  });
});

// ─── POST /api/v1/agent/fraud/user-anomaly ────────────────────────────────────
// Behavioral anomaly report for a specific user.
// Computes activity baseline and detects statistical deviations (>2 std dev).
const UserAnomalyBodySchema = z.object({
  userId: z.union([z.number(), z.string()]),
  auditLogs: z.array(AuditLogSchema).default([]),
  // Optional: user metadata for context
  user: z
    .object({
      name: z.string().optional(),
      role: z.string().optional(),
      facility_id: z.union([z.number(), z.string()]).optional(),
      created_at: z.string().optional(),
    })
    .optional(),
});

fraudRouter.post("/user-anomaly", async (c) => {
  const body = await c.req.json();
  const { userId, auditLogs, user } = UserAnomalyBodySchema.parse(body);

  console.log(`[API] fraud/user-anomaly — userId=${userId}, logs=${auditLogs.length}`);

  const anomalies: Anomaly[] = [];

  // ── Baseline computation ──────────────────────────────────────────────────

  // 1. Actions by hour bucket
  const hourBuckets = new Map<string, number>(); // "YYYY-MM-DD HH" → count
  const dayBuckets = new Map<string, number>(); // "YYYY-MM-DD" → count
  const actionCounts = new Map<string, number>(); // action → total count

  for (const log of auditLogs) {
    const ts = new Date(log.created_at);
    const hourKey = `${ts.toISOString().slice(0, 13)}`;
    const dayKey = ts.toISOString().slice(0, 10);

    hourBuckets.set(hourKey, (hourBuckets.get(hourKey) ?? 0) + 1);
    dayBuckets.set(dayKey, (dayBuckets.get(dayKey) ?? 0) + 1);
    actionCounts.set(log.action, (actionCounts.get(log.action) ?? 0) + 1);
  }

  // 2. Statistical baseline for per-hour activity
  const hourCounts = Array.from(hourBuckets.values());
  const hourMean =
    hourCounts.length > 0 ? hourCounts.reduce((a, b) => a + b, 0) / hourCounts.length : 0;
  const hourVariance =
    hourCounts.length > 1
      ? hourCounts.reduce((sum, v) => sum + (v - hourMean) ** 2, 0) / hourCounts.length
      : 0;
  const hourStdDev = Math.sqrt(hourVariance);
  const hourThreshold = hourMean + 2 * hourStdDev;

  // Check for unusually high frequency spikes
  for (const [bucket, count] of hourBuckets) {
    if (count > hourThreshold && hourThreshold > 0 && count > 10) {
      anomalies.push({
        type: "HIGH_FREQUENCY",
        description: `${count} actions in 1 hour (${bucket}) — baseline mean: ${hourMean.toFixed(1)}/hr, threshold: ${hourThreshold.toFixed(1)}`,
        severity: count > hourThreshold * 2 ? "HIGH" : "MEDIUM",
      });
    }
  }

  // 3. Off-hours activity detection
  // Compute modal hour of activity (normal working hours)
  const hourOfDay = new Map<number, number>(); // hour 0-23 → count
  for (const log of auditLogs) {
    const h = new Date(log.created_at).getUTCHours();
    hourOfDay.set(h, (hourOfDay.get(h) ?? 0) + 1);
  }
  const totalActivity = auditLogs.length;
  const peakHour =
    Array.from(hourOfDay.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 9;

  // Flag activity more than 6 hours away from peak (suggesting off-hours)
  for (const log of auditLogs) {
    const h = new Date(log.created_at).getUTCHours();
    const distFromPeak = Math.min(Math.abs(h - peakHour), 24 - Math.abs(h - peakHour));
    if (distFromPeak > 6 && (h < 6 || h > 22)) {
      // Only flag genuinely unusual hours
      const hourActivity = hourOfDay.get(h) ?? 0;
      const hourPct = totalActivity > 0 ? (hourActivity / totalActivity) * 100 : 0;
      if (hourPct > 5) {
        // More than 5% of activity at off-hours
        anomalies.push({
          type: "OFF_HOURS_ACTIVITY",
          description: `${hourPct.toFixed(1)}% of activity at hour ${h}:00 UTC (${hourActivity} actions) — typical peak at ${peakHour}:00 UTC`,
          severity: "MEDIUM",
        });
        break; // one flag is enough
      }
    }
  }

  // 4. Unusually high approval rate
  const approvalCount = actionCounts.get("approve_permit") ?? 0;
  const totalPermitActions = (actionCounts.get("submit_permit") ?? 0) + approvalCount;
  if (approvalCount > 20 && totalPermitActions > 0) {
    const approvalRatio = approvalCount / totalPermitActions;
    if (approvalRatio > 0.8) {
      anomalies.push({
        type: "ABNORMAL_APPROVAL_RATIO",
        description: `User approved ${approvalCount} permits out of ${totalPermitActions} permit actions (${(approvalRatio * 100).toFixed(1)}% approval rate — expected <80%)`,
        severity: "MEDIUM",
      });
    }
  }

  // AI behavioral analysis
  const topActions = Array.from(actionCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([action, count]) => `${action}: ${count}`)
    .join(", ");

  const aiResult = await chatCompletion([
    {
      role: "system",
      content: `You are a behavioral fraud analyst for an industrial permit-to-work system.
Analyse this user's activity pattern and identify behavioral anomalies.
Return JSON with:
- "additionalAnomalies": Array<{ type: string, description: string, severity: "LOW"|"MEDIUM"|"HIGH"|"CRITICAL" }>
- "riskScore": number (0.0–1.0) — overall behavioral risk probability
- "summary": string — brief behavioral assessment`,
    },
    {
      role: "user",
      content: `USER BEHAVIORAL ANALYSIS
User ID: ${userId}
Name: ${user?.name ?? "Unknown"}, Role: ${user?.role ?? "Unknown"}
Total Audit Log Entries: ${auditLogs.length}
Active Days: ${dayBuckets.size}
Top Actions: ${topActions}
Avg Actions/Hour: ${hourMean.toFixed(2)}
Hour StdDev: ${hourStdDev.toFixed(2)}
Off-hours Activity (hr <6 or >22): ${Array.from(hourOfDay.entries()).filter(([h]) => h < 6 || h > 22).reduce((sum, [, c]) => sum + c, 0)} actions
Approval Count: ${approvalCount}

Rule-based anomalies found: ${anomalies.length}
${anomalies.map((a) => `- [${a.severity}] ${a.type}: ${a.description}`).join("\n")}

Identify any additional behavioral anomalies or risk patterns.`,
    },
  ]);

  let aiOutput: {
    additionalAnomalies: Anomaly[];
    riskScore: number;
    summary: string;
  };
  try {
    aiOutput = JSON.parse(aiResult.content);
  } catch {
    aiOutput = {
      additionalAnomalies: [],
      riskScore: anomalies.length > 0 ? Math.min(anomalies.length * 0.2, 0.95) : 0.05,
      summary: aiResult.content,
    };
  }

  const allAnomalies = [...anomalies, ...(aiOutput.additionalAnomalies ?? [])];

  console.log(
    `[API] fraud/user-anomaly complete — userId=${userId}, flagged=${allAnomalies.length > 0}, anomalies=${allAnomalies.length}`
  );

  return c.json({
    success: true,
    data: {
      userId,
      flagged: allAnomalies.length > 0,
      severity: maxSeverity(allAnomalies),
      riskScore: aiOutput.riskScore ?? Math.min(anomalies.length * 0.2, 0.95),
      summary: aiOutput.summary,
      anomalies: allAnomalies,
      baseline: {
        totalActions: auditLogs.length,
        activeDays: dayBuckets.size,
        avgActionsPerHour: parseFloat(hourMean.toFixed(2)),
        peakHourUTC: peakHour,
        topActions: Array.from(actionCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([action, count]) => ({ action, count })),
      },
    },
    metadata: {
      promptTokens: aiResult.promptTokens,
      completionTokens: aiResult.completionTokens,
    },
  });
});

// ─── POST /api/v1/agent/fraud/scan ────────────────────────────────────────────
// Batch fraud scan — checks a list of permits and user activity in bulk.
// Designed for facility-level scans over a date range.
const ScanBodySchema = z.object({
  permits: z.array(
    z.object({
      id: z.union([z.number(), z.string()]),
      issuerId: z.union([z.number(), z.string()]).nullish(),
      approverId: z.union([z.number(), z.string()]).nullish(),
      status: z.string().nullish(),
      workType: z.string().nullish(),
      workArea: z.string().nullish(),
      created_at: z.string().nullish(),
      signatures: z.array(SignatureSchema).nullish().transform(v => v ?? []),
      isolationSections: z.array(IsolationSectionSchema).nullish().transform(v => v ?? []),
    })
  ),
  auditLogs: z.array(AuditLogSchema).default([]),
  userRoles: z.record(z.string(), z.string()).default({}),
  facilityId: z.union([z.number(), z.string()]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

fraudRouter.post("/scan", async (c) => {
  const body = await c.req.json();
  const { permits, auditLogs, userRoles, facilityId, from, to } = ScanBodySchema.parse(body);

  console.log(
    `[API] fraud/scan — facilityId=${facilityId ?? "all"}, permits=${permits.length}, logs=${auditLogs.length}`
  );

  const flaggedPermits: Array<{
    permitId: unknown;
    severity: string;
    anomalyCount: number;
    types: string[];
  }> = [];

  // Run rule-based checks on each permit synchronously (no AI per-permit for batch performance)
  for (const permit of permits) {
    const permAnomalies: Anomaly[] = [];

    // Self-approval
    if (
      permit.issuerId != null &&
      permit.approverId != null &&
      String(permit.issuerId) === String(permit.approverId)
    ) {
      permAnomalies.push({
        type: "SELF_APPROVAL",
        description: `issuerId (${permit.issuerId}) matches approverId`,
        severity: "HIGH",
      });
    }

    // Signature role mismatch
    for (const sig of permit.signatures) {
      const actualRole = userRoles[String(sig.userId)];
      if (actualRole && sig.role && actualRole.toLowerCase() !== sig.role.toLowerCase()) {
        permAnomalies.push({
          type: "SIGNATURE_ROLE_MISMATCH",
          description: `User ${sig.userId} signed as '${sig.role}' (actual: '${actualRole}')`,
          userId: sig.userId,
          severity: "HIGH",
        });
      }
    }

    // Isolation self-verify
    for (const section of permit.isolationSections) {
      if (
        section.isolatorId != null &&
        section.verifierId != null &&
        String(section.isolatorId) === String(section.verifierId)
      ) {
        permAnomalies.push({
          type: "ISOLATION_SELF_VERIFY",
          description: `Same person (${section.isolatorId}) is isolator and verifier`,
          affectedFields: ["isolatorId", "verifierId"],
          severity: "HIGH",
        });
      }
    }

    if (permAnomalies.length > 0) {
      flaggedPermits.push({
        permitId: permit.id,
        severity: maxSeverity(permAnomalies),
        anomalyCount: permAnomalies.length,
        types: [...new Set(permAnomalies.map((a) => a.type))],
      });
    }
  }

  // User-level frequency analysis from audit logs
  const userActionCounts = new Map<string, Map<string, number>>(); // userId → hourBucket → count
  for (const log of auditLogs) {
    const uid = String(log.userId);
    if (!userActionCounts.has(uid)) userActionCounts.set(uid, new Map());
    const bucket = new Date(log.created_at).toISOString().slice(0, 13);
    const m = userActionCounts.get(uid)!;
    m.set(bucket, (m.get(bucket) ?? 0) + 1);
  }

  const flaggedUsers: Array<{ userId: string; anomalyType: string; detail: string }> = [];
  for (const [uid, buckets] of userActionCounts) {
    const counts = Array.from(buckets.values());
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    const stdDev = Math.sqrt(counts.reduce((s, v) => s + (v - mean) ** 2, 0) / counts.length);
    const threshold = mean + 2 * stdDev;
    for (const [bucket, count] of buckets) {
      if (count > threshold && count > 10) {
        flaggedUsers.push({
          userId: uid,
          anomalyType: "HIGH_FREQUENCY",
          detail: `${count} actions in hour ${bucket} (threshold: ${threshold.toFixed(1)})`,
        });
        break;
      }
    }
  }

  // AI summary for the batch scan
  const aiResult = await chatCompletion([
    {
      role: "system",
      content: `You are a fraud risk analyst for an industrial permit-to-work system.
Summarise the batch fraud scan results and highlight the highest-risk findings.
Return JSON with:
- "executiveSummary": string — 2-3 sentence summary for management
- "topRisks": string[] — top 3-5 most critical findings
- "recommendedActions": string[] — immediate actions to take`,
    },
    {
      role: "user",
      content: `BATCH FRAUD SCAN RESULTS
Facility: ${facilityId ?? "All"}
Period: ${from ?? "N/A"} to ${to ?? "N/A"}
Total Permits Scanned: ${permits.length}
Flagged Permits: ${flaggedPermits.length}
Total Audit Logs Analysed: ${auditLogs.length}
Flagged Users: ${flaggedUsers.length}

Flagged Permit Summary:
${flaggedPermits.slice(0, 10).map((fp) => `  Permit ${fp.permitId}: [${fp.severity}] ${fp.types.join(", ")}`).join("\n") || "  None"}

Flagged User Summary:
${flaggedUsers.slice(0, 10).map((fu) => `  User ${fu.userId}: ${fu.anomalyType} — ${fu.detail}`).join("\n") || "  None"}

Provide executive summary and recommended actions.`,
    },
  ]);

  let aiOutput: {
    executiveSummary: string;
    topRisks: string[];
    recommendedActions: string[];
  };
  try {
    aiOutput = JSON.parse(aiResult.content);
  } catch {
    aiOutput = {
      executiveSummary: aiResult.content,
      topRisks: [],
      recommendedActions: [],
    };
  }

  console.log(
    `[API] fraud/scan complete — flaggedPermits=${flaggedPermits.length}, flaggedUsers=${flaggedUsers.length}`
  );

  return c.json({
    success: true,
    data: {
      scanPeriod: { facilityId: facilityId ?? null, from: from ?? null, to: to ?? null },
      summary: {
        totalPermitsScanned: permits.length,
        flaggedPermits: flaggedPermits.length,
        flaggedUsers: flaggedUsers.length,
        totalAuditLogsAnalysed: auditLogs.length,
      },
      flaggedPermits,
      flaggedUsers,
      executiveSummary: aiOutput.executiveSummary,
      topRisks: aiOutput.topRisks ?? [],
      recommendedActions: aiOutput.recommendedActions ?? [],
    },
    metadata: {
      promptTokens: aiResult.promptTokens,
      completionTokens: aiResult.completionTokens,
    },
  });
});

export default fraudRouter;
