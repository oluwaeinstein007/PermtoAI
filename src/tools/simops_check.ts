import { z } from "zod";
import { checkSimops } from "../services/simopsService.js";

const PermitRequestSchema = z.object({
  startDate: z.string().describe("Permit start date (ISO date or datetime)"),
  endDate: z.string().describe("Permit end date (ISO date or datetime)"),
  workType: z.string().describe("Type of work being requested, e.g. 'Hot Work', 'Confined Space Entry'"),
  workArea: z.string().nullable().optional().describe("Work area or zone (nullable)"),
});

const ExistingPermitSchema = z.object({
  id: z.union([z.number(), z.string()]).describe("Permit ID"),
  type: z.string().optional().describe("Permit category/type, e.g. 'Draft'"),
  status: z.string().describe("Permit status, e.g. 'draft', 'approved'"),
  workType: z.string().describe("Work type of the existing permit"),
  workArea: z.string().nullable().optional().describe("Work area of the existing permit"),
  startDate: z.string().describe("Permit start datetime"),
  endDate: z.string().describe("Permit end datetime"),
  jobType: z.string().optional().describe("Job type (may duplicate workType)"),
});

const SimopsCheckParams = z.object({
  request: PermitRequestSchema,
  permits: z
    .array(ExistingPermitSchema)
    .describe("Existing active/draft permits to check against"),
});

export const SimopsCheckTool = {
  name: "SIMOPS_CHECK" as const,
  description:
    "Check a new permit request for SIMOPS (Simultaneous Operations) conflicts against existing permits. " +
    "Detects: (1) schedule conflicts — same work type and area with overlapping dates, and " +
    "(2) SIMOPS incompatibilities — work type pairs that must not run simultaneously (e.g. Hot Work + Confined Space Entry). " +
    "Returns conflict details, severity ratings, and an overall risk level.",
  parameters: SimopsCheckParams,
  execute: async (args: z.infer<typeof SimopsCheckParams>) => {
    console.log(
      `[SIMOPS_CHECK] Checking conflicts for workType="${args.request.workType}" ` +
        `from ${args.request.startDate} to ${args.request.endDate} ` +
        `against ${args.permits.length} existing permit(s)`
    );

    try {
      const result = checkSimops(args.request, args.permits);

      return JSON.stringify({
        success: true,
        request: args.request,
        conflicts: {
          count: result.scheduleConflicts.count,
          permits: result.scheduleConflicts.permits,
        },
        simopsFlags: result.simopsFlags,
        overallRisk: result.overallRisk,
        summary: result.summary,
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : "An unknown error occurred during SIMOPS check.";
      console.error(`[SIMOPS_CHECK] Error: ${message}`);
      throw new Error(message);
    }
  },
};
