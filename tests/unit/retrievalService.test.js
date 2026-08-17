const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  createRetrievalService,
  reciprocalRankFusion,
  STRATEGIES,
} = require("../../services/retrievalService");
const { createTestLogger } = require("../helpers/mocks");

const point = (id, score, vector) => ({
  id,
  score,
  vector,
  payload: { chunkId: id, pageContent: `chunk ${id}`, source: "Founder.pdf" },
});

function build({ points = [], onSearch } = {}) {
  const calls = [];

  const service = createRetrievalService({
    embedText: async () => [1, 0],
    searchPoints: async (vector, options) => {
      calls.push(options);
      if (onSearch) return onSearch(options);
      return points;
    },
    logger: createTestLogger(),
  });

  return { service, calls };
}

describe("retrievalService", () => {
  it("applies the configured defaults", async () => {
    const { service, calls } = build({ points: [] });

    await service.retrieve("a question");

    assert.equal(calls[0].scoreThreshold, 0.65);
    assert.equal(calls[0].withPayload, true);
  });

  it("maps points into the documented chunk shape", async () => {
    const { service } = build({ points: [point(3, 0.91, [1, 0])] });

    const { chunks } = await service.retrieve("q", { useMmr: false });

    assert.deepEqual(Object.keys(chunks[0]).sort(), [
      "chunkId",
      "pageContent",
      "score",
      "source",
    ]);
    assert.equal(chunks[0].chunkId, 3);
    assert.equal(chunks[0].score, 0.91);
  });

  it("returns at most the requested topK", async () => {
    const points = Array.from({ length: 20 }, (_, i) =>
      point(i, 0.9 - i / 100, [Math.cos(i), Math.sin(i)])
    );
    const { service } = build({ points });

    const { chunks } = await service.retrieve("q", { limit: 5 });
    assert.equal(chunks.length, 5);
  });

  it("widens the candidate pool when MMR is on", async () => {
    const { service, calls } = build({ points: [] });

    await service.retrieve("q", { limit: 5, useMmr: true });

    assert.equal(calls[0].limit, 20, "5 * pool multiplier of 4");
    assert.equal(calls[0].withVector, true, "MMR needs vectors");
  });

  it("does not over-fetch or request vectors when MMR is off", async () => {
    const { service, calls } = build({ points: [] });

    await service.retrieve("q", { limit: 5, useMmr: false });

    assert.equal(calls[0].limit, 5);
    assert.equal(calls[0].withVector, false);
  });

  it("drops a near-duplicate in favour of a distinct chunk", async () => {
    const points = [
      point(1, 0.99, [1, 0]),
      point(2, 0.98, [1, 0.001]), // near-duplicate
      point(3, 0.80, [0, 1]),
    ];
    const { service } = build({ points });

    const { chunks } = await service.retrieve("q", {
      limit: 2,
      useMmr: true,
      mmrLambda: 0.5,
    });

    assert.deepEqual(chunks.map((c) => c.chunkId), [1, 3]);
  });

  it("passes a metadata filter through to the search", async () => {
    const { service, calls } = build({ points: [] });
    const filter = { must: [{ key: "source", match: { value: "Founder.pdf" } }] };

    await service.retrieve("q", { filter });

    assert.deepEqual(calls[0].filter, filter);
  });

  it("reports embedding and search durations", async () => {
    const { service } = build({ points: [] });

    const { timings } = await service.retrieve("q");

    assert.ok(Number.isFinite(timings.embedMs));
    assert.ok(Number.isFinite(timings.searchMs));
  });

  it("returns no chunks when nothing clears the threshold", async () => {
    const { service } = build({ points: [] });

    const { chunks } = await service.retrieve("unrelated question");
    assert.deepEqual(chunks, []);
  });

  it("rejects a blank question", async () => {
    const { service } = build();
    await assert.rejects(() => service.retrieve("   "), /non-empty question/);
  });

  it("fails loudly for an unimplemented strategy rather than degrading", async () => {
    const { service } = build();
    await assert.rejects(
      () => service.retrieve("q", { strategy: STRATEGIES.HYBRID }),
      /not implemented yet/
    );
  });
});

describe("reciprocalRankFusion", () => {
  it("ranks an item appearing in both lists above singles", () => {
    const dense = [{ id: "a" }, { id: "b" }];
    const sparse = [{ id: "c" }, { id: "a" }];

    const fused = reciprocalRankFusion([dense, sparse]);
    assert.equal(fused[0].id, "a");
  });

  it("preserves every unique item", () => {
    const fused = reciprocalRankFusion([[{ id: "a" }], [{ id: "b" }]]);
    assert.equal(fused.length, 2);
  });

  it("handles an empty input", () => {
    assert.deepEqual(reciprocalRankFusion([]), []);
  });
});
