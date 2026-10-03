const { config } = require("../config/env");
const { AppError, upstreamError } = require("../lib/errors");
const { logger: defaultLogger } = require("../lib/logger");
const { getOpenAIClient } = require("./openaiClient");
const { createRetrievalService, extractKeywords } = require("./retrievalService");
const { classifyConversational } = require("./conversationalIntentService");
const { isAbstractQuestion } = require("./queryUnderstanding");
const { detectLanguage, toRetrievalQuery, asSearchQuestion, LANGUAGES } = require("./languageService");
const { resolveFollowUp } = require("./followUpService");
const { detectIntent, selectEvidence } = require("./intentService");
const { repetitionStart, trimRepetition, stripQuestionEcho, ungroundedNumbers } = require("./answerGuard");
const {
  buildMessages: defaultBuildMessages,
  noAnswerReply,
  isNoAnswerReply,
} = require("./promptService");

const CHAT_MODEL = config.llm.chatModel;
const TEMPERATURE = config.llm.temperature;
const MAX_OUTPUT_TOKENS = config.llm.maxOutputTokens;
const SEED = config.llm.seed;
const KEEP_ALIVE = config.llm.keepAlive;
const NON_ENGLISH_FREQUENCY_PENALTY = 0.6;

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

// An intent question (intentService.js) retrieves a few extra candidates,
// because the ones without evidence for the intent are dropped afterwards.
const INTENT_CANDIDATE_LIMIT = config.retrieval.topK + 3;

/** Compact chunk description for debug logs. */
function describeChunks(chunks) {
  return chunks.map((chunk) => ({
    chunkId: chunk.chunkId,
    page: chunk.page,
    score: Number(chunk.score?.toFixed(3)),
    text: (chunk.pageContent ?? "").replace(/\s+/g, " ").slice(0, 100),
  }));
}

/**
 * Applies answerGuard.js to a finished answer. A looping answer is cut back
 * to before the loop; an answer stating a figure the evidence never gives is
 * replaced with the "not found" reply rather than shown as fact.
 */
function guardAnswer(answer, evidenceText, { language, intent }, question) {
  const checkPairs = language !== LANGUAGES.ENGLISH;
  // An intent answer is asked for in one sentence; anything after a blank
  // line is the model carrying on unasked (seen: an invented second paragraph).
  const unechoed = stripQuestionEcho(answer, question);
  const focused = intent ? unechoed.split(/\n\s*\n/)[0].trim() : unechoed;
  const trimmed = trimRepetition(focused, { checkPairs });
  const unsupported = ungroundedNumbers(trimmed, evidenceText);
  if (unsupported.length > 0) {
    return { answer: noAnswerReply(language), guard: "ungrounded_numbers", unsupported };
  }
  if (trimmed !== answer) return { answer: trimmed, guard: "trimmed" };
  return { answer, guard: null };
}

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

  // A follow-up's answer depends on the turn it follows, so that turn is part
  // of its key; a standalone question's key ignores history entirely.
  function cacheKey(question, options, promptHistory) {
    const historyPart = promptHistory.length > 0 ? `|${JSON.stringify(promptHistory)}` : "";
    return `${question.trim()}|${JSON.stringify(options ?? {})}${historyPart}`;
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

  /**
   * seed is omitted entirely (rather than sent as undefined) when unset, so a
   * provider that validates unknown/undefined fields strictly never sees it;
   * keep_alive is Ollama-only (see config/env.js) and included the same way.
   * Shared by every call this service makes — including warmUp() — so the
   * warm-up can never hold the model loaded for a different duration than
   * real requests do.
   */
  function completionExtras(language = LANGUAGES.ENGLISH) {
    return {
      ...(SEED !== undefined ? { seed: SEED } : {}),
      ...(KEEP_ALIVE ? { keep_alive: KEEP_ALIVE } : {}),
      // Only for Tanglish/Tamil answers: without it llama3.2 3B fell into
      // repetition loops there. English requests are sent exactly as before.
      ...(language !== LANGUAGES.ENGLISH ? { frequency_penalty: NON_ENGLISH_FREQUENCY_PENALTY } : {}),
    };
  }

  async function createCompletion(messages, log, language, maxTokens = MAX_OUTPUT_TOKENS) {
    const client = getClient();
    const extras = completionExtras(language);

    try {
      return await client.chat.completions.create(
        {
          model,
          temperature: TEMPERATURE,
          max_tokens: maxTokens,
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
          max_tokens: maxTokens,
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
  async function createCompletionStream(
    messages,
    log,
    onDelta,
    externalSignal,
    language,
    shouldStop,
    maxTokens = MAX_OUTPUT_TOKENS
  ) {
    const client = getClient();
    const extras = completionExtras(language);
    // Combined with the caller's own signal (typically tied to the HTTP
    // client disconnecting) when given, so either the configured hard
    // timeout or an early client disconnect ends the call — a disconnect
    // must free Ollama's single processing slot promptly rather than let an
    // abandoned generation keep running for nobody.
    const abortSignal = () =>
      externalSignal ? AbortSignal.any([requestTimeoutSignal(), externalSignal]) : requestTimeoutSignal();

    async function runStream(body) {
      // Started before create(): Ollama sends its response headers only once
      // the first token exists, so timing from after create() resolved always
      // measured ~0 ms and hid the prefill entirely.
      const streamStartedAt = Date.now();
      const stream = await client.chat.completions.create(
        { ...body, stream: true },
        { signal: abortSignal() }
      );

      let answer = "";
      let firstTokenMs = null;
      let usage;
      let finishReason = null;
      let stoppedEarly = false;

      for await (const part of stream) {
        const delta = part?.choices?.[0]?.delta?.content;
        if (part?.choices?.[0]?.finish_reason) finishReason = part.choices[0].finish_reason;
        if (delta) {
          if (firstTokenMs === null) firstTokenMs = Date.now() - streamStartedAt;
          answer += delta;
          onDelta(delta);
          // Leaving the loop closes the stream, which aborts the request, so
          // Ollama stops spending time on a looping answer.
          if (shouldStop?.(answer)) {
            stoppedEarly = true;
            break;
          }
        }
        // Present only if the provider opts in to a final usage-bearing chunk;
        // absent (usage stays undefined) is expected and handled the same way
        // completion?.usage already is on the non-streaming path.
        if (part?.usage) usage = part.usage;
      }

      // Every complete answer ends with a finish_reason ("stop", "length").
      // Without one the connection dropped mid-answer. Seen live when the
      // laptop slept mid-generation: the half sentence "…about taking that"
      // was returned as if it were the whole answer. Fail instead, so the
      // client shows an error with Retry rather than a silently cut answer.
      if (!stoppedEarly && finishReason === null && !externalSignal?.aborted) {
        throw upstreamError("The model's answer was cut off before it finished. Please try again.");
      }

      return { answer, firstTokenMs, usage };
    }

    try {
      return await runStream({ model, temperature: TEMPERATURE, max_tokens: maxTokens, ...extras, messages });
    } catch (error) {
      const unsupportedTemperature =
        error?.status === 400 && /temperature/i.test(error?.message ?? "");

      if (!unsupportedTemperature) throw error;

      log.warn("model rejected explicit temperature; retrying with model default", {
        model,
        temperature: TEMPERATURE,
      });

      return runStream({ model, max_tokens: maxTokens, ...extras, messages });
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
  async function prepareRequest(question, options, history, log) {
    // Checked before the cache and before retrieval: obvious small talk
    // ("hi", "thanks", "bye", …) needs neither — no embedding call, no
    // Qdrant search, no query expansion, no model call. Purely deterministic
    // pattern matching (conversationalIntentService.js), so this never
    // depends on `options` and never costs a round trip either way.
    const conversational = classifyConversational(question);
    if (conversational) {
      return { type: "conversational", result: { answer: conversational.answer, citations: [] } };
    }

    // English questions are retrieved exactly as asked. Only a question that
    // is in, or asks for, another language has its language wording removed
    // first, so "Consistency na enna?" is searched as "Consistency".
    const { language, explicit: explicitLanguage } = detectLanguage(question);
    const searchableQuestion =
      language === LANGUAGES.ENGLISH && !explicitLanguage ? question : toRetrievalQuery(question);
    const { followUp, retrievalQuery, promptHistory } = resolveFollowUp({
      question,
      retrievalQuery: searchableQuestion,
      history,
    });
    // A question with a recognised intent ("who wrote this book", in any
    // phrasing) is searched with that intent's own query and answered only
    // from passages that can be evidence for it.
    const previousQuestion = Array.isArray(history)
      ? history.filter((turn) => turn.role === "user").at(-1)?.content
      : undefined;
    const intent = detectIntent(question, { previousQuestion });
    const searchQuery = intent
      ? intent.retrievalQuery
      : searchableQuestion === question
        ? retrievalQuery
        : asSearchQuestion(retrievalQuery);
    const meta = {
      language,
      followUp,
      intent: intent?.name ?? null,
      maxOutputTokens: intent?.maxOutputTokens,
    };

    log.debug("[CHAT] question", {
      question,
      ...meta,
      retrievalQuery: searchQuery,
      historyTurns: promptHistory.length,
    });

    const key = cacheKey(question, options, promptHistory);
    const cached = cacheGet(key);
    if (cached) return { type: "cache_hit", result: cached, meta };

    const retrievalOptions =
      options.limit !== undefined
        ? options
        : intent
          ? // The intent query is already the ideal phrasing, so paraphrasing
            // it (one extra model call, ~5 s on CPU) can only add noise.
            { ...options, limit: INTENT_CANDIDATE_LIMIT, useQueryExpansion: false }
          : isAbstractQuestion(retrievalQuery)
            ? { ...options, limit: WIDER_EVIDENCE_LIMIT }
            : options;

    const { chunks: retrieved, timings } = await retriever.retrieve(searchQuery, retrievalOptions);
    let chunks = intent
      ? selectEvidence(intent, retrieved).slice(0, options.limit ?? config.retrieval.topK)
      : retrieved;

    // A translated Tanglish query is searched inside the "What does the book
    // say about: …" frame, and the frame alone resembles the book's own intro
    // pages, so an off-topic question can clear the score threshold on it
    // ("Pizza dough epdi pannanum?" scored 0.53 and got an invented answer).
    // Such a query must share at least one of its own content words (a
    // prefix, so "start" matches "started") with what was retrieved.
    const framed = !intent && searchQuery !== retrievalQuery;
    if (framed && chunks.length > 0) {
      const subjectStems = extractKeywords(retrievalQuery).map((keyword) =>
        keyword.slice(0, Math.max(5, keyword.length - 2))
      );
      const sharesSubject = (chunk) =>
        subjectStems.some((stem) => (chunk.pageContent ?? "").toLowerCase().includes(stem));
      if (subjectStems.length > 0 && !chunks.some(sharesSubject)) {
        log.debug("[RETRIEVAL] no retrieved chunk mentions the question's subject", { subjectStems });
        chunks = [];
      }
    }

    log.debug("[RETRIEVAL] results", {
      retrievalQuery: searchQuery,
      retrieved: describeChunks(retrieved),
      selectedChunkIds: chunks.map((chunk) => chunk.chunkId),
      ...(intent ? { droppedWithoutEvidence: retrieved.length - chunks.length } : {}),
    });

    const citations = chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      score: chunk.score,
      page: chunk.page,
      pageEnd: chunk.pageEnd,
    }));

    // Nothing cleared the score threshold, or nothing retrieved can be
    // evidence for the question's intent: answer with the exact fallback the
    // system prompt specifies rather than let the model guess from unrelated text.
    if (chunks.length === 0) {
      const noContextResult = { answer: noAnswerReply(language), citations: [] };
      return { type: "no_context", key, result: noContextResult, timings, meta };
    }

    // Negligible in practice (pure in-process string work), but measured
    // anyway so the per-stage log line accounts for the full request rather
    // than leaving an unexplained gap between retrieval and the model call.
    const promptBuildStartedAt = Date.now();
    const messages = buildMessages({
      question,
      chunks,
      history: promptHistory,
      language,
      explicitLanguage,
      answerInstruction: intent?.answerInstructions?.[language],
    });
    const promptBuildMs = Date.now() - promptBuildStartedAt;

    // Everything an answer may legitimately quote a figure from.
    const evidenceText = [
      question,
      ...chunks.map((chunk) => `${chunk.pageContent} page ${chunk.page} ${chunk.pageEnd}`),
    ].join("\n");

    log.debug("[CONTEXT] prompt built", {
      chunks: chunks.length,
      contextChars: messages.at(-1).content.length,
      historyMessages: promptHistory.length,
    });

    return { type: "needs_completion", key, citations, messages, timings, promptBuildMs, meta, evidenceText };
  }

  /**
   * Timing fields shared by every "chat request complete" line, so each
   * outcome logs the same stage breakdown. retrievalMs covers the query
   * embedding, every Qdrant search and query expansion.
   */
  function stageTimings(timings) {
    if (!timings) return {};
    return { ...timings, retrievalMs: timings.embedMs + timings.searchMs };
  }

  /**
   * A reply that is only the "not found" sentence cites nothing, whatever was
   * retrieved, so the UI doesn't show source badges under a non-answer.
   */
  function finalResult(answer, citations, language) {
    if (!answer) return { answer: noAnswerReply(language), citations: [] };
    return { answer, citations: isNoAnswerReply(answer) ? [] : citations };
  }

  /**
   * Single-turn RAG: retrieve context, build the prompt, call the model.
   *
   * @param {string} question
   * @param {object} [options] retrieval overrides (topK, threshold, filter, …)
   * @param {object} [context]
   * @param {Array<{role: string, content: string}>} [context.history] earlier
   *   turns; used only when the question is a follow-up (followUpService.js)
   * @returns {Promise<{answer: string, citations: Array<{chunkId: number, score: number}>}>}
   */
  async function ask(question, options = {}, { logger: requestLogger, history } = {}) {
    const log = requestLogger ?? logger;
    const startedAt = Date.now();

    log.info("chat request received", { questionLength: question.length });

    const prepared = await prepareRequest(question, options, history, log);

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
        ...prepared.meta,
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
        ...prepared.meta,
        retrievedChunks: 0,
        ...stageTimings(prepared.timings),
        gptMs: 0,
        totalMs: Date.now() - startedAt,
      });
      cacheSet(prepared.key, prepared.result);
      return prepared.result;
    }

    const { key, citations, messages, timings, promptBuildMs, meta } = prepared;

    const gptStartedAt = Date.now();
    let completion;
    try {
      completion = await createCompletion(messages, log, meta.language, meta.maxOutputTokens);
    } catch (error) {
      if (error instanceof AppError) throw error;

      throw upstreamError(
        `The language model request failed: ${error?.message ?? error}`,
        error
      );
    }
    const gptMs = Date.now() - gptStartedAt;

    const rawAnswer = completion?.choices?.[0]?.message?.content?.trim();
    const guarded = rawAnswer ? guardAnswer(rawAnswer, prepared.evidenceText, meta, question) : null;
    const answer = guarded?.answer;
    const result = finalResult(answer, citations, meta.language);

    log.debug("[ANSWER] final", {
      rawAnswer,
      answer: result.answer,
      guard: guarded?.guard ?? null,
      unsupported: guarded?.unsupported,
    });
    log.info("chat request complete", {
      outcome: !answer ? "empty_completion" : result.citations.length === 0 ? "declined" : "answered",
      ...meta,
      guard: guarded?.guard ?? null,
      model,
      retrievedChunks: citations.length,
      topScore: citations[0]?.score,
      ...stageTimings(timings),
      promptBuildMs,
      gptMs,
      totalMs: Date.now() - startedAt,
      usage: completion?.usage,
    });

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
   * arrived all at once." When the model's whole reply turns out to be the
   * "not found" sentence, `onCitations` fires a second time with `[]`.
   *
   * A disconnect (`signal` aborted) rethrows the abort error unwrapped, so
   * the caller can tell a cancelled request from a failed model call.
   *
   * @param {string} question
   * @param {object} [options]
   * @param {object} [callbacks]
   * @param {(citations: Array) => void} [callbacks.onCitations]
   * @param {(delta: string) => void} [callbacks.onDelta]
   * @param {Array<{role: string, content: string}>} [callbacks.history]
   * @returns {Promise<{answer: string, citations: Array<{chunkId: number, score: number}>}>}
   */
  async function askStream(
    question,
    options = {},
    { logger: requestLogger, onCitations, onDelta, onReplace, signal, history } = {}
  ) {
    const log = requestLogger ?? logger;
    const startedAt = Date.now();

    log.info("chat request received", { questionLength: question.length, stream: true });

    const prepared = await prepareRequest(question, options, history, log);

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
        ...prepared.meta,
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
        ...prepared.meta,
        retrievedChunks: 0,
        ...stageTimings(prepared.timings),
        gptMs: 0,
        totalMs: Date.now() - startedAt,
      });
      onCitations?.(prepared.result.citations);
      onDelta?.(prepared.result.answer);
      cacheSet(prepared.key, prepared.result);
      return prepared.result;
    }

    const { key, citations, messages, timings, promptBuildMs, meta } = prepared;
    onCitations?.(citations);

    const gptStartedAt = Date.now();
    let streamed;
    try {
      const checkPairs = meta.language !== LANGUAGES.ENGLISH;
      streamed = await createCompletionStream(
        messages,
        log,
        (delta) => onDelta?.(delta),
        signal,
        meta.language,
        (soFar) => repetitionStart(soFar, { checkPairs }) !== null,
        meta.maxOutputTokens
      );
    } catch (error) {
      if (signal?.aborted || error instanceof AppError) throw error;

      throw upstreamError(
        `The language model request failed: ${error?.message ?? error}`,
        error
      );
    }
    const gptMs = Date.now() - gptStartedAt;

    const rawAnswer = streamed.answer?.trim();
    const guarded = rawAnswer ? guardAnswer(rawAnswer, prepared.evidenceText, meta, question) : null;
    const answer = guarded?.answer;
    const result = finalResult(answer, citations, meta.language);

    log.debug("[ANSWER] final", {
      rawAnswer,
      answer: result.answer,
      guard: guarded?.guard ?? null,
      unsupported: guarded?.unsupported,
    });
    log.info("chat request complete", {
      outcome: !answer ? "empty_completion" : result.citations.length === 0 ? "declined" : "answered",
      stream: true,
      ...meta,
      guard: guarded?.guard ?? null,
      model,
      retrievedChunks: citations.length,
      topScore: citations[0]?.score,
      ...stageTimings(timings),
      promptBuildMs,
      gptMs,
      // Model call start -> first token: almost all of it is Ollama reading
      // the prompt (prefill), so this is what prompt size changes.
      firstTokenMs: streamed.firstTokenMs,
      // Request start -> first token: what the user actually waits.
      timeToFirstTokenMs:
        streamed.firstTokenMs === null ? null : gptStartedAt - startedAt + streamed.firstTokenMs,
      totalMs: Date.now() - startedAt,
      usage: streamed.usage,
    });

    // The stream produced nothing (mirrors ask()'s empty_completion path) — the
    // caller has received zero onDelta calls so far, so it still needs the
    // fallback text delivered exactly once, the same as every other path here.
    if (!answer) onDelta?.(result.answer);
    // The guard changed text the client has already shown: send the
    // corrected answer whole, to replace what was streamed.
    else if (result.answer !== rawAnswer) onReplace?.(result.answer);
    if (citations.length > 0 && result.citations.length === 0) onCitations?.([]);

    if (answer) cacheSet(key, result);
    return result;
  }

  /**
   * Ollama-only: callers gate on `config.llm.provider === "ollama"` (see
   * server.js). On OpenAI it would only spend a paid completion for nothing.
   *
   * Loads the model and pre-processes the prompt prefix every real request
   * shares, so the first real question after startup doesn't pay for either.
   * On CPU-only Ollama the ~1,000-token system prompt is roughly half of a
   * typical request's prompt, and Ollama reuses an already-processed prefix
   * only when it is byte-identical — hence the messages come from the same
   * `buildMessages` real requests use (the system message and the start of
   * the context block match exactly), with the same model and extras.
   * The reuse holds only while no chat call with a different prefix runs in
   * between (e.g. query expansion when RETRIEVAL_USE_QUERY_EXPANSION is on).
   * One output token: the point is the prefill, not an answer.
   */
  async function warmUp() {
    const messages = buildMessages({ question: "warm-up", chunks: [] });

    await getClient().chat.completions.create(
      {
        model,
        max_tokens: 1,
        ...completionExtras(),
        messages,
      },
      { signal: requestTimeoutSignal() }
    );
  }

  return { ask, askStream, warmUp, clearResponseCache: () => responseCache.clear() };
}

module.exports = { createChatService, CHAT_MODEL, TEMPERATURE };
