import { z } from "zod";
import { SampleService } from "../services/sampleService.js";

const SampleParamsSchema = z.object({
    test_name: z
        .string()
        .describe("The name of the test for which sample data is requested."),
});

export const SampleTool = {
    name: "SAMPLE_TOOL",
    description:
        "Get sample data for a given test.",
    parameters: SampleParamsSchema,
    execute: async (args: z.infer<typeof SampleParamsSchema>) => {

        console.log(`[SAMPLE_TOOL] Called with: ${JSON.stringify(args)}`);
        const sampleService = new SampleService();
        try {
            const medsList = await sampleService.addLog({
                name: args.test_name,
            });
            return `
            Successfully searched medicines with name ${args.test_name}.
            Log Meds: ${medsList}
            `;
        } catch (error: unknown) {
            const message =
                error instanceof Error
                    ? error.message
                    : "An unknown error occurred while searching medicines.";
            console.error(`[SAMPLE_TOOL] Error: ${message}`);
            throw new Error(message);
        }
    },
};
