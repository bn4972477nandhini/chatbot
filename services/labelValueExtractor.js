// Detects the "label row, then value row" shape a table or infographic leaves
// behind once a PDF's positioned text items are flattened into a single line
// of prose (see pdfReader.js's joinTextItems). A wide horizontal gap between
// two items on the same line — a real column boundary — survives flattening
// as 2+ literal spaces, while an ordinary word gap stays a single space. A run
// of ALL-CAPS header words separated by that wide-gap signal, immediately
// followed by the same number of value phrases using the same signal, is a
// flattened table row: "SPENT  REACH  ROI Rs.6000  20K reach  Orders worth of
// 35000" pairs positionally into SPENT=Rs.6000, REACH="20K reach", ROI="Orders
// worth of 35000".
//
// Purely structural — no fixed label vocabulary — so it isn't specific to any
// one book's table headers; it fires on whatever ALL-CAPS, wide-gapped labels
// a given PDF actually uses, and finds nothing on a PDF that doesn't lay out
// tables this way.
const LABEL_GROUP_RE = /(?:[A-Z]{2,20} {2,}){1,7}[A-Z]{2,20}/g;

// The last value's right edge is never marked by a wide gap — it just runs on
// into the next sentence with an ordinary single space — so it is bounded
// with a heuristic instead of a delimiter: the value ends at the first word
// (beyond its own first word) that starts a new sentence, signalled here by a
// capital letter. A word-count cap is a backstop for the rare case no such
// word appears nearby.
const MAX_LAST_VALUE_WORDS = 8;

function isCapitalizedWord(word) {
  return /^[A-Z]/.test(word);
}

function boundLastValue(text) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const bounded = [];

  for (let i = 0; i < words.length && i < MAX_LAST_VALUE_WORDS; i++) {
    const word = words[i];
    if (i > 0 && isCapitalizedWord(word)) break;
    bounded.push(word);
  }

  return bounded.join(" ");
}

/**
 * Finds label/value blocks in a single page's extracted text.
 *
 * Only pairs a label with a value when the value's left AND right edges are
 * both delimited by the wide-gap signal, except for the last value in a
 * block, which is bounded by `boundLastValue` instead. If there are fewer
 * wide-gap-delimited value phrases than labels, only the labels that got a
 * value are returned — a label is never paired with an invented or guessed
 * value.
 *
 * @param {string} pageText
 * @returns {Array<{labels: string[], values: string[], raw: string}>}
 */
function extractLabelValueBlocks(pageText) {
  const blocks = [];
  let match;

  LABEL_GROUP_RE.lastIndex = 0;
  while ((match = LABEL_GROUP_RE.exec(pageText))) {
    const labels = match[0].split(/ {2,}/);
    if (labels.length < 2) continue;

    // A value row never continues past a line break — bounding the search to
    // the label group's own line also keeps `.` (which does not match `\n`)
    // correct here regardless of what follows later in the page's text.
    const afterLabels = pageText.slice(match.index + match[0].length);
    const lineBreak = afterLabels.indexOf("\n");
    const sameLineRemainder = lineBreak === -1 ? afterLabels : afterLabels.slice(0, lineBreak);
    const valueMatch = /^ +(\S.*)$/.exec(sameLineRemainder);
    if (!valueMatch) continue;

    const parts = valueMatch[1].split(/ {2,}/);
    const pairable = Math.min(labels.length, parts.length);
    if (pairable < 2) continue;

    const values = parts.slice(0, pairable - 1);
    const lastValue = boundLastValue(parts[pairable - 1]);
    if (!lastValue) continue;
    values.push(lastValue);

    blocks.push({ labels: labels.slice(0, pairable), values, raw: match[0] });
  }

  return blocks;
}

/**
 * Renders a block as plain "Label: Value" lines, using the label text exactly
 * as it appeared in the PDF (no re-casing) so the rendered fact stays a
 * faithful restatement of the source rather than a paraphrase.
 */
function formatLabelValueBlock(block) {
  return block.labels.map((label, index) => `${label}: ${block.values[index]}`).join("\n");
}

module.exports = { extractLabelValueBlocks, formatLabelValueBlock };
