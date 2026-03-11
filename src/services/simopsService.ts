/**
 * SIMOPS (Simultaneous Operations) Service
 * Detects schedule conflicts and incompatible work type combinations.
 */

// ─── SIMOPS Incompatibility Matrix ───────────────────────────────────────────
// Pairs of work types that must NOT run simultaneously in the same area.
// Matching is case-insensitive and uses substring matching for flexibility.

export interface SimopsRule {
  pair: [string, string];
  severity: "critical" | "high" | "medium";
  reason: string;
}

export const SIMOPS_MATRIX: SimopsRule[] = [
  {
    pair: ["hot work", "confined space entry"],
    severity: "critical",
    reason:
      "Hot work introduces ignition sources that can ignite flammable atmospheres inside confined spaces, creating fire/explosion risk.",
  },
  {
    pair: ["hot work", "gas testing"],
    severity: "critical",
    reason:
      "Ignition sources from hot work can cause explosion during gas venting or atmosphere testing operations.",
  },
  {
    pair: ["hot work", "hydrocarbon draining"],
    severity: "critical",
    reason:
      "Flammable hydrocarbon vapours from draining/venting operations present an explosion risk near hot work.",
  },
  {
    pair: ["hot work", "chemical injection"],
    severity: "critical",
    reason:
      "Chemical injection may release flammable or toxic vapours incompatible with ignition sources from hot work.",
  },
  {
    pair: ["hot work", "tank cleaning"],
    severity: "critical",
    reason:
      "Tank cleaning releases residual hydrocarbon vapours that can be ignited by hot work, causing explosion.",
  },
  {
    pair: ["hot work", "h2s"],
    severity: "critical",
    reason:
      "H₂S is highly flammable; hot work in the presence of H₂S creates an immediate fire/explosion and toxic exposure risk.",
  },
  {
    pair: ["hot work", "sour service"],
    severity: "critical",
    reason:
      "Sour service work involves H₂S-bearing streams that present explosion and toxic exposure risks near ignition sources.",
  },
  {
    pair: ["radiography", ""],
    severity: "high",
    reason:
      "Industrial radiography emits ionising radiation requiring exclusion zones; all non-essential personnel must clear the area.",
  },
  {
    pair: ["pressure testing", "hot work"],
    severity: "critical",
    reason:
      "Pressure testing involves high-energy stored energy; hot work nearby can cause catastrophic failure if a line ruptures.",
  },
  {
    pair: ["pressure testing", "confined space entry"],
    severity: "high",
    reason:
      "A pressure test failure adjacent to a confined space entry can cause sudden gas/liquid release, trapping workers.",
  },
  {
    pair: ["electrical testing", "confined space entry"],
    severity: "high",
    reason:
      "Live electrical testing in proximity to confined space entry creates electrocution risk in an escape-restricted environment.",
  },
  {
    pair: ["scaffolding erection", "work below"],
    severity: "high",
    reason:
      "Dropped objects from scaffolding erection create struck-by hazards for workers directly below.",
  },
  {
    pair: ["chemical cleaning", "hot work"],
    severity: "critical",
    reason:
      "Chemical cleaning solvents release flammable vapours incompatible with hot work ignition sources.",
  },
  {
    pair: ["nitrogen purging", "confined space entry"],
    severity: "critical",
    reason:
      "Nitrogen is an asphyxiant; purging operations adjacent to confined space entry can cause rapid oxygen depletion and fatality.",
  },
  {
    pair: ["blasting", "hot work"],
    severity: "high",
    reason:
      "Abrasive blasting generates dust and sparks; proximity to hot work can cause ignition in dusty/hydrocarbon environments.",
  },
  {
    pair: ["blasting", "confined space entry"],
    severity: "high",
    reason:
      "Blasting creates airborne particulates and pressure waves that can penetrate and endanger confined space workers.",
  },
  {
    pair: ["crane lift", "work below"],
    severity: "high",
    reason:
      "Crane lifts mandate exclusion zones below the lift path; simultaneous ground-level work violates dropped-object safety.",
  },
  {
    pair: ["acid injection", "hot work"],
    severity: "critical",
    reason:
      "Acid injection can release hydrogen gas, which is highly flammable and explosive near hot work ignition sources.",
  },
  {
    pair: ["welding", "painting"],
    severity: "high",
    reason:
      "Paint and coating solvents are flammable; simultaneous welding can ignite solvent vapours.",
  },
  {
    pair: ["electrical isolation", "hot work"],
    severity: "medium",
    reason:
      "Electrical isolation work may expose live conductors; hot work nearby risks arc flash or igniting insulation.",
  },
];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PermitRequest {
  startDate: string;
  endDate: string;
  workType: string;
  workArea?: string | null;
}

export interface ExistingPermit {
  id: number | string;
  type?: string;
  status: string;
  workType: string;
  workArea?: string | null;
  startDate: string;
  endDate: string;
  jobType?: string;
  [key: string]: unknown;
}

export interface ScheduleConflict {
  permitId: number | string;
  status: string;
  workType: string;
  workArea?: string | null;
  startDate: string;
  endDate: string;
  overlapStart: string;
  overlapEnd: string;
}

export interface SimopsFlag {
  permitId: number | string;
  requestWorkType: string;
  conflictingWorkType: string;
  severity: "critical" | "high" | "medium";
  reason: string;
}

export interface SimopsCheckResult {
  scheduleConflicts: {
    count: number;
    permits: ScheduleConflict[];
  };
  simopsFlags: {
    count: number;
    flags: SimopsFlag[];
  };
  overallRisk: "none" | "low" | "medium" | "high" | "critical";
  summary: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toDate(dateStr: string): Date {
  // Handles both "2024-06-01" and "2026-03-18T07:00:00.000Z"
  return new Date(dateStr);
}

function datesOverlap(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date
): { overlaps: boolean; start: Date; end: Date } {
  const overlapStart = aStart > bStart ? aStart : bStart;
  const overlapEnd = aEnd < bEnd ? aEnd : bEnd;
  return {
    overlaps: overlapStart < overlapEnd,
    start: overlapStart,
    end: overlapEnd,
  };
}

function workAreasMatch(
  requestArea: string | null | undefined,
  permitArea: string | null | undefined
): boolean {
  // If request has no workArea, any permit in any area is a potential conflict
  if (!requestArea) return true;
  if (!permitArea) return false;
  return requestArea.trim().toLowerCase() === permitArea.trim().toLowerCase();
}

function normalise(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Check if two work types are incompatible according to the SIMOPS matrix.
 * Returns matching rule or null.
 */
export function findSimopsConflict(
  workTypeA: string,
  workTypeB: string
): SimopsRule | null {
  const a = normalise(workTypeA);
  const b = normalise(workTypeB);

  for (const rule of SIMOPS_MATRIX) {
    const [p1, p2] = rule.pair.map(normalise);

    // Skip rules with empty second pair (radiography standalone handled below)
    if (p2 === "") {
      if (a.includes(p1) || b.includes(p1)) {
        // Radiography: any simultaneous work is a concern
        const other = a.includes(p1) ? b : a;
        if (other && other !== p1) {
          return rule;
        }
      }
      continue;
    }

    const aMatchesP1 = a.includes(p1);
    const bMatchesP2 = b.includes(p2);
    const aMatchesP2 = a.includes(p2);
    const bMatchesP1 = b.includes(p1);

    if ((aMatchesP1 && bMatchesP2) || (aMatchesP2 && bMatchesP1)) {
      return rule;
    }
  }

  return null;
}

// ─── Main Service Function ────────────────────────────────────────────────────

export function checkSimops(
  request: PermitRequest,
  existingPermits: ExistingPermit[]
): SimopsCheckResult {
  const reqStart = toDate(request.startDate);
  const reqEnd = toDate(request.endDate);

  const scheduleConflicts: ScheduleConflict[] = [];
  const simopsFlags: SimopsFlag[] = [];
  const seenSimopsIds = new Set<string>();

  for (const permit of existingPermits) {
    const permStart = toDate(permit.startDate);
    const permEnd = toDate(permit.endDate);

    // 1. Check date range overlap
    const { overlaps, start: overlapStart, end: overlapEnd } = datesOverlap(
      reqStart,
      reqEnd,
      permStart,
      permEnd
    );

    if (!overlaps) continue;

    // 2. Check work area match
    const areaMatches = workAreasMatch(request.workArea, permit.workArea);
    if (!areaMatches) continue;

    // 3. Schedule conflict — same type running simultaneously in same area
    if (normalise(request.workType) === normalise(permit.workType)) {
      scheduleConflicts.push({
        permitId: permit.id,
        status: permit.status,
        workType: permit.workType,
        workArea: permit.workArea,
        startDate: permit.startDate,
        endDate: permit.endDate,
        overlapStart: overlapStart.toISOString(),
        overlapEnd: overlapEnd.toISOString(),
      });
    }

    // 4. SIMOPS incompatibility — different types that shouldn't coexist
    const conflictingType = permit.workType;
    if (normalise(request.workType) !== normalise(conflictingType)) {
      const rule = findSimopsConflict(request.workType, conflictingType);
      if (rule) {
        const flagKey = `${permit.id}-${normalise(request.workType)}-${normalise(conflictingType)}`;
        if (!seenSimopsIds.has(flagKey)) {
          seenSimopsIds.add(flagKey);
          simopsFlags.push({
            permitId: permit.id,
            requestWorkType: request.workType,
            conflictingWorkType: conflictingType,
            severity: rule.severity,
            reason: rule.reason,
          });
        }
      }
    }
  }

  // 5. Compute overall risk
  const hasCritical = simopsFlags.some((f) => f.severity === "critical");
  const hasHigh =
    simopsFlags.some((f) => f.severity === "high") ||
    scheduleConflicts.length > 0;
  const hasMedium = simopsFlags.some((f) => f.severity === "medium");

  let overallRisk: SimopsCheckResult["overallRisk"] = "none";
  if (hasCritical) overallRisk = "critical";
  else if (hasHigh) overallRisk = "high";
  else if (hasMedium) overallRisk = "medium";
  else if (scheduleConflicts.length > 0) overallRisk = "high";

  // 6. Build summary
  const parts: string[] = [];
  if (scheduleConflicts.length > 0) {
    parts.push(
      `${scheduleConflicts.length} schedule conflict(s) — same work type running simultaneously in the same area`
    );
  }
  if (simopsFlags.length > 0) {
    const critCount = simopsFlags.filter((f) => f.severity === "critical").length;
    parts.push(
      `${simopsFlags.length} SIMOPS incompatibility flag(s)${critCount > 0 ? ` (${critCount} critical)` : ""}`
    );
  }
  const summary =
    parts.length > 0
      ? `SIMOPS review required: ${parts.join("; ")}.`
      : "No schedule conflicts or SIMOPS incompatibilities detected.";

  return {
    scheduleConflicts: {
      count: scheduleConflicts.length,
      permits: scheduleConflicts,
    },
    simopsFlags: {
      count: simopsFlags.length,
      flags: simopsFlags,
    },
    overallRisk,
    summary,
  };
}
