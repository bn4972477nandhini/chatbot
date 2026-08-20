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

    assert.equal(result.totalChunks, 87, "founder.pdf splits into 87 chunks");
    assert.equal(result.indexedChunks, 87);
    assert.equal(qdrant.state.upserted.length, 87);
  });

  it("writes the documented payload for every point", async () => {
    const { service, qdrant } = build();

    await service.indexBook();

    for (const point of qdrant.state.upserted) {
      assert.deepEqual(Object.keys(point.payload).sort(), [
        "chunkId",
        "hasStructuredData",
        "page",
        "pageContent",
        "pageEnd",
        "section",
        "sectionTitle",
        "source",
      ]);
      assert.equal(point.payload.source, "Founder.pdf");
      assert.equal(point.id, point.payload.chunkId);
      assert.ok(point.payload.pageContent.trim().length > 0);
      assert.equal(point.vector.length, 1536);
      assert.ok(Number.isInteger(point.payload.page), "every chunk is attributed to a page");
      assert.ok(point.payload.page >= 1 && point.payload.page <= 94);
      assert.ok(point.payload.pageEnd >= point.payload.page);
      assert.ok(Number.isInteger(point.payload.section));
    }
  });

  it("attributes the front matter and every chapter's chunks to a section", async () => {
    const { service, qdrant } = build();

    await service.indexBook();

    const sections = new Set(qdrant.state.upserted.map((p) => p.payload.section));
    // Section 0 is front matter (before the first chapter divider); the book
    // has 14 chapters, so sections 0-14 should all be represented.
    assert.equal(sections.size, 15, "front matter (0) plus 14 detected chapters");

    const titled = qdrant.state.upserted.filter((p) => p.payload.sectionTitle);
    assert.ok(titled.length > 0, "at least some chunks carry a real chapter title");
  });

  it("normalizes every campaign's flattened SPENT/REACH/ROI infographic into searchable Label: Value lines", async () => {
    const { service, qdrant } = build();

    await service.indexBook();

    const structured = qdrant.state.upserted.filter((p) => p.payload.hasStructuredData);
    // Every campaign chapter in the book (14) ends with this infographic.
    assert.equal(structured.length, 14, "one structured chunk per campaign infographic");

    for (const point of structured) {
      assert.match(point.payload.pageContent, /SPENT: Rs\.\d/);
    }

    // The IIT Chennai campaign's infographic (page 14) is the one this system
    // previously failed to answer from.
    const iitChennai = structured.find((p) => p.payload.page <= 14 && p.payload.pageEnd >= 14);
    assert.ok(iitChennai, "a chunk covering page 14 carries structured data");
    assert.match(iitChennai.payload.pageContent, /SPENT: Rs\.6000/);
    assert.match(iitChennai.payload.pageContent, /REACH: 20K reach/);
    // The original flattened table text — and the surrounding narrative it
    // sits inside — is preserved in the very same chunk, not split off into
    // an isolated, context-free one that would look identical to every other
    // campaign's SPENT/REACH/ROI restatement.
    assert.match(iitChennai.payload.pageContent, /SPENT {2}REACH {2}ROI Rs\.6000/);
    assert.match(iitChennai.payload.pageContent, /Myth Buster/);
    // This chapter's own opening narrative (two pages earlier) names the
    // actual campaign — without it, "SPENT: Rs.6000" is unambiguous as a
    // fact but orphaned from which of the book's 14 campaigns it belongs to.
    assert.match(iitChennai.payload.pageContent, /IIT Chennai/);
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

    assert.equal(openai.calls.embeddings.length, 1, "87 chunks fit in one batch of 96");
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
