/**
 * Central environment parsing and validation.
 *
 * Values are read once and validated eagerly so a misconfigured deployment fails
 * at boot with a precise message, instead of surfacing as a confusing runtime
 * error on the first request. Secrets are never logged.
 */

function readInt(name, fallback, { min, max }) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be an integer, received "${raw}".`);
  }
  if (value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}, received ${value}.`);
  }
  return value;
}

function readFloat(name, fallback, { min, max }) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;

  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a number, received "${raw}".`);
  }
  if (value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}, received ${value}.`);
  }
  return value;
}

function readString(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

function buildConfig() {
  const config = {
    nodeEnv: readString("NODE_ENV", "development"),
    port: readInt("PORT", 3000, { min: 1, max: 65535 }),
    logLevel: readString("LOG_LEVEL", "info"),

    openai: {
      apiKey: readString("OPENAI_API_KEY", ""),
      chatModel: readString("CHAT_MODEL", "gpt-5.5"),
      embeddingModel: readString("EMBEDDING_MODEL", "text-embedding-3-small"),
      // text-embedding-3-small produces 1536-dim vectors.
      embeddingDimensions: readInt("EMBEDDING_DIMENSIONS", 1536, { min: 1, max: 8192 }),
      temperature: readFloat("CHAT_TEMPERATURE", 0.2, { min: 0, max: 2 }),
      timeoutMs: readInt("OPENAI_TIMEOUT_MS", 60_000, { min: 1_000, max: 600_000 }),
    },

    qdrant: {
      url: readString("QDRANT_URL", ""),
      apiKey: readString("QDRANT_API_KEY", ""),
      collection: readString("QDRANT_COLLECTION", "founder_book"),
      timeoutMs: readInt("QDRANT_TIMEOUT_MS", 20_000, { min: 1_000, max: 600_000 }),
    },

    retrieval: {
      topK: readInt("RETRIEVAL_TOP_K", 5, { min: 1, max: 50 }),
      scoreThreshold: readFloat("RETRIEVAL_SCORE_THRESHOLD", 0.65, { min: 0, max: 1 }),
      // MMR re-ranks a wider candidate pool down to topK for diversity.
      useMmr: readString("RETRIEVAL_USE_MMR", "true") !== "false",
      mmrLambda: readFloat("RETRIEVAL_MMR_LAMBDA", 0.7, { min: 0, max: 1 }),
      mmrPoolMultiplier: readInt("RETRIEVAL_MMR_POOL_MULTIPLIER", 4, { min: 1, max: 20 }),
    },

    limits: {
      // Upper bound on a question, in characters. Caps token spend per request
      // and blocks context-stuffing attempts.
      maxQuestionLength: readInt("MAX_QUESTION_LENGTH", 1_000, { min: 1, max: 20_000 }),
      jsonBodyBytes: readInt("MAX_BODY_BYTES", 16 * 1024, { min: 256, max: 5 * 1024 * 1024 }),
      chatRateLimitWindowMs: readInt("CHAT_RATE_WINDOW_MS", 60_000, { min: 1_000, max: 3_600_000 }),
      chatRateLimitMax: readInt("CHAT_RATE_MAX", 20, { min: 1, max: 10_000 }),
      indexRateLimitWindowMs: readInt("INDEX_RATE_WINDOW_MS", 3_600_000, { min: 1_000, max: 86_400_000 }),
      indexRateLimitMax: readInt("INDEX_RATE_MAX", 5, { min: 1, max: 1_000 }),
    },

    chunking: {
      chunkSize: readInt("CHUNK_SIZE", 1000, { min: 100, max: 8000 }),
      chunkOverlap: readInt("CHUNK_OVERLAP", 200, { min: 0, max: 4000 }),
    },
  };

  if (config.chunking.chunkOverlap >= config.chunking.chunkSize) {
    throw new Error("CHUNK_OVERLAP must be smaller than CHUNK_SIZE.");
  }

  return config;
}

const config = buildConfig();

/**
 * Credentials are validated separately from shape: the server must still boot
 * without them so /health and /read-pdf work, but the routes that need them
 * should fail with a clear message.
 *
 * @returns {string[]} names of missing required variables
 */
function missingCredentials() {
  const missing = [];
  if (!config.openai.apiKey) missing.push("OPENAI_API_KEY");
  if (!config.qdrant.url) missing.push("QDRANT_URL");
  return missing;
}

const isProduction = config.nodeEnv === "production";

module.exports = { config, missingCredentials, isProduction, buildConfig };
