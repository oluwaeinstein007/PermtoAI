import { z } from "zod";
import { HazardSchema } from "../schemas/index.js";
import { ValidationService } from "../services/validationService.js";

const AnomalyDetectParams = z.object({
  hazards: z
    .array(HazardSchema)
    .min(1)
    .describe("Hazard assessments to check for anomalies"),
});

export const AnomalyDetectTool = {
  name: "ANOMALY_DETECT" as const,
  description:
    "Detect anomalies in hazard assessments: duplicate permits, identical readings, copy-pasted risk assessments, and suspicious patterns. Uses isolation-style checks and similarity thresholds.",
  parameters: AnomalyDetectParams,
  execute: async (args: z.infer<typeof AnomalyDetectParams>) => {
    console.log(`[ANOMALY_DETECT] Checking ${args.hazards.length} hazards for anomalies`);
    const validationService = new ValidationService();

    try {
      const result = validationService.anomalyDetection(args.hazards);

      return JSON.stringify({
        success: true,
        anomaliesDetected: !result.passed,
        issueCount: result.issues.length,
        issues: result.issues,
        confidence: result.confidence,
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : "An unknown error occurred during anomaly detection.";
      console.error(`[ANOMALY_DETECT] Error: ${message}`);
      throw new Error(message);
    }
  },
};
