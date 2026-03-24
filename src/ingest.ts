#!/usr/bin/env tsx
/**
 * Compliance Document Ingestion Pipeline
 * Ingests PDFs from compliance_docs/ into Qdrant (permito_compliance_docs collection).
 *
 * Features:
 *  - Smart text chunking (paragraph-aware, sentence-boundary splits, overlap)
 *  - Deduplication via SHA-256 content hash as point ID (re-runs are idempotent)
 *  - Batched embedding + upsert to respect API rate limits
 *  - Per-file clean mode: wipe existing chunks for a file before re-ingesting
 *
 * Usage:
 *   pnpm ingest                                    # ingest all PDFs in compliance_docs/
 *   pnpm ingest -- --file SAFETY-REGULATIONS.pdf   # single file
 *   pnpm ingest -- --clean                         # delete collection then re-ingest all
 *   pnpm ingest -- --clean-file                    # wipe per-file chunks then re-ingest
 *
 * Requires:
 *   pdftotext — sudo apt install poppler-utils      (text-based PDFs)
 *   ocrmypdf  — sudo apt install tesseract-ocr ocrmypdf  (scanned/image PDFs, auto-detected)
 */
import "dotenv/config";
import { createHash } from "crypto";
import { readdirSync, mkdtempSync, rmSync, existsSync } from "fs";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import path from "path";
import { QdrantClient } from "@qdrant/js-client-rest";
import { embedText } from "./services/embeddingService.js";
import { env } from "./config.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const CHUNK_SIZE = 1400;       // target chars per chunk
const CHUNK_OVERLAP = 180;     // overlap chars between consecutive chunks
const EMBED_BATCH_SIZE = 5;    // chunks embedded in parallel per batch
const UPSERT_BATCH_SIZE = 50;  // points upserted per Qdrant call
const RATE_LIMIT_DELAY = 600;  // ms between embedding batches

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = path.resolve(__dirname, "../compliance_docs");
const COLLECTION = env.QDRANT_COMPLIANCE_COLLECTION;
const VECTOR_SIZE = env.EMBEDDING_DIMENSIONS;

const client = new QdrantClient({ url: env.QDRANT_URL, apiKey: env.QDRANT_API_KEY });

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Convert first 15 hex chars of SHA-256 to a safe uint53 point ID.
 * Same content always produces the same ID → upsert is idempotent.
 */
function contentHash(text: string): number {
  const hex = createHash("sha256").update(text).digest("hex");
  return parseInt(hex.slice(0, 15), 16);
}

// ─── Smart Text Chunker ───────────────────────────────────────────────────────

/**
 * Split text into overlapping chunks with these priorities:
 *  1. Prefer splitting at paragraph boundaries (double newline)
 *  2. Fall back to sentence boundaries (. ? !)
 *  3. Hard split at CHUNK_SIZE if no boundary found
 */
function chunkText(text: string): string[] {
  // Normalise whitespace: collapse 3+ newlines to 2, trim runs of spaces
  const normalised = text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  if (normalised.length <= CHUNK_SIZE) return [normalised].filter(Boolean);

  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < normalised.length) {
    const end = cursor + CHUNK_SIZE;

    if (end >= normalised.length) {
      // Last piece
      const tail = normalised.slice(cursor).trim();
      if (tail) chunks.push(tail);
      break;
    }

    // Look for best split point within [cursor, end]
    const window = normalised.slice(cursor, end + 200); // small lookahead

    // 1. Paragraph boundary (double newline)
    const paraIdx = window.lastIndexOf("\n\n");
    // 2. Sentence boundary
    const sentenceMatch = [...window.matchAll(/[.!?]\s/g)];
    const sentIdx =
      sentenceMatch.length > 0
        ? sentenceMatch[sentenceMatch.length - 1].index! + 1
        : -1;

    let splitAt: number;
    if (paraIdx > CHUNK_SIZE / 3) {
      splitAt = cursor + paraIdx;
    } else if (sentIdx > CHUNK_SIZE / 3) {
      splitAt = cursor + sentIdx;
    } else {
      splitAt = cursor + CHUNK_SIZE;
    }

    const chunk = normalised.slice(cursor, splitAt).trim();
    if (chunk) chunks.push(chunk);

    // Advance with overlap (step back by CHUNK_OVERLAP chars)
    cursor = Math.max(cursor + 1, splitAt - CHUNK_OVERLAP);
  }

  return chunks;
}

// ─── PDF Extraction via pdftotext ────────────────────────────────────────────

interface ExtractedChunk {
  content: string;
  sourceFile: string;
  chunkIndex: number;
  totalChunks: number;
  pageHint: string;
}

function extractTextFromPdf(filePath: string): string {
  try {
    // pdftotext -layout preserves reading order; stderr suppressed (font warnings)
    const raw = execSync(`pdftotext -layout "${filePath}" - 2>/dev/null`, {
      maxBuffer: 50 * 1024 * 1024, // 50 MB
      encoding: "utf8",
    });
    return raw as string;
  } catch (err) {
    throw new Error(`pdftotext failed for "${filePath}": ${(err as Error).message}`);
  }
}

function countPdfPages(filePath: string): number {
  try {
    const info = execSync(`pdfinfo "${filePath}"`, { encoding: "utf8" }) as string;
    const match = /Pages:\s+(\d+)/.exec(info);
    return match ? parseInt(match[1], 10) : 1;
  } catch {
    return 1;
  }
}

/**
 * Returns true if the PDF appears to be a scanned image (no selectable text).
 * Threshold: < 50 characters per page on average.
 */
function isScannedPdf(text: string, pages: number): boolean {
  return pages > 0 && text.trim().length / pages < 50;
}

/** Check whether ocrmypdf + tesseract are installed. */
function hasOcr(): boolean {
  try {
    execSync("ocrmypdf --version 2>/dev/null", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run ocrmypdf on a scanned PDF and return the extracted text.
 * Creates a temporary OCR'd PDF, runs pdftotext on it, then cleans up.
 */
function ocrPdf(filePath: string): string {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "permito-ocr-"));
  const ocrPdfPath = path.join(tmpDir, "ocr_output.pdf");

  try {
    // --skip-text: don't re-OCR pages that already have text
    // --output-type pdf: standard PDF output
    // --jobs 2: parallelise tesseract across 2 threads
    execSync(
      `ocrmypdf --skip-text --output-type pdf --jobs 2 -q "${filePath}" "${ocrPdfPath}" 2>/dev/null`,
      { timeout: 5 * 60 * 1000 } // 5 min max
    );

    const text = execSync(`pdftotext -layout "${ocrPdfPath}" - 2>/dev/null`, {
      maxBuffer: 50 * 1024 * 1024,
      encoding: "utf8",
    }) as string;

    return text;
  } finally {
    // Always clean up temp dir
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function extractChunks(filePath: string): Promise<ExtractedChunk[]> {
  const filename = path.basename(filePath);
  let rawText = extractTextFromPdf(filePath);
  const totalPages = countPdfPages(filePath);

  // ── Auto-OCR scanned PDFs ────────────────────────────────────────────────
  if (isScannedPdf(rawText, totalPages)) {
    const charsPerPage = Math.round(rawText.trim().length / totalPages);
    process.stdout.write(`\n    [scanned ~${charsPerPage} chars/page] `);

    if (!hasOcr()) {
      console.log(
        `\n    ✗ OCR tools not found. Install them then re-run:\n` +
        `      sudo apt install -y tesseract-ocr ocrmypdf\n` +
        `      pnpm ingest -- --file "${filename}"`
      );
      return [];
    }

    process.stdout.write(`running OCR (this may take a minute)... `);
    try {
      rawText = ocrPdf(filePath);
    } catch (err) {
      console.log(`\n    ✗ OCR failed: ${(err as Error).message}`);
      return [];
    }

    if (isScannedPdf(rawText, totalPages)) {
      console.log(`\n    ✗ OCR produced no usable text. The document may be image-heavy or in an unsupported language.`);
      return [];
    }

    console.log(`OCR complete.`);
  }

  const chunks = chunkText(rawText);
  const totalChars = rawText.length;

  return chunks.map((content, i) => {
    const startPos = rawText.indexOf(content.slice(0, 60));
    const midPos = startPos >= 0 ? startPos + content.length / 2 : (i / chunks.length) * totalChars;
    const estPage = Math.max(1, Math.round((midPos / totalChars) * totalPages));
    return {
      content,
      sourceFile: filename,
      chunkIndex: i,
      totalChunks: chunks.length,
      pageHint: `~p.${estPage}/${totalPages}`,
    };
  });
}

// ─── Qdrant Helpers ───────────────────────────────────────────────────────────

async function ensureCollection() {
  try {
    await client.getCollection(COLLECTION);
    console.log(`  Collection "${COLLECTION}" already exists.`);
  } catch {
    await client.createCollection(COLLECTION, {
      vectors: { size: VECTOR_SIZE, distance: "Cosine" },
    });
    console.log(`  Created collection "${COLLECTION}" (${VECTOR_SIZE}d, Cosine).`);
  }

  // Payload index for efficient per-file delete/filter
  await client.createPayloadIndex(COLLECTION, {
    field_name: "sourceFile",
    field_schema: "keyword",
  }).catch(() => {}); // ignore if already exists
}

async function deleteBySourceFile(filename: string) {
  await client.delete(COLLECTION, {
    filter: {
      must: [{ key: "sourceFile", match: { value: filename } }],
    },
  });
  console.log(`  Deleted existing chunks for "${filename}".`);
}

async function cleanCollection() {
  try {
    await client.deleteCollection(COLLECTION);
    console.log(`  Deleted collection "${COLLECTION}".`);
  } catch {
    // didn't exist
  }
  await ensureCollection();
}

// ─── Ingest One File ──────────────────────────────────────────────────────────

async function ingestFile(filePath: string, cleanFile: boolean) {
  const filename = path.basename(filePath);
  console.log(`\n  [File] ${filename}`);

  // 1. Extract chunks
  process.stdout.write(`    Extracting chunks... `);
  const chunks = await extractChunks(filePath);
  console.log(`${chunks.length} chunks`);

  if (chunks.length === 0) {
    console.log(`    Nothing to ingest.`);
    return;
  }

  // 2. Optionally wipe existing vectors for this file
  if (cleanFile) {
    await deleteBySourceFile(filename);
  }

  // 3. Build points — deduplicate within this batch by content hash
  const seenIds = new Set<number>();
  const points: Array<{
    id: number;
    vector: number[];
    payload: Record<string, unknown>;
  }> = [];

  /**
   * Embed with automatic retry on transient errors (503, ETIMEDOUT, etc.).
   * Uses exponential backoff: 5s → 15s → 45s (3 attempts).
   */
  async function embedWithRetry(text: string, attempt = 1): Promise<number[]> {
    try {
      return await embedText(text);
    } catch (err) {
      const msg = String(err);
      const isTransient = msg.includes("503") || msg.includes("UNAVAILABLE") || msg.includes("ETIMEDOUT") || msg.includes("429") || msg.includes("quota");
      if (isTransient && attempt < 3) {
        const wait = attempt * 5000;
        process.stdout.write(`[retry ${attempt}/2 in ${wait / 1000}s] `);
        await sleep(wait);
        return embedWithRetry(text, attempt + 1);
      }
      throw err;
    }
  }

  // Process in embedding batches
  for (let b = 0; b < chunks.length; b += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(b, b + EMBED_BATCH_SIZE);
    process.stdout.write(
      `    Embedding batch ${Math.ceil(b / EMBED_BATCH_SIZE) + 1}/${Math.ceil(chunks.length / EMBED_BATCH_SIZE)} (${batch.length} chunks)... `
    );

    const vectors = await Promise.all(batch.map((c) => embedWithRetry(c.content)));

    for (let i = 0; i < batch.length; i++) {
      const chunk = batch[i];
      const id = contentHash(chunk.content);

      if (seenIds.has(id)) {
        process.stdout.write(`[dup] `);
        continue; // skip exact duplicate within this run
      }
      seenIds.add(id);

      points.push({
        id,
        vector: vectors[i],
        payload: {
          content: chunk.content,
          sourceFile: chunk.sourceFile,
          chunkIndex: chunk.chunkIndex,
          totalChunks: chunk.totalChunks,
          pageHint: chunk.pageHint,
          ingestedAt: new Date().toISOString(),
        },
      });
    }

    console.log(`✓`);

    if (b + EMBED_BATCH_SIZE < chunks.length) {
      await sleep(RATE_LIMIT_DELAY);
    }
  }

  // 4. Upsert in batches (idempotent — same hash = same ID = overwrite)
  for (let u = 0; u < points.length; u += UPSERT_BATCH_SIZE) {
    const batch = points.slice(u, u + UPSERT_BATCH_SIZE);
    await client.upsert(COLLECTION, { points: batch });
  }

  console.log(`    Upserted ${points.length} unique chunks for "${filename}".`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const cleanAll = args.includes("--clean");
  const cleanFiles = args.includes("--clean-file"); // clean per file before re-ingest
  const singleFile = args.find((a, i) => args[i - 1] === "--file");

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║     PermitoAI — Compliance Document Ingestion Pipeline  ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`\nQdrant:     ${env.QDRANT_URL}`);
  console.log(`Collection: ${COLLECTION}`);
  console.log(`Chunk size: ${CHUNK_SIZE} chars  |  Overlap: ${CHUNK_OVERLAP} chars`);
  console.log(`Batch size: embed=${EMBED_BATCH_SIZE}  upsert=${UPSERT_BATCH_SIZE}`);

  // Discover PDFs
  const allPdfs = readdirSync(DOCS_DIR)
    .filter((f) => f.toLowerCase().endsWith(".pdf"))
    .map((f) => path.join(DOCS_DIR, f));

  const targets = singleFile
    ? [path.join(DOCS_DIR, singleFile)]
    : allPdfs;

  if (targets.length === 0) {
    console.log(`\nNo PDFs found in ${DOCS_DIR}`);
    return;
  }

  console.log(`\nFound ${targets.length} PDF(s) to process:`);
  targets.forEach((f) => console.log(`  • ${path.basename(f)}`));

  // Ensure collection exists (or wipe if --clean)
  console.log("\n─── Collection Setup ───");
  if (cleanAll) {
    console.log("  --clean flag: rebuilding collection from scratch.");
    await cleanCollection();
  } else {
    await ensureCollection();
  }

  // Ingest
  console.log("\n─── Ingesting Files ───");
  let totalChunks = 0;
  for (const filePath of targets) {
    await ingestFile(filePath, cleanFiles && !cleanAll);
    totalChunks++;
  }

  // Final stats
  const info = await client.getCollection(COLLECTION);
  const pointCount =
    typeof info.points_count === "number" ? info.points_count : "?";

  console.log("\n" + "=".repeat(60));
  console.log(`Ingestion complete.`);
  console.log(`Files processed : ${totalChunks}`);
  console.log(`Total points in "${COLLECTION}": ${pointCount}`);
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("\nIngestion failed:", err);
  process.exit(1);
});
