const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { extractLabelValueBlocks, formatLabelValueBlock } = require("../../services/labelValueExtractor");

describe("extractLabelValueBlocks", () => {
  it("pairs a flattened three-label, three-value table positionally", () => {
    // A single page's own extracted text, exactly as pdfReader.js would
    // return it (one flattened line, no embedded newlines) — the real page
    // 14 of the book this system was built against.
    const pageText =
      "14 ZERO RUPEE MARKETING Myth Buster:- Anybody can use guerrilla marketing " +
      "technique no matter how big the company is. If you are participating in an " +
      "expo, what can you do differently to pull the crowd at less cost ? SPENT  " +
      "REACH  ROI Rs.6000  20K reach  Orders worth of 35000";

    const blocks = extractLabelValueBlocks(pageText);

    assert.equal(blocks.length, 1);
    assert.deepEqual(blocks[0].labels, ["SPENT", "REACH", "ROI"]);
    assert.deepEqual(blocks[0].values, ["Rs.6000", "20K reach", "Orders worth of 35000"]);
  });

  it("does not let a value row bleed across a line break within the page text", () => {
    const pageText = "SPENT  REACH  ROI Rs.100  1K\nSome unrelated line that follows on the next line.";

    const blocks = extractLabelValueBlocks(pageText);

    assert.equal(blocks.length, 1);
    assert.deepEqual(blocks[0].labels, ["SPENT", "REACH"]);
    assert.deepEqual(blocks[0].values, ["Rs.100", "1K"]);
  });

  it("returns only the labels it can confidently pair a value to, never an invented one", () => {
    // Real page from the book: only one wide gap follows the values, so only
    // SPENT and REACH are unambiguously bounded — ROI is deliberately omitted
    // rather than guessed.
    const pageText =
      "74 ZERO RUPEE MARKETING Myth Buster:- Brands can collaborate & can run a " +
      "campaign together as well . SPENT  REACH  ROI Rs.2000  2 lakh + people " +
      "Articles worth 1 lakh Which brand can you collaborate with?";

    const blocks = extractLabelValueBlocks(pageText);

    assert.equal(blocks.length, 1);
    assert.deepEqual(blocks[0].labels, ["SPENT", "REACH"]);
    assert.deepEqual(blocks[0].values, ["Rs.2000", "2 lakh + people"]);
  });

  it("bounds the final value at the next sentence rather than running on", () => {
    const pageText = "SPENT  REACH  ROI Rs.500  5 million views  Articles worth 4 lakhs Observe the moment.";

    const blocks = extractLabelValueBlocks(pageText);

    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].values[2], "Articles worth 4 lakhs");
  });

  it("keeps a multi-word capitalized value intact when it is itself wide-gap bounded", () => {
    const pageText = "SPENT  REACH  ROI Rs.25000  Brand Recall  Walkins increase Take a newspaper.";

    const blocks = extractLabelValueBlocks(pageText);

    assert.equal(blocks.length, 1);
    assert.deepEqual(blocks[0].values, ["Rs.25000", "Brand Recall", "Walkins increase"]);
  });

  it("does not fire on a single ALL-CAPS heading with no wide-gapped run", () => {
    const pageText = "8 ZERO RUPEE MARKETING Playing on social behavior and rewarding generosity.";

    const blocks = extractLabelValueBlocks(pageText);

    assert.deepEqual(blocks, []);
  });

  it("does not fire on ordinary single-spaced ALL-CAPS words in running prose", () => {
    // "ZERO RUPEE MARKETING" repeats on nearly every page of the real book —
    // single-spaced, not wide-gapped — and must never be mistaken for a table.
    const pageText = "14 ZERO RUPEE MARKETING Myth Buster:- some more prose that keeps going here.";

    const blocks = extractLabelValueBlocks(pageText);

    assert.deepEqual(blocks, []);
  });

  it("does not fire on mixed-case label/value lines separated by wide gaps", () => {
    // Real page from the book's copyright page: "Email  : x Website  : y" — not
    // ALL-CAPS, so it must not be treated as a table header run.
    const pageText = "Email  : sakthi@the6.in Website  : www.example.com Contact  : +91 98947 00013";

    const blocks = extractLabelValueBlocks(pageText);

    assert.deepEqual(blocks, []);
  });

  it("returns nothing for text with no structure at all", () => {
    assert.deepEqual(extractLabelValueBlocks("Just an ordinary sentence with no tables in it."), []);
    assert.deepEqual(extractLabelValueBlocks(""), []);
  });
});

describe("formatLabelValueBlock", () => {
  it("renders one Label: Value line per pair, using the label text verbatim", () => {
    const block = { labels: ["SPENT", "REACH", "ROI"], values: ["Rs.6000", "20K reach", "Orders worth of 35000"] };

    const formatted = formatLabelValueBlock(block);

    assert.equal(formatted, "SPENT: Rs.6000\nREACH: 20K reach\nROI: Orders worth of 35000");
  });
});
