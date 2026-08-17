const assert = require("node:assert/strict");
const { after, before, describe, it } = require("node:test");

const { createApp } = require("../../app");
const { createTestLogger } = require("../helpers/mocks");

/**
 * API tests drive the real Express stack — middleware, validation, rate limits
 * and the error boundary — over real HTTP, with the services stubbed out.
 */
let server;
let baseUrl;
let chatCalls = [];
let indexBehaviour = async () => ({ totalChunks: 86, indexedChunks: 86 });

before(async () => {
  const app = createApp({
    chatService: {
      ask: async (question, options) => {
        chatCalls.push({ question, options });
        return {
          answer: "A mock answer.",
          citations: [{ chunkId: 12, score: 0.92 }],
        };
      },
    },
    indexBook: (...args) => indexBehaviour(...args),
    checkQdrant: async () => true,
    logger: createTestLogger(),
  });

  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
});

function post(path, body, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...options.headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /chat", () => {
  it("answers a valid question with the documented shape", async () => {
    const response = await post("/chat", { question: "What is Zero Rupee Marketing?" });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(body).sort(), ["answer", "citations"]);
    assert.equal(body.answer, "A mock answer.");
    assert.deepEqual(body.citations, [{ chunkId: 12, score: 0.92 }]);
  });

  it("trims the question before passing it on", async () => {
    chatCalls = [];
    await post("/chat", { question: "  padded  " });

    assert.equal(chatCalls[0].question, "padded");
  });

  it("rejects an empty body", async () => {
    const response = await post("/chat", {});
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.success, false);
    assert.match(body.error, /non-empty 'question'/);
  });

  it("rejects an empty question", async () => {
    assert.equal((await post("/chat", { question: "" })).status, 400);
  });

  it("rejects a whitespace-only question", async () => {
    assert.equal((await post("/chat", { question: "   " })).status, 400);
  });

  it("rejects a non-string question", async () => {
    assert.equal((await post("/chat", { question: 42 })).status, 400);
  });

  it("rejects an array body", async () => {
    assert.equal((await post("/chat", [1, 2])).status, 400);
  });

  it("rejects an over-long question", async () => {
    const response = await post("/chat", { question: "x".repeat(1001) });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.match(body.error, /1000 characters or fewer/);
  });

  it("rejects malformed JSON with a clean message", async () => {
    const response = await post("/chat", "{not json");
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error, "Request body must be valid JSON.");
  });

  it("accepts optional retrieval overrides", async () => {
    chatCalls = [];
    const response = await post("/chat", {
      question: "q",
      topK: 3,
      scoreThreshold: 0.5,
    });

    assert.equal(response.status, 200);
    assert.equal(chatCalls[0].options.limit, 3);
    assert.equal(chatCalls[0].options.scoreThreshold, 0.5);
  });

  it("rejects an out-of-range topK", async () => {
    assert.equal((await post("/chat", { question: "q", topK: 99 })).status, 400);
  });

  it("rejects an out-of-range scoreThreshold", async () => {
    assert.equal((await post("/chat", { question: "q", scoreThreshold: 5 })).status, 400);
  });

  it("never leaks a stack trace when the service throws", async () => {
    const app = createApp({
      chatService: {
        ask: async () => {
          throw new Error("internal detail: db password is hunter2");
        },
      },
      logger: createTestLogger(),
    });

    const isolated = app.listen(0);
    await new Promise((resolve) => isolated.once("listening", resolve));

    const response = await fetch(`http://127.0.0.1:${isolated.address().port}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "q" }),
    });
    const body = await response.json();

    assert.equal(response.status, 500);
    assert.equal(body.error, "Internal server error.");
    assert.ok(!JSON.stringify(body).includes("hunter2"));
    assert.ok(!JSON.stringify(body).includes("at "), "no stack frames");

    isolated.close();
  });
});

describe("POST /index-book", () => {
  it("returns the documented shape", async () => {
    indexBehaviour = async () => ({ totalChunks: 86, indexedChunks: 86 });

    const response = await post("/index-book", {});
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, { success: true, totalChunks: 86, indexedChunks: 86 });
  });

  it("reports a concurrent run as 409 rather than 500", async () => {
    const { conflict } = require("../../lib/errors");
    indexBehaviour = async () => {
      throw conflict("An indexing run is already in progress.");
    };

    const response = await post("/index-book", {});
    const body = await response.json();

    assert.equal(response.status, 409);
    assert.equal(body.success, false);
    assert.match(body.error, /already in progress/);
  });
});

describe("GET /health", () => {
  it("reports ok when dependencies are reachable", async () => {
    const response = await fetch(`${baseUrl}/health`);
    const body = await response.json();

    assert.equal(body.checks.qdrant, "ok");
    assert.ok(Number.isFinite(body.uptimeSeconds));
  });

  it("reports 503 and degraded when Qdrant is unreachable", async () => {
    const app = createApp({
      chatService: { ask: async () => ({ answer: "", citations: [] }) },
      checkQdrant: async () => {
        throw new Error("connection refused");
      },
      logger: createTestLogger(),
    });

    const isolated = app.listen(0);
    await new Promise((resolve) => isolated.once("listening", resolve));

    const response = await fetch(`http://127.0.0.1:${isolated.address().port}/health`);
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.status, "degraded");
    assert.equal(body.checks.qdrant, "unreachable");

    isolated.close();
  });
});

describe("security headers and unknown routes", () => {
  it("sets helmet headers and hides the framework", async () => {
    const response = await fetch(`${baseUrl}/health`);

    assert.equal(response.headers.get("x-powered-by"), null);
    assert.ok(response.headers.get("x-content-type-options"));
  });

  it("returns JSON, not HTML, for an unknown route", async () => {
    const response = await fetch(`${baseUrl}/nope`);
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.equal(body.success, false);
  });

  it("echoes a request id for correlation", async () => {
    const response = await fetch(`${baseUrl}/health`);
    assert.ok(response.headers.get("x-request-id"));
  });
});
