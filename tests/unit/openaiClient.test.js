const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

function freshClientModule() {
  delete require.cache[require.resolve("../../config/env")];
  delete require.cache[require.resolve("../../services/openaiClient")];
  return require("../../services/openaiClient");
}

describe("openaiClient — provider selection", () => {
  it("targets Ollama's OpenAI-compatible endpoint when LLM_PROVIDER=ollama, without an API key", () => {
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.LLM_PROVIDER = "ollama";
    process.env.OLLAMA_BASE_URL = "http://localhost:11434";

    try {
      const { getOpenAIClient } = freshClientModule();
      const client = getOpenAIClient();

      assert.equal(client.baseURL, "http://localhost:11434/v1");
    } finally {
      delete process.env.LLM_PROVIDER;
      delete process.env.OLLAMA_BASE_URL;
      process.env.OPENAI_API_KEY = savedKey;
      freshClientModule();
    }
  });

  it("still requires OPENAI_API_KEY when LLM_PROVIDER=openai", () => {
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.LLM_PROVIDER = "openai";

    try {
      const { getOpenAIClient } = freshClientModule();
      assert.throws(() => getOpenAIClient(), /OPENAI_API_KEY is not set/);
    } finally {
      delete process.env.LLM_PROVIDER;
      process.env.OPENAI_API_KEY = savedKey;
      freshClientModule();
    }
  });
});
