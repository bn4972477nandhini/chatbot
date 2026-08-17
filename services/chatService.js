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

      return client.chat.completions.create({ model, messages });
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

    const { chunks, timings } = await retriever.retrieve(question, options);

    const citations = chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      score: chunk.score,
    }));

    // Nothing cleared the score threshold — answer with the exact fallback the
    // system prompt specifies rather than spending a model call on empty context.
    if (chunks.length === 0) {
      log.info("chat request complete", {
        outcome: "no_context",
        retrievedChunks: 0,
        embedMs: timings.embedMs,
        searchMs: timings.searchMs,
        gptMs: 0,
        totalMs: Date.now() - startedAt,
      });

      return { answer: NO_ANSWER_REPLY, citations: [] };
    }

    const messages = buildMessages({ question, chunks });

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
      embedMs: timings.embedMs,
      searchMs: timings.searchMs,
      gptMs,
      totalMs: Date.now() - startedAt,
      usage: completion?.usage,
    });

    return { answer: answer || NO_ANSWER_REPLY, citations };
  }

  return { ask };
}

module.exports = { createChatService, CHAT_MODEL, TEMPERATURE };
