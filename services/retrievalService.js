const { config } = require("../config/env");
const { logger: defaultLogger } = require("../lib/logger");
const { embedText: defaultEmbedText } = require("./embeddingService");
const { maximalMarginalRelevance } = require("./mmr");
const { searchPoints: defaultSearchPoints } = require("./qdrantService");

const TOP_K = config.retrieval.topK;
const SCORE_THRESHOLD = config.retrieval.scoreThreshold;

/**
 * Retrieval strategies.
 *
 * Only dense vector search is implemented today. The seam exists so sparse
 * (BM25 / SPLADE) and hybrid fusion can be added without touching chatService
 * or the routes: implement the strategy, register it here, and switch via the
 * `strategy` option or RETRIEVAL_STRATEGY.
 */
const STRATEGIES = {
  DENSE: "dense",
  SPARSE: "sparse",
  HYBRID: "hybrid",
};

// Words too generic to distinguish one chunk from another. Deliberately small
// and generic — this is not tuned to any specific question or answer.
const STOPWORDS = new Set([
  "what", "who", "whom", "whose", "which", "when", "where", "why", "how",
  "this", "that", "these", "those", "book", "does", "did", "do", "is", "are",
  "was", "were", "will", "would", "should", "could", "can", "give", "example",
  "please", "tell", "about", "with", "from", "into", "your", "you", "the",
  "and", "for", "not",
]);
const MIN_KEYWORD_LENGTH = 4;

// A wide, unfiltered pool the fallback scans — large enough to cover a
// book-sized collection without scaling into a full corpus scan.
const FALLBACK_POOL_SIZE = 100;
const FALLBACK_MATCH_COUNT = 10;

/**
 * Pulls the distinctive words out of a question — lowercased, punctuation
 * stripped, stopwords and short filler words removed. Exported for testing.
 */
function extractKeywords(question) {
  const words = (question.toLowerCase().match(/[a-z0-9']+/g) ?? [])
    .filter((word) => word.length >= MIN_KEYWORD_LENGTH && !STOPWORDS.has(word));
  return [...new Set(words)];
}

/**
 * Scores a chunk of text by how many distinct keywords it contains and how
 * often. Distinct coverage dominates so a chunk mentioning three different
 * query terms once each outranks one that repeats a single term three times.
 */
function scoreLexicalMatch(pageContent, keywords) {
  const text = pageContent.toLowerCase();
  let distinctHits = 0;
  let totalHits = 0;

  for (const keyword of keywords) {
    const count = text.split(keyword).length - 1;
    if (count > 0) {
      distinctHits += 1;
      totalHits += count;
    }
  }

  return distinctHits === 0 ? 0 : distinctHits * 10 + totalHits;
}

/**
 * Reciprocal Rank Fusion — the merge step a hybrid retriever needs.
 *
 * Implemented and tested now so that adding a sparse retriever later is purely
 * additive. Fuses ranked lists by rank rather than score, which avoids having to
 * normalise incomparable scoring scales.
 */
function reciprocalRankFusion(rankedLists, { k = 60, key = (item) => item.id } = {}) {
  const scores = new Map();

  for (const list of rankedLists) {
    list.forEach((item, rank) => {
      const id = key(item);
      const existing = scores.get(id);
      const contribution = 1 / (k + rank + 1);

      if (existing) existing.score += contribution;
      else scores.set(id, { item, score: contribution });
    });
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);
}

/**
 * Builds a retrieval service. Dependencies are injected with real defaults so
 * tests can drive the logic without an OpenAI key or a running Qdrant.
 */
function createRetrievalService({
  embedText = defaultEmbedText,
  searchPoints = defaultSearchPoints,
  logger = defaultLogger,
} = {}) {
  /**
   * Embeds the question and returns the most relevant chunks.
   *
   * @param {string} question
   * @param {object} [options]
   * @param {number} [options.limit]           top K to return
   * @param {number} [options.scoreThreshold]  minimum cosine score
   * @param {boolean}[options.useMmr]          diversity re-ranking
   * @param {number} [options.mmrLambda]       1 = relevance, 0 = diversity
   * @param {object} [options.filter]          Qdrant payload filter
   * @param {string} [options.strategy]
   * @returns {Promise<{chunks: Array, timings: object}>}
   */
  async function retrieve(question, options = {}) {
    if (typeof question !== "string" || question.trim() === "") {
      throw new Error("retrieve requires a non-empty question.");
    }

    const {
      limit = TOP_K,
      scoreThreshold = SCORE_THRESHOLD,
      useMmr = config.retrieval.useMmr,
      mmrLambda = config.retrieval.mmrLambda,
      filter,
      strategy = STRATEGIES.DENSE,
    } = options;

    if (strategy !== STRATEGIES.DENSE) {
      // Fail loudly rather than silently degrading to dense results.
      throw new Error(
        `Retrieval strategy "${strategy}" is not implemented yet. Only "dense" is available.`
      );
    }

    const embedStartedAt = Date.now();
    const vector = await embedText(question);
    const embedMs = Date.now() - embedStartedAt;

    // MMR needs a wider pool to have anything to diversify between; without it
    // the pool is exactly the requested number of results.
    const poolSize = useMmr
      ? Math.min(limit * config.retrieval.mmrPoolMultiplier, 100)
      : limit;

    const searchStartedAt = Date.now();
    const densePoints = await searchPoints(vector, {
      limit: poolSize,
      scoreThreshold,
      withPayload: true,
      withVector: useMmr,
      filter,
    });

    // Dense embeddings can under-rank a short, fact-dense chunk (a copyright
    // page's "Author: X" line) against a natural-language question, even
    // though the chunk is a strong, obviously relevant match once you widen
    // the net a little — it just misses the strict score_threshold cutoff by
    // a small margin. This fallback only runs once the question has already
    // cleared the bar as topically plausible (densePoints non-empty) — a
    // genuinely off-topic question still gets zero results and the no-answer
    // path, nothing is resurrected for it.
    let candidatePoints = densePoints;
    let lexicalMatchCount = 0;

    if (densePoints.length > 0) {
      const widePool = await searchPoints(vector, {
        limit: FALLBACK_POOL_SIZE,
        scoreThreshold: 0,
        withPayload: true,
        withVector: useMmr,
        filter,
      });

      const rankedLists = [densePoints];

      // Exact-term signal: catches a chunk dense embedding poorly represents
      // at all (jargon, codes, names) but that literally contains the term.
      const keywords = extractKeywords(question);
      if (keywords.length > 0) {
        const lexicalMatches = widePool
          .map((point) => ({ point, score: scoreLexicalMatch(point.payload?.pageContent ?? "", keywords) }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, FALLBACK_MATCH_COUNT)
          .map((entry) => entry.point);

        lexicalMatchCount = lexicalMatches.length;
        if (lexicalMatches.length > 0) rankedLists.push(lexicalMatches);
      }

      // Raw-similarity signal: recovers a chunk dense search DOES recognise as
      // relevant, just not confidently enough to clear scoreThreshold alone —
      // MMR is left to decide, on real relevance and diversity, whether it
      // actually earns a place in the final answer.
      rankedLists.push(widePool.slice(0, FALLBACK_MATCH_COUNT));

      candidatePoints = reciprocalRankFusion(rankedLists, {
        key: (point) => point.payload?.chunkId ?? point.id,
      });
    }
    const searchMs = Date.now() - searchStartedAt;

    const selected = useMmr
      ? maximalMarginalRelevance({
          queryVector: vector,
          candidates: candidatePoints,
          k: limit,
          lambda: mmrLambda,
        })
      : candidatePoints.slice(0, limit);

    const chunks = selected.map((point) => ({
      score: point.score,
      // Falls back to the point ID: payload.chunkId and the ID are written as
      // the same value by the indexer.
      chunkId: point.payload?.chunkId ?? point.id,
      pageContent: point.payload?.pageContent ?? "",
      source: point.payload?.source ?? "",
    }));

    logger.debug("retrieval complete", {
      poolSize: densePoints.length,
      lexicalMatchCount,
      returned: chunks.length,
      scoreThreshold,
      useMmr,
      embedMs,
      searchMs,
    });

    return { chunks, timings: { embedMs, searchMs } };
  }

  return { retrieve };
}

module.exports = {
  createRetrievalService,
  reciprocalRankFusion,
  extractKeywords,
  scoreLexicalMatch,
  STRATEGIES,
  TOP_K,
  SCORE_THRESHOLD,
};
