const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { chunkText, chunkPages, detectSections } = require("../../services/chunkService");

describe("chunkText", () => {
  it("still splits a plain string into Document[] (used by GET /read-pdf)", async () => {
    const chunks = await chunkText("a".repeat(50));
    assert.ok(chunks.length >= 1);
    assert.equal(typeof chunks[0].pageContent, "string");
  });
});

describe("detectSections", () => {
  it("keeps pre-divider pages in section 0 with no title", () => {
    const pages = [
      { pageNumber: 1, text: "" },
      {
        pageNumber: 2,
        text: "Title Page long enough text here that is clearly not a divider at all really",
      },
    ];

    const sections = detectSections(pages);

    assert.deepEqual(sections[0], { section: 0, sectionTitle: null });
    assert.deepEqual(sections[1], { section: 0, sectionTitle: null });
  });

  it("opens a new section at a short divider page followed by a title-length page", () => {
    const pages = [
      { pageNumber: 1, text: "3  1" }, // strips to "1" — a divider
      { pageNumber: 2, text: "4 A Fascinating Chapter About Something Interesting" },
      { pageNumber: 3, text: "Long narrative content about the chapter goes here and continues." },
    ];

    const sections = detectSections(pages);

    assert.equal(sections[0].section, 1);
    assert.equal(sections[1].section, 1);
    assert.ok(sections[1].sectionTitle.includes("Fascinating Chapter"));
    // The narrative page after the divider/title pair inherits the same section.
    assert.equal(sections[2].section, 1);
    assert.equal(sections[2].sectionTitle, sections[1].sectionTitle);
  });

  it("does not open a new section when a short trailing page has no valid title after it", () => {
    const pages = [
      { pageNumber: 1, text: "3  1" },
      { pageNumber: 2, text: "4 A Fascinating Chapter About Something Interesting" },
      { pageNumber: 3, text: "7  2" }, // looks divider-shaped, but...
      { pageNumber: 4, text: "" }, // ...the next page is empty, not a title
    ];

    const sections = detectSections(pages);

    // Still section 1 throughout — page 3/4 never open a second section.
    assert.equal(sections[2].section, 1);
    assert.equal(sections[3].section, 1);
  });

  it("increments through multiple real chapters", () => {
    const pages = [
      { pageNumber: 1, text: "1  1" },
      { pageNumber: 2, text: "2 First Chapter Title Here For Testing Purposes" },
      { pageNumber: 3, text: "Some narrative." },
      { pageNumber: 4, text: "4  2" },
      { pageNumber: 5, text: "5 Second Chapter Title Here For Testing Purposes" },
      { pageNumber: 6, text: "More narrative." },
    ];

    const sections = detectSections(pages);

    assert.equal(sections[2].section, 1);
    assert.equal(sections[5].section, 2);
    assert.notEqual(sections[2].sectionTitle, sections[5].sectionTitle);
  });
});

describe("chunkPages", () => {
  const repeat = (word, targetLength) => {
    let text = "";
    while (text.length < targetLength) text += `${word} `;
    return text.slice(0, targetLength);
  };

  it("attributes every chunk to a valid page range within the input", async () => {
    const pages = [
      { pageNumber: 1, text: repeat("alpha", 700) },
      { pageNumber: 2, text: repeat("beta", 700) },
      { pageNumber: 3, text: repeat("gamma", 700) },
    ];

    const chunks = await chunkPages(pages);

    assert.ok(chunks.length > 1, "long enough input to produce multiple chunks");

    for (const chunk of chunks) {
      assert.ok(chunk.metadata.page >= 1 && chunk.metadata.page <= 3);
      assert.ok(chunk.metadata.pageEnd >= chunk.metadata.page);
      assert.ok(chunk.metadata.pageEnd <= 3);
    }

    // The first chunk starts at the very beginning of the input.
    assert.equal(chunks[0].metadata.page, 1);
    // The last chunk ends at the very end of the input.
    assert.equal(chunks.at(-1).metadata.pageEnd, 3);
  });

  it("attributes a chunk that straddles multiple pages to the full range", async () => {
    // Mirrors the real book's shape: a couple of short pages (like a chapter
    // divider) followed by a long one — short pages easily merge into the same
    // chunk as their neighbours, exactly like 16 of founder.pdf's real 86
    // chunks do.
    const pages = [
      { pageNumber: 1, text: "x".repeat(60) },
      { pageNumber: 2, text: "y".repeat(60) },
      { pageNumber: 3, text: "z".repeat(900) },
    ];

    const chunks = await chunkPages(pages);

    assert.ok(
      chunks.some((c) => c.metadata.page < c.metadata.pageEnd),
      "at least one chunk spans more than one page"
    );
  });

  it("carries section metadata from detectSections onto each chunk", async () => {
    const pages = [
      { pageNumber: 1, text: "3  1" },
      { pageNumber: 2, text: "4 A Fascinating Chapter About Something Interesting" },
      { pageNumber: 3, text: repeat("narrative", 700) },
    ];

    const chunks = await chunkPages(pages);

    assert.ok(chunks.every((c) => c.metadata.section === 1));
    assert.ok(chunks.every((c) => c.metadata.sectionTitle?.includes("Fascinating Chapter")));
  });

  it("augments a page containing a flattened label/value table with normalized Label: Value lines", async () => {
    const tableText =
      "14 ZERO RUPEE MARKETING Myth Buster:- some framing prose here. SPENT  REACH  " +
      "ROI Rs.6000  20K reach  Orders worth of 35000";
    const pages = [{ pageNumber: 1, text: tableText }];

    const chunks = await chunkPages(pages);

    assert.equal(chunks.length, 1);
    // The original extracted text is still present, untouched.
    assert.ok(chunks[0].pageContent.includes(tableText));
    // A normalized, unambiguous restatement sits alongside it.
    assert.ok(chunks[0].pageContent.includes("SPENT: Rs.6000"));
    assert.ok(chunks[0].pageContent.includes("REACH: 20K reach"));
    assert.ok(chunks[0].pageContent.includes("ROI: Orders worth of 35000"));
    assert.equal(chunks[0].metadata.hasStructuredData, true);
  });

  it("ties a structured restatement back to its chapter's opening narrative", async () => {
    // Mirrors the real book's shape: a divider + title page open a section,
    // a narrative page names the subject, and a later page in the same
    // section carries only a flattened, unlabelled table.
    const pages = [
      { pageNumber: 1, text: "9  1" }, // divider
      { pageNumber: 2, text: "10 A Campaign About The Fictional Widget Launch" }, // title
      {
        pageNumber: 3,
        text: `${repeat("We launched the Widget campaign at the Example Convention.", 200)}`,
      },
      {
        pageNumber: 4,
        text: "14 Myth Buster:- some framing text. SPENT  REACH  ROI Rs.100  1K  Goodwill Next question?",
      },
    ];

    const chunks = await chunkPages(pages);

    const structuredChunk = chunks.find((c) => c.metadata.hasStructuredData);
    assert.ok(structuredChunk, "one chunk carries the structured flag");
    assert.match(structuredChunk.pageContent, /SPENT: Rs\.100/);
    // The narrative page's opening (naming the actual subject) travels with
    // the restated fact, not just the label/value pair on its own.
    assert.match(structuredChunk.pageContent, /Widget campaign/);
  });

  it("does not add structured lines or set the flag on a page with no label/value table", async () => {
    const pages = [{ pageNumber: 1, text: repeat("ordinary narrative text", 700) }];

    const chunks = await chunkPages(pages);

    assert.ok(chunks.every((c) => c.metadata.hasStructuredData === false));
    assert.ok(chunks.every((c) => !c.pageContent.includes(":")));
  });

  it("leaves detectSections' output unaffected by the appended structured text", async () => {
    // The divider/title heuristic reads raw page length; appending text to a
    // content page must not change the section boundaries it finds.
    const pages = [
      { pageNumber: 1, text: "3  1" },
      { pageNumber: 2, text: "4 A Fascinating Chapter About Something Interesting" },
      {
        pageNumber: 3,
        text: `${repeat("narrative", 700)} SPENT  REACH  ROI Rs.100  1K  Goodwill Next sentence.`,
      },
    ];

    const chunks = await chunkPages(pages);

    assert.ok(chunks.every((c) => c.metadata.section === 1));
  });
});
