const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { rankByBm25 } = require("../../services/lexicalRetrievalService");

const point = (id, pageContent) => ({ id, payload: { chunkId: id, pageContent } });

describe("rankByBm25", () => {
  it("returns nothing when no keyword appears anywhere in the pool", async () => {
    const points = [point(1, "some unrelated text"), point(2, "more unrelated text")];

    const ranked = await rankByBm25(points, ["author"]);

    assert.deepEqual(ranked, []);
  });

  it("ranks a chunk covering more distinct keywords above one repeating a single keyword", async () => {
    const singleRepeated = point(1, "author author author");
    const bothPresent = point(2, "author sakthivel");
    const points = [singleRepeated, bothPresent];

    const ranked = await rankByBm25(points, ["author", "sakthivel"]);

    assert.equal(ranked[0].id, 2, "distinct coverage of both keywords ranks first");
  });

  it("weighs a rare, discriminating keyword above one that is common across the pool", async () => {
    // "business" appears in nearly every chunk of a book about business — a
    // weak, undiscriminating signal — while "sakthivel" appears in exactly
    // one. BM25's inverse-document-frequency term should value the rare hit
    // more than the common one, unlike a plain frequency count.
    const rareHit = point(1, "the author's name is sakthivel");
    const commonOnly = [2, 3, 4, 5, 6].map((id) => point(id, "this chunk also talks about business"));
    const points = [rareHit, ...commonOnly];

    const ranked = await rankByBm25(points, ["business", "sakthivel"]);

    assert.equal(ranked[0].id, 1, "the rare, distinctive keyword outweighs the common one");
  });

  it("returns an empty list for an empty keyword list or an empty pool", async () => {
    assert.deepEqual(await rankByBm25([point(1, "text")], []), []);
    assert.deepEqual(await rankByBm25([], ["author"]), []);
  });

  it("honors the k option to cap how many results come back", async () => {
    const points = [1, 2, 3, 4, 5].map((id) => point(id, `chunk ${id} mentions the author distinctly`));

    const ranked = await rankByBm25(points, ["author"], { k: 2 });

    assert.equal(ranked.length, 2);
  });

  it("returns the original point objects, not copies or LangChain Documents", async () => {
    const original = point(1, "the author wrote this");

    const ranked = await rankByBm25([original], ["author"]);

    assert.equal(ranked[0], original);
  });

  it("matches a keyword against differently-cased source text (a capitalized label, a sentence-initial word)", async () => {
    // extractKeywords() always lowercases the question, but PDF-extracted text
    // routinely capitalizes the very word a question asks about — a label
    // ("Author: Jane Doe"), a heading, or just the start of a sentence. The
    // underlying "okapibm25" package matches with a case-sensitive regex, so
    // without normalising case here, a keyword can score zero against every
    // chunk in the pool even though it appears verbatim, just capitalized.
    const labelled = point(1, "Business Development - Jane Doe\nAuthor: Jane Doe");
    const sentenceInitial = point(2, "Author of three prior books, she began writing young.");
    const unrelated = point(3, "this chunk never mentions that role at all");
    const points = [labelled, sentenceInitial, unrelated];

    const ranked = await rankByBm25(points, ["author"]);

    assert.deepEqual(
      ranked.map((p) => p.id),
      [1, 2],
      "both capitalized occurrences are found, ranked above the chunk with no match at all"
    );
  });
});
