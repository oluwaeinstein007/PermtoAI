import { Hono } from "hono";
import { JobContextSchema } from "../../schemas/index.js";
import { HazardService } from "../../services/hazardService.js";
import { RiskScoringService } from "../../services/riskScoringService.js";
import { ValidationService } from "../../services/validationService.js";
import { chatCompletion } from "../../services/embeddingService.js";

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

export default agentRouter;
