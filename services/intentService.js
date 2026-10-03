/**
 * Recognises questions whose answer is one specific kind of fact, so
 * retrieval can look for that fact instead of for whatever shares words with
 * the question.
 *
 * Only one intent so far: who wrote the book. Generic vector search handled
 * it badly. "intha book writer yaru" became the search "book writer", which
 * ranked the acknowledgements page (an editor credited as "Author & Content
 * Writer") above the copyright page's "Author: <name>", and filled the rest
 * of the context with unrelated marketing passages.
 *
 * Nothing here knows any answer: each intent only says how to phrase the
 * search and which passages can count as evidence at all.
 */

const AUTHOR_TERMS = /^(author|authors|writer|writers|wrote|written|write|writes|penned|ezhuth\w*|ezhudh\w*|ezhudhi\w*|ezhuthi\w*)$/;
const IDENTITY_TERMS = /^(who|whom|whose|name|names|identity|yaar|yaaru|yaru|yar|peru|peyar|per)$/;
// What the author does or has done, in English or Tanglish.
const BACKGROUND_TERMS = /^(work|works|worked|job|jobs|profession|career|background|biography|bio|company|companies|venture|ventures|founded|founder|business|businesses|pannirukkaru|pannirukaru|panraru|pannuraru|seiraru|velai)$/;
// Pointing back at a person named in the previous turn.
const PERSON_PRONOUNS = /^(he|him|his|avaru|avar|ivaru|ivar|avanga)$/;

// Words that carry no subject of their own in an "who wrote this book"
// question, in English or Tanglish. Anything else left over (e.g. "foreword",
// "profession", "consistency") means the question is about something more.
const FILLER = new Set([
  "the", "this", "that", "is", "was", "are", "of", "a", "an", "book", "books", "s", "what", "whats",
  "intha", "indha", "inda", "idhu", "idha", "ah", "oda", "da", "la", "na", "enna",
  "pannanga", "pannaanga", "pannaru", "pannar", "panninanga", "pannadhu", "pannathu", "pannunaru",
  "ezhuthunadhu", "ezhudhunadhu", "ezhuthinanga", "ezhudhinanga", "ezhuthiyadhu",
  "by", "did", "has", "have", "tell", "me", "please", "sollu", "sollunga", "do", "you", "know",
  "theriyuma", "it", "its",
]);

const INTENTS = Object.freeze({
  author_identity: {
    // Searched instead of the question as asked: an English phrasing of the
    // intent embeds far closer to an "Author: X" line than "book writer" does.
    retrievalQuery: "Who is the author of this book? Who wrote this book?",
    // A passage that never mentions authorship cannot say who the author is.
    evidence: /\b(author|authors|writer|written|wrote|penned)\b/i,
    // An explicit "Author: X" / "Written by X" line is the most direct
    // evidence there is, so it goes first in the context.
    // Case-insensitive on the label, but the value must start with a capital
    // letter (a name), so "author: the" in running text doesn't count.
    strongEvidence: /\b(?:[Aa]uthor|[Ww]riter)\s*[:\-–]\s*[A-Z]|\b[Ww]ritten\s+by\s+[A-Z]/,
    // One sentence, in the answer language, replacing the general language
    // instruction. Measured: with the general Tanglish instruction ("two or
    // three sentences") also present, the model gave the right name and then
    // a second, invented paragraph ("amma & appa ezhuthi").
    answerInstructions: {
      english:
        "Answer in one short sentence that gives only the name of the person the context states wrote this book. Nothing else.",
      tanglish:
        "Answer in one short Tanglish sentence that gives only the name of the person the context states wrote this book, " +
        'in this form: "Indha book-oda writer <name>." Nothing else.',
      tamil:
        "Answer in one short sentence in Tamil script that gives only the name of the person the context states wrote this book. Nothing else.",
    },
    // A one-sentence answer needs a few dozen tokens; the cap stops a
    // ramble before it starts (and saves ~0.3 s per token on CPU).
    maxOutputTokens: 40,
  },
  author_background: {
    // Phrased like a typical "about the author" page rather than like the
    // question: that page tends to say "He is the Founder and Chief … of …"
    // without repeating the name, so neither the name nor "work" finds it.
    // Measured: this ranks that page first (0.64); "<name> work" missed it.
    retrievalQuery:
      "Author biography: he is the founder of a company, his roles and positions, brands he worked with, media features and awards.",
    answerInstructions: {
      english:
        "Answer in two or three short sentences, only from the context, describing the work of the person the context names as this book's author.",
      // A fill-in form, as for the name: free-form Tanglish here produced
      // unrelated campaign fragments ("banner-layam, tent-layam, voodoo
      // doll-layam"); this form gave the book's own roles word for word.
      tanglish:
        "Answer in simple Tanglish, only from the context, about the work of the person the context names as this book's author, " +
        'in this form: "Avaru <role> at <company>, <role> at <company>." Use the roles and company names exactly as the context gives them. Nothing else.',
      tamil:
        "Answer in two or three short sentences in Tamil script, only from the context, describing the work of the person the context names as this book's author.",
    },
    maxOutputTokens: 120,
  },
});

function withName(name) {
  return { name, ...INTENTS[name] };
}

function tokens(question) {
  return question.toLowerCase().match(/[a-z]+/g) ?? [];
}

/**
 * @param {string} question
 * @param {object} [context]
 * @param {string} [context.previousQuestion] the last question asked, so a
 *   pronoun follow-up ("Avaru enna work pannirukkaru?") after an author
 *   question is understood as being about the author
 * @returns {object | null} the intent, or null for an ordinary question
 */
function detectIntent(question, { previousQuestion } = {}) {
  if (typeof question !== "string") return null;

  const words = tokens(question.replace(/'s\b/gi, ""));
  const hasAuthorTerm = words.some((word) => AUTHOR_TERMS.test(word));
  const hasIdentityTerm = words.some((word) => IDENTITY_TERMS.test(word));
  const hasBackgroundTerm = words.some((word) => BACKGROUND_TERMS.test(word));

  // "What companies has the author founded?", or "Avaru enna work
  // pannirukkaru?" right after an author question. A question that also asks
  // who the author is ("Who is the author and what is his profession?") is
  // left to the general path, which answers both halves.
  if (hasBackgroundTerm && !hasIdentityTerm) {
    const refersToAuthor =
      words.some((word) => PERSON_PRONOUNS.test(word)) &&
      typeof previousQuestion === "string" &&
      detectIntent(previousQuestion) !== null;
    if (hasAuthorTerm || refersToAuthor) return withName("author_background");
  }
  // "yaar write pannanga" asks who; "author name enna" asks for a name; a
  // bare "Who penned this book?" asks who. All need an author term.
  if (!hasAuthorTerm || !hasIdentityTerm) return null;

  const leftover = words.filter(
    (word) => !AUTHOR_TERMS.test(word) && !IDENTITY_TERMS.test(word) && !FILLER.has(word)
  );
  if (leftover.length > 0) return null;

  return withName("author_identity");
}

/**
 * Keeps only chunks that can be evidence for the intent, strongest first,
 * otherwise in their retrieved order. An intent without an evidence rule
 * keeps everything.
 */
function selectEvidence(intent, chunks) {
  if (!intent.evidence) return chunks;
  const relevant = chunks.filter((chunk) => intent.evidence.test(chunk.pageContent ?? ""));
  const strong = relevant.filter((chunk) => intent.strongEvidence.test(chunk.pageContent ?? ""));
  const rest = relevant.filter((chunk) => !strong.includes(chunk));
  return [...strong, ...rest];
}

module.exports = { detectIntent, selectEvidence, INTENTS };
