const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  questionType,
  isNumericQuestion,
  isPersonQuestion,
  isMultiPart,
  isShortQuestion,
  isAbstractQuestion,
  classifyQuestion,
} = require("../../services/queryUnderstanding");

describe("queryUnderstanding", () => {
  describe("questionType", () => {
    it("detects the leading wh-word regardless of case or punctuation", () => {
      assert.equal(questionType("Who is the author?"), "who");
      assert.equal(questionType("what is this book about?"), "what");
      assert.equal(questionType("WHERE is the office?"), "where");
    });

    it("returns 'other' for imperatives and statements", () => {
      assert.equal(questionType("Tell me about the campaign."), "other");
      assert.equal(questionType("Describe the marketing strategy."), "other");
    });
  });

  describe("isNumericQuestion", () => {
    it("detects a question containing a digit", () => {
      assert.ok(isNumericQuestion("Was it 6000 rupees?"));
    });

    it("detects generic quantity phrasing without any specific figure", () => {
      assert.ok(isNumericQuestion("How much was spent on the campaign?"));
      assert.ok(isNumericQuestion("How many people attended?"));
      assert.ok(isNumericQuestion("What was the cost?"));
    });

    it("does not flag an unrelated factual question as numeric", () => {
      assert.equal(isNumericQuestion("Who is the author of this book?"), false);
    });
  });

  describe("isPersonQuestion", () => {
    it("detects a who-question as a person question", () => {
      assert.ok(isPersonQuestion("Who wrote this book?"));
    });

    it("detects a what-question asking about identity via role words", () => {
      assert.ok(isPersonQuestion("What is the author's name?"));
    });

    it("does not flag an unrelated what-question", () => {
      assert.equal(isPersonQuestion("What is Zero Rupee Marketing?"), false);
    });
  });

  describe("isMultiPart", () => {
    it("detects two distinct question clauses joined by 'and'", () => {
      assert.ok(isMultiPart("Who is the author and where is he based?"));
    });

    it("detects multiple question marks", () => {
      assert.ok(isMultiPart("Who is the author? What is the book about?"));
    });

    it("does not flag a single simple question", () => {
      assert.equal(isMultiPart("Who is the author?"), false);
    });
  });

  describe("isShortQuestion", () => {
    it("flags a terse, grammatically minimal question", () => {
      assert.ok(isShortQuestion("Who is author?"));
      assert.ok(isShortQuestion("Author name?"));
    });

    it("does not flag a full-length question", () => {
      assert.equal(
        isShortQuestion("Who is the author of this book and what is his profession?"),
        false
      );
    });
  });

  describe("isAbstractQuestion", () => {
    it("detects a whole-book summary request", () => {
      assert.ok(isAbstractQuestion("Summarize the key ideas of the book."));
      assert.ok(isAbstractQuestion("What is the main message of the book?"));
      assert.ok(isAbstractQuestion("Give me an overview of the book."));
      assert.ok(isAbstractQuestion("What's the gist of this book?"));
    });

    it("does not flag an ordinary specific-fact question", () => {
      assert.equal(isAbstractQuestion("Who is the author of this book?"), false);
      assert.equal(isAbstractQuestion("How much was spent on the campaign?"), false);
      assert.equal(isAbstractQuestion("What does guerrilla marketing mean?"), false);
    });
  });

  describe("classifyQuestion", () => {
    it("bundles every detector into one object", () => {
      const result = classifyQuestion("Who is author?");
      assert.deepEqual(Object.keys(result).sort(), [
        "isAbstract",
        "isMultiPart",
        "isNumeric",
        "isPerson",
        "isShort",
        "type",
      ]);
      assert.equal(result.type, "who");
      assert.equal(result.isShort, true);
      assert.equal(result.isPerson, true);
    });
  });
});
