const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  createRetrievalService,
  reciprocalRankFusion,
  extractKeywords,
  scoreLexicalMatch,
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

describe("extractKeywords", () => {
  it("drops stopwords and short filler words", () => {
    assert.deepEqual(extractKeywords("Who is the author of this book?"), ["author"]);
  });

  it("keeps distinct, meaningful terms", () => {
    assert.deepEqual(
      extractKeywords("What marketing mistakes should startups avoid?"),
      ["marketing", "mistakes", "startups", "avoid"]
    );
  });

  it("returns nothing for an all-stopword or too-short question", () => {
    assert.deepEqual(extractKeywords("q"), []);
    assert.deepEqual(extractKeywords("What is this?"), []);
  });
});

describe("scoreLexicalMatch", () => {
  it("scores zero when no keyword appears", () => {
    assert.equal(scoreLexicalMatch("some unrelated text", ["author"]), 0);
  });

  it("rewards distinct keyword coverage over repeated single-keyword hits", () => {
    const singleRepeated = scoreLexicalMatch("author author author", ["author", "sakthivel"]);
    const bothPresent = scoreLexicalMatch("author sakthivel", ["author", "sakthivel"]);
    assert.ok(bothPresent > singleRepeated);
  });
});

describe("retrievalService — widened fallback", () => {
  it("recovers a chunk the dense pass under-ranked, via an exact keyword match", async () => {
    // Mirrors the real founder.pdf bug: the copyright page's "Author: Sakthivel
    // Pannerselvam" line scores just under the cosine threshold, so the
    // threshold-filtered dense pass never sees it — but it is an exact lexical
    // hit for "author", so the fallback should pull it back in.
    const authorChunk = point(0, 0.54, [1, 0]);
    authorChunk.payload.pageContent = "Copyright page. Author: Sakthivel Pannerselvam.";
    const denseChunk = point(1, 0.62, [0, 1]);
    denseChunk.payload.pageContent = "Acknowledgements and thanks to everyone who helped.";

    const { service, calls } = build({
      onSearch: (options) =>
        // The threshold-filtered pass (first call) excludes the author chunk,
        // exactly like the real bug; the wide pass (scoreThreshold: 0) includes it.
        options.scoreThreshold === 0 ? [denseChunk, authorChunk] : [denseChunk],
    });

    const { chunks } = await service.retrieve("Who is the author of this book?", {
      useMmr: false,
    });

    assert.equal(calls.length, 2, "falls back to a second, wider search");
    assert.ok(chunks.some((c) => c.chunkId === 0), "recovers the author chunk");
  });

  it("recovers a chunk via raw similarity even with no lexical keyword overlap", async () => {
    // Same shape of bug, but the recovered chunk doesn't literally contain any
    // of the question's words — only the widened raw-similarity ranking (not
    // the keyword pass) can find it. Mirrors "Who wrote Founder Book?", where
    // the copyright chunk contains neither "wrote" nor "founder" verbatim.
    const nearMissChunk = point(0, 0.51, [1, 0]);
    nearMissChunk.payload.pageContent = "Copyright page with no matching wording at all.";
    const denseChunk = point(1, 0.6, [0, 1]);

    const { service } = build({
      onSearch: (options) =>
        options.scoreThreshold === 0 ? [denseChunk, nearMissChunk] : [denseChunk],
    });

    const { chunks } = await service.retrieve("Who wrote this book?", { useMmr: false });

    assert.ok(chunks.some((c) => c.chunkId === 0), "recovers via the widened raw-similarity pass");
  });

  it("does not run the fallback when the dense pass found nothing", async () => {
    // A genuinely off-topic question must stay refused, not have unrelated
    // chunks resurrected for it by widening the pool.
    const { service, calls } = build({ points: [] });

    const { chunks } = await service.retrieve("What is the capital of France?");

    assert.equal(calls.length, 1, "never issues the wider fallback search");
    assert.deepEqual(chunks, []);
  });

  it("still widens the pool when the question has no meaningful keywords", async () => {
    // No keywords means the lexical pass contributes nothing, but the
    // raw-similarity widening still runs — it doesn't depend on keywords.
    const { service, calls } = build({ points: [point(1, 0.9, [1, 0])] });

    await service.retrieve("What is this?", { useMmr: false });

    assert.equal(calls.length, 2);
  });

  it("does not introduce a chunk that never appears in the wide pool either", async () => {
    const denseChunk = point(1, 0.9, [1, 0]);
    denseChunk.payload.pageContent = "Nothing here matches the query terms.";

    const { service } = build({ points: [denseChunk] });

    const { chunks } = await service.retrieve("Who is the author?", { useMmr: false });

    assert.deepEqual(chunks.map((c) => c.chunkId), [1]);
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
