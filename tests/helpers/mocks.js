/**
 * Fakes for the two external services. These stand in at the client boundary —
 * the same interface the real SDKs expose — so the service code under test
 * (batching, retry, sorting, error mapping) runs for real.
 */

const DIMENSIONS = 1536;

/** Deterministic pseudo-embedding: same text always yields the same vector. */
function fakeVector(seed, dimensions = DIMENSIONS) {
  const vector = new Array(dimensions);
  let value = 0;

  for (let i = 0; i < String(seed).length; i++) {
    value = (value * 31 + String(seed).charCodeAt(i)) % 1000;
  }

  for (let i = 0; i < dimensions; i++) {
    vector[i] = Math.sin(value + i) / 2;
  }

  return vector;
}

/**
 * Mock OpenAI client.
 *
 * @param {object} [options]
 * @param {Array}  [options.failures] errors thrown on the first N calls
 * @param {string} [options.answer]   chat completion content
 */
function createMockOpenAI({ failures = [], answer = "A mock answer." } = {}) {
  const calls = { embeddings: [], chat: [] };
  let embeddingCallCount = 0;

  return {
    calls,
    embeddings: {
      create: async (params) => {
        calls.embeddings.push(params);

        const failure = failures[embeddingCallCount];
        embeddingCallCount++;
        if (failure) throw failure;

        const inputs = Array.isArray(params.input) ? params.input : [params.input];

        // Returned deliberately out of order to prove the service re-sorts by index.
        const data = inputs.map((text, index) => ({
          index,
          embedding: fakeVector(text),
        }));

        return { data: data.slice().reverse(), model: params.model };
      },
    },
    chat: {
      completions: {
        create: async (params) => {
          calls.chat.push(params);
          return {
            choices: [{ message: { content: answer } }],
            usage: { total_tokens: 42 },
          };
        },
      },
    },
  };
}

/**
 * Mock Qdrant client covering the methods the service uses.
 */
function createMockQdrant({ existingCollections = [], points = [] } = {}) {
  const state = {
    collections: [...existingCollections],
    upserted: [],
    queries: [],
    indexes: [],
  };

  return {
    state,
    getCollections: async () => ({
      collections: state.collections.map((name) => ({ name })),
    }),
    getCollection: async (name) => ({
      config: { params: { vectors: { size: DIMENSIONS } } },
      name,
    }),
    createCollection: async (name) => {
      state.collections.push(name);
      return true;
    },
    createPayloadIndex: async (collection, params) => {
      state.indexes.push(params.field_name);
      return true;
    },
    upsert: async (collection, params) => {
      state.upserted.push(...params.points);
      return { status: "completed" };
    },
    query: async (collection, params) => {
      state.queries.push(params);
      return { points: points.slice(0, params.limit) };
    },
    count: async () => ({ count: state.upserted.length }),
  };
}

/** Collects log lines instead of writing them, for assertions in tests. */
function createTestLogger() {
  const lines = [];
  const record = (level) => (msg, fields) => lines.push({ level, msg, fields });

  const logger = {
    lines,
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    child: () => logger,
  };

  return logger;
}

module.exports = {
  createMockOpenAI,
  createMockQdrant,
  createTestLogger,
  fakeVector,
  DIMENSIONS,
};
