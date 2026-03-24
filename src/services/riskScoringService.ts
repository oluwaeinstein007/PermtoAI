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

export interface RiskMatrixSummary {
  /** Count per risk level */
  counts: { critical: number; high: number; medium: number; low: number };
  /** Sum of all likelihood × severity scores */
  totalMatrixSum: number;
  /** Mean risk score across all hazards */
  averageRiskScore: number;
  /** Highest risk level present in the assessment */
  dominantRiskLevel: RiskLevel;
  /** How many hazards had their severity raised by a safety rule */
  rulesApplied: number;
  /** Actionable overall advice based on risk distribution */
  overallAdvice: string;
  /**
   * Confidence that the risk scores are accurate (0.0–1.0).
   * Boosted by rule coverage, DPR references, and hazard count.
   * Reduced when too few hazards are assessed.
   */
  confidenceScore: number;
  /**
   * 95 % confidence interval around the average risk score.
   * Wider when scores vary a lot or hazard count is low.
   */
  confidenceInterval: { lower: number; upper: number; level: "95%" };
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

  /**
   * Compute aggregate risk matrix summary with confidence scoring.
   * Call this after scoreHazards().
   */
  computeSummary(scored: ScoredHazard[]): RiskMatrixSummary {
    if (scored.length === 0) {
      return {
        counts: { critical: 0, high: 0, medium: 0, low: 0 },
        totalMatrixSum: 0,
        averageRiskScore: 0,
        dominantRiskLevel: "low",
        rulesApplied: 0,
        overallAdvice: "No hazards assessed.",
        confidenceScore: 0,
        confidenceInterval: { lower: 0, upper: 0, level: "95%" },
      };
    }

    const scores = scored.map((s) => s.riskScore.risk);
    const n = scores.length;
    const totalMatrixSum = scores.reduce((a, b) => a + b, 0);
    const averageRiskScore = parseFloat((totalMatrixSum / n).toFixed(2));

    const counts = {
      critical: scored.filter((s) => s.riskLevel === "critical").length,
      high: scored.filter((s) => s.riskLevel === "high").length,
      medium: scored.filter((s) => s.riskLevel === "medium").length,
      low: scored.filter((s) => s.riskLevel === "low").length,
    };

    const dominantRiskLevel: RiskLevel =
      counts.critical > 0
        ? "critical"
        : counts.high > 0
          ? "high"
          : counts.medium > 0
            ? "medium"
            : "low";

    const rulesApplied = scored.filter((s) => s.ruleApplied).length;

    // ── Confidence score ────────────────────────────────────────────────────
    // Base: AI hazard suggestions have inherent uncertainty
    let confidence = 0.55;

    // +0.10 if ≥30 % of hazards were constrained by a safety rule
    if (rulesApplied / n >= 0.3) confidence += 0.10;

    // +0.10 if all hazards have a DPR reference
    const withRef = scored.filter((s) => !!s.hazard.dprReference).length;
    if (withRef === n) confidence += 0.10;
    else if (withRef / n >= 0.5) confidence += 0.05;

    // +0.10 if assessment covers ≥5 distinct hazards (breadth check)
    if (n >= 5) confidence += 0.10;
    if (n >= 8) confidence += 0.05;

    // -0.15 if only 1-2 hazards (too sparse to trust)
    if (n < 3) confidence -= 0.15;

    // -0.05 if coefficient of variation is very high (wildly inconsistent scores)
    const mean = averageRiskScore;
    const variance = scores.reduce((acc, s) => acc + (s - mean) ** 2, 0) / n;
    const stdDev = Math.sqrt(variance);
    const cv = mean > 0 ? stdDev / mean : 0;
    if (cv > 0.6) confidence -= 0.05;

    const confidenceScore = parseFloat(Math.min(0.95, Math.max(0.10, confidence)).toFixed(2));

    // ── 95 % confidence interval around average risk score ──────────────────
    const se = n > 1 ? stdDev / Math.sqrt(n) : stdDev;
    const margin = 1.96 * se;
    const confidenceInterval = {
      lower: parseFloat(Math.max(1, averageRiskScore - margin).toFixed(2)),
      upper: parseFloat(Math.min(25, averageRiskScore + margin).toFixed(2)),
      level: "95%" as const,
    };

    // ── Overall advice ──────────────────────────────────────────────────────
    let overallAdvice: string;
    if (counts.critical > 0) {
      overallAdvice =
        `STOP WORK — ${counts.critical} critical risk(s) identified. Immediate escalation required. ` +
        `Do not proceed until critical hazards are eliminated or risk reduced below critical threshold.`;
    } else if (counts.high > 0) {
      overallAdvice =
        `HOLD — ${counts.high} high-severity risk(s) require senior HSE approval and verified additional ` +
        `controls before work can proceed. Review all high-risk hazard controls.`;
    } else if (counts.medium > 0) {
      overallAdvice =
        `CAUTION — ${counts.medium} medium-risk hazard(s) present. Verify all stated controls are ` +
        `implemented and signed off before starting work. Continue monitoring during execution.`;
    } else {
      overallAdvice =
        `PROCEED — Low overall risk profile (avg score ${averageRiskScore.toFixed(1)}/25). ` +
        `Standard permit-to-work controls are sufficient. Maintain routine monitoring.`;
    }

    return {
      counts,
      totalMatrixSum,
      averageRiskScore,
      dominantRiskLevel,
      rulesApplied,
      overallAdvice,
      confidenceScore,
      confidenceInterval,
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
