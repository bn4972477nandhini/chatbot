const assert = require("node:assert/strict");
const path = require("path");
const { describe, it } = require("node:test");

const { readPDF } = require("../../services/pdfReader");

const BOOK = path.join(__dirname, "..", "..", "uploads", "founder.pdf");
const MISSING = path.join(__dirname, "does-not-exist.pdf");

describe("pdfReader.readPDF", () => {
  it("returns { text, pages } with pages parallel to the PDF's real page count", async () => {
    const { text, pages } = await readPDF(BOOK);

    assert.equal(pages.length, 94, "founder.pdf has 94 pages");
    assert.equal(typeof text, "string");
    // A loose bound rather than an exact count — robust to pdfjs whitespace
    // handling changing slightly across versions, while still catching the
    // book being silently truncated or duplicated.
    assert.ok(text.length > 40_000 && text.length < 80_000);
  });

  it("numbers pages sequentially starting at 1", async () => {
    const { pages } = await readPDF(BOOK);

    for (let i = 0; i < pages.length; i++) {
      assert.equal(pages[i].pageNumber, i + 1);
      assert.equal(typeof pages[i].text, "string");
    }
  });

  it("joins page text into `text` exactly the way callers can rely on", async () => {
    const { text, pages } = await readPDF(BOOK);

    assert.equal(text, `${pages.map((p) => p.text).join("\n")}\n`);
  });

  it("does not silently drop text: extraction covers most of the book, not just a slice", async () => {
    const { pages } = await readPDF(BOOK);

    const nonEmptyPages = pages.filter((p) => p.text.trim().length > 0);
    // Front/back cover pages are legitimately image-only; everything else
    // should carry real text.
    assert.ok(nonEmptyPages.length >= pages.length - 3);
  });

  it("rejects a missing file", async () => {
    await assert.rejects(() => readPDF(MISSING));
  });
});
