const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { detectLanguage, toRetrievalQuery, asSearchQuestion, LANGUAGES } = require("../../services/languageService");

describe("detectLanguage", () => {
  const cases = [
    ["Explain consistency in English", LANGUAGES.ENGLISH, true],
    ["What is Zero Rupee Marketing?", LANGUAGES.ENGLISH, false],
    ["What did Sakthi Anna say about consistency?", LANGUAGES.ENGLISH, false],
    ["Who is the author of this book?", LANGUAGES.ENGLISH, false],
    ["Consistency na enna?", LANGUAGES.TANGLISH, false],
    ["RAG na enna?", LANGUAGES.TANGLISH, false],
    ["Idha Tanglish la explain pannu", LANGUAGES.TANGLISH, true],
    ["Tanglish kudunga", LANGUAGES.TANGLISH, true],
    ["Author yaaru?", LANGUAGES.TANGLISH, false],
    ["Zero Rupee Marketing pathi sollunga", LANGUAGES.TANGLISH, false],
    ["Consistency na enna? English la sollu", LANGUAGES.ENGLISH, true],
    ["Explain this in Tamil", LANGUAGES.TAMIL, true],
    ["இந்த புத்தகத்தின் ஆசிரியர் யார்?", LANGUAGES.TAMIL, false],
  ];

  for (const [question, language, explicit] of cases) {
    it(`"${question}" -> ${language}${explicit ? " (explicit)" : ""}`, () => {
      assert.deepEqual(detectLanguage(question), { language, explicit });
    });
  }

  it("needs two weak markers, so one stray 'la' or 'na' stays English", () => {
    assert.equal(detectLanguage("Is La Liga mentioned?").language, LANGUAGES.ENGLISH);
    assert.equal(detectLanguage("Brand na ah?").language, LANGUAGES.TANGLISH);
  });

  it("treats a non-string as English", () => {
    assert.deepEqual(detectLanguage(undefined), { language: LANGUAGES.ENGLISH, explicit: false });
  });
});

describe("toRetrievalQuery", () => {
  it("keeps only the subject of a Tanglish question", () => {
    assert.equal(toRetrievalQuery("Consistency na enna?"), "Consistency");
    assert.equal(
      toRetrievalQuery("Sakthi Anna consistency pathi enna sonnaru?"),
      "Sakthi Anna consistency"
    );
  });

  it("removes language requests", () => {
    assert.equal(toRetrievalQuery("Explain Zero Rupee Marketing in English"), "Zero Rupee Marketing");
    assert.equal(toRetrievalQuery("Pongal campaign Tanglish la sollu"), "Pongal campaign");
  });

  it("returns an empty string when only instructions are left", () => {
    assert.equal(toRetrievalQuery("Idha Tanglish la explain pannu"), "");
    assert.equal(toRetrievalQuery("Tanglish kudunga"), "");
  });

  it("keeps Tamil-script text", () => {
    assert.equal(toRetrievalQuery("ஆசிரியர் யார்?"), "ஆசிரியர் யார்?");
  });
});

describe("Tanglish words translated for search", () => {
  const cases = [
    ["business start panna enna mindset venum?", "business start mindset need"],
    ["business aarambikka enna important?", "business start important?"],
    ["IIT fest campaign ku evlo selavu aachu?", "IIT fest campaign how much spent cost"],
    ["Pongal kit campaign la enna nadandhuchu?", "Pongal kit campaign happened"],
    ["consistency pathi enna sollirukanga?", "consistency"],
  ];
  for (const [question, expected] of cases) {
    it(`"${question}" -> "${expected}"`, () => {
      assert.equal(toRetrievalQuery(question), expected);
    });
  }

  it("counts a translated word as Tanglish", () => {
    assert.equal(detectLanguage("business aarambikka important?").language, LANGUAGES.TANGLISH);
  });

  it("frames a translated query as a question", () => {
    assert.equal(asSearchQuestion("business start"), "What does the book say about: business start");
  });
});
