const { config } = require("../config/env");
const { AppError, upstreamError } = require("../lib/errors");
const { logger: defaultLogger } = require("../lib/logger");
const { getOpenAIClient } = require("./openaiClient");
const { createRetrievalService } = require("./retrievalService");
const {
  buildMessages: defaultBuildMessages,
  NO_ANSWER_REPLY,
} = require("./promptService");

const CHAT_MODEL = config.llm.chatModel;
const TEMPERATURE = config.llm.temperature;
const MAX_OUTPUT_TOKENS = config.llm.maxOutputTokens;

// A repeated, identical question (same text, same options) is common in
// practice — a user re-asking, a demo, an evaluation loop — and its answer is
// already fully retrieved, grounded and generated; there is nothing to
// recompute. General-purpose (keyed only on the literal question + options,
// never on any specific question text) and bounded both by count (LRU, mirrors
// the pattern in embeddingService.js) and by a short TTL, so a later
// `/index-book` re-index naturally stops mattering within a few minutes
// without this service needing a direct dependency on the indexer to
// invalidate it explicitly.
const RESPONSE_CACHE_LIMIT = 100;
const RESPONSE_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Builds the chat service. Dependencies are injected with real defaults so the
 * orchestration can be tested without network access.
 */
function createChatService({
  retrievalService,
  buildMessages = defaultBuildMessages,
  getClient = getOpenAIClient,
  logger = defaultLogger,
  model = CHAT_MODEL,
} = {}) {
  const retriever = retrievalService || createRetrievalService({ logger });

  /** Insertion-ordered Map used as a small LRU, same shape as embeddingService's. */
  const responseCache = new Map();

  function cacheKey(question, options) {
    return `${question.trim()}|${JSON.stringify(options ?? {})}`;
  }

  function cacheGet(key) {
    const entry = responseCache.get(key);
    if (!entry) return undefined;

    if (Date.now() >= entry.expiresAt) {
      responseCache.delete(key);
      return undefined;
    }

    // Re-insert to mark as most recently used.
    responseCache.delete(key);
    responseCache.set(key, entry);
    return entry.value;
  }

  function cacheSet(key, value) {
    if (responseCache.has(key)) responseCache.delete(key);
    else if (responseCache.size >= RESPONSE_CACHE_LIMIT) {
      const oldest = responseCache.keys().next().value;
      responseCache.delete(oldest);
    }
    responseCache.set(key, { value, expiresAt: Date.now() + RESPONSE_CACHE_TTL_MS });
  }

  /**
   * Some newer OpenAI models only accept the default temperature and reject an
   * explicit value with a 400. Retrying once without the parameter keeps the
   * service working on those models instead of failing the whole request.
   */
  async function createCompletion(messages, log) {
    const client = getClient();

    try {
      return await client.chat.completions.create({
        model,
        temperature: TEMPERATURE,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages,
      });
    } catch (error) {
      const unsupportedTemperature =
        error?.status === 400 && /temperature/i.test(error?.message ?? "");

      if (!unsupportedTemperature) throw error;

      log.warn("model rejected explicit temperature; retrying with model default", {
        model,
        temperature: TEMPERATURE,
      });

      return client.chat.completions.create({ model, max_tokens: MAX_OUTPUT_TOKENS, messages });
    }
  }

  /**
   * Single-turn RAG: retrieve context, build the prompt, call the model.
   *
   * @param {string} question
   * @param {object} [options] retrieval overrides (topK, threshold, filter, …)
   * @returns {Promise<{answer: string, citations: Array<{chunkId: number, score: number}>}>}
   */
  async function ask(question, options = {}, { logger: requestLogger } = {}) {
    const log = requestLogger ?? logger;
    const startedAt = Date.now();

    log.info("chat request received", { questionLength: question.length });

    const key = cacheKey(question, options);
    const cached = cacheGet(key);
    if (cached) {
      log.info("chat request complete", {
        outcome: "cache_hit",
        retrievedChunks: cached.citations.length,
        embedMs: 0,
        denseSearchMs: 0,
        widenMs: 0,
        expansionMs: 0,
        mmrMs: 0,
        searchMs: 0,
        promptBuildMs: 0,
        gptMs: 0,
        totalMs: Date.now() - startedAt,
      });
      return cached;
    }

    const { chunks, timings } = await retriever.retrieve(question, options);

    const citations = chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      score: chunk.score,
      page: chunk.page,
      pageEnd: chunk.pageEnd,
    }));

    // Nothing cleared the score threshold — answer with the exact fallback the
    // system prompt specifies rather than spending a model call on empty context.
    if (chunks.length === 0) {
      log.info("chat request complete", {
        outcome: "no_context",
        retrievedChunks: 0,
        ...timings,
        gptMs: 0,
        totalMs: Date.now() - startedAt,
      });

      const noContextResult = { answer: NO_ANSWER_REPLY, citations: [] };
      cacheSet(key, noContextResult);
      return noContextResult;
    }

    // Negligible in practice (pure in-process string work), but measured
    // anyway so the per-stage log line accounts for the full request rather
    // than leaving an unexplained gap between retrieval and the model call.
    const promptBuildStartedAt = Date.now();
    const messages = buildMessages({ question, chunks });
    const promptBuildMs = Date.now() - promptBuildStartedAt;

    const gptStartedAt = Date.now();
    let completion;
    try {
      completion = await createCompletion(messages, log);
    } catch (error) {
      if (error instanceof AppError) throw error;

      throw upstreamError(
        `The language model request failed: ${error?.message ?? error}`,
        error
      );
    }
    const gptMs = Date.now() - gptStartedAt;

    const answer = completion?.choices?.[0]?.message?.content?.trim();

    log.info("chat request complete", {
      outcome: answer ? "answered" : "empty_completion",
      model,
      retrievedChunks: chunks.length,
      topScore: citations[0]?.score,
      ...timings,
      promptBuildMs,
      gptMs,
      totalMs: Date.now() - startedAt,
      usage: completion?.usage,
    });

    const result = { answer: answer || NO_ANSWER_REPLY, citations };
    // Only a genuine, non-empty completion is cached — an empty completion is
    // an anomaly worth retrying on the next identical request, not a stable
    // answer worth serving again.
    if (answer) cacheSet(key, result);
    return result;
  }

  return { ask, clearResponseCache: () => responseCache.clear() };
}

module.exports = { createChatService, CHAT_MODEL, TEMPERATURE };
