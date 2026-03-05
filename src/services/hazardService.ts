import { z } from "zod";
import { HazardSchema, type Hazard, type JobContext } from "../schemas/index.js";
import { chatCompletion, embedText } from "./embeddingService.js";
import { VectorService, type VectorSearchResult } from "./vectorService.js";
import { env } from "../config.js";

const SYSTEM_INSTRUCTION = `You are an expert HSE AI assistant specialized in Nigerian oil & gas operations.
You are trained on IOGP safety standards and Nigerian DPR regulations.

Your role is to identify workplace hazards and suggest appropriate controls based on:
- Job type and context
- Historical incident data
- Industry best practices
- Nigerian regulatory requirements

Always prioritize worker safety and compliance. Provide specific, actionable recommendations.`;

function buildHazardPrompt(
  context: JobContext,
  regulations: string,
  incidentSummary: string
): string {
  return `Analyze this permit-to-work scenario and identify hazards:

JOB CONTEXT:
- Job Type: ${context.jobType}
- Location: ${context.location}
- Environment: ${context.environment}
- Equipment: ${context.equipment.join(", ")}
- Contractor: ${context.contractor?.name ?? "N/A"} (Tier ${context.contractor?.tier ?? "N/A"})
${context.description ? `- Description: ${context.description}` : ""}

RELEVANT REGULATIONS:
${regulations || "No specific regulations retrieved."}

SIMILAR HISTORICAL INCIDENTS:
${incidentSummary || "No similar incidents found."}

TASK:
Generate 5-${env.MAX_HAZARD_SUGGESTIONS} potential hazards for this job. For each hazard, provide:
1. name: Clear hazard description
2. category: One of [chemical, physical, biological, ergonomic]
3. likelihood: Rating 1-5 (1=rare, 5=almost certain)
4. severity: Rating 1-5 (1=negligible, 5=catastrophic)
5. recommendedControls: Array of specific control measures
6. dprReference: Nigerian DPR regulation reference (if applicable)
7. explanation: Brief rationale for why this hazard is relevant

CRITICAL FOCUS AREAS:
- H₂S exposure in sour gas fields
- Confined space entry hazards
- Hot work in hydrocarbon environments
- SIMOPS (Simultaneous Operations) conflicts
- Dropped objects on offshore platforms

Return a JSON object with key "hazards" containing an array of hazard objects. No markdown, no explanations outside the JSON.`;
}

function formatRegulations(results: VectorSearchResult[]): string {
  if (results.length === 0) return "";
  return results
    .map(
      (r, i) =>
        `[${i + 1}] ${(r.payload["title"] as string) ?? "Regulation"}: ${(r.payload["content"] as string) ?? ""} (relevance: ${r.score.toFixed(2)})`
    )
    .join("\n");
}

function formatIncidents(results: VectorSearchResult[]): string {
  if (results.length === 0) return "";
  return results
    .map(
      (r, i) =>
        `[${i + 1}] ${(r.payload["description"] as string) ?? "Incident"} — Hazards: ${(r.payload["hazards"] as string) ?? "N/A"} (similarity: ${r.score.toFixed(2)})`
    )
    .join("\n");
}

export interface HazardSuggestionResult {
  hazards: Hazard[];
  promptTokens: number;
  completionTokens: number;
  regulationsUsed: number;
  incidentsUsed: number;
}

export class HazardService {
  private vectorService: VectorService;

  constructor() {
    this.vectorService = new VectorService();
  }

  async suggestHazards(context: JobContext): Promise<HazardSuggestionResult> {
    // Build embedding from job context
    const contextText = `${context.jobType} ${context.location} ${context.environment} ${context.equipment.join(" ")} ${context.description ?? ""}`;
    let queryVector: number[];

    try {
      queryVector = await embedText(contextText);
    } catch (error) {
      console.warn("[HazardService] Embedding failed, proceeding without vector search:", error);
      return this.suggestWithoutVectors(context);
    }

    // Retrieve regulations and incidents in parallel
    const [regulations, incidents] = await Promise.all([
      this.vectorService.searchRegulations(queryVector),
      this.vectorService.searchIncidents(queryVector),
    ]);

    const regulationText = formatRegulations(regulations);
    const incidentText = formatIncidents(incidents);

    const prompt = buildHazardPrompt(context, regulationText, incidentText);

    const result = await chatCompletion([
      { role: "system", content: SYSTEM_INSTRUCTION },
      { role: "user", content: prompt },
    ]);

    const parsed = JSON.parse(result.content);
    const hazardsArray = z.array(HazardSchema);
    const hazards = hazardsArray.parse(parsed.hazards);

    // Merge any missed hazards from incident similarity search
    const mergedHazards = this.mergeIncidentHazards(hazards, incidents);

    return {
      hazards: mergedHazards,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      regulationsUsed: regulations.length,
      incidentsUsed: incidents.length,
    };
  }

  /**
   * Fallback: suggest hazards without vector search (rule-based degradation).
   */
  private async suggestWithoutVectors(
    context: JobContext
  ): Promise<HazardSuggestionResult> {
    const prompt = buildHazardPrompt(context, "", "");

    const result = await chatCompletion([
      { role: "system", content: SYSTEM_INSTRUCTION },
      { role: "user", content: prompt },
    ]);

    const parsed = JSON.parse(result.content);
    const hazardsArray = z.array(HazardSchema);
    const hazards = hazardsArray.parse(parsed.hazards);

    return {
      hazards,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      regulationsUsed: 0,
      incidentsUsed: 0,
    };
  }

  /**
   * Missed hazard guardrail: merge hazards discovered from similar incidents
   * that the AI may have missed.
   */
  private mergeIncidentHazards(
    aiHazards: Hazard[],
    incidents: VectorSearchResult[]
  ): Hazard[] {
    const existingNames = new Set(
      aiHazards.map((h) => h.name.toLowerCase())
    );

    for (const incident of incidents) {
      const incidentHazards = incident.payload["hazard_names"] as
        | string[]
        | undefined;
      if (!incidentHazards) continue;

      for (const hazardName of incidentHazards) {
        if (!existingNames.has(hazardName.toLowerCase())) {
          existingNames.add(hazardName.toLowerCase());
          aiHazards.push({
            name: hazardName,
            category: "physical",
            likelihood: 2,
            severity: 3,
            recommendedControls: ["Review historical incident data for specific controls"],
            explanation: `Identified from similar historical incident (similarity: ${incident.score.toFixed(2)}). Requires manual review.`,
          });
        }
      }
    }

    return aiHazards;
  }
}
