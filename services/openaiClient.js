const OpenAI = require("openai");

const { config } = require("../config/env");
const { configError } = require("../lib/errors");

let client = null;

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

module.exports = { getOpenAIClient, setOpenAIClient };
