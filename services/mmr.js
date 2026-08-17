/**
 * Maximal Marginal Relevance.
 *
 * Pure vector maths, deliberately free of any Qdrant or OpenAI coupling so it
 * can be unit tested directly.
 *
 * Plain top-k similarity tends to return near-duplicate chunks — with 200
 * characters of overlap between neighbours, the top hits are frequently the same
 * passage twice. MMR trades a little relevance for diversity, so the model gets
 * several distinct passages instead of one repeated.
 */

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function norm(vector) {
  return Math.sqrt(dot(vector, vector));
}

/** Cosine similarity, returning 0 for zero-length vectors rather than NaN. */
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;

  const denominator = norm(a) * norm(b);
  return denominator === 0 ? 0 : dot(a, b) / denominator;
}

/**
 * Selects up to `k` candidates balancing query relevance against dissimilarity
 * to already-selected items.
 *
 * @param {object}   params
 * @param {number[]} params.queryVector
 * @param {Array<{vector?: number[], score?: number}>} params.candidates
 * @param {number}   params.k
 * @param {number}   params.lambda 1 = pure relevance, 0 = pure diversity
 * @returns {Array} the selected candidate objects, most relevant first
 */
function maximalMarginalRelevance({ queryVector, candidates, k, lambda = 0.7 }) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  if (k <= 0) return [];

  // Without vectors there is nothing to diversify on — preserve Qdrant's order.
  const usable = candidates.filter((c) => Array.isArray(c.vector) && c.vector.length > 0);
  if (usable.length === 0) return candidates.slice(0, k);

  // Precomputed so each candidate's query similarity is calculated once rather
  // than on every selection round.
  const relevance = usable.map((candidate) =>
    typeof candidate.score === "number"
      ? candidate.score
      : cosineSimilarity(queryVector, candidate.vector)
  );

  const selected = [];
  const selectedIndexes = [];
  const remaining = usable.map((_, index) => index);

  while (selected.length < Math.min(k, usable.length)) {
    let bestPosition = 0;
    let bestValue = -Infinity;

    for (let position = 0; position < remaining.length; position++) {
      const index = remaining[position];

      // Penalise by the closest already-selected item.
      let maxSimilarity = 0;
      for (const chosen of selectedIndexes) {
        const similarity = cosineSimilarity(usable[index].vector, usable[chosen].vector);
        if (similarity > maxSimilarity) maxSimilarity = similarity;
      }

      const value = lambda * relevance[index] - (1 - lambda) * maxSimilarity;

      if (value > bestValue) {
        bestValue = value;
        bestPosition = position;
      }
    }

    const chosenIndex = remaining[bestPosition];
    selectedIndexes.push(chosenIndex);
    selected.push(usable[chosenIndex]);
    remaining.splice(bestPosition, 1);
  }

  return selected;
}

module.exports = { maximalMarginalRelevance, cosineSimilarity };
