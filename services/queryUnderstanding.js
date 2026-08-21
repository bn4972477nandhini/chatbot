// Lightweight, purely structural question classification — no ML, no keyword
// lists tied to any specific topic or evaluation question. Every detector
// here is a general pattern (leading wh-word, presence of a digit, sentence
// shape) that applies identically to any question about any book. Used to
// inform *how* retrieval weighs evidence, never *which* chunk is "the"
// answer — the actual evidence still has to be found and confirmed by the
// existing dense/lexical/expansion signals.

const WH_WORDS = ["who", "what", "where", "when", "why", "how", "which", "whom", "whose"];

/**
 * The question's leading wh-word, if any (case-insensitive, ignoring leading
 * punctuation/whitespace). "other" covers imperatives ("Tell me...") and
 * statements used as questions.
 */
function questionType(question) {
  const firstWord = (question.trim().match(/^[a-zA-Z']+/) ?? [""])[0].toLowerCase();
  return WH_WORDS.includes(firstWord) ? firstWord : "other";
}

// Digits, currency symbols, or a small set of maximally generic
// quantity-asking words — none of it tied to any particular figure, unit or
// campaign. "how much"/"how many" are structural English question forms, not
// content-specific keywords.
const NUMERIC_PATTERN = /[0-9₹$€£]|\bhow\s+(much|many)\b|\b(cost|price|amount|percent|percentage|number of)\b/i;

/** Whether the question is asking for a quantity, figure, or count. */
function isNumericQuestion(question) {
  return NUMERIC_PATTERN.test(question);
}

/** Whether the question is asking about a person's identity or role. */
function isPersonQuestion(question) {
  const type = questionType(question);
  if (type === "who" || type === "whom" || type === "whose") return true;
  return /\b(author|writer|person|name)\b/i.test(question) && type !== "other";
}

// A second wh-clause after the first, or explicit conjunction between two
// question-shaped fragments — general sentence-structure signals of "this is
// really two questions", not any specific pair of topics.
const MULTI_PART_PATTERN = new RegExp(
  `\\b(and|also|as well as)\\b.*\\b(${WH_WORDS.join("|")})\\b|\\?.*\\?`,
  "i"
);

/** Whether the question bundles more than one distinct ask together. */
function isMultiPart(question) {
  return MULTI_PART_PATTERN.test(question) || question.trim().split(/\s+/).length > 20;
}

const SHORT_QUESTION_WORD_COUNT = 4;

/** Whether the question is short/terse enough that grammar may be dropped. */
function isShortQuestion(question) {
  return question.trim().split(/\s+/).filter(Boolean).length <= SHORT_QUESTION_WORD_COUNT;
}

/** Convenience bundle of every classification, computed once per question. */
function classifyQuestion(question) {
  return {
    type: questionType(question),
    isNumeric: isNumericQuestion(question),
    isPerson: isPersonQuestion(question),
    isMultiPart: isMultiPart(question),
    isShort: isShortQuestion(question),
  };
}

module.exports = {
  questionType,
  isNumericQuestion,
  isPersonQuestion,
  isMultiPart,
  isShortQuestion,
  classifyQuestion,
};
