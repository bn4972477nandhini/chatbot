/**
 * warmUp() under the Ollama provider. config/env.js reads process.env once at
 * require time and tests/setup-env.js resolves the provider to openai, where
 * keep_alive is never sent — so this file (node --test runs each file in its
 * own process) pins the Ollama settings before any application module loads.
 * Without that, asserting that warm-up and real requests send the same
 * keep_alive/seed would only ever compare undefined with undefined.
 */
process.env.LLM_PROVIDER = "ollama";
process.env.OLLAMA_KEEP_ALIVE = "45m";
process.env.CHAT_SEED = "11";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { createChatService } = require("../../services/chatService");
const { CONTEXT_START } = require("../../services/promptService");
const { createMockOpenAI, createTestLogger } = require("../helpers/mocks");

describe("warmUp (ollama provider)", () => {
  it("sends the same keep_alive and seed as a real request, and a byte-identical prompt prefix", async () => {
    const openai = createMockOpenAI();
    const service = createChatService({
      retrievalService: {
        retrieve: async () => ({
          chunks: [{ chunkId: 1, score: 0.9, pageContent: "body", source: "Founder.pdf", page: 3, pageEnd: 3 }],
          timings: {},
        }),
      },
      getClient: () => openai,
      logger: createTestLogger(),
    });

    await service.warmUp();
    await service.ask("What is Zero Rupee Marketing?");

    const [warm, real] = openai.calls.chat;
    const sharedUserPrefix = `Context:\n\n${CONTEXT_START}\n`;

    assert.equal(warm.keep_alive, "45m");
    assert.equal(real.keep_alive, "45m");
    assert.equal(warm.seed, 11);
    assert.equal(real.seed, 11);
    assert.deepEqual(warm.messages[0], real.messages[0]);
    assert.ok(warm.messages[1].content.startsWith(sharedUserPrefix));
    assert.ok(real.messages[1].content.startsWith(sharedUserPrefix));
  });
});
