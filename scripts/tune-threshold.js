/**
 * Empirically tunes RETRIEVAL_SCORE_THRESHOLD against the real, freshly
 * indexed collection: embeds a batch of genuinely on-topic and genuinely
 * off-topic questions with the real embedding service, queries Qdrant with no
 * threshold at all, and prints the real cosine-score distribution for each
 * group so the cutoff comes from an observed gap rather than a guess.
 *
 * Usage: node scripts/tune-threshold.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const { config } = require("../config/env");
const { embedText } = require("../services/embeddingService");
const { searchPoints } = require("../services/qdrantService");

// Genuinely on-topic: about this specific book's actual subject matter
// (guerrilla/zero-rupee marketing, its author, its case studies). Genuinely
// off-topic: ordinary general-knowledge questions with no connection to the
// book at all. Neither list encodes any *answer* — only the question text,
// used purely to observe where dense-similarity scores land.
const ON_TOPIC = [
  "Who is the author of this book?",
  "What is Zero Rupee Marketing?",
  "Tell me about guerrilla marketing campaigns in the book.",
  "What business lessons does the book discuss?",
  "What awards has the author won?",
  "Describe a marketing campaign involving balloons.",
  "What happened during the farmers' protest campaign?",
  "How much was spent on the campaign and what was the return?",
  "What is the author's background before starting his business?",
  "What companies has the author founded?",
];

const OFF_TOPIC = [
  "What is the capital of France?",
  "How do I bake a chocolate cake?",
  "What is the boiling point of water at sea level?",
  "Explain the theory of general relativity.",
  "What programming language is best for machine learning?",
  "Who won the last FIFA World Cup?",
  "What is the tallest mountain in the world?",
  "How does photosynthesis work?",
  "What year did World War II end?",
  "What is the currency of Japan?",
];

async function scoresFor(questions) {
  const results = [];
  for (const question of questions) {
    const vector = await embedText(question, { useCache: false });
    const points = await searchPoints(vector, {
      limit: 5,
      scoreThreshold: 0, // no filtering — we want to see the raw distribution
      withPayload: false,
    });
    const topScore = points[0]?.score ?? 0;
    results.push({ question, topScore });
  }
  return results;
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted.at(-1);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { min, max, mean };
}

async function main() {
  console.log(`Provider: ${config.llm.provider}, embedding model: ${config.llm.embeddingModel}\n`);

  console.log("=== On-topic questions ===");
  const onTopic = await scoresFor(ON_TOPIC);
  for (const r of onTopic) console.log(`  ${r.topScore.toFixed(4)}  ${r.question}`);
  const onStats = stats(onTopic.map((r) => r.topScore));
  console.log(`  -> min ${onStats.min.toFixed(4)}, mean ${onStats.mean.toFixed(4)}, max ${onStats.max.toFixed(4)}`);

  console.log("\n=== Off-topic questions ===");
  const offTopic = await scoresFor(OFF_TOPIC);
  for (const r of offTopic) console.log(`  ${r.topScore.toFixed(4)}  ${r.question}`);
  const offStats = stats(offTopic.map((r) => r.topScore));
  console.log(`  -> min ${offStats.min.toFixed(4)}, mean ${offStats.mean.toFixed(4)}, max ${offStats.max.toFixed(4)}`);

  console.log("\n=== Analysis ===");
  console.log(`On-topic floor:   ${onStats.min.toFixed(4)}`);
  console.log(`Off-topic ceiling: ${offStats.max.toFixed(4)}`);

  if (onStats.min > offStats.max) {
    const midpoint = (onStats.min + offStats.max) / 2;
    console.log(`Clean separation — no overlap. Suggested threshold: ${midpoint.toFixed(2)} (midpoint of the gap).`);
  } else {
    // Overlap exists: pick a threshold that keeps as much on-topic recall as
    // possible while still rejecting the bulk of off-topic queries — the
    // existing widened-fallback + lexical RRF pass in retrievalService.js is
    // what recovers on-topic chunks that land just under this cutoff, so the
    // threshold can stay conservative rather than needing to catch everything.
    const suggested = Math.max(offStats.mean, onStats.min - 0.05);
    console.log(`⚠ Overlap between groups — no fully clean cutoff exists.`);
    console.log(`Suggested threshold: ${suggested.toFixed(2)} (favors on-topic recall; the lexical/RRF fallback in retrievalService.js recovers most legitimately relevant chunks that still land below this).`);
  }

  console.log(`\nCurrent .env RETRIEVAL_SCORE_THRESHOLD: ${config.retrieval.scoreThreshold}`);
}

main().catch((error) => {
  console.error("Threshold tuning run failed:", error);
  process.exitCode = 1;
});
