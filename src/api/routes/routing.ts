import { Hono } from "hono";
import { z } from "zod";
import { chatCompletion } from "../../services/embeddingService.js";

const routingRouter = new Hono();

// ─── Schemas ──────────────────────────────────────────────────────────────────

const PermitDataSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  type: z.string().optional(),
  workType: z.string(),
  workArea: z.string().nullish(),
  jobType: z.string().optional(),
  severity: z.string().optional(), // Low / Moderate / High / Severe
  likelihood: z.string().optional(), // Low / Unlikely / Likely / Very likely
  hazards: z.array(z.union([z.string(), z.record(z.unknown())])).default([]),
  controlMeasures: z.array(z.union([z.string(), z.record(z.unknown())])).default([]),
  isolationSections: z.array(z.record(z.unknown())).default([]),
  startDate: z.string().nullish(),
  endDate: z.string().nullish(),
  workShift: z.string().optional(),
  attachments: z.array(z.unknown()).default([]),
  created_at: z.string().optional(),
});

const UserSchema = z.object({
  userId: z.union([z.number(), z.string()]),
  name: z.string(),
  role: z.string(),
  currentQueue: z.number().default(0),
});

const RecommendRoutingBodySchema = z.object({
  permit: PermitDataSchema,
  availableUsers: z.array(UserSchema).default([]),
  // Active & pending permits at the same facility for SIMOPS
  activePermits: z.array(z.record(z.unknown())).default([]),
  // Expected risk controls from GET /api/risk-assessment-options
  riskOptions: z.record(z.unknown()).optional(),
});

const PreSubmissionBodySchema = z.object({
  permit: PermitDataSchema,
  riskOptions: z.record(z.unknown()).optional(),
});

// ─── Risk helpers ─────────────────────────────────────────────────────────────

const SEVERITY_WEIGHT: Record<string, number> = {
  Low: 1,
  Moderate: 2,
  High: 3,
  Severe: 4,
};

const LIKELIHOOD_WEIGHT: Record<string, number> = {
  Low: 1,
  Unlikely: 2,
  Likely: 3,
  "Very likely": 4,
};

function computeRiskRating(severity?: string, likelihood?: string): string {
  const s = SEVERITY_WEIGHT[severity ?? ""] ?? 2;
  const l = LIKELIHOOD_WEIGHT[likelihood ?? ""] ?? 2;
  const score = s * l;
  if (score >= 12) return "EXTREME";
  if (score >= 8) return "HIGH";
  if (score >= 4) return "MODERATE";
  return "LOW";
}

// Canonical role requirements per work type
const WORK_TYPE_ROLES: Record<string, string[]> = {
  "Hot Work": ["HSE Manager", "Gas Tester"],
  "Hot Work - Welding/Cutting": ["HSE Manager", "Gas Tester"],
  "Confined Space Entry": ["HSE Manager", "Gas Tester"],
  "Electrical Isolation": ["HSE Manager", "Isolation Manager"],
  "Cold Work": ["HSE Manager"],
  "Working at Height": ["HSE Manager"],
  "Lifting Operations": ["HSE Manager", "Supervisor"],
  "Excavation": ["HSE Manager", "Supervisor"],
  "Chemical Handling": ["HSE Manager"],
  "Pressurized System Work": ["HSE Manager", "Isolation Manager"],
  "Pipeline Work": ["HSE Manager", "Isolation Manager"],
  "Radiography": ["HSE Manager"],
};

const GAS_TESTER_KEYWORDS = [
  "h2s",
  "hydrogen sulfide",
  "toxic gas",
  "confined space",
  "asphyxiation",
  "oxygen deficiency",
  "flammable gas",
  "vapor",
  "vapour",
  "hydrocarbon",
];

function stringifyArray(arr: unknown[]): string {
  return arr.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join(", ");
}

// ─── POST /api/v1/agent/routing/recommend ─────────────────────────────────────
// Workflow:
//   1. Compute risk rating from severity × likelihood
//   2. Determine required roles from work type + isolation sections + hazards
//   3. Filter + rank available users by role and queue depth
//   4. AI identifies missing controls and generates routing notes
//   5. Check active permits for SIMOPS date/area overlaps
routingRouter.post("/recommend", async (c) => {
  const body = await c.req.json();
  const { permit, availableUsers, activePermits, riskOptions } =
    RecommendRoutingBodySchema.parse(body);

  console.log(`[API] routing/recommend — workType="${permit.workType}"`);

  // Step 1: Risk rating
  const riskRating = computeRiskRating(permit.severity, permit.likelihood);

  // Step 2: Required roles
  const requiredRoles = new Set<string>(WORK_TYPE_ROLES[permit.workType] ?? ["HSE Manager"]);

  if ((permit.isolationSections ?? []).length > 0) {
    requiredRoles.add("Isolation Manager");
  }

  const hazardText = JSON.stringify(permit.hazards ?? []).toLowerCase();
  const typeText = permit.workType.toLowerCase();
  const needsGasTester =
    GAS_TESTER_KEYWORDS.some((kw) => hazardText.includes(kw)) ||
    typeText.includes("confined space") ||
    typeText.includes("hot work");

  if (needsGasTester) requiredRoles.add("Gas Tester");
  if (riskRating === "EXTREME") requiredRoles.add("Admin");

  const routingPath = Array.from(requiredRoles);

  // Step 3: Select and rank approvers (lowest queue first per role)
  const recommendedApprovers = availableUsers
    .filter((u) => requiredRoles.has(u.role))
    .sort((a, b) => (a.currentQueue ?? 0) - (b.currentQueue ?? 0))
    .slice(0, 5);

  // Step 4: AI — missing controls + routing notes
  const hazardSummary = stringifyArray(permit.hazards ?? []) || "None listed";
  const controlSummary = stringifyArray(permit.controlMeasures ?? []) || "None listed";

  const aiResult = await chatCompletion([
    {
      role: "system",
      content: `You are a permit-to-work safety expert for Nigerian oil & gas operations.
Analyse the permit and identify missing or inadequate control measures required for this work type.
Return JSON with:
- "missingControls": string[] — controls that should be present but are absent based on the work type and hazards
- "routingNotes": string — brief note for the approver about key risks or special considerations
- "confidence": number (0.0–1.0) — confidence in the routing recommendation`,
    },
    {
      role: "user",
      content: `PERMIT ROUTING ANALYSIS
Work Type: ${permit.workType}
Permit Type: ${permit.type ?? "Not specified"}
Work Area: ${permit.workArea ?? "Not specified"}
Risk Rating: ${riskRating} (Severity: ${permit.severity ?? "?"}, Likelihood: ${permit.likelihood ?? "?"})
Work Shift: ${permit.workShift ?? "Not specified"}
Isolation Sections: ${(permit.isolationSections ?? []).length} section(s)
Attachments: ${(permit.attachments ?? []).length} attached

Identified Hazards: ${hazardSummary}
Current Control Measures: ${controlSummary}
${riskOptions ? `\nExpected controls for ${permit.workType}:\n${JSON.stringify(riskOptions).slice(0, 500)}` : ""}

Identify any missing controls and provide routing notes for the approver.`,
    },
  ]);

  let aiOutput: { missingControls: string[]; routingNotes: string; confidence: number };
  try {
    aiOutput = JSON.parse(aiResult.content);
  } catch {
    aiOutput = { missingControls: [], routingNotes: aiResult.content, confidence: 0.7 };
  }

  // Step 5: SIMOPS overlap check (date + area)
  const simopsConflicts: Array<{ permitId: unknown; workType: string; workArea: string | null }> = [];
  if (permit.startDate && permit.endDate) {
    const reqStart = new Date(permit.startDate).getTime();
    const reqEnd = new Date(permit.endDate).getTime();

    for (const ap of activePermits) {
      const apAny = ap as Record<string, unknown>;
      const apStart = apAny.startDate ? new Date(apAny.startDate as string).getTime() : 0;
      const apEnd = apAny.endDate ? new Date(apAny.endDate as string).getTime() : Infinity;
      const sameArea =
        !permit.workArea ||
        !apAny.workArea ||
        (apAny.workArea as string).toLowerCase().includes(permit.workArea.toLowerCase());

      if (apStart < reqEnd && apEnd > reqStart && sameArea) {
        simopsConflicts.push({
          permitId: apAny.id,
          workType: (apAny.workType as string) ?? "Unknown",
          workArea: (apAny.workArea as string | null) ?? null,
        });
      }
    }
  }

  console.log(
    `[API] routing/recommend complete — riskRating=${riskRating}, approvers=${recommendedApprovers.length}, simopsConflicts=${simopsConflicts.length}`
  );

  return c.json({
    success: true,
    data: {
      recommendedApprovers,
      routingPath,
      missingControls: aiOutput.missingControls ?? [],
      routingNotes: aiOutput.routingNotes,
      riskRating,
      simopsConflicts,
      confidence: aiOutput.confidence ?? 0.7,
    },
    metadata: {
      promptTokens: aiResult.promptTokens,
      completionTokens: aiResult.completionTokens,
    },
  });
});

// ─── POST /api/v1/agent/routing/pre-submission-check ─────────────────────────
// Validates permit completeness before submission.
// Layer 1 — rule-based field checks
// Layer 2 — AI semantic review for contextual gaps
routingRouter.post("/pre-submission-check", async (c) => {
  const body = await c.req.json();
  const { permit, riskOptions } = PreSubmissionBodySchema.parse(body);

  console.log(`[API] routing/pre-submission-check — workType="${permit.workType}"`);

  const issues: Array<{ field: string; message: string }> = [];
  const suggestions: string[] = [];

  // ── Layer 1: Rule-based checks ────────────────────────────────────────────
  if (!permit.workArea) {
    issues.push({ field: "workArea", message: "Work area must be specified" });
  }
  if (!permit.severity) {
    issues.push({ field: "severity", message: "Risk severity must be selected" });
  }
  if (!permit.likelihood) {
    issues.push({ field: "likelihood", message: "Risk likelihood must be selected" });
  }
  if (!permit.hazards || permit.hazards.length === 0) {
    issues.push({ field: "hazards", message: "At least one hazard must be identified before submission" });
    suggestions.push("Run a hazard assessment for your work type");
  }
  if (!permit.controlMeasures || permit.controlMeasures.length === 0) {
    issues.push({ field: "controlMeasures", message: "Control measures are required" });
    suggestions.push("Add control measures for each identified hazard");
  }
  if (!permit.startDate || !permit.endDate) {
    issues.push({ field: "startDate", message: "Permit validity dates (start and end) must be set" });
  }

  // Isolation required for specific work types
  const typeText = permit.workType.toLowerCase();
  const needsIsolation =
    typeText.includes("electrical") ||
    typeText.includes("pressurized") ||
    typeText.includes("pipeline") ||
    typeText.includes("isolation");
  if (needsIsolation && (permit.isolationSections ?? []).length === 0) {
    issues.push({
      field: "isolationSections",
      message: `Isolation plan required for ${permit.workType}`,
    });
    suggestions.push("Add isolation sections with isolator and verifier assignments");
  }

  // Attachment check for high-risk permit types
  const isHighRiskType =
    (permit.type?.toLowerCase().includes("confined space")) ||
    (permit.type?.toLowerCase().includes("hot work")) ||
    typeText.includes("confined space") ||
    typeText.includes("hot work");
  if (isHighRiskType && (permit.attachments ?? []).length === 0) {
    issues.push({
      field: "attachments",
      message: "Supporting documents (P&ID, risk assessment) required for this permit type",
    });
    suggestions.push("Attach P&ID diagram and isolation certificate");
  }

  // Hot work: gas test control measure check
  if (typeText.includes("hot work")) {
    const controls = stringifyArray(permit.controlMeasures ?? []).toLowerCase();
    if (!controls.includes("gas test") && !controls.includes("gas monitor")) {
      issues.push({
        field: "controlMeasures",
        message: "Gas test / gas monitoring is required for Hot Work permits",
      });
      suggestions.push("Add continuous gas monitoring as a control measure");
    }
    if (!controls.includes("fire watch")) {
      suggestions.push("Consider adding a fire watch to control measures");
    }
  }

  // ── Layer 2: AI semantic review ───────────────────────────────────────────
  const aiResult = await chatCompletion([
    {
      role: "system",
      content: `You are a permit-to-work compliance reviewer for Nigerian oil & gas operations.
Review this permit for contextual completeness issues that rule-based checks may miss.
Return JSON with:
- "additionalIssues": Array<{ field: string, message: string }> — gaps not caught by rule checks
- "additionalSuggestions": string[] — recommended improvements
- "ready": boolean — whether the permit content appears ready for submission (AI judgement only, independent of rule checks)`,
    },
    {
      role: "user",
      content: `PERMIT PRE-SUBMISSION REVIEW
Permit Type: ${permit.type ?? "Not specified"}
Work Type: ${permit.workType}
Work Area: ${permit.workArea ?? "Not specified"}
Severity: ${permit.severity ?? "?"}, Likelihood: ${permit.likelihood ?? "?"}
Work Shift: ${permit.workShift ?? "Not specified"}
Hazards (${(permit.hazards ?? []).length}): ${stringifyArray(permit.hazards ?? []).slice(0, 600)}
Control Measures (${(permit.controlMeasures ?? []).length}): ${stringifyArray(permit.controlMeasures ?? []).slice(0, 600)}
Isolation Sections: ${(permit.isolationSections ?? []).length}
Attachments: ${(permit.attachments ?? []).length}
${riskOptions ? `\nExpected requirements for ${permit.workType}:\n${JSON.stringify(riskOptions).slice(0, 400)}` : ""}

Identify any missing safety requirements or completeness gaps.`,
    },
  ]);

  let aiOutput: {
    additionalIssues: Array<{ field: string; message: string }>;
    additionalSuggestions: string[];
    ready: boolean;
  };
  try {
    aiOutput = JSON.parse(aiResult.content);
  } catch {
    aiOutput = { additionalIssues: [], additionalSuggestions: [], ready: issues.length === 0 };
  }

  const allIssues = [...issues, ...(aiOutput.additionalIssues ?? [])];
  const allSuggestions = [...suggestions, ...(aiOutput.additionalSuggestions ?? [])];
  const ready = allIssues.length === 0 && aiOutput.ready !== false;

  console.log(
    `[API] pre-submission-check complete — ready=${ready}, issues=${allIssues.length}`
  );

  return c.json({
    success: true,
    data: {
      ready,
      issues: allIssues,
      suggestions: allSuggestions,
    },
    metadata: {
      promptTokens: aiResult.promptTokens,
      completionTokens: aiResult.completionTokens,
    },
  });
});

export default routingRouter;
