const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  createRetrievalService,
  reciprocalRankFusion,
  extractKeywords,
  STRATEGIES,
} = require("../../services/retrievalService");
const { createTestLogger } = require("../helpers/mocks");

const point = (id, score, vector) => ({
  id,
  score,
  vector,
  payload: {
    chunkId: id,
    pageContent: `chunk ${id}`,
    source: "Founder.pdf",
    page: id + 1,
    pageEnd: id + 1,
    section: 1,
    sectionTitle: "A Chapter Title",
  },
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
      "page",
      "pageContent",
      "pageEnd",
      "score",
      "section",
      "sectionTitle",
      "source",
    ]);
    assert.equal(chunks[0].chunkId, 3);
    assert.equal(chunks[0].score, 0.91);
    assert.equal(chunks[0].page, 4);
  });

  it("falls back to null page/section fields when the payload lacks them", async () => {
    const bare = {
      id: 9,
      score: 0.8,
      vector: [1, 0],
      payload: { chunkId: 9, pageContent: "chunk 9", source: "Founder.pdf" },
    };
    const { service } = build({ points: [bare] });

    const { chunks } = await service.retrieve("q", { useMmr: false });

    assert.equal(chunks[0].page, null);
    assert.equal(chunks[0].pageEnd, null);
    assert.equal(chunks[0].section, null);
    assert.equal(chunks[0].sectionTitle, null);
  });

  it("returns at most the requested topK", async () => {
    const points = Array.from({ length: 20 }, (_, i) =>
      point(i, 0.9 - i / 100, [Math.cos(i), Math.sin(i)])
    );
    const { service } = build({ points });

    const { chunks } = await service.retrieve("q", { limit: 5 });
    assert.equal(chunks.length, 5);
  });

  it("orders the final chunks by score, so the best evidence is always Source 1 regardless of how it was selected", async () => {
    // Mirrors a real bug: a guaranteed (lexically/expansion-rescued) chunk
    // with a lower score was placed ahead of MMR's own pick even when that
    // MMR pick scored higher — so the strongest evidence could land as
    // "Source 5", and a small local model measurably treated it as less
    // authoritative than a more prominently placed, lower-scoring passage.
    const lexicalRescue = point(1, 0.55, [0.9, 0.1]); // guaranteed, but the lower score
    lexicalRescue.payload.pageContent = "mentions the keyword literally";
    const bestMatch = point(2, 0.9, [0.1, 0.9]); // highest score, but only reaches MMR's "remaining"
    const filler = Array.from({ length: 5 }, (_, i) => point(10 + i, 0.6, [0, 1 + i * 1e-6]));

    const { service } = build({
      onSearch: (options) =>
        options.scoreThreshold === 0
          ? [bestMatch, lexicalRescue, ...filler]
          : [bestMatch, ...filler],
    });

    const { chunks } = await service.retrieve("mentions the keyword literally", {
      limit: 5,
      useMmr: true,
    });

    assert.equal(chunks[0].chunkId, 2, "the highest-scoring chunk is Source 1");
    assert.ok(
      chunks.every((c, i) => i === 0 || chunks[i - 1].score >= c.score),
      "chunks are sorted by score descending"
    );
    assert.ok(chunks.some((c) => c.chunkId === 1), "the lexically-guaranteed chunk is still included");
  });

  it("promotes a directly-confirmed chunk ahead of a merely topically-similar one when their scores are close", async () => {
    // General evidence-directness signal: an exact keyword hit is stronger
    // proof of "this passage answers the question" than raw cosine similarity
    // alone, which only measures topical closeness. A small ranking nudge
    // reorders near-ties in its favour without ever overriding a genuinely
    // large score gap (covered by the test above, gap 0.35 >> the nudge).
    const directHit = point(1, 0.60, [0.9, 0.1]);
    directHit.payload.pageContent = "distinctive literally states the fact directly";
    const genericMention = point(2, 0.62, [0.1, 0.9]); // slightly higher score, but no keyword overlap
    const filler = Array.from({ length: 5 }, (_, i) => point(10 + i, 0.55, [0, 1 + i * 1e-6]));

    const { service } = build({
      onSearch: (options) =>
        options.scoreThreshold === 0
          ? [genericMention, directHit, ...filler]
          : [genericMention, ...filler],
    });

    const { chunks } = await service.retrieve("distinctive literally states", {
      limit: 5,
      useMmr: true,
    });

    assert.equal(
      chunks[0].chunkId,
      1,
      "the directly-confirmed chunk outranks a near-tied but merely topical one"
    );
  });

  it("does not let the directness nudge override a genuinely stronger, unconfirmed match", async () => {
    // The flip side of the test above: a small score gap gets reordered, but
    // a real one (far larger than the nudge) never does — directness is a
    // tie-breaker, not a replacement for relevance.
    const directHitWeak = point(1, 0.40, [0.9, 0.1]);
    directHitWeak.payload.pageContent = "distinctive literally states the fact directly";
    const strongMatch = point(2, 0.85, [0.1, 0.9]);
    const filler = Array.from({ length: 5 }, (_, i) => point(10 + i, 0.55, [0, 1 + i * 1e-6]));

    const { service } = build({
      onSearch: (options) =>
        options.scoreThreshold === 0
          ? [strongMatch, directHitWeak, ...filler]
          : [strongMatch, ...filler],
    });

    const { chunks } = await service.retrieve("distinctive literally states", {
      limit: 5,
      useMmr: true,
    });

    assert.equal(chunks[0].chunkId, 2, "a large score gap still wins over the directness nudge");
  });

  it("promotes a chunk flagged with structured data (a LABEL: value line) ahead of a near-tied generic chunk", async () => {
    const structured = point(1, 0.58, [0.9, 0.1]);
    structured.payload.hasStructuredData = true;
    const generic = point(2, 0.60, [0.1, 0.9]);
    const filler = Array.from({ length: 5 }, (_, i) => point(10 + i, 0.55, [0, 1 + i * 1e-6]));

    const { service } = build({ points: [structured, generic, ...filler] });

    const { chunks } = await service.retrieve("q", { limit: 5, useMmr: true });

    assert.equal(chunks[0].chunkId, 1, "the structured-data chunk outranks a near-tied generic one");
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

  it("never drops the only relevant chunk from a pool of irrelevant ones", async () => {
    // The one chunk that actually answers the question is far more relevant
    // (much higher score) than everything else in the pool; MMR must still
    // surface it even though every other candidate is mutually near-identical
    // (and so would otherwise dominate on diversity grounds alone).
    const answerChunk = point(0, 0.95, [1, 0]);
    const filler = Array.from({ length: 10 }, (_, i) =>
      point(i + 1, 0.3, [0, 1 + i * 1e-6])
    );
    const { service } = build({ points: [answerChunk, ...filler] });

    const { chunks } = await service.retrieve("q", { limit: 3, useMmr: true, mmrLambda: 0.7 });

    assert.ok(
      chunks.some((c) => c.chunkId === 0),
      "the sole relevant chunk survives MMR re-ranking"
    );
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

  it("strips a trailing possessive so it can match the word's bare form in chunk text", () => {
    assert.deepEqual(extractKeywords("What's the writer's identity?"), ["writer", "identity"]);
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

  it("still declines when widening finds nothing, dense or lexical", async () => {
    // A genuinely off-topic question must stay refused even after the pool is
    // widened for its keywords — no unrelated chunk gets resurrected for it
    // just because the widened pass ran at all.
    const { service } = build({ points: [] });

    const { chunks } = await service.retrieve("What is the capital of France?");

    assert.deepEqual(chunks, []);
  });

  it("does not skip widening just because the dense pass was empty, when the question has keywords", async () => {
    // The exact-term rescue must not depend on the dense pass finding
    // anything — a question dense search misses entirely (wrong topic
    // vector) can still be recovered by a literal keyword hit.
    const { service, calls } = build({ points: [] });

    await service.retrieve("What is the capital of France?");

    assert.equal(calls.length, 2, "widens the pool to check for an exact keyword match");
  });

  it("protects a lexically-rescued chunk from being diversity-penalized out by MMR", async () => {
    // Mirrors a real bug found against founder.pdf: a chunk containing the
    // literal word "foreword" was correctly rescued into the candidate pool
    // by the exact-keyword pass, but MMR's diversity trade-off then dropped
    // it anyway because it sat close in vector space to a higher-scoring
    // neighbour that got selected first — even though no other candidate
    // says anything about who wrote the foreword.
    const forewordChunk = point(4, 0.5, [0.9, 0.1]); // similar vector to neighbour...
    forewordChunk.payload.pageContent = "It is my pleasure to write the foreword for this book.";
    const neighbour = point(5, 0.7, [0.91, 0.09]); // ...ranks higher, would normally win MMR's slot
    const filler = Array.from({ length: 6 }, (_, i) => point(10 + i, 0.6, [0, 1 + i * 1e-6]));

    const { service } = build({
      onSearch: (options) =>
        options.scoreThreshold === 0
          ? [neighbour, forewordChunk, ...filler]
          : [neighbour, ...filler],
    });

    const { chunks } = await service.retrieve("Who wrote the foreword?", {
      limit: 7,
      useMmr: true,
    });

    assert.ok(
      chunks.some((c) => c.chunkId === 4),
      "the lexically-rescued foreword chunk survives MMR selection"
    );
  });

  it("protects more than one distinct lexically-rescued chunk from MMR, up to the cap", async () => {
    // Two different chunks each independently confirm a different keyword from
    // the question. Neither should be sacrificed just because only one
    // "guaranteed" slot used to be available.
    const spentChunk = point(4, 0.5, [0.9, 0.1]);
    spentChunk.payload.pageContent = "The campaign spent very little on promotion.";
    const reachChunk = point(6, 0.5, [0.2, 0.9]);
    reachChunk.payload.pageContent = "Reach for the campaign grew organically.";
    const neighbour = point(5, 0.7, [0.91, 0.09]);
    const filler = Array.from({ length: 6 }, (_, i) => point(10 + i, 0.6, [0, 1 + i * 1e-6]));

    const { service } = build({
      onSearch: (options) =>
        options.scoreThreshold === 0
          ? [neighbour, spentChunk, reachChunk, ...filler]
          : [neighbour, ...filler],
    });

    const { chunks } = await service.retrieve("What was the campaign's spent and reach?", {
      limit: 7,
      useMmr: true,
    });

    assert.ok(chunks.some((c) => c.chunkId === 4), "the 'spent' match survives");
    assert.ok(chunks.some((c) => c.chunkId === 6), "the 'reach' match survives");
  });

  it("protects a same-section runner-up from being diversity-penalized out by MMR", async () => {
    // Mirrors a real gap found against founder.pdf: a campaign's narrative
    // (the top-ranked chunk) and its SPENT/REACH/ROI summary lived a couple of
    // pages later in the same detected section, but MMR's diversity trade-off
    // dropped the summary chunk in favour of an unrelated chunk from a
    // completely different chapter, purely because that unrelated chunk's
    // vector looked more "diverse" next to the top pick.
    const top = point(1, 0.9, [1, 0]);
    top.payload.section = 1;
    const sameSectionSummary = point(2, 0.55, [0.99, 0.14]); // close to top's vector...
    sameSectionSummary.payload.section = 1; // ...but structurally the same case study
    const otherChapterA = point(10, 0.5, [0, 1]); // far from top's vector...
    otherChapterA.payload.section = 99; // ...and from an unrelated chapter
    const otherChapterB = point(11, 0.45, [0.1, 0.99]);
    otherChapterB.payload.section = 99;

    const { service } = build({
      points: [top, sameSectionSummary, otherChapterA, otherChapterB],
    });

    const { chunks } = await service.retrieve("q", { limit: 3, useMmr: true, mmrLambda: 0.7 });

    assert.ok(
      chunks.some((c) => c.chunkId === 2),
      "the same-section chunk survives MMR selection even without a lexical match"
    );
  });

  it("recovers via exact keyword match even when the dense pass is completely empty", async () => {
    const exactMatch = point(0, 0.4, [1, 0]);
    exactMatch.payload.pageContent = "The foreword was written by a fellow marketer.";

    const { service } = build({
      onSearch: (options) => (options.scoreThreshold === 0 ? [exactMatch] : []),
    });

    const { chunks } = await service.retrieve("Who wrote the foreword?", { useMmr: false });

    assert.ok(
      chunks.some((c) => c.chunkId === 0),
      "an exact keyword hit rescues a chunk even though dense search found nothing at all"
    );
  });

  it("still widens the pool when the question has no meaningful keywords", async () => {
    // No keywords means the lexical pass contributes nothing, but the
    // raw-similarity widening still runs — it doesn't depend on keywords.
    const { service, calls } = build({ points: [point(1, 0.9, [1, 0])] });

    await service.retrieve("What is this?", { useMmr: false });

    assert.equal(calls.length, 2);
  });

  it("protects a lexically-rescued chunk even when the source text capitalizes the matched term", async () => {
    // Mirrors a real bug found against founder.pdf: the question's keyword is
    // always lowercased (extractKeywords), but PDF-extracted text routinely
    // capitalizes the very word being searched for — a label like "Author:",
    // a heading, a sentence-initial word. The underlying BM25 package matches
    // with a case-sensitive regex, so without normalising case before scoring
    // (lexicalRetrievalService.js), a keyword could score zero against every
    // chunk in the pool even though it appears verbatim, just capitalized —
    // silently disabling the lexical guarantee for exactly the chunks (short,
    // label-like, capitalized) it exists to protect. Shaped like the
    // "protects a lexically-rescued chunk..." test above, but with a
    // capitalized source term and enough filler that only the lexical
    // guarantee (not raw similarity) can save it from MMR.
    const authorChunk = point(4, 0.5, [0.9, 0.1]);
    authorChunk.payload.pageContent = "Copyright page. Author: Jane Doe.";
    const neighbour = point(5, 0.7, [0.91, 0.09]);
    const filler = Array.from({ length: 6 }, (_, i) => point(10 + i, 0.6, [0, 1 + i * 1e-6]));

    const { service } = build({
      onSearch: (options) =>
        options.scoreThreshold === 0
          ? [neighbour, authorChunk, ...filler]
          : [neighbour, ...filler],
    });

    const { chunks } = await service.retrieve("Who is the author?", {
      limit: 7,
      useMmr: true,
    });

    assert.ok(
      chunks.some((c) => c.chunkId === 4),
      "the capitalized 'Author:' chunk survives MMR selection via the lexical guarantee"
    );
  });

  it("does not introduce a chunk that never appears in the wide pool either", async () => {
    const denseChunk = point(1, 0.9, [1, 0]);
    denseChunk.payload.pageContent = "Nothing here matches the query terms.";

    const { service } = build({ points: [denseChunk] });

    const { chunks } = await service.retrieve("Who is the author?", { useMmr: false });

    assert.deepEqual(chunks.map((c) => c.chunkId), [1]);
  });
});

describe("retrievalService — query expansion", () => {
  const NARROW_LIMIT = 5;
  const WIDE_LIMIT = 100;
  const VARIANT_LIMIT = 10;

  function buildWithExpansion({ onSearch, expandQuery }) {
    const searchCalls = [];
    const expandQueryCalls = [];

    const service = createRetrievalService({
      embedText: async () => [1, 0],
      // Real variants are batched into one embedTexts() call now — mirror
      // that shape so tests don't reach the real network-calling default.
      embedTexts: async (texts) => texts.map(() => [1, 0]),
      searchPoints: async (vector, options) => {
        searchCalls.push(options);
        return onSearch(options);
      },
      expandQuery: async (question) => {
        expandQueryCalls.push(question);
        return expandQuery ? expandQuery(question) : [];
      },
      logger: createTestLogger(),
    });

    return { service, searchCalls, expandQueryCalls };
  }

  it("does not call expandQuery when useQueryExpansion is not set (default off)", async () => {
    const { service, expandQueryCalls } = buildWithExpansion({
      onSearch: () => [],
      expandQuery: () => ["a paraphrase"],
    });

    await service.retrieve("Who wrote this book?", { useMmr: false });

    assert.equal(expandQueryCalls.length, 0);
  });

  it("skips the paraphrase LLM call entirely when the dense pass's top hit is already lexically confirmed", async () => {
    // A direct, confident question: the dense pass's own top-ranked chunk
    // literally contains the question's keyword too, so dense and lexical
    // signals already agree — nothing is left for a paraphrase to rescue.
    // This is the general (non-question-specific) latency optimisation: skip
    // the extra chat completion, and its own embedding + search round trips,
    // whenever that structural agreement holds, for any question.
    const authorChunk = point(1, 0.6, [1, 0]);
    authorChunk.payload.pageContent = "Author: Sakthivel Pannerselvam.";

    const { service, expandQueryCalls } = buildWithExpansion({
      onSearch: (options) => (options.limit === WIDE_LIMIT ? [authorChunk] : [authorChunk]),
      expandQuery: () => ["a paraphrase"],
    });

    const { chunks, timings } = await service.retrieve("Who is the author?", {
      useMmr: false,
      useQueryExpansion: true,
    });

    assert.equal(expandQueryCalls.length, 0, "expandQuery is never called");
    assert.ok(timings.expansionMs < 5, "the expansion stage does virtually no work");
    assert.ok(chunks.some((c) => c.chunkId === 1), "the confirmed chunk is still returned");
  });

  it("still calls expandQuery when the dense pass's top hit has no lexical confirmation at all", async () => {
    // The opposite of the case above: the top dense hit does NOT literally
    // contain any of the question's keywords, so dense and lexical signals
    // disagree (or lexical found nothing) — a paraphrase might still help,
    // so expansion must still run exactly as before.
    const unrelatedTopHit = point(1, 0.6, [1, 0]);
    unrelatedTopHit.payload.pageContent = "This chunk never mentions that role at all.";

    const { service, expandQueryCalls } = buildWithExpansion({
      onSearch: (options) => (options.limit === VARIANT_LIMIT ? [] : [unrelatedTopHit]),
      expandQuery: () => ["a paraphrase"],
    });

    await service.retrieve("Who is the author?", { useMmr: false, useQueryExpansion: true });

    assert.equal(expandQueryCalls.length, 1, "expandQuery still runs when nothing already confirms the top hit");
  });

  it("promotes a chunk that a paraphrase ranks well, above one only the original phrasing found", async () => {
    // Mirrors the real gap: "Who wrote this book?" ranks the copyright page's
    // "Author: X" chunk below chunks that just say the person's name more
    // often; a paraphrase like "Who is the author?" ranks it clearly higher.
    // Fusing that paraphrase's own search back in should let the chunk win
    // overall, without either phrasing sharing a single literal keyword.
    const authorChunk = point(0, 0.6, [1, 0]);
    authorChunk.payload.pageContent = "Copyright page. Author: Sakthivel Pannerselvam.";
    const nameChunk = point(1, 0.9, [0, 1]);
    nameChunk.payload.pageContent = "Sakthi thanks everyone who helped with the book.";

    const { service } = buildWithExpansion({
      onSearch: (options) => {
        if (options.limit === WIDE_LIMIT) return [];
        if (options.limit === VARIANT_LIMIT) return [authorChunk];
        return [nameChunk, authorChunk]; // narrow pass: nameChunk ranks first
      },
      expandQuery: () => ["Who is the author?"],
    });

    const { chunks } = await service.retrieve("What is this?", {
      useMmr: false,
      useQueryExpansion: true,
    });

    assert.equal(chunks[0].chunkId, 0, "the author chunk wins overall once the paraphrase is fused in");
  });

  it("protects an expansion-confirmed chunk from being diversity-penalized out by MMR", async () => {
    // Mirrors a real bug found against founder.pdf: "Who is the person who
    // wrote the book?" ranked the copyright page's "Author: X" chunk 5th of 5
    // pre-MMR (no literal keyword ties it to the question at all), and MMR's
    // diversity trade-off then dropped it in favour of chunks that only
    // looked more "diverse" — even though a paraphrase's own search ranked it
    // clearly among the best matches. Same shape as the lexical-rescue MMR
    // test above, but the corroborating signal here is semantic, not lexical.
    const authorChunk = point(0, 0.5, [0.9, 0.1]); // similar vector to neighbour...
    authorChunk.payload.pageContent = "Copyright page. Author: Sakthivel Pannerselvam.";
    const neighbour = point(5, 0.7, [0.91, 0.09]); // ...ranks higher, would normally win MMR's slot
    const filler = Array.from({ length: 6 }, (_, i) => point(10 + i, 0.6, [0, 1 + i * 1e-6]));

    const { service } = buildWithExpansion({
      onSearch: (options) => {
        if (options.limit === VARIANT_LIMIT) return [authorChunk]; // the paraphrase ranks it #1
        return [neighbour, ...filler]; // narrow pass never finds it at all
      },
      expandQuery: () => ["Who is the author of this book?"],
    });

    const { chunks } = await service.retrieve("Who is the person who wrote the book?", {
      limit: 7,
      useMmr: true,
      useQueryExpansion: true,
    });

    assert.ok(
      chunks.some((c) => c.chunkId === 0),
      "the expansion-confirmed author chunk survives MMR selection"
    );
  });

  it("still gives an expansion-confirmed chunk a guaranteed slot even when lexical matches alone would fill the whole budget", async () => {
    // Mirrors the exact real bug: "Who is the person who wrote the book?"
    // extracts keywords ["person", "wrote"], which lexically matched enough
    // other chunks to fill the entire 3-slot corroborated-evidence budget on
    // their own — silently squeezing out the expansion-confirmed author
    // chunk even though it was computed correctly, because it was appended
    // after an already-full lexical allocation instead of sharing the budget.
    const authorChunk = point(0, 0.5, [0.9, 0.1]);
    authorChunk.payload.pageContent = "Copyright page. Author: Sakthivel Pannerselvam.";
    const lex1 = point(20, 0.6, [0.2, 0.9]);
    lex1.payload.pageContent = "A person once wrote about something else entirely.";
    const lex2 = point(21, 0.6, [0.21, 0.9]);
    lex2.payload.pageContent = "Another person who wrote a different passage.";
    const lex3 = point(22, 0.6, [0.22, 0.9]);
    lex3.payload.pageContent = "Yet another person wrote something unrelated.";
    const neighbour = point(5, 0.7, [0.91, 0.09]);
    const filler = Array.from({ length: 6 }, (_, i) => point(30 + i, 0.6, [0, 1 + i * 1e-6]));

    const { service } = buildWithExpansion({
      onSearch: (options) => {
        if (options.limit === VARIANT_LIMIT) return [authorChunk];
        if (options.limit === WIDE_LIMIT) return [neighbour, lex1, lex2, lex3, ...filler];
        return [neighbour, ...filler]; // narrow pass never finds the author chunk at all
      },
      expandQuery: () => ["Who is the author of this book?"],
    });

    const { chunks } = await service.retrieve("Who is the person who wrote the book?", {
      limit: 5,
      useMmr: true,
      useQueryExpansion: true,
    });

    assert.ok(
      chunks.some((c) => c.chunkId === 0),
      "the expansion-confirmed chunk still gets a guaranteed slot alongside three lexical matches"
    );
  });

  it("runs a separate dense search per generated variant, embedding the variant's own text", async () => {
    const denseChunk = point(1, 0.9, [1, 0]); // narrow pass finds something, so expansion runs
    const { service, searchCalls } = buildWithExpansion({
      onSearch: (options) =>
        options.limit === VARIANT_LIMIT ? [point(2, 0.7, [1, 0])] : [denseChunk],
      expandQuery: () => ["variant one", "variant two"],
    });

    await service.retrieve("What is this?", { useMmr: false, useQueryExpansion: true });

    const variantCalls = searchCalls.filter((c) => c.limit === VARIANT_LIMIT);
    assert.equal(variantCalls.length, 2, "one dense search per variant");
  });

  it("searches a variant unfiltered, like the wide pool, so a borderline chunk isn't filtered out twice", async () => {
    // The whole point of expansion is to rescue a chunk that scores just
    // under scoreThreshold on the phrasing actually asked (measured against
    // the real book: 0.516 and 0.502 against two variants, both just under a
    // 0.52 threshold) — holding the variant search to that same threshold
    // would filter out exactly the rescue it exists to make.
    const denseChunk = point(1, 0.9, [1, 0]); // narrow pass finds something, so expansion runs
    const { service, searchCalls } = buildWithExpansion({
      onSearch: (options) => (options.limit === VARIANT_LIMIT ? [] : [denseChunk]),
      expandQuery: () => ["a paraphrase"],
    });

    await service.retrieve("What is this?", {
      useMmr: false,
      useQueryExpansion: true,
      scoreThreshold: 0.42,
    });

    const variantCall = searchCalls.find((c) => c.limit === VARIANT_LIMIT);
    assert.equal(variantCall.scoreThreshold, 0);
  });

  it("still declines an off-topic question even with expansion enabled — no chunk gets resurrected just because a paraphrase was tried", async () => {
    const { service } = buildWithExpansion({
      onSearch: () => [], // nothing clears the real threshold, original or paraphrased
      expandQuery: () => ["a differently worded off-topic question"],
    });

    const { chunks } = await service.retrieve("What is the capital of France?", {
      useQueryExpansion: true,
    });

    assert.deepEqual(chunks, []);
  });

  it("does not fail the request when expandQuery itself throws", async () => {
    const denseChunk = point(1, 0.9, [1, 0]);
    const { service } = buildWithExpansion({
      onSearch: () => [denseChunk],
      expandQuery: () => {
        throw new Error("model unavailable");
      },
    });

    const { chunks } = await service.retrieve("What is this?", {
      useMmr: false,
      useQueryExpansion: true,
    });

    assert.ok(chunks.some((c) => c.chunkId === 1), "still answers from the original query alone");
  });

  it("does not run a paraphrase search at all when the original dense pass found nothing", async () => {
    // Same "best guess needs corroboration" gate the wide pool's own
    // raw-similarity signal uses: without it, a genuinely off-topic
    // question's own paraphrase (which a real LLM will produce for *any*
    // input, on- or off-topic) could resurrect chunks a totally unrelated
    // question has no business retrieving.
    const { service, expandQueryCalls } = buildWithExpansion({
      onSearch: () => [], // the original wording's narrow dense pass finds nothing
      expandQuery: () => ["a differently worded version of the question"],
    });

    await service.retrieve("What is this?", { useMmr: false, useQueryExpansion: true });

    assert.equal(expandQueryCalls.length, 0, "expansion never runs without an already-plausible dense pass");
  });

  it("promotes a chunk via a paraphrase when the dense pass found something, even with no matching keywords", async () => {
    // Complements the keyword-only rescue already covered above: here nothing
    // lexical ties the question to the chunk at all, only the paraphrase's
    // own dense search does.
    const rescued = point(7, 0.55, [1, 0]);
    rescued.payload.pageContent = "Some genuinely relevant passage, phrased quite differently.";
    const denseChunk = point(1, 0.9, [0, 1]);

    const { service } = buildWithExpansion({
      onSearch: (options) => {
        if (options.limit === WIDE_LIMIT) return [];
        if (options.limit === VARIANT_LIMIT) return [rescued];
        return [denseChunk];
      },
      expandQuery: () => ["a differently worded version of the question"],
    });

    const { chunks } = await service.retrieve("What is this?", {
      useMmr: false,
      useQueryExpansion: true,
    });

    assert.ok(chunks.some((c) => c.chunkId === 7));
  });
});

describe("retrievalService — hybrid retrieval boundary (abstract query, concrete-fact chunk)", () => {
  // Characterizes a genuine, investigated limitation (not a bug): a question
  // naming an abstract theme (e.g. "personal struggles") whose real answer is
  // a handful of concrete facts (e.g. "quit my job", "no salary", a named
  // event) sharing zero vocabulary with the question, buried inside a larger
  // chunk dominated by a different topic. Measured against the real book:
  // dense search alone ranks that chunk outside the top 30 of 87; BM25 alone
  // (proper IDF, not a naive count) doesn't find it in the top 20 either — it
  // has only one weak, common-word overlap; and query expansion's own
  // generated paraphrases don't reliably surface it, since an LLM paraphrase
  // of an abstract theme tends to stay abstract. These tests document that
  // the three-signal hybrid pipeline still behaves correctly and safely at
  // that boundary — it doesn't fabricate false positives when every signal
  // genuinely comes up empty — and that it *does* still work whenever any one
  // signal has a real hook, which is the actual, general capability this
  // system offers; this specific class of "no shared vocabulary anywhere, in
  // any form" case remains a known limitation of the embedding model, not
  // something a retrieval-side change can safely force past without
  // resurrecting irrelevant chunks for other, genuinely off-topic questions.
  it("does not resurrect a chunk when dense, lexical, and every expansion variant genuinely find nothing", async () => {
    const denseChunk = point(1, 0.9, [1, 0]);
    denseChunk.payload.pageContent = "Completely unrelated marketing content.";

    const { service } = build({
      onSearch: (options) => {
        if (options.limit === 10) return []; // variant searches also find nothing
        return [denseChunk];
      },
      // No fake expandQuery is wired through `build`, so this exercises the
      // real default — irrelevant here since useQueryExpansion is left off,
      // matching how this scenario is actually gated in the widening logic.
    });

    const { chunks } = await service.retrieve("What personal struggles preceded the venture?", {
      useMmr: false,
    });

    // The one unrelated dense hit is the only thing that could appear — nothing
    // resurrects a chunk with no genuine connection to the question at all.
    assert.ok(chunks.every((c) => c.chunkId === 1));
  });

  it("still rescues a concrete-fact chunk once any one signal — dense, lexical, or a paraphrase — actually connects to it", async () => {
    // Same shape of question, but this time the target chunk has a real,
    // if weak, hook: a paraphrase's own dense search ranks it decently. This
    // is the general mechanism working as designed — the boundary above is
    // about having literally no hook in any signal, not about weak hooks
    // being ignored.
    const concreteFactChunk = point(10, 0.5, [0.3, 0.9]);
    concreteFactChunk.payload.pageContent = "I quit my job. I had no salary. The weather that year was the worst.";
    const dominantChunk = point(1, 0.9, [1, 0]);
    dominantChunk.payload.pageContent = "The marketing campaign itself, in detail.";

    const service = createRetrievalService({
      embedText: async () => [1, 0],
      embedTexts: async (texts) => texts.map(() => [1, 0]),
      searchPoints: async (vector, options) =>
        options.limit === 10 ? [concreteFactChunk] : [dominantChunk], // a paraphrase finds it
      expandQuery: async () => ["What hardship did the founder face financially?"],
      logger: createTestLogger(),
    });

    const { chunks } = await service.retrieve("What personal struggles preceded the venture?", {
      useMmr: false,
      useQueryExpansion: true,
    });

    assert.ok(chunks.some((c) => c.chunkId === 10), "a genuine hook in any one signal still rescues the chunk");
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
