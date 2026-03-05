import { z } from "zod";
import { HazardSchema, JobContextSchema } from "../schemas/index.js";
import { ValidationService } from "../services/validationService.js";

const PermitValidateParams = z.object({
  jobContext: JobContextSchema,
  hazards: z.array(HazardSchema),
});

export const PermitValidateTool = {
  name: "PERMIT_VALIDATE" as const,
  description:
    "Run multi-layer validation on a permit application. Layer 1: rule-based checks (fast). Layer 2: AI semantic analysis. Layer 3: standards compliance. Layer 4: anomaly detection. Returns pass/fail for each layer with specific issues.",
  parameters: PermitValidateParams,
  execute: async (args: z.infer<typeof PermitValidateParams>) => {
    console.log(`[PERMIT_VALIDATE] Validating permit for ${args.jobContext.jobType}`);
    const validationService = new ValidationService();

    try {
      const results = await validationService.validatePermit(
        args.jobContext,
        args.hazards
      );

      const allPassed = results.every((r) => r.passed);
      const totalIssues = results.reduce(
        (sum, r) => sum + r.issues.length,
        0
      );

      const recommendation = allPassed
        ? "Recommend Approval"
        : "Flag for Review";

      return JSON.stringify({
        success: true,
        recommendation,
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
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : "An unknown error occurred during permit validation.";
      console.error(`[PERMIT_VALIDATE] Error: ${message}`);
      throw new Error(message);
    }
  },
};
