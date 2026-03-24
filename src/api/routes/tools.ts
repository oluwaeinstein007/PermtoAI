import { Hono } from "hono";
import { z } from "zod";
import { JobContextSchema, HazardSchema } from "../../schemas/index.js";
import { HazardService } from "../../services/hazardService.js";
import { RiskScoringService } from "../../services/riskScoringService.js";
import { ValidationService } from "../../services/validationService.js";
import { chatCompletion } from "../../services/embeddingService.js";
import { checkSimops } from "../../services/simopsService.js";

const toolsRouter = new Hono();

// POST /api/v1/tools/hazard-suggest
toolsRouter.post("/hazard-suggest", async (c) => {
  const body = await c.req.json();
  const jobContext = JobContextSchema.parse(body);

  console.log(`[API] HAZARD_SUGGEST called for job type: ${jobContext.jobType}`);
  const service = new HazardService();
  const result = await service.suggestHazards(jobContext);

  return c.json({
    success: true,
    hazardCount: result.hazards.length,
    hazards: result.hazards,
    metadata: {
      regulationsUsed: result.regulationsUsed,
      incidentsUsed: result.incidentsUsed,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
    },
  });
});

// POST /api/v1/tools/risk-assess
const RiskAssessBody = z.object({
  hazards: z.array(HazardSchema).min(1),
});

toolsRouter.post("/risk-assess", async (c) => {
  const body = await c.req.json();
  const { hazards } = RiskAssessBody.parse(body);

  console.log(`[API] RISK_ASSESS called for ${hazards.length} hazards`);
  const service = new RiskScoringService();
  const scoredHazards = service.scoreHazards(hazards);
  const matrixSummary = service.computeSummary(scoredHazards);

  return c.json({
    success: true,
    summary: {
      counts: matrixSummary.counts,
      totalMatrixSum: matrixSummary.totalMatrixSum,
      averageRiskScore: matrixSummary.averageRiskScore,
      dominantRiskLevel: matrixSummary.dominantRiskLevel,
      rulesApplied: matrixSummary.rulesApplied,
      overallAdvice: matrixSummary.overallAdvice,
      confidenceScore: matrixSummary.confidenceScore,
      confidenceInterval: matrixSummary.confidenceInterval,
    },
    scoredHazards: scoredHazards.map((s) => ({
      hazardName: s.hazard.name,
      category: s.hazard.category,
      likelihood: s.riskScore.likelihood,
      severity: s.riskScore.severity,
      riskScore: s.riskScore.risk,
      riskLevel: s.riskLevel,
      rationale: s.riskScore.rationale,
      ruleApplied: s.ruleApplied,
      controls: s.hazard.recommendedControls,
    })),
  });
});

// POST /api/v1/tools/compliance-check
const ComplianceCheckBody = z.object({
  jobContext: JobContextSchema,
  hazards: z.array(HazardSchema).min(1),
});

toolsRouter.post("/compliance-check", async (c) => {
  const body = await c.req.json();
  const { jobContext, hazards } = ComplianceCheckBody.parse(body);

  console.log(`[API] COMPLIANCE_CHECK called for job type: ${jobContext.jobType}`);

  const hazardSummary = hazards
    .map(
      (h) =>
        `${h.name} (${h.category}, L:${h.likelihood}/S:${h.severity}) — Controls: ${h.recommendedControls.join("; ")}${h.dprReference ? ` — Ref: ${h.dprReference}` : ""}`
    )
    .join("\n");

  const result = await chatCompletion([
    {
      role: "system",
      content: `You are a regulatory compliance expert for Nigerian oil & gas operations. You specialize in:
- DPR EGASPIN (Environmental Guidelines and Standards for the Petroleum Industry in Nigeria)
- ISO 45001 Occupational Health & Safety Management
- IOGP (International Association of Oil & Gas Producers) safety standards

Evaluate the permit against all three frameworks. Return JSON with key "standards" containing an array of objects, each with:
- "standard": the standard name
- "compliant": boolean
- "findings": array of specific issues found
- "recommendations": array of actionable improvement steps`,
    },
    {
      role: "user",
      content: `Evaluate this permit for regulatory compliance:

JOB: ${jobContext.jobType}
LOCATION: ${jobContext.location ?? "Not specified"}
ENVIRONMENT: ${jobContext.environment ?? "Not specified"}
EQUIPMENT: ${(jobContext.equipment ?? []).join(", ") || "Not specified"}
CONTRACTOR: ${jobContext.contractor?.name ?? "N/A"} (Tier ${jobContext.contractor?.tier ?? "N/A"})

HAZARD ASSESSMENT:
${hazardSummary}`,
    },
  ]);

  const parsed = JSON.parse(result.content);
  const overallCompliant = (
    parsed.standards as Array<{ compliant: boolean }>
  ).every((s) => s.compliant);

  return c.json({
    success: true,
    overallCompliant,
    standards: parsed.standards,
    metadata: {
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
    },
  });
});

// POST /api/v1/tools/permit-validate
const PermitValidateBody = z.object({
  jobContext: JobContextSchema,
  hazards: z.array(HazardSchema),
});

toolsRouter.post("/permit-validate", async (c) => {
  const body = await c.req.json();
  const { jobContext, hazards } = PermitValidateBody.parse(body);

  console.log(`[API] PERMIT_VALIDATE called for job type: ${jobContext.jobType}`);
  const service = new ValidationService();
  const results = await service.validatePermit(jobContext, hazards);

  const allPassed = results.every((r) => r.passed);
  const totalIssues = results.reduce((sum, r) => sum + r.issues.length, 0);

  return c.json({
    success: true,
    recommendation: allPassed ? "Recommend Approval" : "Flag for Review",
    allPassed,
    totalIssues,
    layers: results.map((r) => ({
      layer: r.layer,
      passed: r.passed,
      issueCount: r.issues.length,
      issues: r.issues,
      confidence: r.confidence,
      details: r.details,
    })),
  });
});

// POST /api/v1/tools/anomaly-detect
const AnomalyDetectBody = z.object({
  hazards: z.array(HazardSchema).min(1),
});

toolsRouter.post("/anomaly-detect", async (c) => {
  const body = await c.req.json();
  const { hazards } = AnomalyDetectBody.parse(body);

  console.log(`[API] ANOMALY_DETECT called for ${hazards.length} hazards`);
  const service = new ValidationService();
  const result = service.anomalyDetection(hazards);

  return c.json({
    success: true,
    anomaliesDetected: !result.passed,
    issueCount: result.issues.length,
    issues: result.issues,
    confidence: result.confidence,
  });
});

// POST /api/v1/tools/simops-check
const PermitRequestSchema = z.object({
  startDate: z.string(),
  endDate: z.string(),
  workType: z.string(),
  workArea: z.string().nullable().optional(),
});

const ExistingPermitSchema = z.object({
  id: z.union([z.number(), z.string()]),
  type: z.string().optional(),
  status: z.string(),
  workType: z.string(),
  workArea: z.string().nullable().optional(),
  startDate: z.string(),
  endDate: z.string(),
  jobType: z.string().optional(),
});

const SimopsCheckBody = z.object({
  request: PermitRequestSchema,
  permits: z.array(ExistingPermitSchema),
});

toolsRouter.post("/simops-check", async (c) => {
  const body = await c.req.json();
  const { request, permits } = SimopsCheckBody.parse(body);

  console.log(
    `[API] SIMOPS_CHECK called for workType="${request.workType}" against ${permits.length} permit(s)`
  );

  const result = checkSimops(request, permits);

  return c.json({
    success: true,
    request,
    conflicts: {
      count: result.scheduleConflicts.count,
      permits: result.scheduleConflicts.permits,
    },
    simopsFlags: result.simopsFlags,
    overallRisk: result.overallRisk,
    summary: result.summary,
  });
});

export default toolsRouter;
