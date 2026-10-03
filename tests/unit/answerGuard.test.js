const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { repetitionStart, trimRepetition, ungroundedNumbers } = require("../../services/answerGuard");

describe("trimRepetition", () => {
  it("cuts the reported Tanglish loop back to its first clause", () => {
    const looped =
      "Sakthi a DOER, ayan irukkenga. Book writer yaru, ayan irukkenga. Sakthi a entrepreneur, ayan irukkenga. Zero Rupee Marketing ayan irukkenga";

    assert.equal(trimRepetition(looped, { checkPairs: true }), "Sakthi a DOER, ayan irukkenga.");
  });

  it("cuts a repeated five-word phrase in any language", () => {
    const looped =
      "Zero rupee marketing aiyappan, aiyappan! Zero rupee marketing aiyappan, aiyappan! Zero rupee marketing aiyappan, aiyappan!";

    assert.equal(trimRepetition(looped), "Zero rupee marketing aiyappan, aiyappan!");
  });

  it("leaves a correct English answer that repeats a name untouched", () => {
    const answer =
      "Zero Rupee Marketing is cheap. Zero Rupee Marketing is creative. Zero Rupee Marketing works and Zero Rupee Marketing spreads.";

    assert.equal(trimRepetition(answer), answer);
    assert.equal(trimRepetition(answer, { checkPairs: true }), answer);
  });

  it("leaves a list of campaign figures untouched", () => {
    const list =
      "SPENT: Rs.8000, REACH: 2 million. SPENT: Rs.4500, REACH: 7 lakh. SPENT: Rs.6000, REACH: 3 lakh. SPENT: Rs.3000, REACH: 1 lakh.";

    assert.equal(trimRepetition(list, { checkPairs: true }), list);
  });

  it("reports no loop in a clean answer", () => {
    assert.equal(repetitionStart("Indha book-oda writer Sakthivel Pannerselvam.", { checkPairs: true }), null);
  });
});

describe("ungroundedNumbers", () => {
  const evidence = "Spent Rs.6,000 on the campaign. ROI 1.5 lakhs. First Edition June 2020. [Excerpt from page 112]";

  it("flags a figure the evidence never states", () => {
    assert.deepEqual(ungroundedNumbers("Avaru 2011-la start pannaru.", evidence), ["2011"]);
  });

  it("accepts figures written with or without thousands separators, decimals and page numbers", () => {
    assert.deepEqual(ungroundedNumbers("They spent Rs.6000 (page 112) for 1.5 lakhs in 2020.", evidence), []);
  });

  it("ignores small numbers such as list numbering", () => {
    assert.deepEqual(ungroundedNumbers("1. First idea 2. Second idea", evidence), []);
  });
});

describe("stripQuestionEcho", () => {
  const { stripQuestionEcho } = require("../../services/answerGuard");

  it("drops a word-for-word repeat of the question at the start", () => {
    assert.equal(
      stripQuestionEcho("IIT fest campaign ku evlo selavu aachu? Na, Rs.6000 spent.", "IIT fest campaign ku evlo selavu aachu?"),
      "Na, Rs.6000 spent."
    );
  });

  it("leaves an answer that only starts with the same subject alone", () => {
    assert.equal(
      stripQuestionEcho("Zero Rupee Marketing is a technique.", "What is Zero Rupee Marketing?"),
      "Zero Rupee Marketing is a technique."
    );
  });
});
