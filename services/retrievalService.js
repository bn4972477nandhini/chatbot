const { config } = require("../config/env");
const { logger: defaultLogger } = require("../lib/logger");
const { embedText: defaultEmbedText, embedTexts: defaultEmbedTexts } = require("./embeddingService");
const { maximalMarginalRelevance } = require("./mmr");
const { searchPoints: defaultSearchPoints } = require("./qdrantService");
const { createQueryExpansionService } = require("./queryExpansionService");
const { rankByBm25 } = require("./lexicalRetrievalService");
const { isNumericQuestion } = require("./queryUnderstanding");

const { expandQuery: defaultExpandQuery } = createQueryExpansionService();

const TOP_K = config.retrieval.topK;
const SCORE_THRESHOLD = config.retrieval.scoreThreshold;

/**
 * Retrieval strategies.
 *
 * Only dense vector search is implemented today. The seam exists so sparse
 * (BM25 / SPLADE) and hybrid fusion can be added without touching chatService
 * or the routes: implement the strategy, register it here, and switch via the
 * `strategy` option or RETRIEVAL_STRATEGY.
 */
const STRATEGIES = {
  DENSE: "dense",
  SPARSE: "sparse",
  HYBRID: "hybrid",
};

// Words too generic to distinguish one chunk from another. Deliberately small
// and generic — this is not tuned to any specific question or answer.
const STOPWORDS = new Set([
  "what", "who", "whom", "whose", "which", "when", "where", "why", "how",
  "this", "that", "these", "those", "book", "does", "did", "do", "is", "are",
  "was", "were", "will", "would", "should", "could", "can", "give", "example",
  "please", "tell", "about", "with", "from", "into", "your", "you", "the",
  "and", "for", "not",
]);
const MIN_KEYWORD_LENGTH = 4;

// A wide, unfiltered pool the fallback scans — large enough to cover a
// book-sized collection without scaling into a full corpus scan.
const FALLBACK_POOL_SIZE = 100;
const FALLBACK_MATCH_COUNT = 10;

// An explicit "Label: Value" line inline in ordinary prose (e.g. a copyright
// page's "Author: Jane Doe") is exactly the same kind of direct, on-point
// evidence hasStructuredData already rewards — it just isn't the wide-gap
// flattened-table shape labelValueExtractor.js looks for, so the indexer
// never flags it. Generic (any capitalized label word, not tied to "Author"
// or any one book), and deliberately narrow: requires the value to start
// with a capital letter or digit, so it does not fire on an ordinary
// mid-sentence colon. Checked against the real indexed book: matches 15/87
// chunks, 14 of which are already-flagged "SPENT: Rs..." lines this changes
// nothing for; the one new match is the "Author: Sakthivel Pannerselvam"
// copyright-page line.
const INLINE_LABEL_VALUE_RE = /\b[A-Z][a-zA-Z]{2,20}\s*:\s*[A-Z0-9]/;
const hasInlineLabelValue = (point) => INLINE_LABEL_VALUE_RE.test(point.payload?.pageContent ?? "");

/**
 * Pulls the distinctive words out of a question — lowercased, punctuation
 * stripped, stopwords and short filler words removed. Exported for testing.
 *
 * A trailing possessive/contraction "'s" is stripped before filtering, e.g.
 * "writer's" -> "writer" and "what's" -> "what". Without this, a possessive
 * keyword can never lexically match its bare form in chunk text ("writer's"
 * doesn't appear anywhere even when "writer" does), and a contraction like
 * "what's" survives as a spurious keyword even though its base form is
 * already in STOPWORDS.
 */
function extractKeywords(question) {
  const words = (question.toLowerCase().match(/[a-z0-9']+/g) ?? [])
    .map((word) => word.replace(/'s$/, ""))
    .filter((word) => word.length >= MIN_KEYWORD_LENGTH && !STOPWORDS.has(word));
  return [...new Set(words)];
}

/**
 * Reciprocal Rank Fusion — the merge step a hybrid retriever needs.
 *
 * Implemented and tested now so that adding a sparse retriever later is purely
 * additive. Fuses ranked lists by rank rather than score, which avoids having to
 * normalise incomparable scoring scales.
 */
function reciprocalRankFusion(rankedLists, { k = 60, key = (item) => item.id } = {}) {
  const scores = new Map();

  for (const list of rankedLists) {
    list.forEach((item, rank) => {
      const id = key(item);
      const existing = scores.get(id);
      const contribution = 1 / (k + rank + 1);

      if (existing) existing.score += contribution;
      else scores.set(id, { item, score: contribution });
    });
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);
}

/**
 * Builds a retrieval service. Dependencies are injected with real defaults so
 * tests can drive the logic without an OpenAI key or a running Qdrant.
 */
function createRetrievalService({
  embedText = defaultEmbedText,
  embedTexts = defaultEmbedTexts,
  searchPoints = defaultSearchPoints,
  expandQuery = defaultExpandQuery,
  logger = defaultLogger,
} = {}) {
  /**
   * Embeds the question and returns the most relevant chunks.
   *
   * @param {string} question
   * @param {object} [options]
   * @param {number} [options.limit]              top K to return
   * @param {number} [options.scoreThreshold]     minimum cosine score
   * @param {boolean}[options.useMmr]             diversity re-ranking
   * @param {number} [options.mmrLambda]          1 = relevance, 0 = diversity
   * @param {object} [options.filter]             Qdrant payload filter
   * @param {string} [options.strategy]
   * @param {boolean}[options.useQueryExpansion]  also search on a couple of
   *   alternative phrasings of the question (see queryExpansionService.js) —
   *   off by default (config.retrieval.useQueryExpansion), since it costs one
   *   extra chat completion per question
   * @returns {Promise<{chunks: Array, timings: object}>}
   */
  async function retrieve(question, options = {}) {
    if (typeof question !== "string" || question.trim() === "") {
      throw new Error("retrieve requires a non-empty question.");
    }

    const {
      limit = TOP_K,
      scoreThreshold = SCORE_THRESHOLD,
      useMmr = config.retrieval.useMmr,
      mmrLambda = config.retrieval.mmrLambda,
      filter,
      strategy = STRATEGIES.DENSE,
      useQueryExpansion = config.retrieval.useQueryExpansion,
    } = options;

    if (strategy !== STRATEGIES.DENSE) {
      // Fail loudly rather than silently degrading to dense results.
      throw new Error(
        `Retrieval strategy "${strategy}" is not implemented yet. Only "dense" is available.`
      );
    }

    const keyOf = (point) => point.payload?.chunkId ?? point.id;

    const embedStartedAt = Date.now();
    const vector = await embedText(question);
    const embedMs = Date.now() - embedStartedAt;

    // MMR needs a wider pool to have anything to diversify between; without it
    // the pool is exactly the requested number of results.
    const poolSize = useMmr
      ? Math.min(limit * config.retrieval.mmrPoolMultiplier, 100)
      : limit;

    const searchStartedAt = Date.now();
    const denseSearchStartedAt = searchStartedAt;
    const densePoints = await searchPoints(vector, {
      limit: poolSize,
      scoreThreshold,
      withPayload: true,
      withVector: useMmr,
      filter,
    });
    const denseSearchMs = Date.now() - denseSearchStartedAt;

    // Dense embeddings can under-rank a short, fact-dense chunk (a copyright
    // page's "Author: X" line) against a natural-language question, even
    // though the chunk is a strong, obviously relevant match once you widen
    // the net a little — it just misses the strict score_threshold cutoff by
    // a small margin.
    let candidatePoints = densePoints;
    let lexicalMatchCount = 0;
    let lexicalMatches = [];
    let expandedQueryCount = 0;
    let expansionMatches = [];
    const rankedLists = [];

    const keywords = extractKeywords(question);
    // Widening is worth the extra Qdrant round trip either when the dense
    // pass already found something topically plausible, or when the question
    // has distinctive keywords an exact-match pass could still recover even
    // if dense similarity missed the topic entirely (e.g. a term embedded
    // poorly, or oddly tokenised text from PDF extraction).
    const shouldWiden = densePoints.length > 0 || keywords.length > 0;

    const widenStartedAt = Date.now();
    if (shouldWiden) {
      const widePool = await searchPoints(vector, {
        limit: FALLBACK_POOL_SIZE,
        scoreThreshold: 0,
        withPayload: true,
        withVector: useMmr,
        filter,
      });

      rankedLists.push(densePoints);

      // Exact-term signal: catches a chunk dense embedding poorly represents
      // at all (jargon, codes, names) but that literally contains the term.
      // Deliberately independent of whether the dense pass found anything —
      // a literal hit on a distinctive term is strong evidence on its own,
      // so a question dense search misses entirely (wrong topic vector, but
      // right words) can still be answered rather than declined outright.
      // Ranked by BM25 (see lexicalRetrievalService.js) rather than a plain
      // frequency count, so a keyword common across many chunks (weak,
      // undiscriminating) doesn't crowd a genuinely on-topic chunk out of the
      // capped top results the way an unweighted count would.
      if (keywords.length > 0) {
        lexicalMatches = await rankByBm25(widePool, keywords, { k: FALLBACK_MATCH_COUNT });
        lexicalMatchCount = lexicalMatches.length;
        if (lexicalMatches.length > 0) rankedLists.push(lexicalMatches);
      }

      // Raw-similarity signal: recovers a chunk dense search DOES recognise as
      // relevant, just not confidently enough to clear scoreThreshold alone —
      // MMR is left to decide, on real relevance and diversity, whether it
      // actually earns a place in the final answer. Unlike the exact-term
      // signal above, this is only ever a "best guess", so it stays gated
      // behind the dense pass finding something at all — without that gate a
      // genuinely off-topic question (no keyword hits either) would still get
      // its nearest, if irrelevant, chunks resurrected instead of declining.
      if (densePoints.length > 0) {
        rankedLists.push(widePool.slice(0, FALLBACK_MATCH_COUNT));
      }
    }
    const widenMs = Date.now() - widenStartedAt;

    // A paraphrase call only ever exists to rescue a chunk the dense pass
    // under-ranked for the exact wording asked. When the dense pass's own top
    // hit is *already* independently confirmed by an exact keyword match,
    // there is nothing left for a paraphrase to rescue — dense and lexical
    // signals already agree on the same chunk, so the question is a confident,
    // direct match rather than an ambiguous one. Skipping the LLM call (plus
    // its own embedding + search round trips) in that case is a pure latency
    // win with no accuracy cost: this is a structural agreement between two
    // independent signals, not a guess about question wording or topic, so it
    // generalises to any question rather than any specific phrasing. When the
    // signals do NOT already agree — no keyword overlap at all, or the
    // keyword match lands on a different chunk than the dense pass's top pick
    // — expansion still runs exactly as before.
    // A BM25 pass can rank the top dense chunk into its results off a single
    // matched keyword among several extracted from the question — BM25 sums
    // per-term scores, it does not require every term to hit. Real case found
    // against founder.pdf: "What's the writer's identity?" extracts ["writer",
    // "identity"], and the acknowledgments chunk (which only happens to
    // describe a different person's job title as "Content Writer") matched on
    // "writer" alone and was wrongly treated as agreeing with the dense pass —
    // which suppressed the paraphrase rescue that would have found the book's
    // actual "Author: X" chunk. Requiring every extracted keyword to appear in
    // the top chunk's own text (not just that chunk's membership in a pooled,
    // multi-keyword BM25 ranking) is a stronger check for genuine agreement,
    // and needs no extra Qdrant/BM25 round trip.
    const topDensePoint = densePoints.length > 0 ? densePoints[0] : null;
    const topDenseKey = topDensePoint != null ? keyOf(topDensePoint) : null;
    const topDenseText = (topDensePoint?.payload?.pageContent ?? "").toLowerCase();
    const matchedKeywordCount = keywords.filter((keyword) => topDenseText.includes(keyword)).length;
    // A short, generic question (few extracted keywords) makes "most of them
    // matched" too easy to satisfy by chance to mean anything — e.g. matching
    // 1 of 2 keywords is not real corroboration (measured: this is exactly
    // the shape of "What's the writer's identity?", which must keep requiring
    // every keyword to match). Only once there are enough distinctive
    // keywords (>=4) does a majority match become a genuine, distinguishing
    // confidence signal rather than noise — measured against the real book,
    // this safely confirms a clearly on-topic, highly-scored dense hit like
    // "How much was spent on the first campaign at the IIT Chennai fest?"
    // (5 of 8 keywords, 0.77 dense score) without also confirming weakly-
    // matched, still-ambiguous cases like the salon-campaign trap question
    // (1 of 3) or "Who is the author and what is his profession?" (1 of 2,
    // below the 4-keyword floor). Below the floor, the original all-or-
    // nothing rule still applies unchanged.
    const isTopDenseChunkLexicallyConfirmed =
      topDenseKey != null &&
      keywords.length > 0 &&
      (matchedKeywordCount === keywords.length ||
        (keywords.length >= 4 && matchedKeywordCount >= Math.ceil(keywords.length / 2)));

    // Paraphrase signal: a chunk dense search ranks reasonably for the
    // question as asked, but not prominently, can rank clearly higher for a
    // different phrasing of the same question (e.g. a "who is the AUTHOR"
    // question against a chunk headed "Author: X" ranks it well; "who WROTE
    // this book" ranks the same chunk lower, behind pages that just mention
    // the person's name more often) — and the whole point is to rescue a
    // chunk that scores just under scoreThreshold on the phrasing actually
    // asked, so a variant search held to that same threshold defeats its own
    // purpose (measured: a real rescue chunk scored 0.516 and 0.502 against
    // two variants, both just under a 0.52 threshold). Unfiltered like the
    // wide pool, and gated the same way: only contributed when the original
    // dense pass already found something plausible, OR the question has its
    // own distinctive keywords (the same `shouldWiden` gate widening itself
    // uses) — so an off-topic question with neither still can't trigger a
    // paraphrase. This is wider than the raw-similarity signal's gate just
    // above, which stays strictly dense-only: raw similarity resurrects a
    // chunk with no further check, so it needs real dense evidence to trust;
    // a paraphrase instead runs a fresh, real search of its own, so a
    // genuinely off-topic keyword-bearing question still comes up empty and
    // declines correctly (verified: the variant searches find nothing either,
    // exactly like the original ones did). Real case found against
    // founder.pdf: "What's the writer's identity?" has keywords but the
    // narrow dense pass clears zero results at all (its best raw score fell
    // just under scoreThreshold) — under the old dense-only gate this
    // silently fell back to lexical-only evidence and could never reach the
    // book's actual "Author: X" chunk, which shares no keyword with the
    // question, no matter how the question was phrased.
    const expansionStartedAt = Date.now();
    if (useQueryExpansion && shouldWiden && !isTopDenseChunkLexicallyConfirmed) {
      const variants = await expandQuery(question).catch(() => []);
      expandedQueryCount = variants.length;

      if (variants.length > 0) {
        // Batched into one embeddings call rather than one per variant: on
        // the local, CPU-only Ollama setup every call — embedding or chat —
        // is serialized through a single queue (openaiClient.js), so N
        // separate calls cost N full round trips with no concurrency benefit
        // whatsoever. One call embedding N variants together removes that
        // per-call overhead entirely. The Qdrant searches that follow are NOT
        // subject to that queue, so they run concurrently for a further,
        // smaller win.
        const variantVectors = await embedTexts(variants);
        const variantSearches = await Promise.all(
          variantVectors.map((variantVector) =>
            searchPoints(variantVector, {
              limit: FALLBACK_MATCH_COUNT,
              scoreThreshold: 0,
              withPayload: true,
              withVector: useMmr,
              filter,
            })
          )
        );

        const seenExpansionKeys = new Set();
        for (const variantPoints of variantSearches) {
          if (variantPoints.length > 0) rankedLists.push(variantPoints);

          // The best results a variant's own search ranked highest are as
          // strong a relevance signal as an exact keyword hit — a paraphrase
          // rather than a literal match, but independent corroboration either
          // way — so they earn the same MMR-diversity-penalty protection below.
          // Measured against the real book: the correct chunk placed 2nd or
          // 3rd (never 1st — a different chunk consistently mentions the same
          // person more often) depending on the exact generated wording, so a
          // top-2 cutoff was too narrow to reliably catch it; the actual
          // guarantee budget below is still capped independently of this.
          for (const p of variantPoints.slice(0, 3)) {
            const key = keyOf(p);
            if (seenExpansionKeys.has(key)) continue;
            seenExpansionKeys.add(key);
            expansionMatches.push(p);
          }
        }
      }
    }
    const expansionMs = Date.now() - expansionStartedAt;

    if (rankedLists.length > 0) {
      candidatePoints =
        rankedLists.length > 1
          ? reciprocalRankFusion(rankedLists, { key: keyOf })
          : rankedLists[0];
    }

    // An exact keyword match is strong, independent evidence of relevance —
    // unlike a raw cosine score, MMR's diversity trade-off has no way to know
    // that, so left alone it can (and, on a real "who wrote the foreword?"
    // query against this book, did) rank a lexically-confirmed chunk below
    // ones that only look more "diverse". The best lexical matches are
    // therefore carried through untouched by MMR, guaranteeing the
    // answer-bearing chunk can't be diversity-penalized out of the final
    // selection; MMR still governs the remaining slots as before. Capped well
    // below `limit` so MMR always keeps at least a couple of slots to work
    // with — this is a floor under strong evidence, not a replacement for it.
    const mmrStartedAt = Date.now();
    const selected = useMmr
      ? (() => {
          const candidateKeys = new Set(candidatePoints.map(keyOf));
          // MMR's first pick is always whichever remaining candidate has the
          // highest relevance score — no diversity penalty applies yet, since
          // nothing has been selected to be "close to" (see mmr.js). The
          // single top-ranked candidate is therefore going to be selected
          // regardless of any guarantee, so spending a guaranteed slot on it
          // is always wasted budget — and, worse, can starve a chunk that
          // actually needs rescuing (measured against the real book: a
          // dominant top chunk claimed the one available corroboration slot
          // via a paraphrase, even though a different, correct chunk was also
          // corroborated but ranked just behind it in that same signal).
          const topCandidateKey = candidatePoints.length > 0 ? keyOf(candidatePoints[0]) : null;

          // Independent corroborating evidence that a chunk is genuinely
          // relevant — an exact keyword hit or a paraphrase's own dense
          // search ranking it among its best results — earns equal trust
          // here; interleaving them (rather than giving lexical first claim
          // on the whole budget) means a single strong expansion match can't
          // be silently squeezed out just because a few lexical matches
          // happened to fill the cap first.
          const corroboratedCount = Math.min(3, Math.max(1, limit - 2));
          const guaranteedCorroborated = [];
          const guaranteedCorroboratedKeys = new Set();
          const needsRescue = (point) => {
            const key = keyOf(point);
            return candidateKeys.has(key) && key !== topCandidateKey;
          };
          const lexicalIter = lexicalMatches.filter(needsRescue)[Symbol.iterator]();
          const expansionIter = expansionMatches.filter(needsRescue)[Symbol.iterator]();
          let exhausted = false;
          while (guaranteedCorroborated.length < corroboratedCount && !exhausted) {
            const before = guaranteedCorroborated.length;
            for (const iter of [lexicalIter, expansionIter]) {
              if (guaranteedCorroborated.length >= corroboratedCount) break;
              const next = iter.next();
              if (next.done) continue;
              const key = keyOf(next.value);
              if (guaranteedCorroboratedKeys.has(key)) continue;
              guaranteedCorroboratedKeys.add(key);
              guaranteedCorroborated.push(next.value);
            }
            if (guaranteedCorroborated.length === before) exhausted = true;
          }

          // A chunk carrying an explicit LABEL: value line (the indexer's own
          // hasStructuredData flag, or the inline "Author: Name" pattern
          // detected above) is as strong, on-point evidence as a lexical or
          // expansion match — but unlike those, nothing previously guaranteed
          // it a slot, so MMR's diversity trade-off could (and, on a real
          // "who wrote this book?" query against this book, did) leave it out
          // of the final selection entirely even though it sat in the
          // candidate pool the whole time with a perfectly good score; the
          // directness bonus below could only ever re-rank a chunk MMR had
          // already chosen, not rescue one it hadn't. One such runner-up is
          // carried through the same way a lexical match is.
          //
          // Deliberately narrower than the directness *bonus* just below:
          // this only guarantees the inline-label case (e.g. "Author: X"),
          // not the indexer's pre-existing hasStructuredData flag. That flag
          // already matches 14 different campaigns' SPENT/REACH/ROI chunks
          // across the book — guaranteeing a slot for "any hasStructuredData
          // chunk in the pool" pulled in whichever one happened to rank
          // within the wide pool, not necessarily the one relevant to the
          // question actually asked, and measurably displaced a genuinely
          // useful narrative chunk on a real "how much was spent on the first
          // campaign at IIT Chennai" query. hasStructuredData chunks are
          // already well served by dense ranking plus the existing
          // STRUCTURED_NUMERIC_BONUS re-ranking below; only the inline-label
          // case — novel this change, and far rarer (1 real match in the
          // whole book, see hasInlineLabelValue above) — lacked any
          // guarantee at all before this.
          const directEvidenceGuaranteeCount = Math.min(1, Math.floor(limit / 5));
          const guaranteedDirectEvidence = candidatePoints
            .filter(
              (point) =>
                needsRescue(point) &&
                !guaranteedCorroboratedKeys.has(keyOf(point)) &&
                hasInlineLabelValue(point)
            )
            .slice(0, directEvidenceGuaranteeCount);
          const guaranteedDirectEvidenceKeys = new Set(guaranteedDirectEvidence.map(keyOf));

          // A chunk sharing the single best-ranked candidate's `section` is
          // structurally part of the same narrative unit (e.g. a campaign's
          // SPENT/REACH/ROI summary a page or two after the story that earned
          // it) — MMR has no notion of that relationship, only vector
          // similarity, so it can (and, on a real "how much was spent on the
          // first campaign at the IIT Chennai fest?" query against this book,
          // did) penalize such a chunk away for looking topically close to the
          // top pick, in favour of a chunk from an unrelated chapter that only
          // looks more "diverse". One same-section runner-up is carried
          // through the same way a lexical match is.
          const topSection = candidatePoints[0]?.payload?.section;
          const sectionGuaranteeCount = Math.min(1, Math.floor(limit / 3));
          const guaranteedSection =
            topSection == null
              ? []
              : candidatePoints
                  .slice(1)
                  .filter(
                    (point) =>
                      point.payload?.section === topSection &&
                      !guaranteedCorroboratedKeys.has(keyOf(point)) &&
                      !guaranteedDirectEvidenceKeys.has(keyOf(point))
                  )
                  .slice(0, sectionGuaranteeCount);

          const guaranteed = [
            ...guaranteedCorroborated,
            ...guaranteedDirectEvidence,
            ...guaranteedSection,
          ].slice(0, Math.max(0, limit - 1));
          const guaranteedKeys = new Set(guaranteed.map(keyOf));

          const remaining = maximalMarginalRelevance({
            queryVector: vector,
            candidates: candidatePoints.filter((point) => !guaranteedKeys.has(keyOf(point))),
            k: limit - guaranteed.length,
            lambda: mmrLambda,
          });

          // `guaranteed` exists to stop a corroborated chunk from being
          // excluded — it does not follow that it belongs first in the
          // presentation order. Concatenating guaranteed-then-remaining as-is
          // could place a lower-scoring guaranteed chunk ahead of a higher-
          // scoring MMR pick, and the resulting "Source N" position is a real
          // relevance signal the model reads: a chunk labelled last, even
          // when it is the best-scoring evidence available, measurably lost
          // out to a more prominent but less specific one in practice.
          // Re-sorting by score keeps the inclusion guarantee while making
          // the strongest evidence "Source 1" regardless of which mechanism
          // (guarantee or MMR) is why it is present at all.
          //
          // A small additional nudge on top of raw score: cosine similarity
          // alone can rank a chunk that only discusses a topic generally
          // above one that states the specific fact directly (an exact
          // keyword hit, or the indexer's own flag that this chunk carries a
          // structured LABEL: value line) — general, corpus-independent
          // signals of "this passage directly answers a factual question"
          // rather than "this passage is merely on the same topic". The
          // bonus is deliberately small (comparable to the score gap between
          // adjacent real sources, well below the gap between a genuinely
          // strong and a genuinely weak match), so it only reorders close
          // calls — it can promote a directly-confirmed chunk from "Source 3"
          // to "Source 1" among near-ties, but never overrides a clearly
          // higher-scoring, unconfirmed chunk.
          const DIRECTNESS_BONUS = 0.03;
          // A question asking for a quantity is disproportionately well
          // served by a chunk the indexer already flagged as carrying a
          // structured LABEL: value line — that pattern-detection is general
          // (queryUnderstanding.js has no notion of any specific figure or
          // campaign), so this only strengthens an existing general signal
          // for a general class of question, not a rule for any one number.
          const STRUCTURED_NUMERIC_BONUS = 0.06;
          const questionIsNumeric = isNumericQuestion(question);
          const lexicalMatchKeys = new Set(lexicalMatches.map(keyOf));
          const directnessBonus = (point) => {
            if (point.payload?.hasStructuredData === true) {
              return questionIsNumeric ? STRUCTURED_NUMERIC_BONUS : DIRECTNESS_BONUS;
            }
            if (lexicalMatchKeys.has(keyOf(point)) || hasInlineLabelValue(point)) {
              return DIRECTNESS_BONUS;
            }
            return 0;
          };
          const effectiveScore = (point) => (point.score ?? 0) + directnessBonus(point);

          return [...guaranteed, ...remaining].sort(
            (a, b) => effectiveScore(b) - effectiveScore(a)
          );
        })()
      : candidatePoints.slice(0, limit);
    const mmrMs = Date.now() - mmrStartedAt;
    const searchMs = Date.now() - searchStartedAt;

    const chunks = selected.map((point) => ({
      score: point.score,
      // Falls back to the point ID: payload.chunkId and the ID are written as
      // the same value by the indexer.
      chunkId: point.payload?.chunkId ?? point.id,
      pageContent: point.payload?.pageContent ?? "",
      source: point.payload?.source ?? "",
      page: point.payload?.page ?? null,
      pageEnd: point.payload?.pageEnd ?? null,
      section: point.payload?.section ?? null,
      sectionTitle: point.payload?.sectionTitle ?? null,
    }));

    // Per-stage breakdown so it's visible where request time actually goes on
    // the CPU-only local Ollama setup: embedMs and expansionMs are the only
    // stages that call the (serialized, single-queue) LLM client, so they
    // dominate total latency whenever they run; denseSearchMs/widenMs/mmrMs
    // are local Qdrant + in-process CPU work and are normally near-instant.
    const timings = {
      embedMs,
      denseSearchMs,
      widenMs,
      expansionMs,
      mmrMs,
      searchMs,
    };

    logger.debug("retrieval complete", {
      poolSize: densePoints.length,
      lexicalMatchCount,
      expandedQueryCount,
      expansionSkipped: useQueryExpansion && densePoints.length > 0 && isTopDenseChunkLexicallyConfirmed,
      returned: chunks.length,
      scoreThreshold,
      useMmr,
      ...timings,
    });

    return { chunks, timings };
  }

  return { retrieve };
}

module.exports = {
  createRetrievalService,
  reciprocalRankFusion,
  extractKeywords,
  STRATEGIES,
  TOP_K,
  SCORE_THRESHOLD,
};
