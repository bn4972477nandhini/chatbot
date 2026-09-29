/**
 * Deterministic, zero-cost classification of obvious small-talk (greetings,
 * thanks, goodbyes) so those never reach retrieval, query expansion, or the
 * model at all — no extra Ollama call, no Qdrant search. Pure pattern
 * matching against the whole (trimmed, case-folded) question, never a
 * substring match, specifically so a real question that merely starts with a
 * greeting ("Hi, who is the author?") still falls through to the normal RAG
 * pipeline rather than being misclassified as small talk.
 */

const GREETINGS = ["hi", "hello", "hey", "good morning", "good afternoon", "good evening"];
const THANKS = ["thanks", "thank you"];
const GOODBYES = ["bye", "goodbye"];

/** Strips trailing punctuation and surrounding whitespace, case-folded — "Hi!" and "hi" must classify the same. */
function normalize(question) {
  return question.trim().toLowerCase().replace(/[!.?,]+$/, "").trim();
}

function capitalizeFirst(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * @param {string} question
 * @returns {{answer: string} | null} a canned reply for obvious small talk,
 *   or null when the question should go through the normal RAG pipeline —
 *   which is the default for anything not an exact match, by design.
 */
function classifyConversational(question) {
  if (typeof question !== "string") return null;

  const normalized = normalize(question);

  if (GREETINGS.includes(normalized)) {
    return { answer: `${capitalizeFirst(normalized)}! How can I help you?` };
  }
  if (THANKS.includes(normalized)) {
    return { answer: "You're welcome!" };
  }
  if (GOODBYES.includes(normalized)) {
    return { answer: "Bye! Have a great day!" };
  }

  return null;
}

module.exports = { classifyConversational };
