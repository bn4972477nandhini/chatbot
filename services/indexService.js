const path = require("path");

const { conflict, AppError } = require("../lib/errors");
const { logger: defaultLogger } = require("../lib/logger");
const { readPDF } = require("./pdfReader");
const { chunkPages } = require("./chunkService");
const {
  embedTexts: defaultEmbedTexts,
  EMBEDDING_DIMENSIONS,
} = require("./embeddingService");
const {
  ensureCollection: defaultEnsureCollection,
  upsertPoints: defaultUpsertPoints,
} = require("./qdrantService");

const BOOK_PATH = path.join(__dirname, "..", "uploads", "founder.pdf");
const SOURCE_NAME = "Founder.pdf";

// Chunks are embedded and written in slices rather than all at once, so peak
// memory stays bounded by the slice rather than by the size of the book.
const PIPELINE_BATCH_SIZE = 96;

/**
 * Builds the indexing service.
 *
 * A module-level in-flight guard prevents two concurrent /index-book calls from
 * interleaving writes to the same deterministic point IDs.
 */
function createIndexService({
  embedTexts = defaultEmbedTexts,
  ensureCollection = defaultEnsureCollection,
  upsertPoints = defaultUpsertPoints,
  logger = defaultLogger,
  bookPath = BOOK_PATH,
} = {}) {
  let inFlight = null;

  async function runIndexing(log) {
    const startedAt = Date.now();

    const readStartedAt = Date.now();
    const { text, pages } = await readPDF(bookPath);
    const readMs = Date.now() - readStartedAt;

    if (!text.trim()) {
      throw new AppError(`No extractable text found in ${SOURCE_NAME}.`, {
        status: 422,
        code: "empty_document",
      });
    }

    const chunkStartedAt = Date.now();
    const chunks = await chunkPages(pages, { logger: log });
    const chunkMs = Date.now() - chunkStartedAt;

    const totalChunks = chunks.length;

    // Guard against whitespace-only chunks reaching the embeddings API, which
    // rejects empty input.
    const documents = [];
    for (let index = 0; index < chunks.length; index++) {
      const { pageContent, metadata } = chunks[index];
      if (pageContent.trim() !== "") documents.push({ index, pageContent, metadata });
    }

    if (documents.length === 0) {
      throw new AppError(`${SOURCE_NAME} produced no non-empty chunks to index.`, {
        status: 422,
        code: "empty_document",
      });
    }

    // Created before the first write so a dimension mismatch fails before any
    // embedding spend.
    await ensureCollection(EMBEDDING_DIMENSIONS);

    let indexedChunks = 0;
    let embedMs = 0;
    let upsertMs = 0;

    for (let start = 0; start < documents.length; start += PIPELINE_BATCH_SIZE) {
      const slice = documents.slice(start, start + PIPELINE_BATCH_SIZE);

      const embedStartedAt = Date.now();
      const vectors = await embedTexts(slice.map((doc) => doc.pageContent));
      embedMs += Date.now() - embedStartedAt;

      const points = slice.map((doc, offset) => ({
        id: doc.index,
        vector: vectors[offset],
        payload: {
          chunkId: doc.index,
          pageContent: doc.pageContent,
          source: SOURCE_NAME,
          page: doc.metadata.page,
          pageEnd: doc.metadata.pageEnd,
          section: doc.metadata.section,
          sectionTitle: doc.metadata.sectionTitle,
          hasStructuredData: doc.metadata.hasStructuredData ?? false,
        },
      }));

      const upsertStartedAt = Date.now();
      indexedChunks += await upsertPoints(points);
      upsertMs += Date.now() - upsertStartedAt;

      log.debug("indexing batch written", {
        batchStart: start,
        batchSize: slice.length,
        indexedChunks,
      });
    }

    log.info("indexing complete", {
      totalPages: pages.length,
      totalChunks,
      indexedChunks,
      readMs,
      chunkMs,
      embedMs,
      upsertMs,
      totalMs: Date.now() - startedAt,
    });

    return { totalPages: pages.length, totalChunks, indexedChunks };
  }

  /**
   * Runs the full ingestion pipeline: read PDF, chunk, embed, upsert.
   *
   * Chunk index doubles as the Qdrant point ID, so indexing the same book twice
   * replaces the existing vectors rather than appending duplicates.
   */
  async function indexBook({ logger: requestLogger } = {}) {
    const log = requestLogger ?? logger;

    if (inFlight) {
      throw conflict("An indexing run is already in progress. Try again when it finishes.");
    }

    inFlight = runIndexing(log).finally(() => {
      inFlight = null;
    });

    return inFlight;
  }

  return { indexBook, isIndexing: () => inFlight !== null };
}

const defaultService = createIndexService();

module.exports = {
  createIndexService,
  indexBook: defaultService.indexBook,
  isIndexing: defaultService.isIndexing,
  BOOK_PATH,
  SOURCE_NAME,
};
