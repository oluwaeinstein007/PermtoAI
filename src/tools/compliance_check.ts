import { z } from "zod";
import { HazardSchema, JobContextSchema } from "../schemas/index.js";
import { chatCompletion } from "../services/embeddingService.js";

const ComplianceCheckParams = z.object({
  jobContext: JobContextSchema,
  hazards: z.array(HazardSchema).min(1),
});

export const ComplianceCheckTool = {
  name: "COMPLIANCE_CHECK" as const,
  description:
    "Validate a permit application against DPR EGASPIN, ISO 45001, and IOGP standards. Returns compliance status, findings, and recommendations for each standard.",
  parameters: ComplianceCheckParams,
  execute: async (args: z.infer<typeof ComplianceCheckParams>) => {
    console.log(`[COMPLIANCE_CHECK] Checking compliance for ${args.jobContext.jobType}`);

    try {
      const hazardSummary = args.hazards
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

JOB: ${args.jobContext.jobType}
LOCATION: ${args.jobContext.location}
ENVIRONMENT: ${args.jobContext.environment}
EQUIPMENT: ${args.jobContext.equipment.join(", ")}
CONTRACTOR: ${args.jobContext.contractor?.name ?? "N/A"} (Tier ${args.jobContext.contractor?.tier ?? "N/A"})

HAZARD ASSESSMENT:
${hazardSummary}`,
        },
      ]);

      const parsed = JSON.parse(result.content);

      const overallCompliant = (parsed.standards as Array<{ compliant: boolean }>).every(
        (s) => s.compliant
      );

      return JSON.stringify({
        success: true,
        overallCompliant,
        standards: parsed.standards,
        metadata: {
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
        },
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : "An unknown error occurred during compliance check.";
      console.error(`[COMPLIANCE_CHECK] Error: ${message}`);
      throw new Error(message);
    }
  },
};
