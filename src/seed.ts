#!/usr/bin/env tsx
/**
 * Seed script — creates and populates Qdrant collections for PermitoAI.
 * Run: npx tsx src/seed.ts
 *
 * Creates:
 *   - permitoai          : work type regulations & risk assessments
 *   - permito_incidents  : synthetic historical incidents
 */
import 'dotenv/config';
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { QdrantClient } from "@qdrant/js-client-rest";
import { embedText } from "./services/embeddingService.js";
import { env } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Work Type Data ───

interface WorkTypeEntry {
  workType: string;
  inherentLikelihood: number;
  likelihoodLabel: string;
  inherentImpact: number;
  impactLabel: string;
  riskCategory: string;
  recommendation: string;
  hazards: string[];
  controlMeasures: string[];
  permitType: string;
  typicalArea: string;
  energyLevel: string;
  residualRisk: string;
}

const { WorkTypeRiskAssessment }: { WorkTypeRiskAssessment: WorkTypeEntry[] } = JSON.parse(
  readFileSync(path.join(__dirname, "../workTypeRiskData.json"), "utf-8")
);

// ─── Synthetic Historical Incidents ───

const INCIDENTS = [
  {
    description: "H₂S leak during hot work near sour gas wellhead caused two workers to lose consciousness",
    workType: "Hot Work - Welding/Cutting",
    hazard_names: ["H₂S Exposure", "Fire Risk", "Chemical Exposure"],
    outcome: "critical",
    lessons_learned: "Mandatory H₂S monitoring and escape breathing apparatus required for all hot work in sour gas fields",
    location: "Onshore wellhead, Niger Delta",
  },
  {
    description: "Flash fire ignited during welding on production vessel without gas-free certificate",
    workType: "Hot Work - Welding/Cutting",
    hazard_names: ["Fire/Explosion", "Burns", "Flammable Atmosphere"],
    outcome: "high",
    lessons_learned: "Gas-free certificate mandatory before any hot work on process vessels",
    location: "Offshore platform, OML 40",
  },
  {
    description: "Worker asphyxiated inside crude oil storage tank during cleaning without atmospheric test",
    workType: "Tank Cleaning / Entry",
    hazard_names: ["Asphyxiation", "Toxic Vapor", "Oxygen Deficiency"],
    outcome: "critical",
    lessons_learned: "Confined space entry permit with atmospheric test mandatory before tank entry",
    location: "Flow station, Rivers State",
  },
  {
    description: "Confined space rescue failure — standby person entered without SCBA and also became incapacitated",
    workType: "Confined Space Entry",
    hazard_names: ["Oxygen Deficiency", "Toxic Gas", "Asphyxiation"],
    outcome: "critical",
    lessons_learned: "Standby person must be equipped with SCBA; rescue plan must be tested before entry",
    location: "Separator vessel, offshore platform",
  },
  {
    description: "Dropped wrench from scaffold struck worker below during pipe rack maintenance",
    workType: "Working at Height",
    hazard_names: ["Dropped Objects", "Head Injury", "Struck By"],
    outcome: "high",
    lessons_learned: "Tool tethering and exclusion zones below work areas mandatory for all elevated work",
    location: "Pipe rack, refinery, Warri",
  },
  {
    description: "Scaffold collapse during erection injured two workers — base plates not properly secured",
    workType: "Scaffolding Erection/Dismantling",
    hazard_names: ["Structural Collapse", "Fall from Height", "Dropped Objects"],
    outcome: "high",
    lessons_learned: "Scaffold base plates must be inspected by competent person before erection begins",
    location: "Offshore jacket platform",
  },
  {
    description: "Worker fell 6m through open floor grating while connecting scaffold planks",
    workType: "Working at Height",
    hazard_names: ["Fall from Height", "Unprotected Opening", "Serious Injury"],
    outcome: "critical",
    lessons_learned: "All floor openings must be covered or barricaded before work above them begins",
    location: "LNG plant, Bonny Island",
  },
  {
    description: "Electric shock during LV panel maintenance — worker did not isolate equipment before starting",
    workType: "Electrical Work - LV",
    hazard_names: ["Electric Shock", "Arc Flash", "Burns"],
    outcome: "high",
    lessons_learned: "LOTO procedure must be completed and verified before any electrical work",
    location: "Control room, onshore facility",
  },
  {
    description: "Crane load swing struck adjacent pipeline during offshore lifts in rough sea conditions",
    workType: "Lifting & Hoisting - Crane",
    hazard_names: ["Dropped Load", "Struck By", "Pipeline Damage"],
    outcome: "high",
    lessons_learned: "Marine lifting operations must be suspended when sea state exceeds lift plan limits",
    location: "Offshore supply vessel deck",
  },
  {
    description: "Well blowout during wireline operation — well control procedures not followed",
    workType: "Well Intervention / Wireline",
    hazard_names: ["Blowout", "H2S Release", "Fire/Explosion"],
    outcome: "critical",
    lessons_learned: "BOP must be tested and certified before wireline operations; kill fluid must be on standby",
    location: "Offshore well, OML 58",
  },
  {
    description: "Pressure test failure — pipe burst and struck two workers inside the exclusion zone",
    workType: "Pressure Testing",
    hazard_names: ["Rupture", "Flying Debris", "High Pressure Fluid Injection"],
    outcome: "high",
    lessons_learned: "Exclusion zone must be enforced during all pressure tests; workers must be clear of test area",
    location: "Pipeline test site, onshore",
  },
  {
    description: "SIMOPS conflict — drilling crew unaware of nearby hot work; gas from drill cuttings ignited welding sparks",
    workType: "SIMOPS",
    hazard_names: ["Conflict of Operations", "Fire/Explosion", "Communication Failure"],
    outcome: "high",
    lessons_learned: "SIMOPS matrix must be reviewed daily; all permit holders must be briefed on simultaneous operations",
    location: "Drilling platform, Niger Delta",
  },
  {
    description: "Chemical spill during tank drainage — worker exposed to benzene-containing crude without PPE",
    workType: "Environmental Spill Response",
    hazard_names: ["Chemical Exposure", "Inhalation", "Skin Contact"],
    outcome: "medium",
    lessons_learned: "Chemical PPE must be worn before any crude oil or chemical spill response",
    location: "Flow line manifold, onshore field",
  },
  {
    description: "Excavation collapse buried a worker during cable trench digging in waterlogged soil",
    workType: "Excavation / Trenching",
    hazard_names: ["Collapse", "Engulfment", "Water Ingress"],
    outcome: "critical",
    lessons_learned: "Soil assessment and shoring required for all trenches deeper than 1.2m; no work in waterlogged soils without geotechnical approval",
    location: "Onshore pipeline corridor, Imo State",
  },
  {
    description: "Radiation overexposure during radiography when exclusion zone was breached by an uninformed contractor",
    workType: "Radiography / NDT",
    hazard_names: ["Radiation Exposure", "Unauthorized Entry", "Exclusion Zone Breach"],
    outcome: "high",
    lessons_learned: "Physical barriers must prevent unauthorized access; radiography only proceeds after area is verified clear",
    location: "Pipeline weld inspection site",
  },
  {
    description: "Man overboard during vessel-to-platform transfer in low-visibility conditions at night",
    workType: "Marine Vessel Operations",
    hazard_names: ["Man Overboard", "Drowning", "Vessel Collision"],
    outcome: "critical",
    lessons_learned: "Nighttime vessel transfers require additional lighting, life rings deployed, and manned rescue boat on standby",
    location: "Offshore platform, OML 70",
  },
  {
    description: "Helicopter FOD ingestion caused engine surge during takeoff from offshore helideck",
    workType: "Helicopter Operations",
    hazard_names: ["FOD Ingestion", "Engine Failure", "Crash Risk"],
    outcome: "high",
    lessons_learned: "Full FOD sweep of helideck mandatory before every helicopter movement",
    location: "Helideck, offshore platform",
  },
  {
    description: "Pipeline pig trap cover blew off during pig retrieval — workers failed to fully bleed down pressure",
    workType: "Pipeline Pigging",
    hazard_names: ["Trapped Pressure", "Struck By", "Fluid Release"],
    outcome: "critical",
    lessons_learned: "Full pressure bleed-down and verification mandatory before opening any pig trap",
    location: "Pipeline receiving station, Delta State",
  },
];

// ─── Qdrant Client ───

const client = new QdrantClient({
  url: env.QDRANT_URL,
  apiKey: env.QDRANT_API_KEY,
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureCollection(name: string, vectorSize: number) {
  try {
    await client.getCollection(name);
    console.log(`  Collection "${name}" exists — deleting for fresh seed...`);
    await client.deleteCollection(name);
  } catch {
    // Collection doesn't exist yet — that's fine
  }
  await client.createCollection(name, {
    vectors: { size: vectorSize, distance: "Cosine" },
  });
  console.log(`  Created "${name}" (${vectorSize}d, Cosine)`);
}

// ─── Seed Regulations ───

function buildRegulationText(e: WorkTypeEntry): string {
  return [
    `Work Type: ${e.workType}`,
    `Permit Type: ${e.permitType}`,
    `Typical Area: ${e.typicalArea}`,
    `Risk Category: ${e.riskCategory} (Likelihood ${e.inherentLikelihood}/5, Impact ${e.inherentImpact}/5)`,
    `Hazards: ${e.hazards.join(", ")}`,
    `Control Measures: ${e.controlMeasures.join(", ")}`,
    `Energy Level: ${e.energyLevel}`,
    `Residual Risk: ${e.residualRisk}`,
    `Recommendation: ${e.recommendation}`,
  ].join(". ");
}

async function seedRegulations() {
  console.log("\n─── Seeding: Regulations ───");
  await ensureCollection(env.QDRANT_COLLECTION, env.EMBEDDING_DIMENSIONS);

  const points = [];
  for (let i = 0; i < WorkTypeRiskAssessment.length; i++) {
    const entry = WorkTypeRiskAssessment[i];
    process.stdout.write(`  [${i + 1}/${WorkTypeRiskAssessment.length}] "${entry.workType}"... `);

    const vector = await embedText(buildRegulationText(entry));
    points.push({
      id: i + 1,
      vector,
      payload: {
        title: entry.workType,
        content: buildRegulationText(entry),
        workType: entry.workType,
        permitType: entry.permitType,
        typicalArea: entry.typicalArea,
        riskCategory: entry.riskCategory,
        hazards: entry.hazards,
        controlMeasures: entry.controlMeasures,
        recommendation: entry.recommendation,
        inherentLikelihood: entry.inherentLikelihood,
        inherentImpact: entry.inherentImpact,
        energyLevel: entry.energyLevel,
        residualRisk: entry.residualRisk,
      },
    });

    console.log(`✓ (${vector.length}d)`);
    await sleep(300);
  }

  await client.upsert(env.QDRANT_COLLECTION, { points });
  console.log(`  Upserted ${points.length} regulation entries.`);
}

// ─── Seed Incidents ───

async function seedIncidents() {
  console.log("\n─── Seeding: Incidents ───");
  await ensureCollection(env.QDRANT_INCIDENTS_COLLECTION, env.EMBEDDING_DIMENSIONS);

  const points = [];
  for (let i = 0; i < INCIDENTS.length; i++) {
    const inc = INCIDENTS[i];
    process.stdout.write(`  [${i + 1}/${INCIDENTS.length}] "${inc.description.slice(0, 55)}..."... `);

    const text = `${inc.description}. Work type: ${inc.workType}. Hazards: ${inc.hazard_names.join(", ")}. Lessons: ${inc.lessons_learned}`;
    const vector = await embedText(text);
    points.push({
      id: i + 1,
      vector,
      payload: {
        description: inc.description,
        workType: inc.workType,
        hazard_names: inc.hazard_names,
        outcome: inc.outcome,
        lessons_learned: inc.lessons_learned,
        location: inc.location,
      },
    });

    console.log(`✓`);
    await sleep(300);
  }

  await client.upsert(env.QDRANT_INCIDENTS_COLLECTION, { points });
  console.log(`  Upserted ${points.length} incident records.`);
}

// ─── Main ───

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║         PermitoAI — Qdrant Collection Seeder            ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`\nQdrant:      ${env.QDRANT_URL}`);
  console.log(`Regulations: ${env.QDRANT_COLLECTION}`);
  console.log(`Incidents:   ${env.QDRANT_INCIDENTS_COLLECTION}`);
  console.log(`Embedding:   ${env.GOOGLE_EMBEDDING_MODEL} (${env.EMBEDDING_DIMENSIONS}d)`);

  await seedRegulations();
  await seedIncidents();

  console.log("\n" + "=".repeat(60));
  console.log("Seeding complete. Both collections are ready.");
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("Seeding failed:", err);
  process.exit(1);
});
