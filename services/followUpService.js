const { extractKeywords } = require("./retrievalService");
const { toRetrievalQuery } = require("./languageService");

/**
 * Follow-up questions ("Why is it useful?", "Tanglish la sollu") don't carry
 * their own subject, so they can't be retrieved or answered alone. This
 * resolves them against the previous exchange without a model call: on CPU
 * Ollama a query-rewrite completion would cost more than the whole retrieval.
 *
 * Only a detected follow-up gets the earlier turn in its prompt. Sending
 * history with every question would add its tokens to every prefill, which
 * is the slowest step on this hardware.
 */

const MAX_HISTORY_MESSAGES = 4;
// The previous answer is there only so the model can tell what "it" refers
// to; its first few sentences are enough for that.
const MAX_PROMPT_ANSWER_CHARS = 600;
const MAX_FOLLOW_UP_KEYWORDS = 2;

// "this book" / "the author" name their subject, so they are removed before
// looking for a pronoun that points back at the previous turn.
const SELF_CONTAINED_RE = /\b(?:this|that|the)\s+(?:book|author|writer|foreword)\b/gi;

const REFERENCE_WORDS = new Set([
  "it", "its", "this", "that", "these", "those", "they", "them", "their", "he",
  "him", "his", "she", "her", "more", "same", "above",
  "adhu", "athu", "adha", "idhu", "idha", "avar", "avaru", "avanga", "ivar", "ivaru",
  "adhula", "idhula", "athula", "adhoda", "idhoda",
]);

/**
 * Keeps the last few well-formed turns. The route has already validated the
 * shape; this only trims.
 *
 * @param {Array<{role: string, content: string}>} [history]
 */
function recentHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-MAX_HISTORY_MESSAGES);
}

/**
 * The earlier questions a follow-up builds on, oldest first: the most recent
 * one, plus the one before it when that was itself a follow-up. So "Why is it
 * useful?" -> "Tanglish la sollu" still searches for what "it" was.
 */
function topicQuestions(history) {
  const questions = history.filter((turn) => turn.role === "user").map((turn) => turn.content);
  const chain = [];

  for (let index = questions.length - 1; index >= 0; index--) {
    const searchable = toRetrievalQuery(questions[index]);
    chain.unshift(searchable || questions[index]);
    if (!looksLikeFollowUp(searchable, questions[index])) break;
  }

  return chain;
}

/**
 * @param {string} retrievalQuery the question with language wording removed
 *   (languageService.toRetrievalQuery); "" when nothing else was left
 * @param {string} question the question as asked, used for pronouns that
 *   toRetrievalQuery strips (Tanglish "adhu", "idha")
 */
function looksLikeFollowUp(retrievalQuery, question) {
  if (retrievalQuery.trim() === "") return true;

  const referenceText = question.replace(SELF_CONTAINED_RE, " ").toLowerCase();
  const hasReference = (referenceText.match(/[a-z]+/g) ?? []).some((word) =>
    REFERENCE_WORDS.has(word)
  );
  if (!hasReference) return false;

  return extractKeywords(retrievalQuery).length <= MAX_FOLLOW_UP_KEYWORDS;
}

/**
 * @returns {{
 *   followUp: boolean,
 *   retrievalQuery: string,
 *   promptHistory: Array<{role: "user"|"assistant", content: string}>
 * }} `retrievalQuery` is what gets embedded and keyword-matched;
 *   `promptHistory` is what goes into the prompt (empty unless a follow-up).
 */
function resolveFollowUp({ question, retrievalQuery, history }) {
  const turns = recentHistory(history);
  const previousQuestions = topicQuestions(turns);

  if (previousQuestions.length === 0 || !looksLikeFollowUp(retrievalQuery, question)) {
    return { followUp: false, retrievalQuery: retrievalQuery || question, promptHistory: [] };
  }

  const promptHistory = turns.slice(-2).map((turn) => ({
    role: turn.role,
    content:
      turn.role === "assistant" && turn.content.length > MAX_PROMPT_ANSWER_CHARS
        ? `${turn.content.slice(0, MAX_PROMPT_ANSWER_CHARS)}…`
        : turn.content,
  }));

  return {
    followUp: true,
    retrievalQuery: [...previousQuestions, retrievalQuery].join(" ").trim(),
    promptHistory,
  };
}

module.exports = { resolveFollowUp, looksLikeFollowUp, MAX_HISTORY_MESSAGES };
