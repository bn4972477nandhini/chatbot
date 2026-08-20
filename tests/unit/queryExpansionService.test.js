const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { createQueryExpansionService, MAX_VARIANTS } = require("../../services/queryExpansionService");
const { createMockOpenAI, createTestLogger } = require("../helpers/mocks");

describe("expandQuery", () => {
  it("parses one phrasing per line from the model's reply", async () => {
    const openai = createMockOpenAI({ answer: "Who is the author of this book?\nWhat person wrote it?" });
    const { expandQuery } = createQueryExpansionService({ getClient: () => openai, logger: createTestLogger() });

    const variants = await expandQuery("Who wrote this book?");

    assert.deepEqual(variants, ["Who is the author of this book?", "What person wrote it?"]);
  });

  it("strips numbering and bullet prefixes the model adds despite being told not to", async () => {
    const openai = createMockOpenAI({ answer: "1. Who is the author?\n- What person wrote it?" });
    const { expandQuery } = createQueryExpansionService({ getClient: () => openai, logger: createTestLogger() });

    const variants = await expandQuery("Who wrote this book?");

    assert.deepEqual(variants, ["Who is the author?", "What person wrote it?"]);
  });

  it("drops a line that just repeats the original question", async () => {
    const openai = createMockOpenAI({ answer: "Who wrote this book?\nWho is the author of this book?" });
    const { expandQuery } = createQueryExpansionService({ getClient: () => openai, logger: createTestLogger() });

    const variants = await expandQuery("Who wrote this book?");

    assert.deepEqual(variants, ["Who is the author of this book?"]);
  });

  it("caps the number of variants even if the model returns more", async () => {
    const openai = createMockOpenAI({ answer: "a?\nb?\nc?\nd?" });
    const { expandQuery } = createQueryExpansionService({ getClient: () => openai, logger: createTestLogger() });

    const variants = await expandQuery("q?");

    assert.equal(variants.length, MAX_VARIANTS);
  });

  it("drops duplicate variants", async () => {
    const openai = createMockOpenAI({ answer: "Who is the author?\nWho is the author?" });
    const { expandQuery } = createQueryExpansionService({ getClient: () => openai, logger: createTestLogger() });

    const variants = await expandQuery("Who wrote this book?");

    assert.deepEqual(variants, ["Who is the author?"]);
  });

  it("returns an empty list, never throws, when the completion call fails", async () => {
    const openai = {
      chat: { completions: { create: async () => { throw new Error("network down"); } } },
    };
    const { expandQuery } = createQueryExpansionService({ getClient: () => openai, logger: createTestLogger() });

    const variants = await expandQuery("Who wrote this book?");

    assert.deepEqual(variants, []);
  });

  it("returns an empty list when the model reply is empty or unusable", async () => {
    const openai = createMockOpenAI({ answer: "" });
    const { expandQuery } = createQueryExpansionService({ getClient: () => openai, logger: createTestLogger() });

    const variants = await expandQuery("Who wrote this book?");

    assert.deepEqual(variants, []);
  });

  it("does not reference any specific topic vocabulary — it works the same for an unrelated question", async () => {
    const openai = createMockOpenAI({ answer: "What sum did the campaign cost?\nHow much money went into it?" });
    const { expandQuery } = createQueryExpansionService({ getClient: () => openai, logger: createTestLogger() });

    const variants = await expandQuery("How much was spent on the campaign?");

    assert.equal(variants.length, 2);
  });
});
