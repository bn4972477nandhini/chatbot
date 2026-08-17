const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { buildConfig } = require("../../config/env");

describe("buildConfig — LLM provider resolution", () => {
  it("defaults to the openai provider and its own models", () => {
    const config = buildConfig();

    assert.equal(config.llm.provider, "openai");
    assert.equal(config.llm.chatModel, config.openai.chatModel);
    assert.equal(config.llm.embeddingModel, config.openai.embeddingModel);
    assert.equal(config.llm.embeddingDimensions, config.openai.embeddingDimensions);
    assert.equal(config.llm.baseUrl, undefined);
  });

  it("resolves to Ollama's models and an OpenAI-compatible base URL when selected", () => {
    process.env.LLM_PROVIDER = "ollama";
    process.env.OLLAMA_BASE_URL = "http://localhost:11434";
    process.env.OLLAMA_LLM_MODEL = "llama3.2";
    process.env.OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";
    process.env.OLLAMA_EMBEDDING_DIMENSIONS = "768";

    try {
      const config = buildConfig();

      assert.equal(config.llm.provider, "ollama");
      assert.equal(config.llm.chatModel, "llama3.2");
      assert.equal(config.llm.embeddingModel, "nomic-embed-text");
      assert.equal(config.llm.embeddingDimensions, 768);
      assert.equal(config.llm.baseUrl, "http://localhost:11434/v1");
    } finally {
      delete process.env.LLM_PROVIDER;
      delete process.env.OLLAMA_BASE_URL;
      delete process.env.OLLAMA_LLM_MODEL;
      delete process.env.OLLAMA_EMBEDDING_MODEL;
      delete process.env.OLLAMA_EMBEDDING_DIMENSIONS;
    }
  });

  it("rejects an unknown LLM_PROVIDER value", () => {
    process.env.LLM_PROVIDER = "anthropic";

    try {
      assert.throws(() => buildConfig(), /LLM_PROVIDER must be one of/);
    } finally {
      delete process.env.LLM_PROVIDER;
    }
  });
});

describe("missingCredentials — provider-aware", () => {
  function freshEnvModule() {
    delete require.cache[require.resolve("../../config/env")];
    return require("../../config/env");
  }

  it("does not require OPENAI_API_KEY when LLM_PROVIDER is ollama", () => {
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.LLM_PROVIDER = "ollama";

    try {
      const { missingCredentials } = freshEnvModule();
      assert.ok(!missingCredentials().includes("OPENAI_API_KEY"));
    } finally {
      delete process.env.LLM_PROVIDER;
      process.env.OPENAI_API_KEY = savedKey;
      freshEnvModule();
    }
  });

  it("still requires OPENAI_API_KEY when LLM_PROVIDER is openai", () => {
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.LLM_PROVIDER = "openai";

    try {
      const { missingCredentials } = freshEnvModule();
      assert.ok(missingCredentials().includes("OPENAI_API_KEY"));
    } finally {
      delete process.env.LLM_PROVIDER;
      process.env.OPENAI_API_KEY = savedKey;
      freshEnvModule();
    }
  });

  it("always requires QDRANT_URL regardless of provider", () => {
    const savedUrl = process.env.QDRANT_URL;
    delete process.env.QDRANT_URL;

    try {
      const { missingCredentials } = freshEnvModule();
      assert.ok(missingCredentials().includes("QDRANT_URL"));
    } finally {
      process.env.QDRANT_URL = savedUrl;
      freshEnvModule();
    }
  });
});
