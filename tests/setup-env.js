/**
 * Deterministic environment for tests.
 *
 * config/env.js reads process.env once at require time, so these must be set
 * before any application module loads — the test scripts wire this in with
 * `node --test --require`.
 *
 * The values are placeholders: every test injects mock clients, so no request
 * ever leaves the process.
 */
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL || "silent";

process.env.OPENAI_API_KEY = "sk-test-key-not-real";
process.env.QDRANT_URL = "http://localhost:6333";
process.env.QDRANT_COLLECTION = "test_collection";

// Pinned so assertions about defaults do not depend on a developer's .env.
process.env.CHAT_MODEL = "gpt-5.5";
process.env.CHAT_TEMPERATURE = "0.2";
process.env.RETRIEVAL_TOP_K = "5";
process.env.RETRIEVAL_SCORE_THRESHOLD = "0.65";
process.env.RETRIEVAL_MMR_POOL_MULTIPLIER = "4";
process.env.MAX_QUESTION_LENGTH = "1000";

// Rate limits are raised so functional assertions are not throttled; the limiter
// itself is covered by a dedicated test that builds its own app.
process.env.CHAT_RATE_MAX = "10000";
process.env.INDEX_RATE_MAX = "1000";
