import { z } from "zod";

// ─── Hazard Category ───
export const HazardCategorySchema = z.enum([
  "chemical",
  "physical",
  "biological",
  "ergonomic",
]);
export type HazardCategory = z.infer<typeof HazardCategorySchema>;

// ─── Likelihood / Severity (1-5 scale) ───
export const RatingSchema = z.number().int().min(1).max(5);

// ─── Hazard ───
export const HazardSchema = z.object({
  name: z.string().describe("Clear hazard description"),
  category: HazardCategorySchema,
  likelihood: RatingSchema.describe("1=rare, 5=almost certain"),
  severity: RatingSchema.describe("1=negligible, 5=catastrophic"),
  recommendedControls: z.array(z.string()).describe("Specific control measures"),
  dprReference: z.string().optional().describe("Nigerian DPR regulation reference"),
  explanation: z.string().describe("Rationale for why this hazard is relevant"),
});
export type Hazard = z.infer<typeof HazardSchema>;

// ─── Risk Score ───
export const RiskScoreSchema = z.object({
  likelihood: RatingSchema,
  severity: RatingSchema,
  risk: z.number().describe("likelihood × severity"),
  rationale: z.string(),
  historicalEvidence: z.array(z.string()).optional(),
});
export type RiskScore = z.infer<typeof RiskScoreSchema>;

// ─── Job Context (input to hazard engine) ───
export const JobContextSchema = z.object({
  jobType: z.string().describe("Type of job, e.g. 'Hot Work', 'Confined Space Entry'"),
  location: z.string().optional().describe("Work location"),
  environment: z.string().optional().describe("Environmental conditions, e.g. 'Offshore platform', 'Sour gas field'"),
  equipment: z.array(z.string()).optional().describe("Equipment being used"),
  contractor: z
    .object({
      name: z.string(),
      tier: z.number().int().min(1).max(3),
    })
    .optional()
    .describe("Contractor details"),
  description: z.string().optional().describe("Free-text job description"),
});
export type JobContext = z.infer<typeof JobContextSchema>;

// ─── Permit ───
export const PermitSchema = z.object({
  id: z.string(),
  jobContext: JobContextSchema,
  hazards: z.array(HazardSchema),
  riskScores: z.array(RiskScoreSchema).optional(),
  status: z.enum(["draft", "pending_review", "approved", "rejected", "expired"]),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
});
export type Permit = z.infer<typeof PermitSchema>;

// ─── Validation Result ───
export const ValidationResultSchema = z.object({
  layer: z.enum(["rule_based", "semantic", "compliance", "anomaly"]),
  passed: z.boolean(),
  issues: z.array(z.string()),
  confidence: z.number().min(0).max(1).optional(),
  details: z.string().optional(),
});
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

// ─── Compliance Check Result ───
export const ComplianceResultSchema = z.object({
  standard: z.string().describe("e.g. 'DPR EGASPIN', 'ISO 45001', 'IOGP'"),
  compliant: z.boolean(),
  findings: z.array(z.string()),
  recommendations: z.array(z.string()),
});
export type ComplianceResult = z.infer<typeof ComplianceResultSchema>;

// ─── AI Token Usage (audit trail) ───
export const TokenUsageSchema = z.object({
  promptTokens: z.number(),
  completionTokens: z.number(),
  model: z.string(),
  timestamp: z.string().datetime(),
  operation: z.string(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;
