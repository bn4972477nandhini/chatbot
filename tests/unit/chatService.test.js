const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { createChatService } = require("../../services/chatService");
const { NO_ANSWER_REPLY, NO_ANSWER_REPLIES, CONTEXT_START } = require("../../services/promptService");
const { createMockOpenAI, createTestLogger } = require("../helpers/mocks");

const chunk = (chunkId, score, page = chunkId) => ({
  chunkId,
  score,
  pageContent: `content ${chunkId}`,
  source: "Founder.pdf",
  page,
  pageEnd: page,
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

/** A fake client whose chat.completions.create returns an async-iterable stream of chunks, mirroring the openai SDK's streaming shape. */
function createStreamingMockClient({ chunks = ["A mock", " answer."], usage, finished = true } = {}) {
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        create: async (params) => {
          calls.push(params);
          return {
            [Symbol.asyncIterator]: async function* () {
              for (const text of chunks) {
                yield { choices: [{ delta: { content: text } }] };
              }
              // A real stream's last chunk carries finish_reason; `finished:
              // false` simulates a connection that dropped mid-answer.
              if (finished) yield { choices: [{ delta: {}, finish_reason: "stop" }] };
              if (usage) yield { choices: [{ delta: {} }], usage };
            },
          };
        },
      },
    },
  };
}

describe("conversational shortcut", () => {
  it("ask() answers a greeting without retrieving or calling the model", async () => {
    let retrieveCalls = 0;
    const openai = createMockOpenAI({ answer: "should never be reached" });
    const service = createChatService({
      retrievalService: { retrieve: async () => { retrieveCalls++; return { chunks: [], timings: {} }; } },
      getClient: () => openai,
      logger: createTestLogger(),
    });

    const result = await service.ask("Hi");

    assert.equal(result.answer, "Hi! How can I help you?");
    assert.deepEqual(result.citations, []);
    assert.equal(retrieveCalls, 0, "no retrieval for obvious small talk");
    assert.equal(openai.calls.chat.length, 0, "no model call for obvious small talk");
  });

  it("askStream() delivers a greeting as a single onDelta with empty citations, no retrieval", async () => {
    let retrieveCalls = 0;
    const service = createChatService({
      retrievalService: { retrieve: async () => { retrieveCalls++; return { chunks: [], timings: {} }; } },
      getClient: () => { throw new Error("should never be reached"); },
      logger: createTestLogger(),
    });

    const deltas = [];
    const citationsSeen = [];
    const result = await service.askStream("Thank you", {}, {
      onCitations: (c) => citationsSeen.push(c),
      onDelta: (d) => deltas.push(d),
    });

    assert.equal(result.answer, "You're welcome!");
    assert.deepEqual(deltas, ["You're welcome!"]);
    assert.deepEqual(citationsSeen, [[]]);
    assert.equal(retrieveCalls, 0);
  });

  it("still runs the normal RAG pipeline for a real question, even one that starts with a greeting", async () => {
    let retrieveCalls = 0;
    const service = createChatService({
      retrievalService: {
        retrieve: async () => { retrieveCalls++; return { chunks: [chunk(12, 0.92)], timings: {} }; },
      },
      getClient: () => createMockOpenAI({ answer: "The author is Sakthivel Pannerselvam." }),
      logger: createTestLogger(),
    });

    const result = await service.ask("Hi, who is the author?");

    assert.equal(retrieveCalls, 1, "a real question must still go through retrieval");
    assert.equal(result.answer, "The author is Sakthivel Pannerselvam.");
  });
});

describe("wider-evidence routing for abstract/summary questions", () => {
  function buildWithLimitCapture() {
    const seenOptions = [];
    const service = createChatService({
      retrievalService: {
        retrieve: async (question, options) => {
          seenOptions.push(options);
          return { chunks: [chunk(12, 0.92)], timings: {} };
        },
      },
      getClient: () => createMockOpenAI({ answer: "An answer." }),
      logger: createTestLogger(),
    });
    return { service, seenOptions };
  }

  it("widens the limit for an abstract/summary question", async () => {
    const { service, seenOptions } = buildWithLimitCapture();
    await service.ask("Summarize the key ideas of the book.");
    assert.equal(seenOptions[0].limit, 7);
  });

  it("does not widen the limit for a multi-part (non-abstract) question", async () => {
    const { service, seenOptions } = buildWithLimitCapture();
    await service.ask("Who is the author and what is his profession?");
    assert.equal(seenOptions[0].limit, undefined);
  });

  it("does not widen the limit for an ordinary single-fact question", async () => {
    const { service, seenOptions } = buildWithLimitCapture();
    await service.ask("Where is the author based?");
    assert.equal(seenOptions[0].limit, undefined);
  });

  it("does not override a caller-supplied limit", async () => {
    const { service, seenOptions } = buildWithLimitCapture();
    await service.ask("Summarize the key ideas of the book.", { limit: 3 });
    assert.equal(seenOptions[0].limit, 3);
  });
});

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
      { chunkId: 12, score: 0.92, page: 12, pageEnd: 12 },
      { chunkId: 19, score: 0.81, page: 19, pageEnd: 19 },
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

  it("aborts a hung model call within the configured timeout instead of hanging indefinitely", async () => {
    // Never resolves or rejects on its own — models a genuinely hung upstream
    // request (the real incident this guards against: a request that took
    // ~27 minutes to fail despite a configured 180s timeout). Only settles
    // when the signal chatService passed in fires, so a pass here proves the
    // explicit per-request AbortSignal is what ends the call, not luck or
    // some other timeout path.
    const client = {
      chat: {
        completions: {
          create: (params, { signal }) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(new Error("The operation was aborted.")));
            }),
        },
      },
    };

    const service = createChatService({
      retrievalService: {
        retrieve: async () => ({ chunks: [chunk(12, 0.92)], timings: { embedMs: 1, searchMs: 2 } }),
      },
      getClient: () => client,
      logger: createTestLogger(),
      timeoutMs: 50,
    });

    const startedAt = Date.now();
    await assert.rejects(() => service.ask("q"));
    const elapsedMs = Date.now() - startedAt;

    assert.ok(
      elapsedMs < 2000,
      `expected the hung call to abort near the configured 50ms timeout, took ${elapsedMs}ms`
    );
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

  describe("response cache", () => {
    // General-purpose, keyed only on the literal question (+ options) — never
    // on any specific question's text or content, so this exercises the cache
    // mechanism itself, not a particular evaluation question.
    it("serves a repeated, identical question from cache without re-retrieving or re-calling the model", async () => {
      let retrieveCalls = 0;
      const openai = createMockOpenAI({ answer: "A mock answer." });
      const service = createChatService({
        retrievalService: {
          retrieve: async () => {
            retrieveCalls++;
            return { chunks: [chunk(12, 0.92)], timings: { embedMs: 1, searchMs: 2 } };
          },
        },
        getClient: () => openai,
        logger: createTestLogger(),
      });

      const first = await service.ask("What is X?");
      const second = await service.ask("What is X?");

      assert.deepEqual(second, first);
      assert.equal(retrieveCalls, 1, "retrieval only runs once");
      assert.equal(openai.calls.chat.length, 1, "the model is only called once");
    });

    it("does not serve a cached answer for a different question", async () => {
      const openai = createMockOpenAI({ answer: "A mock answer." });
      const service = createChatService({
        retrievalService: {
          retrieve: async () => ({ chunks: [chunk(12, 0.92)], timings: { embedMs: 1, searchMs: 2 } }),
        },
        getClient: () => openai,
        logger: createTestLogger(),
      });

      await service.ask("What is X?");
      await service.ask("What is Y?");

      assert.equal(openai.calls.chat.length, 2, "a genuinely different question is not a cache hit");
    });

    it("does not serve a cached answer when retrieval options differ", async () => {
      const openai = createMockOpenAI({ answer: "A mock answer." });
      const service = createChatService({
        retrievalService: {
          retrieve: async () => ({ chunks: [chunk(12, 0.92)], timings: { embedMs: 1, searchMs: 2 } }),
        },
        getClient: () => openai,
        logger: createTestLogger(),
      });

      await service.ask("q", { limit: 5 });
      await service.ask("q", { limit: 3 });

      assert.equal(openai.calls.chat.length, 2, "different options must not collide in the cache key");
    });

    it("does not cache an empty completion", async () => {
      const openai = createMockOpenAI({ answer: "" });
      const service = createChatService({
        retrievalService: {
          retrieve: async () => ({ chunks: [chunk(12, 0.92)], timings: { embedMs: 1, searchMs: 2 } }),
        },
        getClient: () => openai,
        logger: createTestLogger(),
      });

      await service.ask("q");
      await service.ask("q");

      assert.equal(openai.calls.chat.length, 2, "an empty completion is retried, not served from cache");
    });

    it("clearResponseCache empties the cache", async () => {
      let retrieveCalls = 0;
      const service = createChatService({
        retrievalService: {
          retrieve: async () => {
            retrieveCalls++;
            return { chunks: [chunk(12, 0.92)], timings: { embedMs: 1, searchMs: 2 } };
          },
        },
        getClient: () => createMockOpenAI({ answer: "A mock answer." }),
        logger: createTestLogger(),
      });

      await service.ask("q");
      service.clearResponseCache();
      await service.ask("q");

      assert.equal(retrieveCalls, 2, "a cleared cache is a fresh miss");
    });
  });

  describe("askStream", () => {
    it("delivers deltas in order and resolves with the full concatenated answer", async () => {
      const client = createStreamingMockClient({ chunks: ["A mock", " answer."] });
      const service = createChatService({
        retrievalService: {
          retrieve: async () => ({ chunks: [chunk(12, 0.92)], timings: { embedMs: 1, searchMs: 2 } }),
        },
        getClient: () => client,
        logger: createTestLogger(),
      });

      const deltas = [];
      const result = await service.askStream("q", {}, { onDelta: (d) => deltas.push(d) });

      assert.deepEqual(deltas, ["A mock", " answer."]);
      assert.equal(result.answer, "A mock answer.");
    });

    it("delivers citations before any delta — they depend only on retrieval, never on generation", async () => {
      const client = createStreamingMockClient({ chunks: ["answer"] });
      const service = createChatService({
        retrievalService: {
          retrieve: async () => ({ chunks: [chunk(12, 0.92)], timings: { embedMs: 1, searchMs: 2 } }),
        },
        getClient: () => client,
        logger: createTestLogger(),
      });

      const order = [];
      await service.askStream("q", {}, {
        onCitations: (c) => order.push({ type: "citations", value: c }),
        onDelta: (d) => order.push({ type: "delta", value: d }),
      });

      assert.equal(order[0].type, "citations");
      assert.deepEqual(order[0].value, [{ chunkId: 12, score: 0.92, page: 12, pageEnd: 12 }]);
      assert.equal(order[1].type, "delta");
    });

    it("delivers the exact fallback via a single onDelta call, and empty citations, when no context is found", async () => {
      const client = createStreamingMockClient({ chunks: ["should never be reached"] });
      const service = createChatService({
        retrievalService: { retrieve: async () => ({ chunks: [], timings: {} }) },
        getClient: () => client,
        logger: createTestLogger(),
      });

      const deltas = [];
      const citationsSeen = [];
      const result = await service.askStream("unrelated", {}, {
        onCitations: (c) => citationsSeen.push(c),
        onDelta: (d) => deltas.push(d),
      });

      assert.deepEqual(deltas, [NO_ANSWER_REPLY]);
      assert.deepEqual(citationsSeen, [[]]);
      assert.equal(result.answer, NO_ANSWER_REPLY);
      assert.equal(client.calls.length, 0, "no model call on empty context, same as ask()");
    });

    it("serves a cache hit (populated by a prior ask() or askStream() call) as a single onDelta with the whole cached answer", async () => {
      const client = createStreamingMockClient({ chunks: ["fresh", " answer"] });
      const service = createChatService({
        retrievalService: {
          retrieve: async () => ({ chunks: [chunk(12, 0.92)], timings: { embedMs: 1, searchMs: 2 } }),
        },
        getClient: () => client,
        logger: createTestLogger(),
      });

      await service.askStream("q");
      const deltas = [];
      const result = await service.askStream("q", {}, { onDelta: (d) => deltas.push(d) });

      assert.equal(client.calls.length, 1, "the second, identical question is a cache hit — no second model call");
      assert.deepEqual(deltas, ["fresh answer"]);
      assert.equal(result.answer, "fresh answer");
    });

    it("aborts a hung streaming call within the configured timeout instead of hanging indefinitely", async () => {
      // Never yields — models a genuinely hung upstream request (the real
      // incident this guards against). Only settles when the signal
      // askStream passed in fires, proving the abort is what ends the call.
      const client = {
        chat: {
          completions: {
            create: (params, { signal }) => {
              const stream = {
                [Symbol.asyncIterator]: () => ({
                  next: () =>
                    new Promise((_resolve, reject) => {
                      signal.addEventListener("abort", () => reject(new Error("The operation was aborted.")));
                    }),
                }),
              };
              return Promise.resolve(stream);
            },
          },
        },
      };

      const service = createChatService({
        retrievalService: {
          retrieve: async () => ({ chunks: [chunk(12, 0.92)], timings: { embedMs: 1, searchMs: 2 } }),
        },
        getClient: () => client,
        logger: createTestLogger(),
        timeoutMs: 50,
      });

      const startedAt = Date.now();
      await assert.rejects(() => service.askStream("q"));
      const elapsedMs = Date.now() - startedAt;

      assert.ok(
        elapsedMs < 2000,
        `expected the hung stream to abort near the configured 50ms timeout, took ${elapsedMs}ms`
      );
    });

    it("caches the streamed answer so a later ask() call is served from cache too", async () => {
      const client = createStreamingMockClient({ chunks: ["shared", " cache"] });
      const service = createChatService({
        retrievalService: {
          retrieve: async () => ({ chunks: [chunk(12, 0.92)], timings: { embedMs: 1, searchMs: 2 } }),
        },
        getClient: () => client,
        logger: createTestLogger(),
      });

      const streamed = await service.askStream("q");
      const buffered = await service.ask("q");

      assert.equal(client.calls.length, 1, "ask() after askStream() for the same question is a cache hit");
      assert.deepEqual(buffered, streamed);
    });
  });
});

describe("warmUp", () => {
  it("requests a single token and never touches retrieval", async () => {
    let retrieved = false;
    const openai = createMockOpenAI();
    const service = createChatService({
      retrievalService: {
        retrieve: async () => {
          retrieved = true;
          return { chunks: [], timings: {} };
        },
      },
      getClient: () => openai,
      logger: createTestLogger(),
    });

    await service.warmUp();

    assert.equal(openai.calls.chat.length, 1);
    assert.equal(openai.calls.chat[0].max_tokens, 1);
    assert.equal(retrieved, false);
  });

  // keep_alive/seed equality is asserted in chatServiceWarmupOllama.test.js,
  // where the Ollama provider actually sends them.
  it("shares the real request's system message, prompt prefix and model, so Ollama can reuse the prefill", async () => {
    const { service, openai } = build();

    await service.warmUp();
    await service.ask("What is Zero Rupee Marketing?");

    const [warm, real] = openai.calls.chat;
    const contextPrefix = `Context:\n\n${CONTEXT_START}\n`;

    assert.equal(warm.model, real.model);
    assert.deepEqual(warm.messages[0], real.messages[0]);
    assert.equal(warm.messages[0].role, "system");
    assert.ok(warm.messages[1].content.startsWith(contextPrefix));
    assert.ok(real.messages[1].content.startsWith(contextPrefix));
  });

  it("propagates a client failure so the caller can log it", async () => {
    const openai = createMockOpenAI();
    openai.chat.completions.create = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const { service } = build({ client: openai });

    await assert.rejects(service.warmUp(), /ECONNREFUSED/);
  });
});

describe("language handling", () => {
  function buildRecording({ chunks = [chunk(12, 0.92)], client } = {}) {
    const openai = client ?? createMockOpenAI({ answer: "A mock answer." });
    const retrieved = [];
    const service = createChatService({
      retrievalService: {
        retrieve: async (question) => {
          retrieved.push(question);
          return { chunks, timings: { embedMs: 1, searchMs: 2 } };
        },
      },
      getClient: () => openai,
      logger: createTestLogger(),
    });
    return { service, openai, retrieved };
  }

  it("retrieves an English question exactly as asked", async () => {
    const { service, retrieved } = buildRecording();

    await service.ask("Explain the balloon campaign");

    assert.deepEqual(retrieved, ["Explain the balloon campaign"]);
  });

  it("retrieves a Tanglish question by its subject and asks for a Tanglish answer", async () => {
    const { service, openai, retrieved } = buildRecording({
      chunks: [{ ...chunk(12, 0.92), pageContent: "Consistency is about showing up daily." }],
    });

    await service.ask("Consistency na enna?");

    assert.deepEqual(retrieved, ["What does the book say about: Consistency"]);
    const userContent = openai.calls.chat[0].messages.at(-1).content;
    assert.ok(userContent.includes("User Question:\n\nConsistency na enna?"));
    assert.match(userContent, /Answer language: casual Tanglish/);
  });

  it("answers the no-context fallback in Tanglish for a Tanglish question", async () => {
    const { service } = buildRecording({ chunks: [] });

    const result = await service.ask("Pizza dough epdi pannanum?");

    assert.equal(result.answer, NO_ANSWER_REPLIES.tanglish);
    assert.deepEqual(result.citations, []);
  });
});

describe("follow-up questions", () => {
  const history = [
    { role: "user", content: "What is Zero Rupee Marketing?" },
    { role: "assistant", content: "It is guerrilla marketing on almost no budget." },
  ];

  it("searches with the previous question and puts the last exchange before the question", async () => {
    const retrieved = [];
    const openai = createMockOpenAI();
    const service = createChatService({
      retrievalService: {
        retrieve: async (question) => {
          retrieved.push(question);
          return { chunks: [chunk(12, 0.92)], timings: { embedMs: 1, searchMs: 2 } };
        },
      },
      getClient: () => openai,
      logger: createTestLogger(),
    });

    await service.ask("Why is it useful?", {}, { history });

    assert.deepEqual(retrieved, ["What is Zero Rupee Marketing? Why is it useful?"]);
    const roles = openai.calls.chat[0].messages.map((message) => message.role);
    assert.deepEqual(roles, ["system", "user", "assistant", "user"]);
  });

  it("sends no history with a standalone question, so the prompt stays as short as before", async () => {
    const { service, openai } = build();

    await service.ask("Who wrote the foreword?", {}, { history });

    assert.equal(openai.calls.chat[0].messages.length, 2);
  });

  it("does not serve a standalone answer from cache for the same words asked as a follow-up", async () => {
    const { service, openai } = build();

    await service.ask("Why is it useful?");
    await service.ask("Why is it useful?", {}, { history });

    assert.equal(openai.calls.chat.length, 2);
  });
});

describe("declined answers", () => {
  it("drops citations when the model's whole reply is the fallback sentence", async () => {
    const { service } = build({ client: createMockOpenAI({ answer: NO_ANSWER_REPLY }) });

    const result = await service.ask("What was spent on the salon campaign?");

    assert.equal(result.answer, NO_ANSWER_REPLY);
    assert.deepEqual(result.citations, []);
  });

  it("keeps citations on a real answer that merely mentions the book", async () => {
    const { service } = build({
      chunks: [{ ...chunk(12, 0.92), pageContent: "The spend was Rs.6000." }],
      client: createMockOpenAI({ answer: "The Founder Book says the spend was Rs.6000." }),
    });

    const result = await service.ask("q");

    assert.equal(result.citations.length, 1);
  });

  it("askStream clears the already-sent citations once the reply turns out to be the fallback", async () => {
    const client = createStreamingMockClient({ chunks: [NO_ANSWER_REPLY] });
    const service = createChatService({
      retrievalService: {
        retrieve: async () => ({ chunks: [chunk(12, 0.92)], timings: { embedMs: 1, searchMs: 2 } }),
      },
      getClient: () => client,
      logger: createTestLogger(),
    });

    const citationEvents = [];
    const result = await service.askStream("q", {}, { onCitations: (c) => citationEvents.push(c) });

    assert.equal(citationEvents.length, 2);
    assert.equal(citationEvents[0].length, 1);
    assert.deepEqual(citationEvents[1], []);
    assert.deepEqual(result.citations, []);
  });
});

describe("askStream timing and cancellation", () => {
  it("measures time to first token from when the model call starts, including prefill", async () => {
    const client = createStreamingMockClient({ chunks: ["answer"] });
    const originalCreate = client.chat.completions.create;
    client.chat.completions.create = async (params) => {
      // Ollama answers the HTTP request only once the first token exists.
      await new Promise((resolve) => setTimeout(resolve, 30));
      return originalCreate(params);
    };
    const logger = createTestLogger();
    const service = createChatService({
      retrievalService: {
        retrieve: async () => ({ chunks: [chunk(12, 0.92)], timings: { embedMs: 1, searchMs: 2 } }),
      },
      getClient: () => client,
      logger,
    });

    await service.askStream("q");

    const complete = logger.lines.find((line) => line.msg === "chat request complete");
    assert.ok(complete.fields.firstTokenMs >= 25, `firstTokenMs was ${complete.fields.firstTokenMs}`);
    assert.ok(complete.fields.timeToFirstTokenMs >= complete.fields.firstTokenMs);
    assert.equal(complete.fields.retrievalMs, 3);
  });

  it("rethrows the abort itself, not a 502, when the client disconnects", async () => {
    const controller = new AbortController();
    const client = {
      chat: {
        completions: {
          create: async (params, { signal }) => {
            controller.abort();
            throw signal.reason ?? new Error("aborted");
          },
        },
      },
    };
    const service = createChatService({
      retrievalService: {
        retrieve: async () => ({ chunks: [chunk(12, 0.92)], timings: { embedMs: 1, searchMs: 2 } }),
      },
      getClient: () => client,
      logger: createTestLogger(),
    });

    await assert.rejects(
      () => service.askStream("q", {}, { signal: controller.signal }),
      (error) => error?.status !== 502
    );
  });
});

describe("repetition penalty", () => {
  it("is sent for a Tanglish answer and never for an English one", async () => {
    const { service, openai } = build({
      chunks: [{ ...chunk(12, 0.92), pageContent: "Zero Rupee Marketing means marketing on no budget." }],
    });

    await service.ask("What is Zero Rupee Marketing?");
    await service.ask("Zero Rupee Marketing na enna?");

    assert.equal(openai.calls.chat[0].frequency_penalty, undefined);
    assert.equal(openai.calls.chat[1].frequency_penalty, 0.6);
  });
});

describe("author-identity questions", () => {
  const authorChunk = { ...chunk(0, 0.49), pageContent: "© John Doe Author: John Doe First Edition" };
  const editorChunk = { ...chunk(1, 0.62), pageContent: "Thanks Jane Roe, Editor, Author & Content Writer." };
  const unrelated = { ...chunk(6, 0.52), pageContent: "An Outlier Marketer convinces a small segment." };

  function buildIntent(chunks) {
    const retrieved = [];
    const openai = createMockOpenAI({ answer: "Indha book-oda writer John Doe." });
    const service = createChatService({
      retrievalService: {
        retrieve: async (query, options) => {
          retrieved.push({ query, options });
          return { chunks, timings: { embedMs: 1, searchMs: 2 } };
        },
      },
      getClient: () => openai,
      logger: createTestLogger(),
    });
    return { service, openai, retrieved };
  }

  it("searches with the intent's query and sends only passages about authorship, explicit line first", async () => {
    const { service, openai, retrieved } = buildIntent([editorChunk, unrelated, authorChunk]);

    const result = await service.ask("intha book writer yaru");

    assert.equal(retrieved[0].query, "Who is the author of this book? Who wrote this book?");
    assert.deepEqual(result.citations.map((c) => c.chunkId), [0, 1]);
    const context = openai.calls.chat[0].messages.at(-1).content;
    assert.ok(!context.includes("Outlier Marketer"), "the unrelated passage is not in the prompt");
  });

  it("declines without calling the model when no passage mentions authorship", async () => {
    const { service, openai } = buildIntent([unrelated]);

    const result = await service.ask("intha book writer yaru");

    assert.equal(result.answer, NO_ANSWER_REPLIES.tanglish);
    assert.deepEqual(result.citations, []);
    assert.equal(openai.calls.chat.length, 0);
  });
});

describe("answer checks", () => {
  it("replaces an answer that states a figure the context never gives", async () => {
    const { service } = build({ client: createMockOpenAI({ answer: "The campaign cost Rs.9999." }) });

    const result = await service.ask("How much did the campaign cost?");

    assert.equal(result.answer, NO_ANSWER_REPLY);
    assert.deepEqual(result.citations, []);
  });

  it("keeps an answer whose figures are all in the context", async () => {
    const { service } = build({
      chunks: [{ ...chunk(3, 0.9), pageContent: "The campaign cost Rs.6,000." }],
      client: createMockOpenAI({ answer: "The campaign cost Rs.6000." }),
    });

    const result = await service.ask("How much did the campaign cost?");

    assert.equal(result.answer, "The campaign cost Rs.6000.");
  });

  it("askStream stops a looping Tanglish answer and sends the trimmed text as a replacement", async () => {
    const loop = ["Sakthi a DOER, ayan irukkenga.", " Book writer yaru, ayan irukkenga.", " Sakthi, ayan irukkenga.", " More, ayan irukkenga.", " never sent"];
    const client = createStreamingMockClient({ chunks: loop });
    const service = createChatService({
      retrievalService: {
        retrieve: async () => ({
          chunks: [{ ...chunk(12, 0.92), pageContent: "Zero Rupee Marketing means marketing on no budget." }],
          timings: { embedMs: 1, searchMs: 2 },
        }),
      },
      getClient: () => client,
      logger: createTestLogger(),
    });

    const deltas = [];
    const replacements = [];
    const result = await service.askStream("Zero Rupee Marketing na enna?", {}, {
      onDelta: (d) => deltas.push(d),
      onReplace: (a) => replacements.push(a),
    });

    assert.ok(!deltas.includes(" never sent"), "generation stops once the loop is detected");
    assert.deepEqual(replacements, ["Sakthi a DOER, ayan irukkenga."]);
    assert.equal(result.answer, "Sakthi a DOER, ayan irukkenga.");
  });
});

describe("author-identity answer shape", () => {
  it("caps the output, asks for one sentence and drops an unasked second paragraph", async () => {
    const openai = createMockOpenAI({ answer: "Indha book-oda writer John Doe.\n\nAvaru amma & appa ezhuthi." });
    const service = createChatService({
      retrievalService: {
        retrieve: async () => ({
          chunks: [{ ...chunk(0, 0.5), pageContent: "Author: John Doe" }],
          timings: { embedMs: 1, searchMs: 2 },
        }),
      },
      getClient: () => openai,
      logger: createTestLogger(),
    });

    const result = await service.ask("intha book writer yaru");

    assert.equal(result.answer, "Indha book-oda writer John Doe.");
    assert.equal(openai.calls.chat[0].max_tokens, 40);
    assert.match(openai.calls.chat[0].messages.at(-1).content, /Indha book-oda writer <name>/);
  });
});

describe("interrupted streams", () => {
  it("fails, rather than returning a half answer, when the stream ends without a finish_reason", async () => {
    const client = createStreamingMockClient({ chunks: ["According to Sakthi, starting a business is about taking that"], finished: false });
    const service = createChatService({
      retrievalService: {
        retrieve: async () => ({ chunks: [chunk(12, 0.92)], timings: { embedMs: 1, searchMs: 2 } }),
      },
      getClient: () => client,
      logger: createTestLogger(),
    });

    await assert.rejects(() => service.askStream("q"), /cut off/);
  });
});

describe("off-topic Tanglish questions", () => {
  it("declines without a model call when no retrieved chunk mentions the translated subject", async () => {
    const openai = createMockOpenAI();
    const service = createChatService({
      retrievalService: {
        retrieve: async () => ({
          chunks: [{ ...chunk(7, 0.53), pageContent: "This book is about guerrilla marketing." }],
          timings: { embedMs: 1, searchMs: 2 },
        }),
      },
      getClient: () => openai,
      logger: createTestLogger(),
    });

    const result = await service.ask("Pizza dough epdi pannanum?");

    assert.equal(result.answer, NO_ANSWER_REPLIES.tanglish);
    assert.equal(openai.calls.chat.length, 0);
  });

  it("answers when a retrieved chunk does mention it", async () => {
    const openai = createMockOpenAI({ answer: "Business start panna risk edukkanum." });
    const service = createChatService({
      retrievalService: {
        retrieve: async () => ({
          chunks: [{ ...chunk(5, 0.6), pageContent: "Starting a business takes the ability to take risk." }],
          timings: { embedMs: 1, searchMs: 2 },
        }),
      },
      getClient: () => openai,
      logger: createTestLogger(),
    });

    const result = await service.ask("business start panna enna mindset venum?");

    assert.equal(openai.calls.chat.length, 1);
    assert.equal(result.citations.length, 1);
  });
});
