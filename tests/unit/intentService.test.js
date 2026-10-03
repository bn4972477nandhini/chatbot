const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { detectIntent, selectEvidence } = require("../../services/intentService");

describe("detectIntent: author identity", () => {
  const authorQuestions = [
    "intha book writer yaru",
    "indha book ah yaar ezhuthunadhu?",
    "who is the writer of this book?",
    "book author yaru?",
    "author name enna?",
    "indha book oda author yaaru?",
    "intha book yaar write pannanga?",
    "Who is the author of this book?",
    "What is the author's name?",
    "Who wrote this book?",
    "Who penned this book?",
    "What's the writer's identity?",
  ];
  for (const question of authorQuestions) {
    it(`recognises "${question}"`, () => {
      assert.equal(detectIntent(question)?.name, "author_identity");
    });
  }

  // These mention the author but ask something else; they must keep the
  // normal retrieval path.
  const otherQuestions = [
    "Who wrote the foreword of this book?",
    "Who is the author and what is his profession?",
    "What did the author say about consistency?",
    "What awards has the author received?",
    "Why did the author write this book?",
    "Avaru enna work pannirukkaru?",
    "What is Zero Rupee Marketing?",
  ];
  for (const question of otherQuestions) {
    it(`leaves "${question}" alone`, () => {
      assert.equal(detectIntent(question), null);
    });
  }
});

describe("selectEvidence", () => {
  const intent = detectIntent("Who wrote this book?");
  const chunk = (chunkId, pageContent) => ({ chunkId, pageContent });

  it("drops chunks that never mention authorship and puts an explicit 'Author: X' line first", () => {
    const selected = selectEvidence(intent, [
      chunk(1, "Thanks to Jane Roe, Editor, Author & Content Writer."),
      chunk(6, "An Outlier Marketer convinces a small target segment."),
      chunk(0, "© John Doe Author: John Doe First Edition"),
      chunk(51, "Stories of farmers and their loans."),
    ]);

    assert.deepEqual(selected.map((c) => c.chunkId), [0, 1]);
  });

  it("returns nothing when no chunk mentions authorship", () => {
    assert.deepEqual(selectEvidence(intent, [chunk(6, "Marketing on a budget.")]), []);
  });
});

describe("detectIntent: author background", () => {
  it("recognises a question about the author's work", () => {
    assert.equal(detectIntent("What companies or ventures has the author founded?")?.name, "author_background");
    assert.equal(detectIntent("What is the author's profession?")?.name, "author_background");
  });

  it("recognises a pronoun follow-up only after an author question", () => {
    assert.equal(
      detectIntent("Avaru enna work pannirukkaru?", { previousQuestion: "Indha book writer yaru?" })?.name,
      "author_background"
    );
    assert.equal(
      detectIntent("Avaru enna work pannirukkaru?", { previousQuestion: "What is Zero Rupee Marketing?" }),
      null
    );
  });

  it("leaves a question that also asks who the author is to the general path", () => {
    assert.equal(detectIntent("Who is the author and what is his profession?"), null);
  });

  it("keeps every retrieved chunk, since it has no evidence rule", () => {
    const intent = detectIntent("What is the author's profession?");
    const chunks = [{ chunkId: 2, pageContent: "He is the Founder of a company." }];
    assert.deepEqual(selectEvidence(intent, chunks), chunks);
  });
});
