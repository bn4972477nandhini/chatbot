const { QdrantClient } = require("@qdrant/js-client-rest");

const { config } = require("../config/env");
const { AppError, configError, upstreamError } = require("../lib/errors");

// Cosine matches how OpenAI embeddings are meant to be compared.
const DISTANCE = "Cosine";

const UPSERT_BATCH_SIZE = 256;

let client = null;

/**
 * Lazily builds the Qdrant client so a missing URL only fails when Qdrant is
 * actually used, keeping the rest of the server bootable. One client is reused
 * for the process so its connection pool is shared.
 */
function getQdrantClient() {
  if (client) return client;

  if (!config.qdrant.url) {
    throw configError("QDRANT_URL is not set. Add it to .env before indexing.");
  }

  client = new QdrantClient({
    url: config.qdrant.url,
    // A local Qdrant runs without auth, so the key stays optional.
    apiKey: config.qdrant.apiKey || undefined,
    timeout: config.qdrant.timeoutMs,
  });

  return client;
}

/** Test seam: injects a fake client, or resets with no argument. */
function setQdrantClient(fake) {
  client = fake ?? null;
}

function describeError(error) {
  return error?.data?.status?.error ?? error?.message ?? String(error);
}

/**
 * Builds the Qdrant service.
 *
 * @param {object} [deps]
 * @param {Function} [deps.getClient]
 * @param {string}   [deps.collection]
 */
function createQdrantService({
  getClient = getQdrantClient,
  collection = config.qdrant.collection,
} = {}) {
  /**
   * Creates the collection when absent. When it already exists, its vector size
   * is verified so a dimension mismatch fails loudly here rather than as an
   * opaque rejection on the first upsert.
   */
  async function ensureCollection(vectorSize) {
    const qdrant = getClient();

    let collections;
    try {
      ({ collections } = await qdrant.getCollections());
    } catch (error) {
      throw upstreamError(
        `Could not reach Qdrant at ${config.qdrant.url}: ${describeError(error)}`,
        error
      );
    }

    const exists = collections.some((c) => c.name === collection);

    if (!exists) {
      await qdrant.createCollection(collection, {
        vectors: { size: vectorSize, distance: DISTANCE },
      });

      // Payload indexes make metadata filters efficient rather than full scans.
      // Failures here are non-fatal: filtering still works, just more slowly.
      await Promise.all(
        ["source", "chunkId"].map((field) =>
          qdrant
            .createPayloadIndex(collection, {
              field_name: field,
              field_schema: field === "chunkId" ? "integer" : "keyword",
              wait: true,
            })
            .catch(() => undefined)
        )
      );

      return { created: true };
    }

    const info = await qdrant.getCollection(collection);
    const existingSize = info?.config?.params?.vectors?.size;

    if (existingSize && existingSize !== vectorSize) {
      throw new AppError(
        `Collection "${collection}" expects ${existingSize}-dim vectors but the ` +
          `embedding model produces ${vectorSize}. Delete the collection or point ` +
          `QDRANT_COLLECTION at a different name.`,
        { status: 409, code: "dimension_mismatch" }
      );
    }

    return { created: false };
  }

  /**
   * Upserts points in batches. Point IDs are deterministic, so re-running the
   * indexer overwrites the previous vectors instead of duplicating them.
   *
   * @returns {Promise<number>} count of points written
   */
  async function upsertPoints(points) {
    if (!Array.isArray(points) || points.length === 0) {
      throw new AppError("upsertPoints requires a non-empty array of points.", {
        status: 500,
        code: "invalid_upsert_input",
      });
    }

    const qdrant = getClient();
    let written = 0;

    for (let start = 0; start < points.length; start += UPSERT_BATCH_SIZE) {
      const batch = points.slice(start, start + UPSERT_BATCH_SIZE);

      try {
        // wait: true so the returned count reflects committed writes.
        await qdrant.upsert(collection, { wait: true, points: batch });
      } catch (error) {
        throw upstreamError(
          `Qdrant upsert failed for points ${start}-${start + batch.length - 1}: ${describeError(error)}`,
          error
        );
      }

      written += batch.length;
    }

    return written;
  }

  /**
   * Dense vector search.
   *
   * `withVector` is needed by MMR re-ranking, which compares candidates against
   * each other. `filter` is passed through untouched so callers can restrict by
   * payload metadata (source, chunkId, …).
   *
   * @returns {Promise<Array<{id: number, score: number, payload: object, vector?: number[]}>>}
   */
  async function searchPoints(
    vector,
    { limit, scoreThreshold, withPayload = true, withVector = false, filter } = {}
  ) {
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new AppError("searchPoints requires a non-empty embedding vector.", {
        status: 500,
        code: "invalid_search_input",
      });
    }

    try {
      const { points } = await getClient().query(collection, {
        query: vector,
        limit,
        score_threshold: scoreThreshold,
        with_payload: withPayload,
        with_vector: withVector,
        filter,
      });

      return points ?? [];
    } catch (error) {
      // A 404 here means /index-book has not been run against this collection.
      if (error?.status === 404) {
        throw new AppError(
          `Collection "${collection}" does not exist. Run POST /index-book first.`,
          { status: 503, code: "collection_missing" }
        );
      }

      throw upstreamError(`Qdrant search failed: ${describeError(error)}`, error);
    }
  }

  async function countPoints() {
    const { count } = await getClient().count(collection, { exact: true });
    return count;
  }

  /** Lightweight reachability probe used by /health. */
  async function ping() {
    await getClient().getCollections();
    return true;
  }

  return {
    ensureCollection,
    upsertPoints,
    searchPoints,
    countPoints,
    ping,
    collection,
  };
}

const defaultService = createQdrantService();

module.exports = {
  createQdrantService,
  getQdrantClient,
  setQdrantClient,
  ensureCollection: defaultService.ensureCollection,
  upsertPoints: defaultService.upsertPoints,
  searchPoints: defaultService.searchPoints,
  countPoints: defaultService.countPoints,
  pingQdrant: defaultService.ping,
  COLLECTION_NAME: config.qdrant.collection,
};
