const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { createChatService } = require("../../services/chatService");
const { NO_ANSWER_REPLY } = require("../../services/promptService");
const { createMockOpenAI, createTestLogger } = require("../helpers/mocks");

const chunk = (chunkId, score) => ({
  chunkId,
  score,
  pageContent: `content ${chunkId}`,
  source: "Founder.pdf",
});

function build({ chunks = [chunk(12, 0.92)], client } = {}) {
  const openai = client ?? createMockOpenAI({ answer: "A mock answer." });
  const logger = createTestLogger();

  const service = createChatService({
    retrievalService: {
      retrieve: async () => ({ chunks, timings: { embedMs: 1, searchMs: 2 } }),
    },
    getClient: () => openai,
    logger,
  });

  return { service, openai, logger };
}

describe("chatService", () => {
  it("returns only answer and citations", async () => {
    const { service } = build();

    const result = await service.ask("What is X?");

    assert.deepEqual(Object.keys(result).sort(), ["answer", "citations"]);
  });

  it("shapes citations as chunkId and score", async () => {
    const { service } = build({ chunks: [chunk(12, 0.92), chunk(19, 0.81)] });

    const { citations } = await service.ask("q");

    assert.deepEqual(citations, [
      { chunkId: 12, score: 0.92 },
      { chunkId: 19, score: 0.81 },
    ]);
  });

  it("sends the configured model and temperature", async () => {
    const { service, openai } = build();

    await service.ask("q");

    assert.equal(openai.calls.chat[0].model, "gpt-5.5");
    assert.equal(openai.calls.chat[0].temperature, 0.2);
  });

  it("trims whitespace from the model's answer", async () => {
    const client = createMockOpenAI({ answer: "  spaced  " });
    const { service } = build({ client });

    assert.equal((await service.ask("q")).answer, "spaced");
  });

  it("returns the fallback and skips the model when no context is found", async () => {
    const { service, openai } = build({ chunks: [] });

    const result = await service.ask("unrelated");

    assert.equal(result.answer, NO_ANSWER_REPLY);
    assert.deepEqual(result.citations, []);
    assert.equal(openai.calls.chat.length, 0, "no model call on empty context");
  });

  it("falls back when the model returns an empty completion", async () => {
    const client = createMockOpenAI({ answer: "" });
    const { service } = build({ client });

    assert.equal((await service.ask("q")).answer, NO_ANSWER_REPLY);
  });

  it("retries without temperature when the model rejects it", async () => {
    const attempts = [];
    const client = {
      chat: {
        completions: {
          create: async (params) => {
            attempts.push(params);
            if ("temperature" in params) {
              throw Object.assign(
                new Error("Unsupported value: 'temperature' does not support 0.2"),
                { status: 400 }
              );
            }
            return { choices: [{ message: { content: "recovered" } }] };
          },
        },
      },
    };

    const { service } = build({ client });
    const result = await service.ask("q");

    assert.equal(result.answer, "recovered");
    assert.equal(attempts.length, 2);
    assert.ok(!("temperature" in attempts[1]));
  });

  it("propagates a non-temperature model failure", async () => {
    const client = {
      chat: {
        completions: {
          create: async () => {
            throw Object.assign(new Error("Invalid API key"), { status: 401 });
          },
        },
      },
    };

    const { service } = build({ client });
    await assert.rejects(() => service.ask("q"), /Invalid API key/);
  });

  it("logs retrieval and model durations", async () => {
    const { service, logger } = build();

    await service.ask("q");

    const completed = logger.lines.find((line) => line.msg === "chat request complete");
    assert.ok(completed, "a completion line is logged");
    assert.ok(Number.isFinite(completed.fields.gptMs));
    assert.ok(Number.isFinite(completed.fields.totalMs));
    assert.equal(completed.fields.embedMs, 1);
    assert.equal(completed.fields.searchMs, 2);
  });
});
