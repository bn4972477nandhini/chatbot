const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");

const { config } = require("../config/env");
const { logger: defaultLogger } = require("../lib/logger");
const { extractLabelValueBlocks, formatLabelValueBlock } = require("./labelValueExtractor");

// The splitter is stateless across calls, so one instance is reused rather than
// constructed per indexing run.
const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: config.chunking.chunkSize,
  chunkOverlap: config.chunking.chunkOverlap,
});

/**
 * Splits raw text into overlapping documents.
 *
 * Returns LangChain `Document` objects — read `.pageContent`, not the object.
 */
async function chunkText(text) {
  return await splitter.createDocuments([text]);
}

/**
 * A page's extracted text is treated as a section/chapter *divider* when, after
 * stripping the PDF's own printed page number, almost nothing is left.
 * Design-heavy books often render a chapter's title on the divider spread as an
 * image rather than selectable text, leaving only a lone page/chapter number
 * behind — this is a generic layout signature, not something tied to any one
 * book's content.
 */
const DIVIDER_MAX_LENGTH = 10;

// The page immediately after a divider is treated as its *title* page when its
// own stripped text falls in this band: long enough to be a real title (not
// another near-empty divider), short enough not to be a paragraph of prose.
const TITLE_MIN_LENGTH = 15;
const TITLE_MAX_LENGTH = 200;

function stripLeadingPageNumber(text) {
  return text.replace(/^\s*\d+\s*/, "").trim();
}

/**
 * Detects section/chapter boundaries from page layout alone: a short "divider"
 * page followed by a short "title" page opens a new section, which then covers
 * every page up to the next such pair. Pages before the first divider (cover,
 * copyright, dedication, foreword, …) belong to section 0 with no title.
 *
 * Purely structural — no book-specific strings or facts are referenced — so it
 * degrades gracefully (everything in section 0) on a PDF that doesn't use this
 * layout, rather than misfiring on unrelated content.
 *
 * @param {Array<{pageNumber: number, text: string}>} pages
 * @returns {Array<{section: number, sectionTitle: string|null}>} parallel to `pages`
 */
function detectSections(pages) {
  const sections = new Array(pages.length);

  let sectionIndex = 0;
  let sectionTitle = null;
  let index = 0;

  while (index < pages.length) {
    const stripped = stripLeadingPageNumber(pages[index].text);
    const isDivider = stripped.length > 0 && stripped.length <= DIVIDER_MAX_LENGTH;

    const nextStripped =
      index + 1 < pages.length ? stripLeadingPageNumber(pages[index + 1].text) : "";
    const nextIsTitle =
      nextStripped.length >= TITLE_MIN_LENGTH && nextStripped.length <= TITLE_MAX_LENGTH;

    if (isDivider && nextIsTitle) {
      sectionIndex += 1;
      sectionTitle = nextStripped;
      sections[index] = { section: sectionIndex, sectionTitle };
      sections[index + 1] = { section: sectionIndex, sectionTitle };
      index += 2;
      continue;
    }

    sections[index] = { section: sectionIndex, sectionTitle };
    index += 1;
  }

  return sections;
}

/**
 * Builds the same joined string `pdfReader.readPDF` returns, plus each page's
 * `[start, end)` character offset within it. Kept in lock-step with
 * `pdfReader.js`'s own join logic (page texts joined by "\n", one trailing
 * "\n") so a chunk's position in this string can be trusted to land on the
 * same pages the PDF reader attributed that text to.
 */
function buildPageIndex(pages) {
  const offsets = new Array(pages.length);
  let cursor = 0;

  for (let i = 0; i < pages.length; i++) {
    const start = cursor;
    const end = start + pages[i].text.length;
    offsets[i] = { pageNumber: pages[i].pageNumber, start, end };
    // +1 for the "\n" that follows this page, whether it's an inter-page
    // separator or (on the last page) the single trailing newline.
    cursor = end + 1;
  }

  const fullText = `${pages.map((page) => page.text).join("\n")}\n`;

  return { fullText, offsets };
}

// A page this short is a divider or a title page (see detectSections above),
// not narrative — too short to usefully identify what a campaign/chapter is
// actually about.
const NARRATIVE_MIN_LENGTH = 150;
const OPENING_EXCERPT_LENGTH = 250;

/**
 * A flattened label/value table (e.g. a "SPENT/REACH/ROI" box) sits at the
 * end of a chapter, but rarely names what it's actually about — that context
 * is in the chapter's opening narrative, on an earlier page, and chunking may
 * not keep the two together (the narrative alone can already fill a full
 * chunk). Without it, the restated fact is technically unambiguous but
 * practically orphaned: nothing ties "SPENT: Rs.6000" to the one campaign, of
 * a book with many, that it belongs to.
 *
 * Reuses the section boundaries `detectSections` already finds (a divider +
 * title pair opens each section) — purely structural, not tied to any one
 * page's wording — to locate that section's own opening narrative page and
 * excerpt its first line(s).
 */
function findSectionOpeningExcerpt(pages, sections, pageIndex) {
  const targetSection = sections[pageIndex]?.section;
  if (targetSection == null) return null;

  for (let i = 0; i < pageIndex; i++) {
    if (sections[i]?.section !== targetSection) continue;
    const text = pages[i].text.trim();
    if (text.length < NARRATIVE_MIN_LENGTH) continue; // divider/title page, skip
    return text.slice(0, OPENING_EXCERPT_LENGTH).trim();
  }

  return null;
}

/**
 * Appends any label/value blocks found on a page to that page's own text, as
 * plain "Label: Value" lines — plus, when available, an excerpt of that
 * chapter's opening narrative so the restated fact stays tied to what it's
 * actually about (see `findSectionOpeningExcerpt`). Appending (never
 * rewriting or removing) keeps the original extracted text fully intact
 * within the augmented copy. Joined with a single "\n" rather than a blank
 * line: the splitter treats "\n\n" as a preferred break point and would
 * happily split the restatement into its own chunk, losing that context
 * again. Returns a new pages array; the caller's `pages` is untouched.
 */
function augmentPagesWithStructuredData(pages, sections) {
  const structuredTextByPage = new Map();

  const augmentedPages = pages.map((page, index) => {
    const blocks = extractLabelValueBlocks(page.text);
    if (blocks.length === 0) return page;

    const opening = findSectionOpeningExcerpt(pages, sections, index);
    const structuredText = blocks.map(formatLabelValueBlock).join("\n");
    const withOpening = opening ? `${structuredText}\n(From: ${opening})` : structuredText;

    structuredTextByPage.set(page.pageNumber, structuredText);
    return { ...page, text: `${page.text}\n${withOpening}` };
  });

  return { augmentedPages, structuredTextByPage };
}

/** First and last page whose character range overlaps [start, end). */
function pagesForRange(start, end, offsets) {
  let pageStart = null;
  let pageEnd = null;

  for (const page of offsets) {
    if (page.start < end && page.end >= start) {
      if (pageStart === null) pageStart = page.pageNumber;
      pageEnd = page.pageNumber;
    }
  }

  return { pageStart, pageEnd };
}

/**
 * Splits a PDF's per-page text into overlapping documents, the same way
 * `chunkText` does, but with each chunk attributed back to the page(s) and
 * section it came from. Used for indexing, where that provenance becomes
 * Qdrant payload metadata and, later, a user-facing citation.
 *
 * @param {Array<{pageNumber: number, text: string}>} pages
 * @returns {Promise<Array>} LangChain `Document[]`, each with
 *   `metadata.{page, pageEnd, section, sectionTitle}` set.
 */
async function chunkPages(pages, { logger = defaultLogger } = {}) {
  // Section detection reads page-length layout (divider/title pairs), so it
  // runs against the original pages — the augmented copy's added lines would
  // change page lengths and could confuse that heuristic.
  const sections = detectSections(pages);

  const { augmentedPages, structuredTextByPage } = augmentPagesWithStructuredData(pages, sections);
  const { fullText, offsets } = buildPageIndex(augmentedPages);
  const documents = await splitter.createDocuments([fullText]);

  // Overlapping chunks can start earlier in `fullText` than the previous
  // chunk did, so the forward search allows looking back by a bit more than
  // one overlap window rather than assuming strict forward progress.
  const lookback = config.chunking.chunkOverlap + 100;
  let cursor = 0;

  for (const document of documents) {
    const searchFrom = Math.max(0, cursor - lookback);
    const start = fullText.indexOf(document.pageContent, searchFrom);

    if (start === -1) {
      logger.warn("chunkPages: could not locate chunk in source text; page metadata omitted", {
        preview: document.pageContent.slice(0, 60),
      });
      document.metadata = { ...document.metadata, page: null, pageEnd: null, section: null, sectionTitle: null };
      continue;
    }

    cursor = start;
    const end = start + document.pageContent.length;
    const { pageStart, pageEnd } = pagesForRange(start, end, offsets);
    const sectionInfo =
      pageStart !== null ? sections[pageStart - 1] : { section: null, sectionTitle: null };
    const hasStructuredData =
      pageStart !== null &&
      Array.from({ length: pageEnd - pageStart + 1 }, (_, i) => pageStart + i).some((page) => {
        const structuredText = structuredTextByPage.get(page);
        return structuredText != null && document.pageContent.includes(structuredText);
      });

    document.metadata = {
      ...document.metadata,
      page: pageStart,
      pageEnd,
      section: sectionInfo.section,
      sectionTitle: sectionInfo.sectionTitle,
      hasStructuredData,
    };
  }

  return documents;
}

module.exports = { chunkText, chunkPages, detectSections };
