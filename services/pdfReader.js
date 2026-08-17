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

/**
 * Extracts the full text of a PDF.
 *
 * The file is read with the async API: readFileSync would block the event loop
 * for the whole read, stalling every other in-flight request.
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
        pages[pageNumber - 1] = content.items.map((item) => item.str).join(" ");
      } finally {
        // Releases the page's parsed operator list; without this the whole
        // document stays resident while a large PDF is processed.
        page.cleanup();
      }
    }

    return `${pages.join("\n")}\n`;
  } finally {
    // Frees the worker and its buffers rather than waiting for GC.
    await pdf.destroy();
  }
}

module.exports = { readPDF };
