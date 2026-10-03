/**
 * Cheap, deterministic checks on a generated answer. Neither needs a model
 * call, and both only act on a clearly broken answer.
 *
 * - Repetition: llama3.2 3B sometimes falls into a loop ("ayan irukkenga,
 *   ayan irukkenga, …"). The stream is stopped once a loop appears and the
 *   answer is cut back to before it.
 * - Numbers: a figure the answer states that appears nowhere in the context
 *   was invented (seen live: "2011-la start pannaru" for a year the book
 *   never gives). Such an answer is replaced by the "not found" reply.
 */

// A five-word phrase seen this many times means the model is looping.
// Shorter phrases recur legitimately: a three-word name such as "Zero Rupee
// Marketing" can open several sentences of a correct English answer.
const PHRASE_LENGTH = 5;
const REPEATED_PHRASE_LIMIT = 3;
// Two-word loops ("…, ayan irukkenga. …, ayan irukkenga.") are checked only
// when asked for (non-English answers): in English a two-word term such as
// "guerrilla marketing" legitimately recurs. Only all-lowercase, non-numeric
// pairs count (the loops seen were "ayan irukkenga", "aiyappan aiyappan"), so
// repeated names ("Zero Rupee") and labels ("SPENT: Rs.8000 … SPENT: Rs.4500")
// are left alone.
const REPEATED_PAIR_LIMIT = 4;
const isLoopWord = (entry) => /^\p{Ll}+$/u.test(entry.raw);

function wordsWithOffsets(text) {
  const words = [];
  const pattern = /[\p{L}\p{N}]+/gu;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    words.push({ word: match[0].toLowerCase(), raw: match[0], index: match.index });
  }
  return words;
}

/**
 * @param {string} text
 * @param {{checkPairs?: boolean}} [options]
 * @returns {number | null} the character offset where the loop starts (the
 *   second occurrence of the repeated phrase), or null when there is none
 */
function repetitionStart(text, { checkPairs = false } = {}) {
  const words = wordsWithOffsets(text);
  const phrases = new Map();
  const pairs = new Map();
  const record = (map, key, offset, limit) => {
    const occurrences = map.get(key) ?? [];
    occurrences.push(offset);
    map.set(key, occurrences);
    return occurrences.length >= limit ? occurrences[1] : null;
  };

  for (let index = 0; index + 1 < words.length; index++) {
    const [first, second] = [words[index], words[index + 1]];

    if (index + PHRASE_LENGTH <= words.length) {
      const phrase = words.slice(index, index + PHRASE_LENGTH).map((entry) => entry.word).join(" ");
      const start = record(phrases, phrase, first.index, REPEATED_PHRASE_LIMIT);
      if (start !== null) return start;
    }

    if (checkPairs && isLoopWord(first) && isLoopWord(second)) {
      const start = record(pairs, `${first.word} ${second.word}`, first.index, REPEATED_PAIR_LIMIT);
      if (start !== null) return start;
    }
  }
  return null;
}

/**
 * The answer up to where a loop starts, ending on a sentence boundary when
 * one exists before it. Unchanged when there is no loop.
 */
function trimRepetition(text, options) {
  const start = repetitionStart(text, options);
  if (start === null) return text;

  const head = text.slice(0, start);
  const lastSentenceEnd = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  const trimmed = lastSentenceEnd > 0 ? head.slice(0, lastSentenceEnd + 1) : head;
  return trimmed.replace(/[\s,;:]+$/, "").trim();
}

const alphanumeric = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/**
 * Removes the question when the answer opens by repeating it word for word.
 * llama3.2 3B did this in most Tanglish answers ("IIT fest campaign ku evlo
 * selavu aachu? Na, …") despite being told not to.
 */
function stripQuestionEcho(answer, question) {
  const target = alphanumeric(question ?? "");
  if (target.length < 8 || !alphanumeric(answer).startsWith(target)) return answer;

  let matched = 0;
  let index = 0;
  while (index < answer.length && matched < target.length) {
    if (/[\p{L}\p{N}]/u.test(answer[index])) matched++;
    index++;
  }
  const rest = answer.slice(index).replace(/^[\s?.!,:;-]+/, "");
  if (rest === "") return answer;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

function normaliseNumber(value) {
  return value.replace(/,/g, "").replace(/\.$/, "");
}

// Figures worth checking: three or more digits (amounts, years, counts) or a
// decimal. Short integers are skipped because list numbering ("1.", "2.")
// and small counts are too often phrased differently from the source.
function significantNumbers(text) {
  const numbers = text.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  return numbers
    .map(normaliseNumber)
    .filter((number) => number.replace(/\D/g, "").length >= 3 || number.includes("."));
}

/**
 * @param {string} answer
 * @param {string} evidence everything the answer may legitimately quote:
 *   the retrieved text, its page labels and the question
 * @returns {string[]} figures in the answer that the evidence never states
 */
function ungroundedNumbers(answer, evidence) {
  const known = new Set(significantNumbers(evidence));
  return [...new Set(significantNumbers(answer))].filter((number) => !known.has(number));
}

module.exports = { repetitionStart, trimRepetition, stripQuestionEcho, ungroundedNumbers };
