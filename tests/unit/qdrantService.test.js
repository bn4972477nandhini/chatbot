const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { createQdrantService } = require("../../services/qdrantService");
const { createMockQdrant, fakeVector, DIMENSIONS } = require("../helpers/mocks");

const COLLECTION = "test_collection";

function build(options) {
  const client = createMockQdrant(options);
  const service = createQdrantService({ getClient: () => client, collection: COLLECTION });
  return { client, service };
}

describe("qdrantService.ensureCollection", () => {
  it("creates the collection when absent", async () => {
    const { client, service } = build();

    const result = await service.ensureCollection(DIMENSIONS);

    assert.equal(result.created, true);
    assert.ok(client.state.collections.includes(COLLECTION));
  });

  it("creates payload indexes for filterable fields", async () => {
    const { client, service } = build();

    await service.ensureCollection(DIMENSIONS);

    assert.deepEqual(client.state.indexes.sort(), ["chunkId", "source"]);
  });

  it("does not recreate an existing collection", async () => {
    const { service } = build({ existingCollections: [COLLECTION] });

    const result = await service.ensureCollection(DIMENSIONS);
    assert.equal(result.created, false);
  });

  it("rejects a dimension mismatch with a clear error", async () => {
    const { service } = build({ existingCollections: [COLLECTION] });

    await assert.rejects(() => service.ensureCollection(512), /expects 1536-dim vectors/);
  });
});

describe("qdrantService.upsertPoints", () => {
  const point = (id) => ({
    id,
    vector: fakeVector(id),
    payload: { chunkId: id, pageContent: `chunk ${id}`, source: "Founder.pdf" },
  });

  it("writes every point and reports the count", async () => {
    const { client, service } = build();
    const points = Array.from({ length: 10 }, (_, i) => point(i));

    const written = await service.upsertPoints(points);

    assert.equal(written, 10);
    assert.equal(client.state.upserted.length, 10);
  });

  it("batches large writes", async () => {
    const { client, service } = build();
    const points = Array.from({ length: 600 }, (_, i) => point(i));

    const written = await service.upsertPoints(points);

    assert.equal(written, 600);
    assert.equal(client.state.upserted.length, 600, "no points dropped across batches");
  });

  it("rejects an empty array", async () => {
    const { service } = build();
    await assert.rejects(() => service.upsertPoints([]), /non-empty array/);
  });
});

describe("qdrantService.searchPoints", () => {
  const points = [
    { id: 1, score: 0.9, payload: { chunkId: 1 }, vector: fakeVector(1) },
    { id: 2, score: 0.8, payload: { chunkId: 2 }, vector: fakeVector(2) },
  ];

  it("passes limit, threshold and payload flags through", async () => {
    const { client, service } = build({ points });

    await service.searchPoints(fakeVector("q"), {
      limit: 5,
      scoreThreshold: 0.65,
      withPayload: true,
    });

    const query = client.state.queries[0];
    assert.equal(query.limit, 5);
    assert.equal(query.score_threshold, 0.65);
    assert.equal(query.with_payload, true);
  });

  it("passes a metadata filter through untouched", async () => {
    const { client, service } = build({ points });
    const filter = { must: [{ key: "source", match: { value: "Founder.pdf" } }] };

    await service.searchPoints(fakeVector("q"), { limit: 3, filter });

    assert.deepEqual(client.state.queries[0].filter, filter);
  });

  it("requests vectors only when MMR needs them", async () => {
    const { client, service } = build({ points });

    await service.searchPoints(fakeVector("q"), { limit: 3, withVector: true });
    assert.equal(client.state.queries[0].with_vector, true);
  });

  it("rejects an empty vector", async () => {
    const { service } = build();
    await assert.rejects(() => service.searchPoints([]), /non-empty embedding vector/);
  });

  it("explains a missing collection as an actionable error", async () => {
    const client = createMockQdrant();
    client.query = async () => {
      throw Object.assign(new Error("Not found"), { status: 404 });
    };
    const service = createQdrantService({ getClient: () => client, collection: COLLECTION });

    await assert.rejects(
      () => service.searchPoints(fakeVector("q"), { limit: 1 }),
      /Run POST \/index-book first/
    );
  });
});
