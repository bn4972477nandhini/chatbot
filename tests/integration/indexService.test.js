const assert = require("node:assert/strict");
const path = require("path");
const { describe, it } = require("node:test");

const { createIndexService } = require("../../services/indexService");
const { createEmbeddingService } = require("../../services/embeddingService");
const { createQdrantService } = require("../../services/qdrantService");
const { createMockOpenAI, createMockQdrant, createTestLogger } = require("../helpers/mocks");

const BOOK = path.join(__dirname, "..", "..", "uploads", "founder.pdf");

/**
 * Wires the real indexing pipeline (PDF read, chunking, batching, point
 * construction) against mocked OpenAI and Qdrant clients, so everything except
 * the two network boundaries is exercised for real.
 */
function build() {
  const openai = createMockOpenAI();
  const qdrant = createMockQdrant();

  const embedding = createEmbeddingService({ getClient: () => openai });
  const store = createQdrantService({
    getClient: () => qdrant,
    collection: "test_collection",
  });

  const service = createIndexService({
    embedTexts: embedding.embedTexts,
    ensureCollection: store.ensureCollection,
    upsertPoints: store.upsertPoints,
    logger: createTestLogger(),
    bookPath: BOOK,
  });

  return { service, openai, qdrant };
}

describe("indexService (integration)", () => {
  it("indexes the book end to end", async () => {
    const { service, qdrant } = build();

    const result = await service.indexBook();

    assert.equal(result.totalChunks, 86, "founder.pdf splits into 86 chunks");
    assert.equal(result.indexedChunks, 86);
    assert.equal(qdrant.state.upserted.length, 86);
  });

  it("writes the documented payload for every point", async () => {
    const { service, qdrant } = build();

    await service.indexBook();

    for (const point of qdrant.state.upserted) {
      assert.deepEqual(Object.keys(point.payload).sort(), [
        "chunkId",
        "pageContent",
        "source",
      ]);
      assert.equal(point.payload.source, "Founder.pdf");
      assert.equal(point.id, point.payload.chunkId);
      assert.ok(point.payload.pageContent.trim().length > 0);
      assert.equal(point.vector.length, 1536);
    }
  });

  it("uses unique, deterministic point ids", async () => {
    const { service, qdrant } = build();

    await service.indexBook();

    const ids = qdrant.state.upserted.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, "no duplicate ids");
    assert.ok(ids.every((id) => Number.isInteger(id) && id >= 0));
  });

  it("creates the collection before writing", async () => {
    const { service, qdrant } = build();

    await service.indexBook();

    assert.ok(qdrant.state.collections.includes("test_collection"));
  });

  it("embeds in batches rather than one request", async () => {
    const { service, openai } = build();

    await service.indexBook();

    assert.equal(openai.calls.embeddings.length, 1, "86 chunks fit in one batch of 96");
  });

  it("rejects a concurrent indexing run instead of interleaving writes", async () => {
    const { service } = build();

    const first = service.indexBook();
    await assert.rejects(() => service.indexBook(), /already in progress/);

    await first;

    // The guard releases once the run finishes.
    await service.indexBook();
  });

  it("surfaces a missing book file as an error", async () => {
    const openai = createMockOpenAI();
    const qdrant = createMockQdrant();
    const embedding = createEmbeddingService({ getClient: () => openai });
    const store = createQdrantService({ getClient: () => qdrant, collection: "t" });

    const service = createIndexService({
      embedTexts: embedding.embedTexts,
      ensureCollection: store.ensureCollection,
      upsertPoints: store.upsertPoints,
      logger: createTestLogger(),
      bookPath: path.join(__dirname, "does-not-exist.pdf"),
    });

    await assert.rejects(() => service.indexBook());
  });
});
