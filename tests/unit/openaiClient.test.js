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

  it("wires the real Ollama client's create methods through serializeOllamaClient", () => {
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.LLM_PROVIDER = "ollama";
    process.env.OLLAMA_BASE_URL = "http://localhost:11434";

    try {
      const { getOpenAIClient } = freshClientModule();
      const client = getOpenAIClient();

      // An unwrapped client of the same class exposes the SDK's own method
      // (shared on the prototype). The wrapped client's own `create`
      // properties must have been reassigned to different function objects
      // by serializeOllamaClient, not left pointing at that same method.
      const OpenAI = require("openai");
      const unwrapped = new OpenAI({ apiKey: "ollama", baseURL: client.baseURL, maxRetries: 0 });

      assert.notEqual(client.chat.completions.create, unwrapped.chat.completions.create);
      assert.notEqual(client.embeddings.create, unwrapped.embeddings.create);
    } finally {
      delete process.env.LLM_PROVIDER;
      delete process.env.OLLAMA_BASE_URL;
      process.env.OPENAI_API_KEY = savedKey;
      freshClientModule();
    }
  });
});

describe("openaiClient — serializeOllamaClient", () => {
  it("runs a fake client's chat and embeddings calls one at a time, in call order", async () => {
    const { serializeOllamaClient } = freshClientModule();

    const order = [];
    const running = { count: 0, max: 0 };
    const stub = (label, ms) => async () => {
      running.count += 1;
      running.max = Math.max(running.max, running.count);
      await new Promise((resolve) => setTimeout(resolve, ms));
      running.count -= 1;
      order.push(label);
      return label;
    };

    const fakeClient = {
      chat: { completions: { create: stub("chat", 20) } },
      embeddings: { create: stub("embed", 5) },
    };

    const client = serializeOllamaClient(fakeClient);

    const results = await Promise.all([
      client.chat.completions.create(),
      client.embeddings.create(),
    ]);

    assert.deepEqual(results, ["chat", "embed"]);
    assert.deepEqual(order, ["chat", "embed"]);
    assert.equal(running.max, 1, "a second call must not start before the first settles");
  });
});

describe("openaiClient — createQueue", () => {
  it("runs tasks one at a time, in the order they were enqueued", async () => {
    const { createQueue } = freshClientModule();
    const enqueue = createQueue();

    const order = [];
    const task = (label, ms) => async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      order.push(label);
      return label;
    };

    const results = await Promise.all([
      enqueue(task("a", 15)),
      enqueue(task("b", 5)),
      enqueue(task("c", 1)),
    ]);

    assert.deepEqual(results, ["a", "b", "c"]);
    assert.deepEqual(order, ["a", "b", "c"]);
  });

  it("keeps running later tasks after an earlier one rejects", async () => {
    const { createQueue } = freshClientModule();
    const enqueue = createQueue();

    const failing = enqueue(async () => {
      throw new Error("boom");
    });
    const following = enqueue(async () => "ok");

    await assert.rejects(failing, /boom/);
    assert.equal(await following, "ok");
  });
});
