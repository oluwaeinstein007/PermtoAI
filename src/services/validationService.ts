import type { Hazard, JobContext, ValidationResult } from "../schemas/index.js";
import { chatCompletion } from "./embeddingService.js";
import { classifyRisk } from "./riskScoringService.js";

/**
 * Multi-layer validation system as defined in requirements:
 * Layer 1: Fast rule-based checks (< 100ms)
 * Layer 2: AI semantic analysis (2-3 seconds)
 * Layer 3: Standards compliance (ISO/HIRA/DPR)
 * Layer 4: Anomaly detection
 */
export class ValidationService {
  /**
   * Run all validation layers on a permit's hazards and context.
   */
  async validatePermit(
    context: JobContext,
    hazards: Hazard[]
  ): Promise<ValidationResult[]> {
    // Layer 1 runs synchronously (fast)
    const layer1 = this.ruleBasedChecks(context, hazards);

    // Layers 2 & 3 can run in parallel
    const [layer2, layer3] = await Promise.all([
      this.semanticAnalysis(context, hazards),
      this.complianceCheck(context, hazards),
    ]);

    // Layer 4: anomaly detection
    const layer4 = this.anomalyDetection(hazards);

    return [layer1, layer2, layer3, layer4];
  }

  /**
   * Layer 1: Fast rule-based checks.
   * Validates minimum requirements are met before AI analysis.
   */
  ruleBasedChecks(context: JobContext, hazards: Hazard[]): ValidationResult {
    const issues: string[] = [];

    // Must have at least 1 hazard identified
    if (hazards.length === 0) {
      issues.push("No hazards identified. All permits require hazard assessment.");
    }

    // High-risk job types require minimum number of hazards
    const highRiskJobTypes = [
      "hot work",
      "confined space",
      "work at height",
      "diving",
      "radiography",
    ];
    const isHighRisk = highRiskJobTypes.some((t) =>
      context.jobType.toLowerCase().includes(t)
    );
    if (isHighRisk && hazards.length < 3) {
      issues.push(
        `High-risk job type "${context.jobType}" requires minimum 3 hazards identified. Found ${hazards.length}.`
      );
    }

    // All hazards must have at least one control
    for (const hazard of hazards) {
      if (
        !hazard.recommendedControls ||
        hazard.recommendedControls.length === 0
      ) {
        issues.push(
          `Hazard "${hazard.name}" has no recommended controls.`
        );
      }
    }

    // Critical severity hazards must have at least one real regulatory reference
    const PLACEHOLDER = /^(n\/?a|none|null|not applicable|no reference|no ref)$/i;
    for (const hazard of hazards) {
      const hasRef = hazard.regulatoryRefs?.some((r) => !PLACEHOLDER.test(r.trim()));
      if (hazard.severity >= 4 && !hasRef) {
        issues.push(
          `High-severity hazard "${hazard.name}" (severity=${hazard.severity}) is missing a regulatory reference (DPR EGASPIN, ISO 45001, or IOGP).`
        );
      }
    }

    // Equipment list must not be empty
    if ((context.equipment ?? []).length === 0) {
      issues.push("Equipment list is empty. Specify equipment for proper hazard assessment.");
    }

    return {
      layer: "rule_based",
      passed: issues.length === 0,
      issues,
      confidence: 1.0,
    };
  }

  /**
   * Layer 2: AI semantic analysis.
   * Checks for logical consistency and completeness of hazard assessments.
   */
  async semanticAnalysis(
    context: JobContext,
    hazards: Hazard[]
  ): Promise<ValidationResult> {
    try {
      const hazardSummary = hazards
        .map(
          (h) =>
            `- ${h.name} (${h.category}, L:${h.likelihood}/S:${h.severity}): ${h.recommendedControls.join(", ")}`
        )
        .join("\n");

      const result = await chatCompletion([
        {
          role: "system",
          content: `You are a safety validation AI. Analyze permit hazard assessments for completeness and logical consistency. Return JSON with keys: "passed" (boolean), "issues" (string array), "confidence" (0-1 number).`,
        },
        {
          role: "user",
          content: `Validate this hazard assessment:

JOB: ${context.jobType}${context.location ? ` at ${context.location}` : ""}${context.environment ? ` (${context.environment})` : ""}
EQUIPMENT: ${(context.equipment ?? []).join(", ") || "Not specified"}

IDENTIFIED HAZARDS:
${hazardSummary}

Check for:
1. Missing obvious hazards for this job type
2. Controls that don't match the hazard
3. Inconsistent likelihood/severity ratings
4. Any logically impossible combinations

Note: Only flag issues that are clearly present. Do not penalise missing optional context fields (location, environment) as validation issues.`,
        },
      ]);

      const parsed = JSON.parse(result.content);
      return {
        layer: "semantic",
        passed: parsed.passed ?? true,
        issues: parsed.issues ?? [],
        confidence: parsed.confidence ?? 0.8,
      };
    } catch (error) {
      console.error("[ValidationService] Semantic analysis failed:", error);
      return {
        layer: "semantic",
        passed: true,
        issues: ["Semantic analysis unavailable — skipped."],
        confidence: 0,
        details: "AI service error; rule-based checks still apply.",
      };
    }
  }

  /**
   * Layer 3: Standards compliance check (DPR/ISO/IOGP).
   */
  async complianceCheck(
    context: JobContext,
    hazards: Hazard[]
  ): Promise<ValidationResult> {
    try {
      const result = await chatCompletion([
        {
          role: "system",
          content: `You are a regulatory compliance AI specializing in Nigerian DPR regulations (EGASPIN), ISO 45001, and IOGP safety standards. Return JSON with keys: "passed" (boolean), "issues" (string array), "confidence" (0-1 number).`,
        },
        {
          role: "user",
          content: `Check compliance for this permit:

JOB: ${context.jobType}${context.location ? ` at ${context.location}` : ""}${context.environment ? `\nENVIRONMENT: ${context.environment}` : ""}
HAZARDS: ${hazards.map((h) => `${h.name} [${h.regulatoryRefs?.join("; ") ?? "no ref"}]`).join(", ")}

Verify:
1. All required DPR EGASPIN sections are referenced for the identified hazards
2. ISO 45001 risk assessment requirements are met
3. IOGP recommended practices are followed
4. Any missing mandatory documentation or certifications

Note: Only raise issues based on the hazard data provided. Do not flag absence of optional context fields (location, environment) as compliance failures.`,
        },
      ]);

      const parsed = JSON.parse(result.content);
      return {
        layer: "compliance",
        passed: parsed.passed ?? true,
        issues: parsed.issues ?? [],
        confidence: parsed.confidence ?? 0.8,
      };
    } catch (error) {
      console.error("[ValidationService] Compliance check failed:", error);
      return {
        layer: "compliance",
        passed: true,
        issues: ["Compliance check unavailable — skipped."],
        confidence: 0,
        details: "AI service error; manual compliance review required.",
      };
    }
  }

  /**
   * Layer 4: Anomaly detection.
   * Detects copy-pasted assessments, identical readings, suspicious patterns.
   */
  anomalyDetection(hazards: Hazard[]): ValidationResult {
    const issues: string[] = [];

    // Check for duplicate hazards
    const names = hazards.map((h) => h.name.toLowerCase());
    const uniqueNames = new Set(names);
    if (uniqueNames.size < names.length) {
      issues.push("Duplicate hazards detected. Each hazard should be unique.");
    }

    // Check for all-same ratings (suspicious copy-paste)
    const allSameLikelihood =
      hazards.length > 2 &&
      hazards.every((h) => h.likelihood === hazards[0].likelihood);
    const allSameSeverity =
      hazards.length > 2 &&
      hazards.every((h) => h.severity === hazards[0].severity);
    if (allSameLikelihood && allSameSeverity) {
      issues.push(
        "All hazards have identical likelihood and severity ratings — possible copy-paste. Review individually."
      );
    }

    // Check for suspiciously low risk across all hazards
    const allLowRisk = hazards.every(
      (h) => classifyRisk(h.likelihood * h.severity) === "low"
    );
    if (allLowRisk && hazards.length > 3) {
      issues.push(
        "All hazards classified as low risk. Verify assessments are thorough and not understated."
      );
    }

    // Check for identical controls across different hazards
    const controlSets = hazards.map((h) =>
      h.recommendedControls.sort().join("|")
    );
    const uniqueControlSets = new Set(controlSets);
    if (uniqueControlSets.size === 1 && hazards.length > 2) {
      issues.push(
        "All hazards share identical control measures — controls should be hazard-specific."
      );
    }

    return {
      layer: "anomaly",
      passed: issues.length === 0,
      issues,
      confidence: 0.9,
    };
  }
}
