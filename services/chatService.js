const { config } = require("../config/env");
const { AppError, upstreamError } = require("../lib/errors");
const { logger: defaultLogger } = require("../lib/logger");
const { getOpenAIClient } = require("./openaiClient");
const { createRetrievalService } = require("./retrievalService");
const { classifyConversational } = require("./conversationalIntentService");
const { isAbstractQuestion } = require("./queryUnderstanding");
const {
  buildMessages: defaultBuildMessages,
  NO_ANSWER_REPLY,
} = require("./promptService");

const CHAT_MODEL = config.llm.chatModel;
const TEMPERATURE = config.llm.temperature;
const MAX_OUTPUT_TOKENS = config.llm.maxOutputTokens;
const SEED = config.llm.seed;
const KEEP_ALIVE = config.llm.keepAlive;

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

// A whole-book synthesis question ("summarize the key ideas") legitimately
// needs more distinct evidence chunks than a single-fact question — the
// default topK, tuned for the common case, sometimes crowds out one relevant
// chunk in favour of near-duplicate coverage of another. Only ever widens
// (never narrows) the pool sent to the model, and only for this one
// structurally-detected class — a matching experiment that also widened for
// multi-part questions measurably degraded multi-part answer quality (shifted
// one toward misattributing authorship entirely) without fixing the target
// case, so that class is deliberately excluded here. Skipped when the caller
// already passed an explicit `limit`, so it never overrides a deliberate
// per-request override.
const WIDER_EVIDENCE_LIMIT = config.retrieval.topK + 2;

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
  timeoutMs = config.llm.timeoutMs,
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
  /**
   * A hung request must never be able to block this call — and, because every
   * Ollama call is serialized through one queue (openaiClient.js), never able
   * to block every later request behind it either — for longer than this
   * configured limit. Passed explicitly per attempt (rather than relying
   * solely on the client's own constructor-level `timeout`) because a real
   * incident showed a request take ~27 minutes to fail despite a configured
   * 180s timeout: an explicit, request-scoped AbortSignal is a second,
   * independent enforcement path that does not depend on however the
   * client's internal timeout happens to be implemented. A fresh signal is
   * created per HTTP attempt — an already-fired AbortSignal.timeout() cannot
   * be reused for a second attempt.
   */
  function requestTimeoutSignal() {
    return AbortSignal.timeout(timeoutMs);
  }

  async function createCompletion(messages, log) {
    const client = getClient();
    // seed is omitted entirely (rather than sent as undefined) when unset, so
    // a provider that validates unknown/undefined fields strictly never sees
    // it; keep_alive is Ollama-only (see config/env.js) and included the same way.
    const extras = {
      ...(SEED !== undefined ? { seed: SEED } : {}),
      ...(KEEP_ALIVE ? { keep_alive: KEEP_ALIVE } : {}),
    };

    try {
      return await client.chat.completions.create(
        {
          model,
          temperature: TEMPERATURE,
          max_tokens: MAX_OUTPUT_TOKENS,
          ...extras,
          messages,
        },
        { signal: requestTimeoutSignal() }
      );
    } catch (error) {
      const unsupportedTemperature =
        error?.status === 400 && /temperature/i.test(error?.message ?? "");

      if (!unsupportedTemperature) throw error;

      log.warn("model rejected explicit temperature; retrying with model default", {
        model,
        temperature: TEMPERATURE,
      });

      return client.chat.completions.create(
        {
          model,
          max_tokens: MAX_OUTPUT_TOKENS,
          ...extras,
          messages,
        },
        { signal: requestTimeoutSignal() }
      );
    }
  }

  /**
   * Same call as createCompletion, with `stream: true`. `onDelta` fires for
   * every non-empty text fragment as it arrives, in order; the full answer is
   * still returned at the end so callers that need the complete text (caching,
   * logging) don't have to reassemble it themselves. The temperature-retry
   * behaves the same as the non-streaming path and for the same reason it's
   * safe there: `create()` throwing happens before the `for await` below ever
   * starts, so a retry here can never follow content that was already
   * delivered to `onDelta`.
   */
  async function createCompletionStream(messages, log, onDelta, externalSignal) {
    const client = getClient();
    const extras = {
      ...(SEED !== undefined ? { seed: SEED } : {}),
      ...(KEEP_ALIVE ? { keep_alive: KEEP_ALIVE } : {}),
    };
    // Combined with the caller's own signal (typically tied to the HTTP
    // client disconnecting) when given, so either the configured hard
    // timeout or an early client disconnect ends the call — a disconnect
    // must free Ollama's single processing slot promptly rather than let an
    // abandoned generation keep running for nobody.
    const abortSignal = () =>
      externalSignal ? AbortSignal.any([requestTimeoutSignal(), externalSignal]) : requestTimeoutSignal();

    async function runStream(body) {
      const stream = await client.chat.completions.create(
        { ...body, stream: true },
        { signal: abortSignal() }
      );

      let answer = "";
      let firstTokenMs = null;
      let usage;
      const streamStartedAt = Date.now();

      for await (const part of stream) {
        const delta = part?.choices?.[0]?.delta?.content;
        if (delta) {
          if (firstTokenMs === null) firstTokenMs = Date.now() - streamStartedAt;
          answer += delta;
          onDelta(delta);
        }
        // Present only if the provider opts in to a final usage-bearing chunk;
        // absent (usage stays undefined) is expected and handled the same way
        // completion?.usage already is on the non-streaming path.
        if (part?.usage) usage = part.usage;
      }

      return { answer, firstTokenMs, usage };
    }

    try {
      return await runStream({ model, temperature: TEMPERATURE, max_tokens: MAX_OUTPUT_TOKENS, ...extras, messages });
    } catch (error) {
      const unsupportedTemperature =
        error?.status === 400 && /temperature/i.test(error?.message ?? "");

      if (!unsupportedTemperature) throw error;

      log.warn("model rejected explicit temperature; retrying with model default", {
        model,
        temperature: TEMPERATURE,
      });

      return runStream({ model, max_tokens: MAX_OUTPUT_TOKENS, ...extras, messages });
    }
  }

  /**
   * Everything ask() and askStream() share: the response cache, retrieval,
   * citation shaping and the empty-context fallback. Kept as one function so
   * the two request paths cannot silently drift apart on this logic — only
   * how the model is actually called (buffered vs. streamed) differs between
   * them, in ask()/askStream() themselves.
   *
   * @returns {Promise<
   *   | {type: "conversational", result: object}
   *   | {type: "cache_hit", result: object}
   *   | {type: "no_context", key: string, result: object, timings: object}
   *   | {type: "needs_completion", key: string, citations: Array, messages: Array, timings: object, promptBuildMs: number}
   * >}
   */
  async function prepareRequest(question, options) {
    // Checked before the cache and before retrieval: obvious small talk
    // ("hi", "thanks", "bye", …) needs neither — no embedding call, no
    // Qdrant search, no query expansion, no model call. Purely deterministic
    // pattern matching (conversationalIntentService.js), so this never
    // depends on `options` and never costs a round trip either way.
    const conversational = classifyConversational(question);
    if (conversational) {
      return { type: "conversational", result: { answer: conversational.answer, citations: [] } };
    }

    const key = cacheKey(question, options);
    const cached = cacheGet(key);
    if (cached) return { type: "cache_hit", result: cached };

    const retrievalOptions =
      isAbstractQuestion(question) && options.limit === undefined
        ? { ...options, limit: WIDER_EVIDENCE_LIMIT }
        : options;

    const { chunks, timings } = await retriever.retrieve(question, retrievalOptions);

    const citations = chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      score: chunk.score,
      page: chunk.page,
      pageEnd: chunk.pageEnd,
    }));

    // Nothing cleared the score threshold — answer with the exact fallback the
    // system prompt specifies rather than spending a model call on empty context.
    if (chunks.length === 0) {
      const noContextResult = { answer: NO_ANSWER_REPLY, citations: [] };
      return { type: "no_context", key, result: noContextResult, timings };
    }

    // Negligible in practice (pure in-process string work), but measured
    // anyway so the per-stage log line accounts for the full request rather
    // than leaving an unexplained gap between retrieval and the model call.
    const promptBuildStartedAt = Date.now();
    const messages = buildMessages({ question, chunks });
    const promptBuildMs = Date.now() - promptBuildStartedAt;

    return { type: "needs_completion", key, citations, messages, timings, promptBuildMs };
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

    const prepared = await prepareRequest(question, options);

    if (prepared.type === "conversational") {
      log.info("chat request complete", {
        outcome: "conversational",
        retrievedChunks: 0,
        gptMs: 0,
        totalMs: Date.now() - startedAt,
      });
      return prepared.result;
    }

    if (prepared.type === "cache_hit") {
      log.info("chat request complete", {
        outcome: "cache_hit",
        retrievedChunks: prepared.result.citations.length,
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
      return prepared.result;
    }

    if (prepared.type === "no_context") {
      log.info("chat request complete", {
        outcome: "no_context",
        retrievedChunks: 0,
        ...prepared.timings,
        gptMs: 0,
        totalMs: Date.now() - startedAt,
      });
      cacheSet(prepared.key, prepared.result);
      return prepared.result;
    }

    const { key, citations, messages, timings, promptBuildMs } = prepared;

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
      retrievedChunks: citations.length,
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

  /**
   * Same contract as ask(), plus incremental delivery: `onCitations` fires
   * once retrieval finishes (citations depend only on retrieval, never on the
   * model's output, so they're available well before the first generated
   * token — a real gap on this CPU-only setup, where prefill alone typically
   * takes tens of seconds); `onDelta` fires for each answer fragment as the
   * model generates it. Both the cache-hit and no-context paths still call
   * onDelta exactly once, with the whole (already-known) answer, so a caller
   * driving a UI off these callbacks never has to special-case "the answer
   * arrived all at once."
   *
   * @param {string} question
   * @param {object} [options]
   * @param {object} [callbacks]
   * @param {(citations: Array) => void} [callbacks.onCitations]
   * @param {(delta: string) => void} [callbacks.onDelta]
   * @returns {Promise<{answer: string, citations: Array<{chunkId: number, score: number}>}>}
   */
  async function askStream(
    question,
    options = {},
    { logger: requestLogger, onCitations, onDelta, signal } = {}
  ) {
    const log = requestLogger ?? logger;
    const startedAt = Date.now();

    log.info("chat request received", { questionLength: question.length, stream: true });

    const prepared = await prepareRequest(question, options);

    if (prepared.type === "conversational") {
      log.info("chat request complete", {
        outcome: "conversational",
        stream: true,
        retrievedChunks: 0,
        gptMs: 0,
        totalMs: Date.now() - startedAt,
      });
      onCitations?.(prepared.result.citations);
      onDelta?.(prepared.result.answer);
      return prepared.result;
    }

    if (prepared.type === "cache_hit") {
      log.info("chat request complete", {
        outcome: "cache_hit",
        stream: true,
        retrievedChunks: prepared.result.citations.length,
        gptMs: 0,
        totalMs: Date.now() - startedAt,
      });
      onCitations?.(prepared.result.citations);
      onDelta?.(prepared.result.answer);
      return prepared.result;
    }

    if (prepared.type === "no_context") {
      log.info("chat request complete", {
        outcome: "no_context",
        stream: true,
        retrievedChunks: 0,
        ...prepared.timings,
        gptMs: 0,
        totalMs: Date.now() - startedAt,
      });
      onCitations?.(prepared.result.citations);
      onDelta?.(prepared.result.answer);
      cacheSet(prepared.key, prepared.result);
      return prepared.result;
    }

    const { key, citations, messages, timings, promptBuildMs } = prepared;
    onCitations?.(citations);

    const gptStartedAt = Date.now();
    let streamed;
    try {
      streamed = await createCompletionStream(messages, log, (delta) => onDelta?.(delta), signal);
    } catch (error) {
      if (error instanceof AppError) throw error;

      throw upstreamError(
        `The language model request failed: ${error?.message ?? error}`,
        error
      );
    }
    const gptMs = Date.now() - gptStartedAt;

    const answer = streamed.answer?.trim();

    log.info("chat request complete", {
      outcome: answer ? "answered" : "empty_completion",
      stream: true,
      model,
      retrievedChunks: citations.length,
      topScore: citations[0]?.score,
      ...timings,
      promptBuildMs,
      gptMs,
      firstTokenMs: streamed.firstTokenMs,
      totalMs: Date.now() - startedAt,
      usage: streamed.usage,
    });

    // The stream produced nothing (mirrors ask()'s empty_completion path) — the
    // caller has received zero onDelta calls so far, so it still needs the
    // fallback text delivered exactly once, the same as every other path here.
    if (!answer) onDelta?.(NO_ANSWER_REPLY);

    const result = { answer: answer || NO_ANSWER_REPLY, citations };
    if (answer) cacheSet(key, result);
    return result;
  }

  return { ask, askStream, clearResponseCache: () => responseCache.clear() };
}

module.exports = { createChatService, CHAT_MODEL, TEMPERATURE };
