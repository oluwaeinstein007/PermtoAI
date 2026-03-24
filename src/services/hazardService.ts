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
- Location: ${context.location ?? "Not specified"}
- Environment: ${context.environment ?? "Not specified"}
- Equipment: ${(context.equipment ?? []).join(", ") || "Not specified"}
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
6. dprReference: Nigerian DPR regulation reference (e.g. "DPR EGASPIN Section 4.1.2"). OMIT this field entirely if no specific regulation applies — do NOT use "N/A", "none", "null", or any placeholder string.
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

const DPR_PLACEHOLDER = /^(n\/?a|none|null|not applicable|no reference|no ref)$/i;

/** Strip placeholder dprReference values that the AI sometimes returns instead of omitting the field. */
function normalizeHazards(hazards: Hazard[]): Hazard[] {
  return hazards.map((h) => {
    if (h.dprReference && DPR_PLACEHOLDER.test(h.dprReference.trim())) {
      const { dprReference: _, ...rest } = h;
      return rest as Hazard;
    }
    return h;
  });
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
    const contextText = `${context.jobType} ${context.location ?? ""} ${context.environment ?? ""} ${(context.equipment ?? []).join(" ")} ${context.description ?? ""}`;
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
    const hazards = normalizeHazards(hazardsArray.parse(parsed.hazards));

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
    const hazards = normalizeHazards(hazardsArray.parse(parsed.hazards));

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
   *
   * Only adds hazards that are:
   * - From incidents above the similarity threshold
   * - Not semantically duplicated by an existing AI-generated hazard
   * - Not a generic outcome term (e.g. "Serious Injury")
   * Up to MAX_MERGED_FROM_INCIDENTS additional hazards are added.
   */
  private readonly INCIDENT_SIMILARITY_THRESHOLD = 0.70;
  private readonly MAX_MERGED_FROM_INCIDENTS = 5;

  // Terms that describe outcomes or consequences rather than hazards
  private readonly OUTCOME_TERMS = new Set([
    "serious injury",
    "injury",
    "fatality",
    "death",
    "incident",
  ]);

  // Keywords that indicate a chemical/atmospheric hazard
  private readonly CHEMICAL_KEYWORDS = [
    "gas", "vapor", "vapour", "chemical", "h2s", "co", "oxygen",
    "toxic", "flammable", "explosive", "lel", "fume", "asphyxia",
    "asphyxiation", "atmosphere", "atmospheric",
  ];

  private inferCategory(hazardName: string): Hazard["category"] {
    const lower = hazardName.toLowerCase();
    if (this.CHEMICAL_KEYWORDS.some((kw) => lower.includes(kw))) {
      return "chemical";
    }
    return "physical";
  }

  /**
   * Returns true if the candidate hazard is semantically covered by an
   * existing hazard name, using significant-word overlap.
   */
  private isDuplicate(candidate: string, existingNames: Set<string>): boolean {
    const lower = candidate.toLowerCase();
    if (existingNames.has(lower)) return true;

    const STOP_WORDS = new Set(["from", "with", "that", "this", "into", "over", "under", "and", "the"]);
    const candidateWords = lower
      .split(/[\s/(),]+/)
      .filter((w) => w.length > 3 && !STOP_WORDS.has(w));

    for (const existing of existingNames) {
      if (existing.includes(lower) || lower.includes(existing)) return true;

      const existingWords = existing
        .split(/[\s/(),]+/)
        .filter((w) => w.length > 3 && !STOP_WORDS.has(w));

      if (candidateWords.length === 0) continue;
      const overlap = candidateWords.filter((w) => existingWords.includes(w)).length;
      // If more than half the candidate's key words appear in an existing hazard, treat as duplicate
      if (overlap / candidateWords.length > 0.5) return true;
    }

    return false;
  }

  private isOutcomeTerm(hazardName: string): boolean {
    return this.OUTCOME_TERMS.has(hazardName.toLowerCase());
  }

  private mergeIncidentHazards(
    aiHazards: Hazard[],
    incidents: VectorSearchResult[]
  ): Hazard[] {
    const existingNames = new Set(aiHazards.map((h) => h.name.toLowerCase()));
    let mergedCount = 0;

    for (const incident of incidents) {
      if (incident.score < this.INCIDENT_SIMILARITY_THRESHOLD) continue;

      const incidentHazards = incident.payload["hazard_names"] as string[] | undefined;
      if (!incidentHazards) continue;

      for (const hazardName of incidentHazards) {
        if (mergedCount >= this.MAX_MERGED_FROM_INCIDENTS) break;
        if (this.isOutcomeTerm(hazardName)) continue;
        if (this.isDuplicate(hazardName, existingNames)) continue;

        existingNames.add(hazardName.toLowerCase());
        mergedCount++;

        aiHazards.push({
          name: hazardName,
          category: this.inferCategory(hazardName),
          likelihood: 2,
          severity: 3,
          recommendedControls: ["Review historical incident data for specific controls"],
          explanation: `Identified from similar historical incident (similarity: ${incident.score.toFixed(2)}). Requires manual review.`,
        });
      }

      if (mergedCount >= this.MAX_MERGED_FROM_INCIDENTS) break;
    }

    return aiHazards;
  }
}
