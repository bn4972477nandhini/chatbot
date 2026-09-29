const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { classifyConversational } = require("../../services/conversationalIntentService");

describe("classifyConversational", () => {
  it("recognizes each documented greeting", () => {
    assert.equal(classifyConversational("Hi").answer, "Hi! How can I help you?");
    assert.equal(classifyConversational("Hello").answer, "Hello! How can I help you?");
    assert.equal(classifyConversational("Hey").answer, "Hey! How can I help you?");
    assert.equal(classifyConversational("Good morning").answer, "Good morning! How can I help you?");
    assert.equal(classifyConversational("Good afternoon").answer, "Good afternoon! How can I help you?");
    assert.equal(classifyConversational("Good evening").answer, "Good evening! How can I help you?");
  });

  it("recognizes thanks", () => {
    assert.equal(classifyConversational("Thanks").answer, "You're welcome!");
    assert.equal(classifyConversational("Thank you").answer, "You're welcome!");
  });

  it("recognizes goodbyes", () => {
    assert.equal(classifyConversational("Bye").answer, "Bye! Have a great day!");
    assert.equal(classifyConversational("Goodbye").answer, "Bye! Have a great day!");
  });

  it("is case-insensitive", () => {
    assert.ok(classifyConversational("HELLO"));
    assert.ok(classifyConversational("ThAnK yOu"));
  });

  it("tolerates trailing punctuation and surrounding whitespace", () => {
    assert.ok(classifyConversational("hi!"));
    assert.ok(classifyConversational("hello?"));
    assert.ok(classifyConversational("  bye.  "));
    assert.ok(classifyConversational("thanks!!!"));
  });

  it("does not classify a real question that merely starts with a greeting", () => {
    assert.equal(classifyConversational("Hi, who is the author?"), null);
    assert.equal(classifyConversational("Hello, what is Zero Rupee Marketing?"), null);
  });

  it("does not classify real book questions", () => {
    assert.equal(classifyConversational("Who is the author?"), null);
    assert.equal(classifyConversational("What did the author spend on the IIT Chennai campaign?"), null);
    assert.equal(classifyConversational("Tell me about Sakthi Anna."), null);
  });

  it("does not classify an empty or whitespace-only question", () => {
    assert.equal(classifyConversational(""), null);
    assert.equal(classifyConversational("   "), null);
  });

  it("does not classify a greeting-like word used mid-sentence", () => {
    assert.equal(classifyConversational("Say hi to the author for me"), null);
  });

  it("returns null for a non-string input", () => {
    assert.equal(classifyConversational(undefined), null);
    assert.equal(classifyConversational(42), null);
  });
});
