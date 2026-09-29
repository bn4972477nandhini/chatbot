const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { createEmbeddingService } = require("../../services/embeddingService");
const { createMockOpenAI, DIMENSIONS } = require("../helpers/mocks");

function build(options) {
  const client = createMockOpenAI(options);
  const service = createEmbeddingService({ getClient: () => client });
  return { client, service };
}

describe("embeddingService", () => {
  it("returns one vector per input", async () => {
    const { service } = build();
    const vectors = await service.embedTexts(["a", "b", "c"]);

    assert.equal(vectors.length, 3);
    assert.equal(vectors[0].length, DIMENSIONS);
  });

  it("realigns out-of-order API results with their inputs", async () => {
    const { service } = build();

    // The mock deliberately returns results reversed.
    const [first] = await service.embedTexts(["alpha", "beta"]);
    const [alphaAlone] = await service.embedTexts(["alpha"]);

    assert.deepEqual(first, alphaAlone, "vector stays attached to its own text");
  });

  it("batches inputs beyond the batch size", async () => {
    const { client, service } = build();
    const inputs = Array.from({ length: 200 }, (_, i) => `chunk ${i}`);

    const vectors = await service.embedTexts(inputs);

    assert.equal(vectors.length, 200);
    assert.equal(client.calls.embeddings.length, 3, "200 inputs span 3 batches of 96");
  });

  it("rejects empty input arrays", async () => {
    const { service } = build();
    await assert.rejects(() => service.embedTexts([]), /non-empty array/);
  });

  it("rejects a blank string among the inputs", async () => {
    const { service } = build();
    await assert.rejects(() => service.embedTexts(["ok", "   "]), /index 1/);
  });

  it("retries a 429 and then succeeds", async () => {
    const rateLimit = Object.assign(new Error("Rate limited"), { status: 429 });
    const { client, service } = build({ failures: [rateLimit] });

    const vectors = await service.embedTexts(["a"]);

    assert.equal(vectors.length, 1);
    assert.equal(client.calls.embeddings.length, 2, "one retry after the 429");
  });

  it("does not retry a 401", async () => {
    const unauthorised = Object.assign(new Error("Bad key"), { status: 401 });
    const { client, service } = build({ failures: [unauthorised, unauthorised, unauthorised] });

    await assert.rejects(() => service.embedTexts(["a"]), /Bad key/);
    assert.equal(client.calls.embeddings.length, 1, "auth failures fail fast");
  });

  it("gives up after the retry budget", async () => {
    const serverError = Object.assign(new Error("boom"), { status: 500 });
    const { client, service } = build({ failures: [serverError, serverError, serverError] });

    await assert.rejects(() => service.embedTexts(["a"]), /after 3 attempt/);
    assert.equal(client.calls.embeddings.length, 3);
  });

  it("aborts a hung embeddings call within the configured timeout, rather than hanging", async () => {
    // Never resolves or rejects on its own — models the real incident this
    // guards against: query-expansion's variant-embedding call hung for
    // several minutes because only the client's constructor-level timeout
    // covered it, and that alone did not reliably enforce the deadline. Only
    // settles when the signal we were given fires, so a pass here proves the
    // explicit per-request AbortSignal is what ends the call.
    const client = {
      embeddings: {
        create: (params, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("The operation was aborted.")));
          }),
      },
    };
    const service = createEmbeddingService({ getClient: () => client, timeoutMs: 50 });

    const startedAt = Date.now();
    await assert.rejects(() => service.embedTexts(["a"]));
    const elapsedMs = Date.now() - startedAt;

    assert.ok(
      elapsedMs < 2000,
      `expected the hung call to abort near the configured 50ms timeout, took ${elapsedMs}ms`
    );
  });

  it("does not retry a request that timed out on its own hard deadline", async () => {
    let calls = 0;
    const client = {
      embeddings: {
        create: (params, { signal }) => {
          calls++;
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })));
          });
        },
      },
    };
    const service = createEmbeddingService({ getClient: () => client, timeoutMs: 30 });

    await assert.rejects(() => service.embedTexts(["a"]));

    assert.equal(calls, 1, "a self-inflicted timeout is not worth retrying — it would only multiply the wait");
  });

  it("serves a repeated question from cache", async () => {
    const { client, service } = build();

    await service.embedText("What is Zero Rupee Marketing?");
    await service.embedText("What is Zero Rupee Marketing?");

    assert.equal(client.calls.embeddings.length, 1, "second call is cached");
    assert.equal(service.cacheSize(), 1);
  });

  it("does not use the cache when asked not to", async () => {
    const { client, service } = build();

    await service.embedText("q", { useCache: false });
    await service.embedText("q", { useCache: false });

    assert.equal(client.calls.embeddings.length, 2);
  });

  it("treats surrounding whitespace as the same cache key", async () => {
    const { client, service } = build();

    await service.embedText("question");
    await service.embedText("  question  ");

    assert.equal(client.calls.embeddings.length, 1);
  });
});
