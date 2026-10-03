const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { resolveFollowUp, looksLikeFollowUp } = require("../../services/followUpService");

const history = [
  { role: "user", content: "What is Zero Rupee Marketing?" },
  { role: "assistant", content: "Zero Rupee Marketing is guerrilla marketing on almost no budget." },
];

describe("looksLikeFollowUp", () => {
  it("flags a pronoun question with little subject of its own", () => {
    assert.equal(looksLikeFollowUp("Why is it useful?", "Why is it useful?"), true);
    assert.equal(looksLikeFollowUp("Tell me more", "Tell me more"), true);
  });

  it("flags a question with nothing left but instructions", () => {
    assert.equal(looksLikeFollowUp("", "Idha Tanglish la explain pannu"), true);
  });

  it("does not flag a question that names its own subject", () => {
    assert.equal(looksLikeFollowUp("Who wrote this book?", "Who wrote this book?"), false);
    assert.equal(
      looksLikeFollowUp("What was the Pongal kit campaign about?", "What was the Pongal kit campaign about?"),
      false
    );
  });
});

describe("resolveFollowUp", () => {
  it("searches a follow-up together with the previous question and sends the last exchange", () => {
    const result = resolveFollowUp({
      question: "Why is it useful?",
      retrievalQuery: "Why is it useful?",
      history,
    });

    assert.equal(result.followUp, true);
    assert.equal(result.retrievalQuery, "What is Zero Rupee Marketing? Why is it useful?");
    assert.deepEqual(result.promptHistory, history);
  });

  it("re-asks the previous question for a language-only request", () => {
    const result = resolveFollowUp({
      question: "Idha Tanglish la explain pannu",
      retrievalQuery: "",
      history,
    });

    assert.equal(result.followUp, true);
    assert.equal(result.retrievalQuery, "What is Zero Rupee Marketing?");
  });

  it("leaves a standalone question alone and sends no history", () => {
    const result = resolveFollowUp({
      question: "Who wrote the foreword?",
      retrievalQuery: "Who wrote the foreword?",
      history,
    });

    assert.deepEqual(result, {
      followUp: false,
      retrievalQuery: "Who wrote the foreword?",
      promptHistory: [],
    });
  });

  it("has nothing to follow without history", () => {
    const result = resolveFollowUp({ question: "Why is it useful?", retrievalQuery: "Why is it useful?" });

    assert.equal(result.followUp, false);
    assert.deepEqual(result.promptHistory, []);
  });

  it("falls back to the question as asked when nothing searchable is left and there is no history", () => {
    const result = resolveFollowUp({ question: "Tanglish kudunga", retrievalQuery: "", history: [] });

    assert.equal(result.retrievalQuery, "Tanglish kudunga");
  });

  it("truncates a long previous answer in the prompt", () => {
    const longAnswer = "x".repeat(2000);
    const result = resolveFollowUp({
      question: "Why is it useful?",
      retrievalQuery: "Why is it useful?",
      history: [history[0], { role: "assistant", content: longAnswer }],
    });

    assert.ok(result.promptHistory[1].content.length < 700);
  });
});

describe("follow-up chains", () => {
  it("keeps the original topic through a follow-up of a follow-up", () => {
    const result = resolveFollowUp({
      question: "Idha Tanglish la explain pannu",
      retrievalQuery: "",
      history: [
        { role: "user", content: "What is Zero Rupee Marketing?" },
        { role: "assistant", content: "Guerrilla marketing on almost no budget." },
        { role: "user", content: "Why is it useful?" },
        { role: "assistant", content: "It lets small businesses reach people cheaply." },
      ],
    });

    assert.equal(result.retrievalQuery, "What is Zero Rupee Marketing? Why is it useful?");
    assert.equal(result.promptHistory.length, 2, "only the last exchange goes into the prompt");
  });

  it("stops at the most recent standalone question", () => {
    const result = resolveFollowUp({
      question: "Why is it useful?",
      retrievalQuery: "Why is it useful?",
      history: [
        { role: "user", content: "Who wrote the foreword?" },
        { role: "assistant", content: "Pravin Sekar." },
        { role: "user", content: "What is Zero Rupee Marketing?" },
        { role: "assistant", content: "Guerrilla marketing on almost no budget." },
      ],
    });

    assert.equal(result.retrievalQuery, "What is Zero Rupee Marketing? Why is it useful?");
  });
});

describe("Tanglish back-references", () => {
  it("treats 'adhula …' as a follow-up", () => {
    assert.equal(looksLikeFollowUp("important point", "adhula important point enna?"), true);
  });
});
