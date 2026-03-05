import { z } from "zod";
import { JobContextSchema } from "../schemas/index.js";
import { HazardService } from "../services/hazardService.js";

const HazardSuggestParams = JobContextSchema;

export const HazardSuggestTool = {
  name: "HAZARD_SUGGEST" as const,
  description:
    "Suggest potential workplace hazards for a permit-to-work scenario. Uses AI analysis, historical incident data, and DPR/IOGP regulations to identify hazards with recommended controls.",
  parameters: HazardSuggestParams,
  execute: async (args: z.infer<typeof HazardSuggestParams>) => {
    console.log(`[HAZARD_SUGGEST] Called with job type: ${args.jobType}`);
    const hazardService = new HazardService();

    try {
      const result = await hazardService.suggestHazards(args);

      return JSON.stringify({
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
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : "An unknown error occurred during hazard suggestion.";
      console.error(`[HAZARD_SUGGEST] Error: ${message}`);
      throw new Error(message);
    }
  },
};
