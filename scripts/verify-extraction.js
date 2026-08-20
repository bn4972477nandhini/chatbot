/**
 * Verifies PDF extraction completeness before anything gets indexed.
 *
 * Reports total pages, total extracted characters, a page-by-page breakdown,
 * and flags pages with little or no extractable text so a silent extraction
 * failure (a truncated read, a corrupt page, a scanned image with no text
 * layer) is caught here rather than discovered later as a retrieval gap.
 *
 * Usage: node scripts/verify-extraction.js
 */
const { readPDF } = require("../services/pdfReader");
const { BOOK_PATH, SOURCE_NAME } = require("../services/indexService");

const SHORT_PAGE_THRESHOLD = 30;

async function main() {
  console.log(`Reading ${SOURCE_NAME} from ${BOOK_PATH} ...\n`);

  const startedAt = Date.now();
  const { text, pages } = await readPDF(BOOK_PATH);
  const elapsedMs = Date.now() - startedAt;

  const emptyPages = pages.filter((p) => p.text.trim().length === 0);
  const shortPages = pages.filter(
    (p) => p.text.trim().length > 0 && p.text.trim().length < SHORT_PAGE_THRESHOLD
  );
  const nonEmptyPages = pages.length - emptyPages.length;

  console.log("=== Extraction summary ===");
  console.log(`Total pages:            ${pages.length}`);
  console.log(`Total extracted chars:  ${text.length}`);
  console.log(`Non-empty pages:        ${nonEmptyPages}/${pages.length}`);
  console.log(`Extraction time:        ${elapsedMs}ms`);
  console.log(`Avg chars/page:         ${Math.round(text.length / pages.length)}`);

  console.log("\n=== Empty pages (no extractable text at all) ===");
  if (emptyPages.length === 0) {
    console.log("(none)");
  } else {
    for (const p of emptyPages) console.log(`  page ${p.pageNumber}`);
  }

  console.log(`\n=== Short pages (<${SHORT_PAGE_THRESHOLD} non-whitespace chars) ===`);
  if (shortPages.length === 0) {
    console.log("(none)");
  } else {
    for (const p of shortPages) {
      console.log(`  page ${p.pageNumber} (${p.text.trim().length} chars): ${JSON.stringify(p.text.trim())}`);
    }
  }

  console.log("\n=== Per-page character counts ===");
  for (const p of pages) {
    console.log(`  page ${String(p.pageNumber).padStart(3, " ")}: ${p.text.length} chars`);
  }

  console.log("\n=== Verdict ===");
  const suspiciouslyEmptyFraction = emptyPages.length / pages.length;
  if (suspiciouslyEmptyFraction > 0.1) {
    console.log(
      `⚠ ${emptyPages.length}/${pages.length} pages (${(suspiciouslyEmptyFraction * 100).toFixed(1)}%) are empty — investigate before indexing.`
    );
    process.exitCode = 1;
  } else {
    console.log(
      `OK — extraction reached all ${pages.length} pages; ${emptyPages.length} legitimately empty (cover art), the rest carry text.`
    );
  }
}

main().catch((error) => {
  console.error("Extraction verification failed:", error);
  process.exitCode = 1;
});
