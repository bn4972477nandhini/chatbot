const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { maximalMarginalRelevance, cosineSimilarity } = require("../../services/mmr");

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);
  });

  it("returns 0 for orthogonal vectors", () => {
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  });

  it("returns 0 rather than NaN for a zero vector", () => {
    assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  });

  it("returns 0 for mismatched lengths", () => {
    assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), 0);
  });
});

describe("maximalMarginalRelevance", () => {
  const query = [1, 0];

  it("returns an empty array for no candidates", () => {
    assert.deepEqual(maximalMarginalRelevance({ queryVector: query, candidates: [], k: 3 }), []);
  });

  it("prefers a diverse second result over a near-duplicate", () => {
    const candidates = [
      { id: "a", vector: [1, 0], score: 0.99 },
      { id: "b", vector: [1, 0.01], score: 0.98 }, // near-duplicate of a
      { id: "c", vector: [0, 1], score: 0.80 }, // clearly different
    ];

    const selected = maximalMarginalRelevance({
      queryVector: query,
      candidates,
      k: 2,
      lambda: 0.5,
    });

    assert.equal(selected[0].id, "a", "most relevant is selected first");
    assert.equal(selected[1].id, "c", "diverse chunk beats the near-duplicate");
  });

  it("collapses to pure relevance ordering at lambda = 1", () => {
    const candidates = [
      { id: "a", vector: [1, 0], score: 0.9 },
      { id: "b", vector: [1, 0], score: 0.8 },
      { id: "c", vector: [0, 1], score: 0.7 },
    ];

    const selected = maximalMarginalRelevance({
      queryVector: query,
      candidates,
      k: 3,
      lambda: 1,
    });

    assert.deepEqual(selected.map((s) => s.id), ["a", "b", "c"]);
  });

  it("never returns more than k results", () => {
    const candidates = Array.from({ length: 10 }, (_, i) => ({
      id: i,
      vector: [Math.cos(i), Math.sin(i)],
      score: 1 - i / 20,
    }));

    assert.equal(
      maximalMarginalRelevance({ queryVector: query, candidates, k: 4 }).length,
      4
    );
  });

  it("never returns duplicates", () => {
    const candidates = Array.from({ length: 6 }, (_, i) => ({
      id: i,
      vector: [Math.cos(i), Math.sin(i)],
      score: 0.9,
    }));

    const selected = maximalMarginalRelevance({ queryVector: query, candidates, k: 6 });
    assert.equal(new Set(selected.map((s) => s.id)).size, 6);
  });

  it("falls back to input order when candidates carry no vectors", () => {
    const candidates = [{ id: "a", score: 0.9 }, { id: "b", score: 0.8 }];

    const selected = maximalMarginalRelevance({ queryVector: query, candidates, k: 1 });
    assert.deepEqual(selected.map((s) => s.id), ["a"]);
  });
});
