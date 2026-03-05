import type { Hazard, RiskScore } from "../schemas/index.js";

/**
 * Rule-based minimum severity constraints for critical hazards.
 * AI predictions are bounded by these rules — AI assists, rules constrain.
 */
const CRITICAL_HAZARD_RULES: Record<string, { minSeverity: number }> = {
  h2s: { minSeverity: 4 },
  "h₂s": { minSeverity: 4 },
  "hydrogen sulfide": { minSeverity: 4 },
  "confined space": { minSeverity: 4 },
  "fall from height": { minSeverity: 4 },
  "work at height": { minSeverity: 3 },
  "hot work": { minSeverity: 3 },
  "dropped object": { minSeverity: 3 },
  explosion: { minSeverity: 5 },
  "hydrocarbon release": { minSeverity: 4 },
  fire: { minSeverity: 4 },
  radiation: { minSeverity: 4 },
  electrocution: { minSeverity: 4 },
  asphyxiation: { minSeverity: 5 },
};

/**
 * Risk level classification based on risk score (likelihood × severity).
 */
export type RiskLevel = "low" | "medium" | "high" | "critical";

export function classifyRisk(riskScore: number): RiskLevel {
  if (riskScore >= 15) return "critical";
  if (riskScore >= 10) return "high";
  if (riskScore >= 5) return "medium";
  return "low";
}

export interface ScoredHazard {
  hazard: Hazard;
  riskScore: RiskScore;
  riskLevel: RiskLevel;
  ruleApplied: boolean;
}

export class RiskScoringService {
  /**
   * Score a list of hazards, applying rule-based severity constraints.
   */
  scoreHazards(hazards: Hazard[]): ScoredHazard[] {
    return hazards.map((hazard) => this.scoreHazard(hazard));
  }

  private scoreHazard(hazard: Hazard): ScoredHazard {
    let severity = hazard.severity;
    let ruleApplied = false;

    // Apply critical hazard severity floor rules
    const hazardNameLower = hazard.name.toLowerCase();
    for (const [keyword, rule] of Object.entries(CRITICAL_HAZARD_RULES)) {
      if (hazardNameLower.includes(keyword)) {
        if (severity < rule.minSeverity) {
          severity = rule.minSeverity;
          ruleApplied = true;
        }
        break;
      }
    }

    const risk = hazard.likelihood * severity;
    const riskLevel = classifyRisk(risk);

    const rationale = this.buildRationale(hazard, severity, ruleApplied);

    return {
      hazard: { ...hazard, severity },
      riskScore: {
        likelihood: hazard.likelihood as 1 | 2 | 3 | 4 | 5,
        severity: severity as 1 | 2 | 3 | 4 | 5,
        risk,
        rationale,
        historicalEvidence: hazard.dprReference
          ? [hazard.dprReference]
          : undefined,
      },
      riskLevel,
      ruleApplied,
    };
  }

  private buildRationale(
    hazard: Hazard,
    adjustedSeverity: number,
    ruleApplied: boolean
  ): string {
    const parts: string[] = [];

    parts.push(hazard.explanation);

    if (ruleApplied) {
      parts.push(
        `Severity adjusted from ${hazard.severity} to ${adjustedSeverity} by safety rule constraint.`
      );
    }

    if (hazard.dprReference) {
      parts.push(`Reference: ${hazard.dprReference}.`);
    }

    return parts.join(" ");
  }
}
