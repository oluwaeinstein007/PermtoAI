import { Hono } from "hono";
import { z } from "zod";
import { chatCompletion } from "../../services/embeddingService.js";

const analyticsRouter = new Hono();

// ─── Shared schemas ───────────────────────────────────────────────────────────

const PermitRecordSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  type: z.string().optional(),
  workType: z.string().optional(),
  workArea: z.string().optional().nullable(),
  status: z.string().optional(),
  severity: z.string().optional(),
  likelihood: z.string().optional(),
  hazards: z.union([z.array(z.unknown()), z.string()]).optional(),
  controlMeasures: z.union([z.array(z.unknown()), z.string()]).optional(),
  workShift: z.string().optional(),
  activeDays: z.union([z.array(z.string()), z.string()]).optional(),
  startDate: z.string().optional().nullable(),
  endDate: z.string().optional().nullable(),
  closed_at: z.string().optional().nullable(),
  created_at: z.string().optional(),
  rejectionReason: z.string().optional().nullable(),
  suspensionReason: z.string().optional().nullable(),
  completionChecklist: z.record(z.unknown()).optional().nullable(),
  isolationSections: z.union([z.array(z.unknown()), z.string()]).optional(),
  issuerId: z.union([z.number(), z.string()]).optional().nullable(),
  approverId: z.union([z.number(), z.string()]).optional().nullable(),
  facilityId: z.union([z.number(), z.string()]).optional().nullable(),
  companyId: z.union([z.number(), z.string()]).optional().nullable(),
});

type PermitRecord = z.infer<typeof PermitRecordSchema>;

const SEVERITY_SCORE: Record<string, number> = {
  Low: 1,
  Moderate: 2,
  High: 3,
  Severe: 4,
};

const LIKELIHOOD_SCORE: Record<string, number> = {
  Low: 1,
  Unlikely: 2,
  Likely: 3,
  "Very likely": 4,
};

function riskScore(permit: PermitRecord): number {
  return (SEVERITY_SCORE[permit.severity ?? ""] ?? 1) * (LIKELIHOOD_SCORE[permit.likelihood ?? ""] ?? 1);
}

function parseJsonField(field: unknown): unknown[] {
  if (Array.isArray(field)) return field;
  if (typeof field === "string") {
    try {
      const parsed = JSON.parse(field);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function getMonth(dateStr?: string | null): string {
  if (!dateStr) return "Unknown";
  return dateStr.slice(0, 7); // "YYYY-MM"
}

// ─── POST /api/v1/agent/analytics/trends ─────────────────────────────────────
// Computes permit volume, hazard frequencies, risk trends, approval time,
// and top work areas from a batch of permits. AI adds strategic insights.
const TrendsBodySchema = z.object({
  permits: z.array(PermitRecordSchema),
  auditLogs: z
    .array(
      z.object({
        action: z.string(),
        userId: z.union([z.number(), z.string()]).optional(),
        permitId: z.union([z.number(), z.string()]).optional().nullable(),
        created_at: z.string(),
      })
    )
    .optional()
    .default([]),
  facilityId: z.union([z.number(), z.string()]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

analyticsRouter.post("/trends", async (c) => {
  const body = await c.req.json();
  const { permits, auditLogs, facilityId, from, to } = TrendsBodySchema.parse(body);

  console.log(`[API] analytics/trends — permits=${permits.length}, facilityId=${facilityId ?? "all"}`);

  // ── Volume by month ───────────────────────────────────────────────────────
  const volumeByMonth = new Map<string, { total: number; approved: number; rejected: number; suspended: number }>();
  for (const p of permits) {
    const month = getMonth(p.created_at);
    if (!volumeByMonth.has(month)) {
      volumeByMonth.set(month, { total: 0, approved: 0, rejected: 0, suspended: 0 });
    }
    const m = volumeByMonth.get(month)!;
    m.total++;
    if (p.status === "approved" || p.status === "active" || p.status === "closed") m.approved++;
    if (p.status === "rejected") m.rejected++;
    if (p.status === "suspended") m.suspended++;
  }

  const permitVolume = Array.from(volumeByMonth.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, counts]) => ({ month, ...counts }));

  // ── Top hazards ───────────────────────────────────────────────────────────
  const hazardCounts = new Map<string, number>();
  for (const p of permits) {
    const hazards = parseJsonField(p.hazards);
    for (const h of hazards) {
      const key = typeof h === "string" ? h : (h as Record<string, unknown>)?.name as string ?? JSON.stringify(h);
      if (key) hazardCounts.set(key, (hazardCounts.get(key) ?? 0) + 1);
    }
  }
  const totalPermits = permits.length || 1;
  const topHazards = Array.from(hazardCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([hazard, count]) => ({
      hazard,
      count,
      percentage: parseFloat(((count / totalPermits) * 100).toFixed(1)),
    }));

  // ── Risk trend by month ───────────────────────────────────────────────────
  const riskByMonth = new Map<string, number[]>();
  for (const p of permits) {
    const month = getMonth(p.created_at);
    if (!riskByMonth.has(month)) riskByMonth.set(month, []);
    riskByMonth.get(month)!.push(riskScore(p));
  }
  const riskTrend = Array.from(riskByMonth.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, scores]) => ({
      month,
      avgRiskScore: parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)),
      permitsWithHighRisk: scores.filter((s) => s >= 9).length,
    }));

  // ── Top work areas ────────────────────────────────────────────────────────
  const areaStats = new Map<string, { count: number; riskScores: number[]; severities: string[] }>();
  for (const p of permits) {
    const area = p.workArea ?? "Unspecified";
    if (!areaStats.has(area)) areaStats.set(area, { count: 0, riskScores: [], severities: [] });
    const a = areaStats.get(area)!;
    a.count++;
    a.riskScores.push(riskScore(p));
    if (p.severity) a.severities.push(p.severity);
  }
  const topWorkAreas = Array.from(areaStats.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)
    .map(([workArea, stats]) => {
      const avgRisk = stats.riskScores.reduce((a, b) => a + b, 0) / stats.riskScores.length;
      const severityCounts = stats.severities.reduce<Record<string, number>>((acc, s) => {
        acc[s] = (acc[s] ?? 0) + 1;
        return acc;
      }, {});
      const dominantSeverity = Object.entries(severityCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Unknown";
      return { workArea, count: stats.count, avgRiskScore: parseFloat(avgRisk.toFixed(2)), dominantSeverity };
    });

  // ── Work type distribution ────────────────────────────────────────────────
  const workTypeCounts = new Map<string, number>();
  for (const p of permits) {
    const wt = p.workType ?? "Unknown";
    workTypeCounts.set(wt, (workTypeCounts.get(wt) ?? 0) + 1);
  }
  const workTypeDistribution = Array.from(workTypeCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([workType, count]) => ({
      workType,
      count,
      percentage: parseFloat(((count / totalPermits) * 100).toFixed(1)),
    }));

  // ── Approval time from audit logs ────────────────────────────────────────
  const submitTimes = new Map<string, number>(); // permitId → timestamp
  const approveTimes = new Map<string, number>();
  for (const log of auditLogs) {
    if (!log.permitId) continue;
    const pid = String(log.permitId);
    const ts = new Date(log.created_at).getTime();
    if (log.action === "submit_permit") submitTimes.set(pid, ts);
    if (log.action === "approve_permit") approveTimes.set(pid, ts);
  }
  const approvalHours: number[] = [];
  for (const [pid, submitTs] of submitTimes) {
    const approveTs = approveTimes.get(pid);
    if (approveTs && approveTs > submitTs) {
      approvalHours.push((approveTs - submitTs) / 3_600_000);
    }
  }
  const approvalTimeAvgHours =
    approvalHours.length > 0
      ? parseFloat((approvalHours.reduce((a, b) => a + b, 0) / approvalHours.length).toFixed(1))
      : null;

  // ── Day/shift breakdown ───────────────────────────────────────────────────
  const shiftCounts = { Day: 0, Night: 0, Unknown: 0 };
  for (const p of permits) {
    const shift = p.workShift ?? "Unknown";
    shiftCounts[shift as keyof typeof shiftCounts] =
      (shiftCounts[shift as keyof typeof shiftCounts] ?? 0) + 1;
  }

  // ── Rejection reasons ────────────────────────────────────────────────────
  const rejectedPermits = permits.filter((p) => p.status === "rejected");
  const rejectionReasons = new Map<string, number>();
  for (const p of rejectedPermits) {
    const reason = p.rejectionReason ?? "Not specified";
    rejectionReasons.set(reason, (rejectionReasons.get(reason) ?? 0) + 1);
  }
  const topRejectionReasons = Array.from(rejectionReasons.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count }));

  // ── AI insights ───────────────────────────────────────────────────────────
  const aiResult = await chatCompletion([
    {
      role: "system",
      content: `You are a safety analytics expert for Nigerian oil & gas operations.
Analyse the permit trend data and provide strategic insights.
Return JSON with:
- "keyInsights": string[] — 3-5 most important observations from the data
- "riskTrends": string — narrative description of how risk is trending
- "operationalRecommendations": string[] — 3-5 actionable recommendations for management`,
    },
    {
      role: "user",
      content: `PERMIT TREND ANALYSIS
Period: ${from ?? "N/A"} to ${to ?? "N/A"}, Facility: ${facilityId ?? "All"}
Total Permits: ${totalPermits}
Approval Rate: ${((permits.filter((p) => ["approved", "active", "closed"].includes(p.status ?? "")).length / totalPermits) * 100).toFixed(1)}%
Rejection Rate: ${((rejectedPermits.length / totalPermits) * 100).toFixed(1)}%
Avg Approval Time: ${approvalTimeAvgHours != null ? `${approvalTimeAvgHours}h` : "N/A"}

Top Work Types: ${workTypeDistribution.slice(0, 5).map((w) => `${w.workType} (${w.count})`).join(", ")}
Top Work Areas: ${topWorkAreas.slice(0, 5).map((a) => `${a.workArea} (${a.count}, avgRisk: ${a.avgRiskScore})`).join(", ")}
Top Hazards: ${topHazards.slice(0, 5).map((h) => `${h.hazard} (${h.count})`).join(", ")}
Shift Split: Day=${shiftCounts.Day}, Night=${shiftCounts.Night}
High-Risk Permits (score ≥9): ${permits.filter((p) => riskScore(p) >= 9).length} (${((permits.filter((p) => riskScore(p) >= 9).length / totalPermits) * 100).toFixed(1)}%)

Provide strategic safety insights and operational recommendations.`,
    },
  ]);

  let aiOutput: {
    keyInsights: string[];
    riskTrends: string;
    operationalRecommendations: string[];
  };
  try {
    aiOutput = JSON.parse(aiResult.content);
  } catch {
    aiOutput = { keyInsights: [], riskTrends: aiResult.content, operationalRecommendations: [] };
  }

  console.log(`[API] analytics/trends complete — ${permitVolume.length} months, topHazards=${topHazards.length}`);

  return c.json({
    success: true,
    data: {
      period: { facilityId: facilityId ?? null, from: from ?? null, to: to ?? null },
      summary: {
        totalPermits,
        approvalRate: parseFloat(((permits.filter((p) => ["approved", "active", "closed"].includes(p.status ?? "")).length / totalPermits) * 100).toFixed(1)),
        rejectionRate: parseFloat(((rejectedPermits.length / totalPermits) * 100).toFixed(1)),
        approvalTimeAvgHours,
        highRiskPermits: permits.filter((p) => riskScore(p) >= 9).length,
      },
      permitVolume,
      topHazards,
      riskTrend,
      topWorkAreas,
      workTypeDistribution,
      shiftBreakdown: shiftCounts,
      topRejectionReasons,
      insights: {
        keyInsights: aiOutput.keyInsights ?? [],
        riskTrends: aiOutput.riskTrends,
        operationalRecommendations: aiOutput.operationalRecommendations ?? [],
      },
    },
    metadata: {
      promptTokens: aiResult.promptTokens,
      completionTokens: aiResult.completionTokens,
    },
  });
});

// ─── POST /api/v1/agent/analytics/predictions ────────────────────────────────
// Predicts high-risk periods, bottlenecks, and recommended actions
// from historical permit data.
const PredictionsBodySchema = z.object({
  permits: z.array(PermitRecordSchema),
  auditLogs: z
    .array(
      z.object({
        action: z.string(),
        userId: z.union([z.number(), z.string()]).optional(),
        permitId: z.union([z.number(), z.string()]).optional().nullable(),
        created_at: z.string(),
      })
    )
    .optional()
    .default([]),
  facilityId: z.union([z.number(), z.string()]).optional(),
});

analyticsRouter.post("/predictions", async (c) => {
  const body = await c.req.json();
  const { permits, auditLogs, facilityId } = PredictionsBodySchema.parse(body);

  console.log(`[API] analytics/predictions — permits=${permits.length}, facilityId=${facilityId ?? "all"}`);

  // Compute features for AI prediction
  const weekdayCounts = new Array(7).fill(0); // 0=Sun .. 6=Sat
  const monthCounts = new Map<string, number>();
  const workAreaRisk = new Map<string, { count: number; totalRisk: number; rejections: number }>();
  const issuerHistory = new Map<string, { total: number; rejected: number; avgControls: number }>();

  for (const p of permits) {
    if (p.created_at) {
      const d = new Date(p.created_at);
      weekdayCounts[d.getDay()]++;
      const monthKey = getMonth(p.created_at);
      monthCounts.set(monthKey, (monthCounts.get(monthKey) ?? 0) + 1);
    }

    const area = p.workArea ?? "Unspecified";
    if (!workAreaRisk.has(area)) workAreaRisk.set(area, { count: 0, totalRisk: 0, rejections: 0 });
    const ar = workAreaRisk.get(area)!;
    ar.count++;
    ar.totalRisk += riskScore(p);
    if (p.status === "rejected") ar.rejections++;

    if (p.issuerId) {
      const uid = String(p.issuerId);
      if (!issuerHistory.has(uid)) issuerHistory.set(uid, { total: 0, rejected: 0, avgControls: 0 });
      const ih = issuerHistory.get(uid)!;
      ih.total++;
      if (p.status === "rejected") ih.rejected++;
      ih.avgControls = (ih.avgControls * (ih.total - 1) + parseJsonField(p.controlMeasures).length) / ih.total;
    }
  }

  // Approver queue analysis from audit logs
  const approverSubmitCounts = new Map<string, number>(); // approverId → pending permits
  for (const p of permits.filter((p) => p.status === "submitted" && p.approverId)) {
    const aid = String(p.approverId);
    approverSubmitCounts.set(aid, (approverSubmitCounts.get(aid) ?? 0) + 1);
  }

  // Approval time per approver
  const approverTimes = new Map<string, number[]>();
  const submitTs = new Map<string, number>();
  for (const log of auditLogs) {
    if (!log.permitId) continue;
    if (log.action === "submit_permit") submitTs.set(String(log.permitId), new Date(log.created_at).getTime());
    if (log.action === "approve_permit") {
      const pid = String(log.permitId);
      const sub = submitTs.get(pid);
      if (sub) {
        const uid = String(log.userId ?? "unknown");
        if (!approverTimes.has(uid)) approverTimes.set(uid, []);
        approverTimes.get(uid)!.push((new Date(log.created_at).getTime() - sub) / 3_600_000);
      }
    }
  }

  const bottleneckApprovers = Array.from(approverTimes.entries())
    .map(([uid, times]) => ({
      userId: uid,
      avgApprovalHours: parseFloat((times.reduce((a, b) => a + b, 0) / times.length).toFixed(1)),
      pendingPermits: approverSubmitCounts.get(uid) ?? 0,
    }))
    .filter((a) => a.avgApprovalHours > 24 || a.pendingPermits > 5)
    .sort((a, b) => b.avgApprovalHours - a.avgApprovalHours)
    .slice(0, 5);

  // High-activity months (top 3 by volume)
  const sortedMonths = Array.from(monthCounts.entries()).sort((a, b) => b[1] - a[1]);

  // High-risk areas
  const highRiskAreas = Array.from(workAreaRisk.entries())
    .map(([area, stats]) => ({
      area,
      count: stats.count,
      avgRisk: parseFloat((stats.totalRisk / stats.count).toFixed(2)),
      rejectionRate: parseFloat(((stats.rejections / stats.count) * 100).toFixed(1)),
    }))
    .filter((a) => a.avgRisk >= 6 || a.rejectionRate >= 20)
    .sort((a, b) => b.avgRisk - a.avgRisk)
    .slice(0, 5);

  const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const peakWeekday = weekdayCounts.indexOf(Math.max(...weekdayCounts));

  // AI predictive analysis
  const aiResult = await chatCompletion([
    {
      role: "system",
      content: `You are a predictive safety analyst for Nigerian oil & gas operations.
Based on historical permit patterns, predict upcoming risks and bottlenecks.
Return JSON with:
- "highRiskPeriods": Array<{ dateRange: string, reason: string, riskScore: number (0.0–1.0) }>
- "predictedBottlenecks": Array<{ stage: string, estimatedDelayHours: number, affectedRole: string, detail: string }>
- "recommendedActions": string[] — 3-6 proactive actions management should take`,
    },
    {
      role: "user",
      content: `PREDICTIVE ANALYTICS INPUT
Facility: ${facilityId ?? "All"}
Historical Permits: ${permits.length}
Peak Submission Day: ${weekdayNames[peakWeekday]} (${weekdayCounts[peakWeekday]} permits)
Peak Months: ${sortedMonths.slice(0, 3).map(([m, c]) => `${m} (${c})`).join(", ")}

High-Risk Work Areas:
${highRiskAreas.map((a) => `  ${a.area}: avgRisk=${a.avgRisk}, rejectionRate=${a.rejectionRate}%`).join("\n") || "  None identified"}

Approval Bottlenecks (approvers with avg >24h or >5 pending):
${bottleneckApprovers.map((a) => `  User ${a.userId}: ${a.avgApprovalHours}h avg, ${a.pendingPermits} pending`).join("\n") || "  None identified"}

High Risk Rate: ${((permits.filter((p) => riskScore(p) >= 9).length / (permits.length || 1)) * 100).toFixed(1)}%
Rejection Rate: ${((permits.filter((p) => p.status === "rejected").length / (permits.length || 1)) * 100).toFixed(1)}%

Generate predictions for the next 4 weeks based on these patterns.`,
    },
  ]);

  let aiOutput: {
    highRiskPeriods: Array<{ dateRange: string; reason: string; riskScore: number }>;
    predictedBottlenecks: Array<{ stage: string; estimatedDelayHours: number; affectedRole: string; detail: string }>;
    recommendedActions: string[];
  };
  try {
    aiOutput = JSON.parse(aiResult.content);
  } catch {
    aiOutput = { highRiskPeriods: [], predictedBottlenecks: [], recommendedActions: [aiResult.content] };
  }

  console.log(`[API] analytics/predictions complete — highRiskPeriods=${(aiOutput.highRiskPeriods ?? []).length}`);

  return c.json({
    success: true,
    data: {
      facilityId: facilityId ?? null,
      computedPatterns: {
        peakSubmissionDay: weekdayNames[peakWeekday],
        highRiskAreas,
        bottleneckApprovers,
        peakMonths: sortedMonths.slice(0, 3).map(([month, count]) => ({ month, count })),
      },
      highRiskPeriods: aiOutput.highRiskPeriods ?? [],
      predictedBottlenecks: aiOutput.predictedBottlenecks ?? [],
      recommendedActions: aiOutput.recommendedActions ?? [],
    },
    metadata: {
      promptTokens: aiResult.promptTokens,
      completionTokens: aiResult.completionTokens,
    },
  });
});

// ─── POST /api/v1/agent/analytics/incident-correlation ───────────────────────
// Identifies which combinations of factors (work type, area, shift, hazard count)
// correlate with higher historical incident risk.
const IncidentCorrelationBodySchema = z.object({
  permits: z.array(PermitRecordSchema),
  facilityId: z.union([z.number(), z.string()]).optional(),
});

analyticsRouter.post("/incident-correlation", async (c) => {
  const body = await c.req.json();
  const { permits, facilityId } = IncidentCorrelationBodySchema.parse(body);

  console.log(`[API] analytics/incident-correlation — permits=${permits.length}`);

  // Build combination risk profiles
  const comboCounts = new Map<
    string,
    { count: number; totalRisk: number; rejections: number; suspensions: number; highRisk: number }
  >();

  for (const p of permits) {
    const wt = p.workType ?? "Unknown";
    const area = p.workArea ?? "Unknown";
    const shift = p.workShift ?? "Unknown";
    const hazardCount = parseJsonField(p.hazards).length;
    const hazardBucket = hazardCount <= 2 ? "≤2 hazards" : hazardCount <= 5 ? "3-5 hazards" : ">5 hazards";

    // Store combinations at different granularities
    const keys = [
      `${wt} | ${shift}`,
      `${wt} | ${area}`,
      `${wt} | ${area} | ${shift}`,
      `${area} | ${shift} | ${hazardBucket}`,
    ];

    for (const key of keys) {
      if (!comboCounts.has(key)) {
        comboCounts.set(key, { count: 0, totalRisk: 0, rejections: 0, suspensions: 0, highRisk: 0 });
      }
      const c = comboCounts.get(key)!;
      c.count++;
      c.totalRisk += riskScore(p);
      if (p.status === "rejected") c.rejections++;
      if (p.status === "suspended") c.suspensions++;
      if (riskScore(p) >= 9) c.highRisk++;
    }
  }

  // Rank combinations by average risk × high-risk rate
  const correlations = Array.from(comboCounts.entries())
    .filter(([, stats]) => stats.count >= 3) // minimum sample size
    .map(([factor, stats]) => {
      const avgRisk = stats.totalRisk / stats.count;
      const highRiskRate = stats.highRisk / stats.count;
      const rejectionRate = stats.rejections / stats.count;
      const riskMultiplier = parseFloat((avgRisk / 4).toFixed(2)); // normalised to 1–4 scale
      return {
        factor,
        sampleSize: stats.count,
        avgRiskScore: parseFloat(avgRisk.toFixed(2)),
        highRiskRate: parseFloat((highRiskRate * 100).toFixed(1)),
        rejectionRate: parseFloat((rejectionRate * 100).toFixed(1)),
        riskMultiplier,
        incidentRisk: highRiskRate >= 0.5 ? "HIGH" : highRiskRate >= 0.25 ? "MEDIUM" : "LOW",
        historicalRate: parseFloat(highRiskRate.toFixed(2)),
      };
    })
    .sort((a, b) => b.avgRiskScore - a.avgRiskScore)
    .slice(0, 20);

  // Top 5 risk combinations (work type + area + shift)
  const tripleCombos = Array.from(comboCounts.entries())
    .filter(([key]) => key.split(" | ").length === 3 && key.includes(" | "))
    .filter(([, stats]) => stats.count >= 3)
    .sort((a, b) => b[1].totalRisk / b[1].count - a[1].totalRisk / a[1].count)
    .slice(0, 5)
    .map(([key, stats]) => {
      const [workType, workArea, shift] = key.split(" | ");
      return {
        workType: workType ?? "Unknown",
        workArea: workArea ?? "Unknown",
        shift: shift ?? "Unknown",
        count: stats.count,
        avgRiskScore: parseFloat((stats.totalRisk / stats.count).toFixed(2)),
        riskMultiplier: parseFloat((stats.totalRisk / stats.count / 4).toFixed(2)),
      };
    });

  // AI correlation narrative
  const aiResult = await chatCompletion([
    {
      role: "system",
      content: `You are a safety incident correlation analyst for Nigerian oil & gas operations.
Interpret these risk factor correlations and provide safety insights.
Return JSON with:
- "correlationInsights": string[] — 3-5 key insights about the risk correlations
- "mostCriticalCombinations": string[] — top 3 highest-risk factor combinations described in plain language
- "mitigationRecommendations": string[] — 3-5 specific mitigations for the identified high-risk combinations`,
    },
    {
      role: "user",
      content: `INCIDENT CORRELATION ANALYSIS
Facility: ${facilityId ?? "All"}
Total Permits Analysed: ${permits.length}

Top 10 Risk Combinations:
${correlations.slice(0, 10).map((c) => `  [${c.incidentRisk}] ${c.factor}: avgRisk=${c.avgRiskScore}, highRiskRate=${c.highRiskRate}%, n=${c.sampleSize}`).join("\n")}

Top Triple Combinations (workType | workArea | shift):
${tripleCombos.map((tc) => `  ${tc.workType} | ${tc.workArea} | ${tc.shift}: avgRisk=${tc.avgRiskScore}, riskMultiplier=${tc.riskMultiplier}x, n=${tc.count}`).join("\n") || "  Insufficient data"}

Provide insights and targeted mitigations.`,
    },
  ]);

  let aiOutput: {
    correlationInsights: string[];
    mostCriticalCombinations: string[];
    mitigationRecommendations: string[];
  };
  try {
    aiOutput = JSON.parse(aiResult.content);
  } catch {
    aiOutput = {
      correlationInsights: [],
      mostCriticalCombinations: [],
      mitigationRecommendations: [aiResult.content],
    };
  }

  console.log(`[API] analytics/incident-correlation complete — correlations=${correlations.length}`);

  return c.json({
    success: true,
    data: {
      facilityId: facilityId ?? null,
      totalPermitsAnalysed: permits.length,
      correlations,
      topRiskCombinations: tripleCombos,
      insights: {
        correlationInsights: aiOutput.correlationInsights ?? [],
        mostCriticalCombinations: aiOutput.mostCriticalCombinations ?? [],
        mitigationRecommendations: aiOutput.mitigationRecommendations ?? [],
      },
    },
    metadata: {
      promptTokens: aiResult.promptTokens,
      completionTokens: aiResult.completionTokens,
    },
  });
});

// ─── POST /api/v1/agent/analytics/compliance-report ─────────────────────────
// Executive-level compliance summary across all facilities in a company.
const ComplianceReportBodySchema = z.object({
  permits: z.array(PermitRecordSchema),
  companyId: z.union([z.number(), z.string()]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

analyticsRouter.post("/compliance-report", async (c) => {
  const body = await c.req.json();
  const { permits, companyId, from, to } = ComplianceReportBodySchema.parse(body);

  console.log(`[API] analytics/compliance-report — permits=${permits.length}, companyId=${companyId ?? "all"}`);

  const totalPermits = permits.length || 1;
  const approved = permits.filter((p) => ["approved", "active", "closed"].includes(p.status ?? "")).length;
  const rejected = permits.filter((p) => p.status === "rejected").length;
  const suspended = permits.filter((p) => p.status === "suspended").length;
  const closed = permits.filter((p) => p.status === "closed").length;

  // Checklist completion rate
  let totalChecklist = 0;
  let completedChecklist = 0;
  for (const p of permits) {
    if (p.completionChecklist && typeof p.completionChecklist === "object") {
      const items = Object.values(p.completionChecklist as Record<string, unknown>);
      totalChecklist += items.length;
      completedChecklist += items.filter((v) => v === true || v === "completed" || v === "done").length;
    }
  }
  const checklistCompletionRate =
    totalChecklist > 0
      ? parseFloat(((completedChecklist / totalChecklist) * 100).toFixed(1))
      : null;

  // Isolation completion rate
  let totalIsolations = 0;
  let verifiedIsolations = 0;
  for (const p of permits) {
    const sections = parseJsonField(p.isolationSections);
    totalIsolations += sections.length;
    verifiedIsolations += sections.filter((s) => {
      const sec = s as Record<string, unknown>;
      return sec.verifierId != null && sec.verifierApprovedAt != null;
    }).length;
  }
  const isolationCompletionRate =
    totalIsolations > 0
      ? parseFloat(((verifiedIsolations / totalIsolations) * 100).toFixed(1))
      : null;

  // Per-facility breakdown
  const facilityStats = new Map<
    string,
    { total: number; approved: number; rejected: number; highRisk: number }
  >();
  for (const p of permits) {
    const fid = String(p.facilityId ?? "Unknown");
    if (!facilityStats.has(fid)) facilityStats.set(fid, { total: 0, approved: 0, rejected: 0, highRisk: 0 });
    const fs = facilityStats.get(fid)!;
    fs.total++;
    if (["approved", "active", "closed"].includes(p.status ?? "")) fs.approved++;
    if (p.status === "rejected") fs.rejected++;
    if (riskScore(p) >= 9) fs.highRisk++;
  }

  const facilityBreakdown = Array.from(facilityStats.entries())
    .sort((a, b) => b[1].total - a[1].total)
    .map(([facilityId, stats]) => ({
      facilityId,
      totalPermits: stats.total,
      approvalRate: parseFloat(((stats.approved / stats.total) * 100).toFixed(1)),
      rejectionRate: parseFloat(((stats.rejected / stats.total) * 100).toFixed(1)),
      highRiskRate: parseFloat(((stats.highRisk / stats.total) * 100).toFixed(1)),
      complianceScore: parseFloat(
        (((stats.approved - stats.highRisk * 0.3) / stats.total) * 100).toFixed(1)
      ),
    }));

  // Suspension causes
  const suspensionReasons = new Map<string, number>();
  for (const p of permits.filter((p) => p.status === "suspended")) {
    const reason = p.suspensionReason ?? "Not specified";
    suspensionReasons.set(reason, (suspensionReasons.get(reason) ?? 0) + 1);
  }

  // AI executive summary
  const aiResult = await chatCompletion([
    {
      role: "system",
      content: `You are a compliance reporting specialist for Nigerian oil & gas operations.
Generate an executive-level compliance report summary.
Return JSON with:
- "executiveSummary": string — 3-4 sentence board-level summary
- "complianceRating": "EXCELLENT" | "GOOD" | "FAIR" | "POOR"
- "keyRisks": string[] — top 3 compliance risks
- "recommendations": string[] — top 3 strategic recommendations for leadership`,
    },
    {
      role: "user",
      content: `COMPLIANCE REPORT
Company: ${companyId ?? "All"}, Period: ${from ?? "N/A"} to ${to ?? "N/A"}
Total Permits: ${totalPermits}
Approval Rate: ${((approved / totalPermits) * 100).toFixed(1)}%
Rejection Rate: ${((rejected / totalPermits) * 100).toFixed(1)}%
Suspension Rate: ${((suspended / totalPermits) * 100).toFixed(1)}%
High Risk Rate: ${((permits.filter((p) => riskScore(p) >= 9).length / totalPermits) * 100).toFixed(1)}%
Checklist Completion: ${checklistCompletionRate != null ? `${checklistCompletionRate}%` : "N/A"}
Isolation Completion: ${isolationCompletionRate != null ? `${isolationCompletionRate}%` : "N/A"}

Facility Count: ${facilityStats.size}
Best Facility: ${facilityBreakdown[0]?.facilityId ?? "N/A"} (${facilityBreakdown[0]?.approvalRate ?? "N/A"}% approval)
Worst Facility by Rejection: ${facilityBreakdown.sort((a, b) => b.rejectionRate - a.rejectionRate)[0]?.facilityId ?? "N/A"} (${facilityBreakdown[0]?.rejectionRate ?? "N/A"}% rejection)

Generate an executive compliance summary.`,
    },
  ]);

  let aiOutput: {
    executiveSummary: string;
    complianceRating: string;
    keyRisks: string[];
    recommendations: string[];
  };
  try {
    aiOutput = JSON.parse(aiResult.content);
  } catch {
    aiOutput = {
      executiveSummary: aiResult.content,
      complianceRating: "FAIR",
      keyRisks: [],
      recommendations: [],
    };
  }

  console.log(`[API] analytics/compliance-report complete — facilities=${facilityBreakdown.length}, rating=${aiOutput.complianceRating}`);

  return c.json({
    success: true,
    data: {
      reportPeriod: { companyId: companyId ?? null, from: from ?? null, to: to ?? null },
      overallMetrics: {
        totalPermits,
        approvalRate: parseFloat(((approved / totalPermits) * 100).toFixed(1)),
        rejectionRate: parseFloat(((rejected / totalPermits) * 100).toFixed(1)),
        suspensionRate: parseFloat(((suspended / totalPermits) * 100).toFixed(1)),
        closedPermits: closed,
        highRiskRate: parseFloat(
          ((permits.filter((p) => riskScore(p) >= 9).length / totalPermits) * 100).toFixed(1)
        ),
        checklistCompletionRate,
        isolationCompletionRate,
      },
      facilityBreakdown,
      topSuspensionReasons: Array.from(suspensionReasons.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([reason, count]) => ({ reason, count })),
      executiveInsights: {
        complianceRating: aiOutput.complianceRating,
        executiveSummary: aiOutput.executiveSummary,
        keyRisks: aiOutput.keyRisks ?? [],
        recommendations: aiOutput.recommendations ?? [],
      },
    },
    metadata: {
      promptTokens: aiResult.promptTokens,
      completionTokens: aiResult.completionTokens,
    },
  });
});

export default analyticsRouter;
