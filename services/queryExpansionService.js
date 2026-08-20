const { config } = require("../config/env");
const { logger: defaultLogger } = require("../lib/logger");
const { getOpenAIClient: defaultGetClient } = require("./openaiClient");

// Bounded well below a normal answer: this is a handful of short phrasings,
// not prose, so a small budget keeps the extra round trip cheap on a
// CPU-bound local model.
const MAX_OUTPUT_TOKENS = 80;
const MAX_VARIANTS = 2;
const MAX_VARIANT_LENGTH = 150;

// Deliberately topic-agnostic: no wording here is specific to any subject
// (author, numbers, or anything else) the book happens to contain. It asks
// the model to paraphrase whatever question it's given, so the same
// mechanism helps a paraphrased question on any topic, not just one.
const SYSTEM_PROMPT =
  `Rewrite the user's question as ${MAX_VARIANTS} short alternative phrasings that ask for ` +
  "the same information in different words. Reply with exactly one phrasing per line, " +
  "nothing else — no numbering, no bullet points, no explanation, no repetition of the " +
  "original wording.";

/**
 * Builds the query-expansion service.
 *
 * Generates a small number of alternative phrasings of a question via the
 * configured chat model, so retrieval can search on several wordings of the
 * same underlying question rather than only the user's exact one — the fix
 * for a chunk that dense search ranks reasonably but not top for one
 * phrasing (e.g. "who wrote this book?") when it would rank clearly higher
 * for another (e.g. "who is the author?"), without hand-listing synonyms for
 * any particular topic.
 */
function createQueryExpansionService({ getClient = defaultGetClient, logger = defaultLogger } = {}) {
  /**
   * @param {string} question
   * @returns {Promise<string[]>} up to MAX_VARIANTS alternative phrasings;
   *   empty on any failure — expansion is a recall aid, never a hard
   *   dependency, so a broken or slow call degrades to "no expansion" rather
   *   than failing the whole request.
   */
  async function expandQuery(question) {
    try {
      const client = getClient();
      const response = await client.chat.completions.create({
        model: config.llm.chatModel,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: question },
        ],
      });

      const content = response?.choices?.[0]?.message?.content ?? "";
      const normalizedQuestion = question.trim().toLowerCase();

      const variants = content
        .split("\n")
        .map((line) => line.replace(/^[\s\-*•\d.)]+/, "").trim())
        .filter((line) => line.length > 0 && line.length <= MAX_VARIANT_LENGTH)
        .filter((line) => line.toLowerCase() !== normalizedQuestion);

      return [...new Set(variants)].slice(0, MAX_VARIANTS);
    } catch (error) {
      logger.warn("query expansion failed; continuing with the original question only", {
        error: error?.message ?? String(error),
      });
      return [];
    }
  }

  return { expandQuery };
}

module.exports = { createQueryExpansionService, MAX_VARIANTS, MAX_VARIANT_LENGTH };
