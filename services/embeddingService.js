const { config } = require("../config/env");
const { AppError, upstreamError } = require("../lib/errors");
const { getOpenAIClient } = require("./openaiClient");

const EMBEDDING_MODEL = config.llm.embeddingModel;
const EMBEDDING_DIMENSIONS = config.llm.embeddingDimensions;

// The embeddings endpoint accepts many inputs per call. Keeping batches modest
// stays well inside the per-request token ceiling for 1000-char chunks.
const BATCH_SIZE = 96;

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;

// Query embeddings are cached because the same questions recur (example prompts,
// retries, refreshes) and each repeat is an avoidable paid round trip. Chunk
// embeddings are deliberately not cached — they are embedded once per indexing
// run and would only bloat memory.
const QUERY_CACHE_LIMIT = 256;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Rate limits (429) and transient 5xx responses are the common failure mode when
 * embedding a whole book, so those are retried with exponential backoff. Client
 * errors such as 401 or 400 fail immediately — retrying them cannot help.
 */
function isRetryable(error) {
  // Our own configuration errors are never worth retrying.
  if (error instanceof AppError) return false;

  const status = error?.status;
  if (status === undefined) {
    // Network and timeout failures are retryable; a genuine bug (TypeError,
    // ReferenceError) is not.
    return !(error instanceof TypeError || error instanceof ReferenceError);
  }
  return status === 429 || status >= 500;
}

/**
 * Builds the embedding service.
 *
 * @param {object} [deps]
 * @param {Function} [deps.getClient] returns an OpenAI-compatible client
 */
function createEmbeddingService({ getClient = getOpenAIClient } = {}) {
  /** Insertion-ordered Map used as a small LRU for query embeddings. */
  const queryCache = new Map();

  function cacheGet(key) {
    if (!queryCache.has(key)) return undefined;

    // Re-insert to mark as most recently used.
    const value = queryCache.get(key);
    queryCache.delete(key);
    queryCache.set(key, value);
    return value;
  }

  function cacheSet(key, value) {
    if (queryCache.has(key)) queryCache.delete(key);
    else if (queryCache.size >= QUERY_CACHE_LIMIT) {
      // Evict the oldest entry.
      const oldest = queryCache.keys().next().value;
      queryCache.delete(oldest);
    }
    queryCache.set(key, value);
  }

  async function createEmbeddingBatch(inputs) {
    // Resolved outside the loop so a missing API key fails immediately instead
    // of being retried as a transient error.
    const openai = getClient();

    let lastError;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await openai.embeddings.create({
          model: EMBEDDING_MODEL,
          input: inputs,
        });

        // The API documents results as index-tagged; sort defensively so vectors
        // can never drift out of alignment with their source chunks.
        return response.data
          .slice()
          .sort((a, b) => a.index - b.index)
          .map((item) => item.embedding);
      } catch (error) {
        lastError = error;

        if (attempt === MAX_RETRIES || !isRetryable(error)) break;

        await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }

    // Configuration errors keep their own status and message.
    if (lastError instanceof AppError) throw lastError;

    throw upstreamError(
      `Failed to create embeddings after ${MAX_RETRIES} attempt(s): ${lastError?.message ?? lastError}`,
      lastError
    );
  }

  /**
   * Embeds an array of strings, preserving input order in the returned vectors.
   */
  async function embedTexts(texts) {
    if (!Array.isArray(texts) || texts.length === 0) {
      throw new AppError("embedTexts requires a non-empty array of strings.", {
        status: 500,
        code: "invalid_embedding_input",
      });
    }

    const blankIndex = texts.findIndex(
      (text) => typeof text !== "string" || text.trim() === ""
    );
    if (blankIndex !== -1) {
      throw new AppError(
        `embedTexts received an empty or non-string value at index ${blankIndex}.`,
        { status: 500, code: "invalid_embedding_input" }
      );
    }

    // Pre-sized so the array is not repeatedly grown while batching.
    const vectors = new Array(texts.length);

    for (let start = 0; start < texts.length; start += BATCH_SIZE) {
      const batch = texts.slice(start, start + BATCH_SIZE);
      const embeddings = await createEmbeddingBatch(batch);

      if (embeddings.length !== batch.length) {
        throw upstreamError(
          `Embedding count mismatch: expected ${batch.length}, received ${embeddings.length}.`
        );
      }

      for (let offset = 0; offset < embeddings.length; offset++) {
        vectors[start + offset] = embeddings[offset];
      }
    }

    return vectors;
  }

  /**
   * Embeds a single string, serving repeat questions from an in-process cache.
   */
  async function embedText(text, { useCache = true } = {}) {
    const key = typeof text === "string" ? text.trim() : "";

    if (useCache && key) {
      const cached = cacheGet(key);
      if (cached) return cached;
    }

    const [vector] = await embedTexts([text]);

    if (useCache && key) cacheSet(key, vector);

    return vector;
  }

  return {
    embedTexts,
    embedText,
    clearCache: () => queryCache.clear(),
    cacheSize: () => queryCache.size,
  };
}

// Default instance used by the app; tests build their own with a fake client.
const defaultService = createEmbeddingService();

module.exports = {
  createEmbeddingService,
  embedTexts: defaultService.embedTexts,
  embedText: defaultService.embedText,
  clearEmbeddingCache: defaultService.clearCache,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
};
