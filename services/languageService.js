/**
 * Works out which language the user wants the answer in, and strips the
 * language-request wording out of the question before retrieval.
 *
 * Deterministic and dictionary-based: no model call, so it costs nothing on
 * the latency budget. It looks only at the question text, never at the book.
 */

const LANGUAGES = Object.freeze({
  ENGLISH: "english",
  TANGLISH: "tanglish",
  TAMIL: "tamil",
});

const TAMIL_SCRIPT_RE = /[஀-௿]/;

// Explicit requests win over anything inferred from how the question is
// written: "Consistency na enna? English la sollu" asks for English.
const EXPLICIT_REQUESTS = [
  [LANGUAGES.TANGLISH, /\btanglish\b/i],
  [LANGUAGES.ENGLISH, /\b(?:in|into)\s+english\b|\benglish\s*(?:la|le|lae|il|lla)\b/i],
  [LANGUAGES.TAMIL, /\b(?:in|into)\s+tamil\b|\btamil\s*(?:la|le|lae|il|lla)\b/i],
];

const DIRECTIVE_RE =
  /\b(?:in|into)\s+(?:english|tanglish|tamil)\b|\b(?:english|tanglish|tamil)\s*(?:la|le|lae|il|lla)?\b/gi;

// Tamil words written in English letters. One of these is enough to call a
// question Tanglish. None of them is an ordinary English word.
const STRONG_TANGLISH_WORDS = new Set([
  "enna", "ennaa", "yenna", "enaku", "enakku", "epdi", "eppadi", "epadi", "yeppadi",
  "yaaru", "yaru", "yaar", "enga", "engae", "edhu", "ethu", "edhuku", "ethuku",
  "edhukku", "eppo", "evlo", "evvalavu", "pannu", "pannunga", "pannuga", "panna",
  "panni", "pannanum", "pannalam", "pannuvanga", "pannirukaru", "pannirukkaru",
  "pannirukkanga", "pannanga", "pannaanga", "pannaru", "ezhuthunadhu", "ezhudhunadhu", "sollu", "sollunga",
  "solla", "solli", "sonnaru", "sonnar", "sonnanga", "sonnadhu", "solringa",
  "sollirukaru", "kudunga", "kudu", "kodu", "kodunga", "iruku", "irukku", "irukka",
  "irukkanga", "irundhuchu", "illa", "illai", "illaya", "venum", "vendum",
  "theriyuma", "theriyum", "theriyadhu", "pathi", "patthi", "paththi", "idha",
  "idhu", "adhu", "athu", "adha", "indha", "intha", "andha", "antha", "avaru",
  "avar", "avanga", "ivaru", "ivar", "nalla", "romba", "konjam", "ungalukku",
  "unga", "namma", "neenga", "matum", "mattum", "dhaan", "thaan", "aana",
  "puriyala", "puriyum", "vishayam", "badhil", "sollirukanga", "sollirukkanga",
  "sollirukkaru", "seiyanum", "seyyanum", "panradhu", "pannradhu", "nadakkum", "adhula",
  "idhula", "athula", "adhoda", "idhoda", "aachu", "irukanga",
]);

// Tamil content words with their English meaning, substituted into the
// retrieval query. The embedding model (nomic-embed-text) only understands
// English: left in place, "business start panna enna seiyanum?" searched as
// "business start seiyanum" and found farmer-protest and biriyani pages, while
// its English paraphrase found the book's entrepreneurship foreword. A model
// call translated worse (5 of 10 test questions came out wrong, e.g.
// "consistency pathi…" -> "the consistency of the food path") and costs
// seconds; this costs nothing. Plain dictionary meanings only, nothing about
// the book. Question words that carry no meaning (enna, pathi) are in
// STRONG_TANGLISH_WORDS instead and are dropped.
const TRANSLATIONS = new Map([
  ["aarambikka", "start"], ["aarambikkanum", "start"], ["aarambichaaru", "started"],
  ["aarambichu", "started"], ["aarambam", "start"], ["thodanga", "start"], ["thodangu", "start"],
  ["venum", "need"], ["vendum", "need"], ["thevai", "need"],
  ["mukkiyam", "important"], ["mukkiyamaana", "important"], ["mukkiyamana", "important"],
  ["selavu", "spent cost"], ["selavaachu", "spent"],
  ["evlo", "how much"], ["evvalavu", "how much"], ["ethana", "how many"], ["ethanai", "how many"],
  ["epdi", "how"], ["eppadi", "how"], ["epadi", "how"], ["yeppadi", "how"],
  ["edhuku", "why"], ["ethuku", "why"], ["edhukku", "why"], ["eppo", "when"], ["eppodhu", "when"],
  ["enga", "where"], ["engae", "where"], ["yaar", "who"], ["yaaru", "who"], ["yaru", "who"],
  ["nadandhuchu", "happened"], ["nadanthathu", "happened"], ["nadandhadhu", "happened"],
  ["kathukka", "learn"], ["kathukalam", "learn"], ["katrukolla", "learn"], ["paadam", "lesson"],
  ["vetri", "success"], ["tholvi", "failure"], ["panam", "money"], ["kaasu", "money"],
  ["velai", "work"], ["thozhil", "business"], ["vyabaram", "business"], ["kadai", "shop"],
  ["vaadikkaiyalar", "customer"], ["vaadikkaiyaalar", "customer"], ["makkal", "people"],
  ["aalunga", "people"], ["yosanai", "idea"], ["manasu", "mindset"], ["mananilai", "mindset"],
  ["nambikkai", "confidence"], ["payan", "benefit"], ["nanmai", "benefit"], ["upayogam", "use"],
  ["kashtam", "struggle"], ["prachanai", "problem"], ["vilambaram", "advertising"],
  ["ilavasam", "free"], ["arivurai", "advice"], ["muyarchi", "effort"], ["porumai", "patience"],
  ["thodarchi", "consistency"],
]);

// Common in Tanglish but too short or ambiguous to decide on alone; two of
// them together are enough.
const WEAK_TANGLISH_WORDS = new Set(["na", "la", "ah", "le", "dhan", "oda", "kitta", "ku"]);

// Words that only say *how* to answer ("explain it simply"), not what about.
// Removed from the retrieval query along with the Tanglish words above.
const INSTRUCTION_WORDS = new Set([
  "explain", "explanation", "answer", "reply", "respond", "translate", "language",
  "simple", "simply",
]);

function words(text) {
  return text.toLowerCase().match(/[a-z']+/g) ?? [];
}

/**
 * @param {string} question
 * @returns {{language: string, explicit: boolean}} `explicit` is true when the
 *   question names a language outright ("in English", "Tanglish la")
 */
function detectLanguage(question) {
  const text = typeof question === "string" ? question : "";

  for (const [language, pattern] of EXPLICIT_REQUESTS) {
    if (pattern.test(text)) return { language, explicit: true };
  }

  if (TAMIL_SCRIPT_RE.test(text)) return { language: LANGUAGES.TAMIL, explicit: false };

  let weak = 0;
  for (const word of words(text)) {
    if (STRONG_TANGLISH_WORDS.has(word) || TRANSLATIONS.has(word)) return { language: LANGUAGES.TANGLISH, explicit: false };
    if (WEAK_TANGLISH_WORDS.has(word)) weak++;
  }
  if (weak >= 2) return { language: LANGUAGES.TANGLISH, explicit: false };

  return { language: LANGUAGES.ENGLISH, explicit: false };
}

/**
 * The question with language requests, Tanglish words and how-to-answer words
 * removed, so embedding and keyword matching see only the subject.
 * "Consistency na enna? Tanglish la explain pannu" -> "Consistency". Returns
 * "" when nothing but instructions is left ("Idha Tanglish la sollu").
 */
function toRetrievalQuery(question) {
  if (typeof question !== "string") return "";

  const withoutDirectives = question.replace(DIRECTIVE_RE, " ");
  const kept = [];
  for (const token of withoutDirectives.split(/\s+/)) {
    const bare = token.toLowerCase().replace(/[^a-z']/g, "");
    if (bare === "") {
      if (/[^\s?.!,]/.test(token)) kept.push(token);
    } else if (TRANSLATIONS.has(bare)) {
      kept.push(TRANSLATIONS.get(bare));
    } else if (
      !STRONG_TANGLISH_WORDS.has(bare) &&
      !WEAK_TANGLISH_WORDS.has(bare) &&
      !INSTRUCTION_WORDS.has(bare)
    ) {
      kept.push(token);
    }
  }

  const result = kept.join(" ").replace(/\s+([?.!,])/g, "$1").trim();
  return /[\p{L}\p{N}]/u.test(result) ? result : "";
}

/**
 * A translated Tanglish query is a bag of English words ("business start
 * mindset need"), which embeds noticeably worse than a question. Measured:
 * bare, the book's entrepreneurship passages scored ~0.42–0.46 (under the
 * 0.52 threshold) and biriyani/farmer pages ranked first; in this frame the
 * same passages ranked first at 0.58–0.61.
 */
function asSearchQuestion(query) {
  return `What does the book say about: ${query}`;
}

module.exports = { detectLanguage, toRetrievalQuery, asSearchQuestion, LANGUAGES };
