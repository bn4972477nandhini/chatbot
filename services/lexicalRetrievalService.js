const { BM25Retriever } = require("@langchain/community/retrievers/bm25");
const { Document } = require("@langchain/core/documents");

/**
 * Ranks points by Okapi BM25 relevance to the given keywords.
 *
 * Uses the BM25 implementation already bundled with `@langchain/community`
 * (a project dependency; nothing new to install) rather than a plain
 * term-frequency count: a keyword that appears in most of the pool (common,
 * undiscriminating — e.g. "business" in a book about business) contributes
 * far less than one that appears in only a couple of chunks (rare,
 * discriminating), via BM25's inverse-document-frequency term. A naive
 * frequency count treats both the same, so a handful of chunks sharing one
 * weak, common keyword can outrank — or crowd out of a capped top-N — a
 * chunk that is the only one actually on-topic.
 *
 * Corpus-relative by nature: scores depend on the whole `points` pool passed
 * in, not on any single chunk in isolation, so this only makes sense run
 * once over a candidate pool (e.g. the wide fallback pool), not per-chunk.
 *
 * @param {Array<{payload?: {pageContent?: string}}>} points
 * @param {string[]} keywords
 * @param {object} [options]
 * @param {number} [options.k] how many ranked results to return (default: all)
 * @returns {Promise<Array>} the subset of `points` that scored above zero,
 *   ranked best-first
 */
async function rankByBm25(points, keywords, { k } = {}) {
  if (keywords.length === 0 || points.length === 0) return [];

  // The underlying "okapibm25" package matches terms with a case-sensitive
  // regex, but extractKeywords() always lowercases the question. Source PDF
  // text routinely capitalizes the very words a question asks about — labels
  // ("Author:"), headers, proper nouns at a sentence start — so without
  // lowercasing the document text here, a keyword can silently score zero
  // against every chunk in the pool even when it appears verbatim, just in a
  // different case. Only this internal scoring copy is lowercased; the
  // original points (and their original-case pageContent) are what's returned.
  const docs = points.map(
    (point, index) =>
      new Document({
        pageContent: (point.payload?.pageContent ?? "").toLowerCase(),
        metadata: { index },
      })
  );

  const retriever = BM25Retriever.fromDocuments(docs, {
    k: k ?? points.length,
    includeScore: true,
  });

  const results = await retriever.invoke(keywords.join(" "));

  return results.filter((doc) => (doc.metadata.bm25Score ?? 0) > 0).map((doc) => points[doc.metadata.index]);
}

module.exports = { rankByBm25 };
