import { z } from "zod";
import { HazardSchema } from "../schemas/index.js";
import { RiskScoringService } from "../services/riskScoringService.js";

const RiskAssessParams = z.object({
  hazards: z
    .array(HazardSchema)
    .min(1)
    .describe("Array of hazards to score against the risk matrix"),
});

export const RiskAssessTool = {
  name: "RISK_ASSESS" as const,
  description:
    "Score identified hazards using the risk matrix (likelihood × severity). Applies rule-based severity constraints for critical hazards (e.g., H₂S minimum severity = 4). Returns risk levels and audit-ready rationale.",
  parameters: RiskAssessParams,
  execute: async (args: z.infer<typeof RiskAssessParams>) => {
    console.log(`[RISK_ASSESS] Scoring ${args.hazards.length} hazards`);
    const riskService = new RiskScoringService();

    try {
      const scoredHazards = riskService.scoreHazards(args.hazards);

      const summary = {
        critical: scoredHazards.filter((s) => s.riskLevel === "critical").length,
        high: scoredHazards.filter((s) => s.riskLevel === "high").length,
        medium: scoredHazards.filter((s) => s.riskLevel === "medium").length,
        low: scoredHazards.filter((s) => s.riskLevel === "low").length,
      };

      const rulesApplied = scoredHazards.filter((s) => s.ruleApplied).length;

      return JSON.stringify({
        success: true,
        summary,
        rulesApplied,
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
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : "An unknown error occurred during risk assessment.";
      console.error(`[RISK_ASSESS] Error: ${message}`);
      throw new Error(message);
    }
  },
};
