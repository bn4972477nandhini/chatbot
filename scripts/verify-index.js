/**
 * Verifies the Qdrant collection after indexing: point count, vector
 * dimension, payload shape, sample chunks, and — most importantly — that
 * every non-empty page of the source PDF is actually represented by at least
 * one indexed chunk, so "86 chunks were written" can't quietly mean part of
 * the book got skipped.
 *
 * Usage: node scripts/verify-index.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const { config } = require("../config/env");
const { getQdrantClient } = require("../services/qdrantService");
const { readPDF } = require("../services/pdfReader");
const { BOOK_PATH } = require("../services/indexService");

async function main() {
  const client = getQdrantClient();
  const collection = config.qdrant.collection;

  const info = await client.getCollection(collection);
  const count = await client.count(collection, { exact: true });

  console.log("=== Collection info ===");
  console.log(`Collection:        ${collection}`);
  console.log(`Total points:      ${count.count}`);
  console.log(`Vector size:       ${info.config.params.vectors.size}`);
  console.log(`Distance metric:   ${info.config.params.vectors.distance}`);
  console.log(`Indexed fields:    ${Object.keys(info.payload_schema ?? {}).join(", ") || "(none reported)"}`);

  // Scroll every point (86-ish — small enough to pull in one page) to inspect
  // payload shape and compute real page coverage.
  const { points } = await client.scroll(collection, {
    limit: 500,
    with_payload: true,
    with_vector: false,
  });

  console.log(`\n=== Payload shape (from ${points.length} scrolled points) ===`);
  const keySets = new Set(points.map((p) => Object.keys(p.payload).sort().join(",")));
  console.log(`Distinct payload key sets: ${keySets.size}`);
  for (const keys of keySets) console.log(`  { ${keys} }`);

  console.log("\n=== Sample chunks ===");
  for (const p of points.slice(0, 3)) {
    console.log(`--- point id ${p.id} ---`);
    console.log(`  chunkId: ${p.payload.chunkId}, page: ${p.payload.page}-${p.payload.pageEnd}, section: ${p.payload.section} (${p.payload.sectionTitle ?? "no title"})`);
    console.log(`  pageContent: ${JSON.stringify(p.payload.pageContent.slice(0, 120))}...`);
  }

  console.log("\n=== Page coverage ===");
  const { pages } = await readPDF(BOOK_PATH);
  const nonEmptyPages = pages.filter((p) => p.text.trim().length > 0).map((p) => p.pageNumber);

  const coveredPages = new Set();
  for (const p of points) {
    const start = p.payload.page;
    const end = p.payload.pageEnd ?? start;
    if (start == null) continue;
    for (let pageNumber = start; pageNumber <= end; pageNumber++) coveredPages.add(pageNumber);
  }

  const missing = nonEmptyPages.filter((pageNumber) => !coveredPages.has(pageNumber));

  console.log(`Non-empty PDF pages:      ${nonEmptyPages.length}`);
  console.log(`Pages represented in index: ${coveredPages.size}`);
  console.log(`Missing (non-empty, uncovered) pages: ${missing.length ? missing.join(", ") : "(none)"}`);

  console.log("\n=== Verdict ===");
  const dimensionOk = info.config.params.vectors.size === config.llm.embeddingDimensions;
  const countOk = count.count > 0;
  const coverageOk = missing.length === 0;

  console.log(`Vector dimension matches ${config.llm.provider}'s ${config.llm.embeddingModel} (${config.llm.embeddingDimensions}): ${dimensionOk ? "OK" : "MISMATCH"}`);
  console.log(`Points written: ${countOk ? "OK" : "EMPTY COLLECTION"}`);
  console.log(`Full page coverage: ${coverageOk ? "OK" : "GAPS FOUND"}`);

  if (!dimensionOk || !countOk || !coverageOk) process.exitCode = 1;
}

main().catch((error) => {
  console.error("Index verification failed:", error);
  process.exitCode = 1;
});
