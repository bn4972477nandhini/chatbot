const fs = require("fs/promises");

// pdfjs-dist is ESM-only while this project is CommonJS, so it is pulled in with
// a dynamic import. The promise is cached because the module is expensive to
// evaluate and would otherwise be resolved on every call.
let pdfjsPromise = null;

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  }
  return pdfjsPromise;
}

// pdf.js reports text as a run of items positioned by an affine `transform`
// ([a, b, c, d, e, f], where e/f are the x/y origin). A run is usually a whole
// line, but some PDFs split a single word across two items at a font/style
// boundary (observed in this book: "foreword" arrives as two items, "fore"
// then "word", butted up against each other with ~0 gap). Always joining
// items with a literal space — as naively mapping `item.str` and `.join(" ")`
// does — turns that into "fore word", corrupting the word for both embedding
// and exact keyword matching. Inserting a space only when consecutive items
// are actually separated (a real gap on the same line, or a new line
// entirely) reconstructs the word correctly while still separating genuinely
// distinct words and lines.
const SAME_LINE_TOLERANCE = 2;
const SPACE_GAP_THRESHOLD = 0.3;

function joinTextItems(items) {
  let text = "";
  let prevEndX = null;
  let prevY = null;

  for (const item of items) {
    if (!item.str) continue;

    const x = item.transform[4];
    const y = item.transform[5];

    if (prevEndX !== null) {
      const sameLine = prevY !== null && Math.abs(y - prevY) < SAME_LINE_TOLERANCE;
      const needsSpace = !sameLine || x - prevEndX > SPACE_GAP_THRESHOLD;
      if (needsSpace) text += " ";
    }

    text += item.str;
    prevEndX = x + (item.width ?? 0);
    prevY = y;
  }

  return text;
}

/**
 * Extracts the full text of a PDF, page by page.
 *
 * The file is read with the async API: readFileSync would block the event loop
 * for the whole read, stalling every other in-flight request.
 *
 * @returns {Promise<{text: string, pages: Array<{pageNumber: number, text: string}>}>}
 *   `text` is every page joined by "\n" (with a trailing newline) — the same
 *   shape callers relied on before this returned page-level detail too, so
 *   chunking against `text` is unaffected. `pages` is 1-indexed and lets a
 *   caller map a character offset in `text` back to the PDF page it came from.
 */
async function readPDF(filePath) {
  const pdfjs = await loadPdfjs();

  const buffer = await fs.readFile(filePath);
  const data = new Uint8Array(buffer);

  const loadingTask = pdfjs.getDocument({ data });
  const pdf = await loadingTask.promise;

  try {
    // Collected into an array and joined once — repeated string concatenation
    // across hundreds of pages allocates a new string every time.
    const pages = new Array(pdf.numPages);

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);

      try {
        const content = await page.getTextContent();
        pages[pageNumber - 1] = {
          pageNumber,
          text: joinTextItems(content.items),
        };
      } finally {
        // Releases the page's parsed operator list; without this the whole
        // document stays resident while a large PDF is processed.
        page.cleanup();
      }
    }

    return {
      text: `${pages.map((page) => page.text).join("\n")}\n`,
      pages,
    };
  } finally {
    // Frees the worker and its buffers rather than waiting for GC.
    await pdf.destroy();
  }
}

module.exports = { readPDF };
