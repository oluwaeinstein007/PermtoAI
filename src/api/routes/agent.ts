import { Hono } from "hono";
import { z } from "zod";
import { JobContextSchema } from "../../schemas/index.js";
import { HazardService } from "../../services/hazardService.js";
import { RiskScoringService } from "../../services/riskScoringService.js";
import { ValidationService } from "../../services/validationService.js";
import { chatCompletion } from "../../services/embeddingService.js";
import { checkSimops } from "../../services/simopsService.js";

const agentRouter = new Hono();

// GET /api/v1/agent/tools — list all available tools and workflows
agentRouter.get("/tools", (c) => {
  return c.json({
    success: true,
    tools: [
      {
        name: "HAZARD_SUGGEST",
        endpoint: "POST /api/v1/tools/hazard-suggest",
        description:
          "Suggest potential workplace hazards for a permit-to-work scenario using AI + historical incident data and DPR/IOGP regulations.",
        input: "JobContext",
        inputSchema: {
          jobType: "string (e.g. 'Hot Work', 'Confined Space Entry')",
          location: "string",
          environment: "string (e.g. 'Offshore platform')",
          equipment: "string[]",
          contractor: "{ name: string, tier: 1|2|3 } (optional)",
          description: "string (optional)",
        },
      },
      {
        name: "RISK_ASSESS",
        endpoint: "POST /api/v1/tools/risk-assess",
        description:
          "Score hazards using the risk matrix (likelihood × severity) with rule-based severity constraints for critical hazards (H₂S min severity=4, explosion min severity=5, etc.).",
        input: "{ hazards: Hazard[] }",
      },
      {
        name: "COMPLIANCE_CHECK",
        endpoint: "POST /api/v1/tools/compliance-check",
        description:
          "Validate permit against DPR EGASPIN, ISO 45001, and IOGP standards. Returns compliance status, findings, and recommendations per standard.",
        input: "{ jobContext: JobContext, hazards: Hazard[] }",
      },
      {
        name: "PERMIT_VALIDATE",
        endpoint: "POST /api/v1/tools/permit-validate",
        description:
          "Multi-layer permit validation: Layer 1 rule-based checks → Layer 2 AI semantic analysis → Layer 3 standards compliance → Layer 4 anomaly detection.",
        input: "{ jobContext: JobContext, hazards: Hazard[] }",
      },
      {
        name: "ANOMALY_DETECT",
        endpoint: "POST /api/v1/tools/anomaly-detect",
        description:
          "Detect copy-pasted assessments, duplicate hazards, identical ratings, and suspicious patterns in hazard assessments.",
        input: "{ hazards: Hazard[] }",
      },
      {
        name: "SIMOPS_CHECK",
        endpoint: "POST /api/v1/tools/simops-check",
        description:
          "Check a new permit request for SIMOPS (Simultaneous Operations) conflicts against existing permits. Detects schedule conflicts (same type + area + overlapping dates) and incompatible work type pairs (e.g. Hot Work + Confined Space Entry).",
        input: "{ request: PermitRequest, permits: ExistingPermit[] }",
        inputSchema: {
          request: {
            startDate: "string (ISO date or datetime)",
            endDate: "string (ISO date or datetime)",
            workType: "string (e.g. 'Hot Work', 'Confined Space Entry')",
            workArea: "string | null (optional)",
          },
          permits: "ExistingPermit[] — list of active/draft permits to check against",
        },
      },
    ],
    workflows: [
      {
        name: "full-assessment",
        endpoint: "POST /api/v1/agent/full-assessment",
        description:
          "Complete permit pipeline: hazard-suggest → risk-assess → compliance-check + permit-validate (parallel). Returns all results in a single response.",
        input: "JobContext",
      },
      {
        name: "quick-assess",
        endpoint: "POST /api/v1/agent/quick-assess",
        description:
          "Fast two-step assessment: hazard-suggest → risk-assess. Flags if full assessment is needed based on risk levels.",
        input: "JobContext",
      },
      {
        name: "simops-assess",
        endpoint: "POST /api/v1/agent/simops-assess",
        description:
          "Full SIMOPS workflow: (1) detect schedule conflicts and incompatible work type pairs, " +
          "(2) suggest hazards for the requested work type and any conflicting types in parallel, " +
          "(3) score all hazards, (4) AI generates a consolidated SIMOPS safety briefing and recommendation.",
        input: "{ request: PermitRequest, permits: ExistingPermit[], jobContext?: Partial<JobContext> }",
      },
    ],
  });
});

// POST /api/v1/agent/full-assessment
// Workflow: hazard-suggest → risk-assess → compliance-check + permit-validate (parallel)
agentRouter.post("/full-assessment", async (c) => {
  const body = await c.req.json();
  const jobContext = JobContextSchema.parse(body);

  console.log(`[API] Agent full-assessment started for job type: ${jobContext.jobType}`);

  const hazardService = new HazardService();
  const riskService = new RiskScoringService();
  const validationService = new ValidationService();

  // Step 1: Suggest hazards
  console.log("[API] Step 1/3 — Suggesting hazards...");
  const hazardResult = await hazardService.suggestHazards(jobContext);
  const hazards = hazardResult.hazards;

  // Step 2: Score hazards
  console.log("[API] Step 2/3 — Scoring hazards...");
  const scoredHazards = riskService.scoreHazards(hazards);

  // Step 3: Compliance check + permit validation in parallel
  console.log("[API] Step 3/3 — Running compliance check and permit validation...");
  const hazardSummary = hazards
    .map(
      (h) =>
        `${h.name} (${h.category}, L:${h.likelihood}/S:${h.severity}) — Controls: ${h.recommendedControls.join("; ")}${h.dprReference ? ` — Ref: ${h.dprReference}` : ""}`
    )
    .join("\n");

  const [complianceRaw, validationResults] = await Promise.all([
    chatCompletion([
      {
        role: "system",
        content: `You are a regulatory compliance expert for Nigerian oil & gas operations. Evaluate against DPR EGASPIN, ISO 45001, and IOGP. Return JSON with key "standards" — array of objects with "standard", "compliant", "findings", and "recommendations".`,
      },
      {
        role: "user",
        content: `Evaluate compliance:
JOB: ${jobContext.jobType}
LOCATION: ${jobContext.location ?? "Not specified"}
ENVIRONMENT: ${jobContext.environment ?? "Not specified"}
EQUIPMENT: ${(jobContext.equipment ?? []).join(", ") || "Not specified"}
CONTRACTOR: ${jobContext.contractor?.name ?? "N/A"} (Tier ${jobContext.contractor?.tier ?? "N/A"})

HAZARDS:
${hazardSummary}`,
      },
    ]),
    validationService.validatePermit(jobContext, hazards),
  ]);

  const complianceParsed = JSON.parse(complianceRaw.content);
  const overallCompliant = (
    complianceParsed.standards as Array<{ compliant: boolean }>
  ).every((s) => s.compliant);

  const riskSummary = {
    critical: scoredHazards.filter((s) => s.riskLevel === "critical").length,
    high: scoredHazards.filter((s) => s.riskLevel === "high").length,
    medium: scoredHazards.filter((s) => s.riskLevel === "medium").length,
    low: scoredHazards.filter((s) => s.riskLevel === "low").length,
  };

  const allValidationPassed = validationResults.every((r) => r.passed);

  console.log(`[API] Full assessment complete — recommendation: ${allValidationPassed && overallCompliant ? "Approve" : "Flag for Review"}`);

  return c.json({
    success: true,
    jobContext,
    recommendation:
      allValidationPassed && overallCompliant
        ? "Recommend Approval"
        : "Flag for Review",
    steps: {
      hazardSuggest: {
        hazardCount: hazards.length,
        hazards,
        metadata: {
          regulationsUsed: hazardResult.regulationsUsed,
          incidentsUsed: hazardResult.incidentsUsed,
          promptTokens: hazardResult.promptTokens,
          completionTokens: hazardResult.completionTokens,
        },
      },
      riskAssess: {
        summary: riskSummary,
        rulesApplied: scoredHazards.filter((s) => s.ruleApplied).length,
        scoredHazards: scoredHazards.map((s) => ({
          hazardName: s.hazard.name,
          category: s.hazard.category,
          likelihood: s.riskScore.likelihood,
          severity: s.riskScore.severity,
          riskScore: s.riskScore.risk,
          riskLevel: s.riskLevel,
          ruleApplied: s.ruleApplied,
          controls: s.hazard.recommendedControls,
        })),
      },
      complianceCheck: {
        overallCompliant,
        standards: complianceParsed.standards,
        metadata: {
          promptTokens: complianceRaw.promptTokens,
          completionTokens: complianceRaw.completionTokens,
        },
      },
      permitValidate: {
        allPassed: allValidationPassed,
        totalIssues: validationResults.reduce(
          (sum, r) => sum + r.issues.length,
          0
        ),
        layers: validationResults.map((r) => ({
          layer: r.layer,
          passed: r.passed,
          issueCount: r.issues.length,
          issues: r.issues,
          confidence: r.confidence,
          details: r.details,
        })),
      },
    },
  });
});

// POST /api/v1/agent/quick-assess
// Workflow: hazard-suggest → risk-assess
agentRouter.post("/quick-assess", async (c) => {
  const body = await c.req.json();
  const jobContext = JobContextSchema.parse(body);

  console.log(`[API] Agent quick-assess started for job type: ${jobContext.jobType}`);

  const hazardService = new HazardService();
  const riskService = new RiskScoringService();

  // Step 1: Suggest hazards
  const hazardResult = await hazardService.suggestHazards(jobContext);
  const hazards = hazardResult.hazards;

  // Step 2: Score hazards
  const scoredHazards = riskService.scoreHazards(hazards);

  const riskSummary = {
    critical: scoredHazards.filter((s) => s.riskLevel === "critical").length,
    high: scoredHazards.filter((s) => s.riskLevel === "high").length,
    medium: scoredHazards.filter((s) => s.riskLevel === "medium").length,
    low: scoredHazards.filter((s) => s.riskLevel === "low").length,
  };

  const requiresFullAssessment =
    riskSummary.critical > 0 || riskSummary.high > 0;

  return c.json({
    success: true,
    jobContext,
    recommendation: requiresFullAssessment
      ? "Requires Full Assessment"
      : "Proceed with Caution",
    requiresFullAssessment,
    hazardCount: hazards.length,
    riskSummary,
    hazards,
    scoredHazards: scoredHazards.map((s) => ({
      hazardName: s.hazard.name,
      category: s.hazard.category,
      likelihood: s.riskScore.likelihood,
      severity: s.riskScore.severity,
      riskScore: s.riskScore.risk,
      riskLevel: s.riskLevel,
      ruleApplied: s.ruleApplied,
      controls: s.hazard.recommendedControls,
    })),
    metadata: {
      regulationsUsed: hazardResult.regulationsUsed,
      incidentsUsed: hazardResult.incidentsUsed,
    },
  });
});

// ─── SIMOPS schemas (mirrors tools.ts, kept local to avoid circular deps) ────
const AgentPermitRequestSchema = z.object({
  startDate: z.string(),
  endDate: z.string(),
  workType: z.string(),
  workArea: z.string().nullable().optional(),
});

const AgentExistingPermitSchema = z.object({
  id: z.union([z.number(), z.string()]),
  type: z.string().optional(),
  status: z.string(),
  workType: z.string(),
  workArea: z.string().nullable().optional(),
  startDate: z.string(),
  endDate: z.string(),
  jobType: z.string().optional(),
});

const SimopsAssessBody = z.object({
  request: AgentPermitRequestSchema,
  permits: z.array(AgentExistingPermitSchema),
  // Optional extra context to enrich the hazard suggestion step
  jobContext: JobContextSchema.partial().optional(),
});

// POST /api/v1/agent/simops-assess
// Workflow:
//   Step 1 — checkSimops (schedule conflicts + incompatibility flags)
//   Step 2 — suggestHazards for request.workType + each unique conflicting workType (parallel)
//   Step 3 — scoreHazards on combined hazard list
//   Step 4 — AI SIMOPS safety briefing
agentRouter.post("/simops-assess", async (c) => {
  const body = await c.req.json();
  const { request, permits, jobContext: extraContext } = SimopsAssessBody.parse(body);

  console.log(
    `[API] Agent simops-assess started — workType="${request.workType}" against ${permits.length} permit(s)`
  );

  // ── Step 1: SIMOPS conflict check ─────────────────────────────────────────
  console.log("[API] Step 1/4 — Running SIMOPS conflict check...");
  const simopsResult = checkSimops(request, permits);

  // Collect unique work types that conflict with the request (for hazard enrichment)
  const conflictingWorkTypes = [
    ...new Set([
      ...simopsResult.simopsFlags.flags.map((f) => f.conflictingWorkType),
    ]),
  ].filter((wt) => wt.toLowerCase() !== request.workType.toLowerCase());

  // ── Step 2: Hazard suggestions (parallel) ─────────────────────────────────
  console.log(
    `[API] Step 2/4 — Suggesting hazards for ${1 + conflictingWorkTypes.length} work type(s)...`
  );
  const hazardService = new HazardService();
  const riskService = new RiskScoringService();

  const baseContext = {
    jobType: request.workType,
    location: extraContext?.location,
    environment: extraContext?.environment,
    equipment: extraContext?.equipment,
    contractor: extraContext?.contractor,
    description: extraContext?.description,
  };

  const hazardJobs = [
    hazardService.suggestHazards(baseContext),
    ...conflictingWorkTypes.map((wt) =>
      hazardService.suggestHazards({ ...baseContext, jobType: wt })
    ),
  ];

  const hazardResults = await Promise.all(hazardJobs);

  // Merge hazards — deduplicate by name (case-insensitive)
  const seenNames = new Set<string>();
  const allHazards = hazardResults.flatMap((r) => r.hazards).filter((h) => {
    const key = h.name.toLowerCase();
    if (seenNames.has(key)) return false;
    seenNames.add(key);
    return true;
  });

  // ── Step 3: Score all hazards ─────────────────────────────────────────────
  console.log("[API] Step 3/4 — Scoring hazards...");
  const scoredHazards = riskService.scoreHazards(allHazards);

  const riskSummary = {
    critical: scoredHazards.filter((s) => s.riskLevel === "critical").length,
    high: scoredHazards.filter((s) => s.riskLevel === "high").length,
    medium: scoredHazards.filter((s) => s.riskLevel === "medium").length,
    low: scoredHazards.filter((s) => s.riskLevel === "low").length,
  };

  // ── Step 4: AI SIMOPS safety briefing ────────────────────────────────────
  console.log("[API] Step 4/4 — Generating SIMOPS safety briefing...");

  const conflictSummaryText =
    simopsResult.scheduleConflicts.count > 0
      ? `SCHEDULE CONFLICTS (${simopsResult.scheduleConflicts.count}):\n` +
        simopsResult.scheduleConflicts.permits
          .map(
            (p) =>
              `  - Permit #${p.permitId} [${p.status}]: ${p.workType} in "${p.workArea ?? "N/A"}" ` +
              `overlaps from ${p.overlapStart} to ${p.overlapEnd}`
          )
          .join("\n")
      : "No schedule conflicts detected.";

  const simopsFlagText =
    simopsResult.simopsFlags.count > 0
      ? `SIMOPS INCOMPATIBILITIES (${simopsResult.simopsFlags.count}):\n` +
        simopsResult.simopsFlags.flags
          .map(
            (f) =>
              `  - Permit #${f.permitId} [${f.severity.toUpperCase()}]: "${f.requestWorkType}" vs "${f.conflictingWorkType}" — ${f.reason}`
          )
          .join("\n")
      : "No SIMOPS incompatibilities detected.";

  const hazardText = scoredHazards
    .slice(0, 15) // cap prompt length
    .map(
      (s) =>
        `  ${s.hazard.name} [${s.riskLevel.toUpperCase()} risk ${s.riskScore.risk}] — ${s.hazard.recommendedControls.slice(0, 2).join("; ")}`
    )
    .join("\n");

  const aiResult = await chatCompletion([
    {
      role: "system",
      content: `You are a SIMOPS (Simultaneous Operations) safety coordinator for Nigerian oil & gas operations,
trained on IOGP Report 470 (SIMOPS), DPR EGASPIN, and ISO 45001.

Your job is to produce a clear, structured SIMOPS safety briefing that:
1. Summarises the conflict situation
2. States the key risks from running these operations simultaneously
3. Gives concrete, prioritised mitigations for each conflict
4. Issues an overall recommendation (HOLD, PROCEED WITH CONTROLS, or SAFE TO PROCEED)

Return JSON with keys:
- "situationSummary": string — brief narrative of what is conflicting and why it matters
- "keyRisks": string[] — top 3-5 risks from simultaneous operations
- "mitigations": Array<{ conflict: string, actions: string[] }> — per-conflict control measures
- "recommendation": "HOLD" | "PROCEED WITH CONTROLS" | "SAFE TO PROCEED"
- "recommendationRationale": string`,
    },
    {
      role: "user",
      content: `SIMOPS CHECK — New Permit Request
Work Type: ${request.workType}
Work Area: ${request.workArea ?? "Not specified"}
Schedule: ${request.startDate} → ${request.endDate}

${conflictSummaryText}

${simopsFlagText}

TOP HAZARDS IDENTIFIED (${allHazards.length} total, risk summary: ${JSON.stringify(riskSummary)}):
${hazardText}

Generate a SIMOPS safety briefing for the permit approver.`,
    },
  ]);

  let briefing: {
    situationSummary: string;
    keyRisks: string[];
    mitigations: Array<{ conflict: string; actions: string[] }>;
    recommendation: string;
    recommendationRationale: string;
  };

  try {
    briefing = JSON.parse(aiResult.content);
  } catch {
    briefing = {
      situationSummary: aiResult.content,
      keyRisks: [],
      mitigations: [],
      recommendation: simopsResult.overallRisk === "critical" ? "HOLD" : "PROCEED WITH CONTROLS",
      recommendationRationale: "AI response could not be parsed as JSON.",
    };
  }

  console.log(
    `[API] simops-assess complete — recommendation: ${briefing.recommendation}, overallRisk: ${simopsResult.overallRisk}`
  );

  return c.json({
    success: true,
    request,
    recommendation: briefing.recommendation,
    overallRisk: simopsResult.overallRisk,
    steps: {
      simopsCheck: {
        conflicts: {
          count: simopsResult.scheduleConflicts.count,
          permits: simopsResult.scheduleConflicts.permits,
        },
        simopsFlags: simopsResult.simopsFlags,
        summary: simopsResult.summary,
      },
      safetyBriefing: {
        situationSummary: briefing.situationSummary,
        keyRisks: briefing.keyRisks,
        mitigations: briefing.mitigations,
        recommendationRationale: briefing.recommendationRationale,
        metadata: {
          promptTokens: aiResult.promptTokens,
          completionTokens: aiResult.completionTokens,
        },
      },
    },
  });
});

export default agentRouter;
