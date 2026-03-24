#!/usr/bin/env tsx
/**
 * Test script for PermitoAI MCP tools.
 * Run: npx tsx src/run_tool.ts
 *
 * Offline tests: RISK_ASSESS, ANOMALY_DETECT, PERMIT_VALIDATE Layer 1
 * AI tests (Gemini): HAZARD_SUGGEST, COMPLIANCE_CHECK
 */
import 'dotenv/config';
import { RiskScoringService } from "./services/riskScoringService.js";
import { ValidationService } from "./services/validationService.js";
import { HazardService } from "./services/hazardService.js";
import { chatCompletion } from "./services/embeddingService.js";
import type { Hazard, JobContext } from "./schemas/index.js";

// ─── Sample Data ───

const sampleContext: JobContext = {
  jobType: "Hot Work",
  location: "Platform B - Deck 3",
  environment: "Offshore platform, sour gas field",
  equipment: ["Welding machine", "Grinder", "Fire extinguisher", "Gas detector"],
  contractor: { name: "SafeWeld Ltd", tier: 2 },
  description: "Welding repair on a 10-meter elevated pipe section near hydrocarbon processing unit",
};

const sampleHazards: Hazard[] = [
  {
    name: "H₂S gas exposure",
    category: "chemical",
    likelihood: 4,
    severity: 3, // intentionally low — rule should bump to 4
    recommendedControls: [
      "Continuous gas monitoring",
      "Escape breathing apparatus",
      "Wind direction monitoring",
    ],
    regulatoryRefs: ["DPR EGASPIN Section 5.2.3", "ISO 45001:2018 Clause 8.1.3"],
    explanation: "Sour gas field environment presents high H₂S risk requiring constant monitoring",
  },
  {
    name: "Fall from height",
    category: "physical",
    likelihood: 3,
    severity: 2, // intentionally low — rule should bump to 4
    recommendedControls: [
      "Full body harness with double lanyard",
      "Scaffolding with guardrails",
      "Rescue plan in place",
    ],
    regulatoryRefs: ["DPR EGASPIN Section 4.1.7", "IOGP Report 459 Section 3.2"],
    explanation: "10-meter elevated work area requires fall protection measures",
  },
  {
    name: "Fire/explosion from hot work near hydrocarbons",
    category: "physical",
    likelihood: 3,
    severity: 4,
    recommendedControls: [
      "Hot work permit with gas-free certificate",
      "Fire watch during and 30 min after work",
      "Fire blankets and extinguishers on site",
    ],
    regulatoryRefs: ["DPR EGASPIN Section 3.4.2", "ISO 45001:2018 Clause 8.1.4"],
    explanation: "Welding near hydrocarbon processing unit creates fire/explosion risk",
  },
  {
    name: "Dropped objects",
    category: "physical",
    likelihood: 3,
    severity: 2, // rule should bump to 3
    recommendedControls: [
      "Tool tethering",
      "Barricade below work area",
      "Hard hats for all personnel below",
    ],
    explanation: "Working at height with tools creates dropped object hazard for personnel below",
  },
  {
    name: "Heat stress",
    category: "physical",
    likelihood: 3,
    severity: 2,
    recommendedControls: [
      "Regular hydration breaks",
      "Shade structures",
      "Monitor workers for heat exhaustion signs",
    ],
    explanation: "Hot work in tropical offshore environment increases heat stress risk",
  },
];

// ─── Test: Risk Scoring ───

function testRiskScoring() {
  console.log("\n" + "=".repeat(60));
  console.log("TEST: RISK_ASSESS — Risk Scoring with Rule Constraints");
  console.log("=".repeat(60));

  const riskService = new RiskScoringService();
  const scored = riskService.scoreHazards(sampleHazards);

  for (const s of scored) {
    const ruleTag = s.ruleApplied ? " [RULE APPLIED]" : "";
    console.log(
      `\n  ${s.hazard.name}${ruleTag}` +
      `\n    L:${s.riskScore.likelihood} × S:${s.riskScore.severity} = ${s.riskScore.risk} (${s.riskLevel.toUpperCase()})` +
      `\n    Rationale: ${s.riskScore.rationale}`
    );
  }

  // Verify rules were applied
  const h2s = scored.find((s) => s.hazard.name.includes("H₂S"));
  const fall = scored.find((s) => s.hazard.name.includes("Fall"));
  const dropped = scored.find((s) => s.hazard.name.includes("Dropped"));

  console.log("\n  --- Rule Verification ---");
  console.log(`  H₂S severity: ${h2s?.riskScore.severity} (expected ≥4) ${h2s?.ruleApplied ? "✓" : "✗"}`);
  console.log(`  Fall severity: ${fall?.riskScore.severity} (expected ≥4) ${fall?.ruleApplied ? "✓" : "✗"}`);
  console.log(`  Dropped obj severity: ${dropped?.riskScore.severity} (expected ≥3) ${dropped?.ruleApplied ? "✓" : "✗"}`);
}

// ─── Test: Anomaly Detection ───

function testAnomalyDetection() {
  console.log("\n" + "=".repeat(60));
  console.log("TEST: ANOMALY_DETECT — Normal Assessment");
  console.log("=".repeat(60));

  const validationService = new ValidationService();

  // Normal assessment — should pass
  const normalResult = validationService.anomalyDetection(sampleHazards);
  console.log(`  Passed: ${normalResult.passed}`);
  console.log(`  Issues: ${normalResult.issues.length === 0 ? "None" : normalResult.issues.join("; ")}`);

  // Suspicious assessment — all same ratings
  console.log("\n" + "-".repeat(40));
  console.log("TEST: ANOMALY_DETECT — Suspicious Copy-Paste");
  console.log("-".repeat(40));

  const suspiciousHazards: Hazard[] = [
    { name: "Hazard A", category: "physical", likelihood: 3, severity: 3, recommendedControls: ["Control X"], explanation: "Reason A" },
    { name: "Hazard B", category: "chemical", likelihood: 3, severity: 3, recommendedControls: ["Control X"], explanation: "Reason B" },
    { name: "Hazard C", category: "physical", likelihood: 3, severity: 3, recommendedControls: ["Control X"], explanation: "Reason C" },
  ];

  const suspiciousResult = validationService.anomalyDetection(suspiciousHazards);
  console.log(`  Passed: ${suspiciousResult.passed}`);
  for (const issue of suspiciousResult.issues) {
    console.log(`  ⚠ ${issue}`);
  }
}

// ─── Test: Rule-Based Validation (Layer 1) ───

function testRuleBasedValidation() {
  console.log("\n" + "=".repeat(60));
  console.log("TEST: PERMIT_VALIDATE Layer 1 — Rule-Based Checks");
  console.log("=".repeat(60));

  const validationService = new ValidationService();

  // Valid permit
  const validResult = validationService.ruleBasedChecks(sampleContext, sampleHazards);
  console.log(`\n  Valid permit:`);
  console.log(`    Passed: ${validResult.passed}`);
  console.log(`    Issues: ${validResult.issues.length === 0 ? "None" : ""}`);
  for (const issue of validResult.issues) {
    console.log(`      - ${issue}`);
  }

  // Invalid permit — no hazards
  const emptyResult = validationService.ruleBasedChecks(sampleContext, []);
  console.log(`\n  Empty hazards:`);
  console.log(`    Passed: ${emptyResult.passed}`);
  for (const issue of emptyResult.issues) {
    console.log(`      - ${issue}`);
  }

  // Invalid — missing controls and no equipment
  const badContext: JobContext = {
    jobType: "Hot Work",
    location: "Site X",
    environment: "Onshore",
    equipment: [],
  };
  const badHazard: Hazard[] = [
    { name: "Fire", category: "physical", likelihood: 4, severity: 5, recommendedControls: [], explanation: "Fire risk" },
  ];
  const badResult = validationService.ruleBasedChecks(badContext, badHazard);
  console.log(`\n  Bad permit (missing controls, no equipment, too few hazards):`);
  console.log(`    Passed: ${badResult.passed}`);
  for (const issue of badResult.issues) {
    console.log(`      - ${issue}`);
  }
}

// ─── Test: HAZARD_SUGGEST (Gemini) ───

async function testHazardSuggest() {
  console.log("\n" + "=".repeat(60));
  console.log("TEST: HAZARD_SUGGEST — Gemini AI Hazard Identification");
  console.log("=".repeat(60));

  const hazardService = new HazardService();
  console.log("  Calling Gemini for hazard suggestions (no vector DB)...");

  const result = await hazardService.suggestHazards(sampleContext);

  console.log(`\n  Hazards returned: ${result.hazards.length}`);
  console.log(`  Tokens: ${result.promptTokens} prompt / ${result.completionTokens} completion`);
  for (const h of result.hazards) {
    console.log(
      `\n  • ${h.name} [${h.category}] L:${h.likelihood}/S:${h.severity}` +
      `\n    Controls: ${h.recommendedControls.join("; ")}` +
      (h.regulatoryRefs?.length ? `\n    Refs: ${h.regulatoryRefs.join("; ")}` : "")
    );
  }
}

// ─── Test: COMPLIANCE_CHECK (Gemini) ───

async function testComplianceCheck() {
  console.log("\n" + "=".repeat(60));
  console.log("TEST: COMPLIANCE_CHECK — Gemini Regulatory Compliance");
  console.log("=".repeat(60));

  const hazardSummary = sampleHazards
    .map(
      (h) =>
        `${h.name} (${h.category}, L:${h.likelihood}/S:${h.severity}) — Controls: ${h.recommendedControls.join("; ")}${h.regulatoryRefs?.length ? ` — Refs: ${h.regulatoryRefs.join("; ")}` : ""}`
    )
    .join("\n");

  console.log("  Calling Gemini for compliance check...");

  const result = await chatCompletion([
    {
      role: "system",
      content: `You are a regulatory compliance expert for Nigerian oil & gas operations. Evaluate permits against DPR EGASPIN, ISO 45001, and IOGP standards. Return JSON with key "standards" containing an array of objects, each with: "standard" (string), "compliant" (boolean), "findings" (string array), "recommendations" (string array).`,
    },
    {
      role: "user",
      content: `Evaluate this permit for regulatory compliance:\n\nJOB: ${sampleContext.jobType}\nLOCATION: ${sampleContext.location}\nENVIRONMENT: ${sampleContext.environment}\nEQUIPMENT: ${sampleContext.equipment.join(", ")}\nCONTRACTOR: ${sampleContext.contractor?.name} (Tier ${sampleContext.contractor?.tier})\n\nHAZARD ASSESSMENT:\n${hazardSummary}`,
    },
  ]);

  const parsed = JSON.parse(result.content);
  const overallCompliant = (parsed.standards as Array<{ compliant: boolean }>).every((s) => s.compliant);

  console.log(`\n  Overall Compliant: ${overallCompliant}`);
  console.log(`  Tokens: ${result.promptTokens} prompt / ${result.completionTokens} completion`);

  for (const s of parsed.standards as Array<{ standard: string; compliant: boolean; findings: string[]; recommendations: string[] }>) {
    console.log(`\n  [${s.compliant ? "PASS" : "FAIL"}] ${s.standard}`);
    for (const f of s.findings) console.log(`    Finding: ${f}`);
    for (const r of s.recommendations) console.log(`    Rec: ${r}`);
  }
}

// ─── Run All Tests ───

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║      PermitoAI — Full Test Suite (Offline + Gemini)     ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  // Offline (rule-based) tests
  testRiskScoring();
  testAnomalyDetection();
  testRuleBasedValidation();

  console.log("\n" + "=".repeat(60));
  console.log("Offline tests complete. Starting Gemini AI tests...");
  console.log("=".repeat(60));

  // AI-powered tests
  await testHazardSuggest();
  await testComplianceCheck();

  console.log("\n" + "=".repeat(60));
  console.log("All tests complete.");
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
