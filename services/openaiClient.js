const OpenAI = require("openai");

const { config } = require("../config/env");
const { configError } = require("../lib/errors");

let client = null;

/**
 * A FIFO queue that runs one task at a time, waiting for each to settle
 * (resolve or reject) before starting the next. Exported for unit testing in
 * isolation from the OpenAI SDK.
 */
function createQueue() {
  let tail = Promise.resolve();

  return function enqueue(task) {
    const result = tail.then(task, task);
    tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };
}

/**
 * Ollama runs on this machine's CPU with no GPU (see CLAUDE.md), so a chat
 * completion and an embedding call contend for the same cores if they overlap
 * — two browser tabs, a retry racing the original request, or a chat request
 * landing mid-`/index-book`. Measured effect: concurrent calls didn't just
 * queue politely, they measurably slowed each other down (embeddings that
 * normally take ~150ms took 6-7s) and pushed some requests straight past
 * OLLAMA_TIMEOUT_MS. Serializing every call through one queue removes that
 * thrashing — each request still takes as long as it would alone, but no
 * longer degrades further (or times out) under concurrent load. Mutates the
 * client's methods in place rather than wrapping it so callers, and the
 * `client.baseURL` test assertion, keep seeing the real client.
 */
function serializeOllamaClient(rawClient) {
  const enqueue = createQueue();
  const originalChatCreate = rawClient.chat.completions.create.bind(rawClient.chat.completions);
  const originalEmbeddingsCreate = rawClient.embeddings.create.bind(rawClient.embeddings);

  rawClient.chat.completions.create = (...args) => enqueue(() => originalChatCreate(...args));
  rawClient.embeddings.create = (...args) => enqueue(() => originalEmbeddingsCreate(...args));

  return rawClient;
}

/**
 * Single shared client for the whole app — embeddings and chat both use it, so
 * connections and keep-alive sockets are reused rather than rebuilt per
 * request. Built lazily so the server still boots without credentials.
 *
 * Doubles as the Ollama client: Ollama exposes an OpenAI-compatible surface
 * (/v1/chat/completions, /v1/embeddings), so pointing the same `openai` SDK at
 * its base URL is enough — no separate client implementation needed. Ollama
 * does not check the API key, so a placeholder is used.
 */
function getOpenAIClient() {
  if (client) return client;

  if (config.llm.provider === "ollama") {
    client = new OpenAI({
      apiKey: "ollama",
      baseURL: config.llm.baseUrl,
      timeout: config.llm.timeoutMs,
      maxRetries: 0,
    });

    // Only Ollama is CPU-bound and single-instance; a hosted OpenAI-compatible
    // endpoint is built for real concurrency, so it is left unserialized.
    serializeOllamaClient(client);

    return client;
  }

  if (!config.openai.apiKey) {
    throw configError("OPENAI_API_KEY is not set. Add it to .env before using the API.");
  }

  client = new OpenAI({
    apiKey: config.openai.apiKey,
    timeout: config.openai.timeoutMs,
    // Retries are handled in embeddingService with our own backoff policy;
    // letting the SDK retry as well would multiply the effective attempts.
    maxRetries: 0,
  });

  return client;
}

/** Test seam: injects a fake client, or resets with no argument. */
function setOpenAIClient(fake) {
  client = fake ?? null;
}

module.exports = { getOpenAIClient, setOpenAIClient, createQueue, serializeOllamaClient };
