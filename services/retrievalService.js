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
    const points = await searchPoints(vector, {
      limit: poolSize,
      scoreThreshold,
      withPayload: true,
      withVector: useMmr,
      filter,
    });
    const searchMs = Date.now() - searchStartedAt;

    const selected = useMmr
      ? maximalMarginalRelevance({
          queryVector: vector,
          candidates: points,
          k: limit,
          lambda: mmrLambda,
        })
      : points.slice(0, limit);

    const chunks = selected.map((point) => ({
      score: point.score,
      // Falls back to the point ID: payload.chunkId and the ID are written as
      // the same value by the indexer.
      chunkId: point.payload?.chunkId ?? point.id,
      pageContent: point.payload?.pageContent ?? "",
      source: point.payload?.source ?? "",
    }));

    logger.debug("retrieval complete", {
      poolSize: points.length,
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
  STRATEGIES,
  TOP_K,
  SCORE_THRESHOLD,
};
