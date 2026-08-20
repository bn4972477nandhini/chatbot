/**
 * Comprehensive end-to-end evaluation, run as real HTTP POST /chat calls
 * against a live server (real query embedding -> real Qdrant retrieval ->
 * real MMR/RRF re-ranking -> real prompt construction -> real Ollama
 * llama3.2 completion). Nothing here is mocked or called in-process.
 *
 * Expected answers are grading data for THIS SCRIPT ONLY, derived by reading
 * the actual indexed PDF (uploads/founder.pdf) — none of it lives in
 * application code (services/*, promptService.js, etc.), which never
 * references any book-specific fact.
 *
 * Usage: node scripts/evaluate-chat.js [--base=http://localhost:3000]
 *        node scripts/evaluate-chat.js --range=1-6 --out=eval-batch1.json
 *        node scripts/evaluate-chat.js --regression
 *
 * --range=START-END (1-indexed, inclusive) restricts the run to a slice of
 * QUESTIONS below — for running the full set as several short-lived
 * processes instead of one long one on a slow, CPU-bound Ollama backend.
 * --out=<filename> writes results under scripts/ as that name instead of
 * overwriting eval-results.json, so batches don't clobber each other.
 * --regression runs REGRESSION_QUESTIONS (the salon/raincoat attribution
 * lock-in set) instead of the 33-question QUESTIONS set; --range still
 * applies within whichever pool is selected.
 */
const { NO_ANSWER_REPLY } = require("../services/promptService");

const BASE_URL =
  process.argv.find((a) => a.startsWith("--base="))?.slice("--base=".length) ??
  "http://localhost:3000";

const RANGE_ARG = process.argv.find((a) => a.startsWith("--range="))?.slice("--range=".length);
const OUT_ARG = process.argv.find((a) => a.startsWith("--out="))?.slice("--out=".length);

/**
 * `expect: "answer"` passes when the response is a real, cited answer that
 * contains at least one of `keywords` (case-insensitive substring, any
 * match). `expect: "decline"` passes when the response is the exact
 * NO_ANSWER_REPLY fallback.
 */
const QUESTIONS = [
  // --- Item 17's exact required questions -----------------------------
  { id: "req-author-1", category: "author", question: "Who is the author of this book?", expect: "answer", keywords: ["Sakthivel", "Pannerselvam"] },
  { id: "req-author-2", category: "author", question: "What is the author's name?", expect: "answer", keywords: ["Sakthivel", "Pannerselvam"] },
  { id: "req-author-3", category: "author", question: "Who wrote this book?", expect: "answer", keywords: ["Sakthivel", "Pannerselvam"] },
  { id: "req-bio-1", category: "biography", question: "Tell me about Sakthi Anna.", expect: "answer", keywords: ["Sakthivel", "the6.in", "Surprise", "guerrilla"] },
  { id: "req-concept-1", category: "concept", question: "What is Zero Rupee Marketing?", expect: "answer", keywords: ["guerrilla", "zero rupee", "low cost", "low-cost"] },
  { id: "req-examples-1", category: "examples", question: "Give me examples from the book.", expect: "answer", keywords: ["campaign"] },
  { id: "req-marketing-1", category: "marketing", question: "What marketing lessons are discussed in the book?", expect: "answer", keywords: ["marketing"] },
  { id: "req-campaigns-1", category: "campaigns", question: "What campaigns are mentioned?", expect: "answer", keywords: ["campaign"] },
  // The book only poses a salon campaign as a rhetorical "myth buster"
  // discussion prompt on page 80 — no case study with an actual spend figure
  // exists for it (the nearby SPENT/REACH/ROI numbers belong to the previous,
  // unrelated raincoat campaign). Correct behavior is to decline rather than
  // fabricate a number by borrowing an adjacent campaign's figures.
  { id: "req-salon-1", category: "numbers/trap", question: "What was spent on the salon campaign?", expect: "decline", note: "No real salon case study exists — only a rhetorical prompt. Declining (or explicitly saying no figure is given) is correct; stating a specific Rs. figure for 'the salon campaign' would be a hallucination." },
  { id: "req-business-1", category: "business", question: "What are the important business lessons from the book?", expect: "answer", keywords: ["business", "marketing"] },
  { id: "req-summary-1", category: "multi-chunk", question: "Summarize the key ideas of the book.", expect: "answer", keywords: ["guerrilla", "marketing"] },
  { id: "req-mainmsg-1", category: "multi-chunk", question: "What is the main message of the book?", expect: "answer", keywords: ["guerrilla", "marketing"] },
  { id: "req-offtopic-1", category: "unsupported", question: "What is the capital of France?", expect: "decline" },

  // --- Additional coverage ---------------------------------------------
  { id: "dates-1", category: "dates", question: "When was this book published?", expect: "answer", keywords: ["2020"] },
  { id: "locations-1", category: "locations", question: "Where is the author based?", expect: "answer", keywords: ["Chennai"] },
  { id: "numbers-1", category: "numbers", question: "How much was spent on the first guerrilla marketing campaign at the IIT Chennai fest?", expect: "answer", keywords: ["6000", "6,000"] },
  { id: "casestudy-1", category: "case study", question: "What happened during the balloon campaign at IIT Chennai?", expect: "answer", keywords: ["balloon", "IIT"] },
  { id: "casestudy-2", category: "case study", question: "What was the Pongal kit campaign about?", expect: "answer", keywords: ["Pongal", "ninja"] },
  { id: "achievements-1", category: "achievements", question: "What awards has the author received?", expect: "answer", keywords: ["award"] },
  { id: "personal-1", category: "personal story", question: "What personal struggles did the author face before starting his business?", expect: "answer", keywords: ["flood", "quit", "salary", "job"] },
  { id: "bio-family-1", category: "biography", question: "Who are the author's family members mentioned in the book?", expect: "answer", keywords: ["Bhuvana", "Laya", "Sharaan"] },
  { id: "business-companies-1", category: "business", question: "What companies or ventures has the author founded?", expect: "answer", keywords: ["the6.in", "HappyO", "Drums Circle"] },
  { id: "definition-1", category: "definition", question: "What does guerrilla marketing mean according to the book?", expect: "answer", keywords: ["guerrilla"] },
  { id: "why-1", category: "why", question: "Why did the author write this book?", expect: "answer", keywords: ["Pravin", "Covid", "lockdown"] },
  { id: "how-1", category: "how", question: "How did the author execute the balloon campaign at IIT?", expect: "answer", keywords: ["balloon"] },
  { id: "paraphrase-1", category: "paraphrased", question: "Who penned this book?", expect: "answer", keywords: ["Sakthivel", "Pannerselvam"] },
  { id: "paraphrase-2", category: "paraphrased", question: "What's the writer's identity?", expect: "answer", keywords: ["Sakthivel", "Pannerselvam"] },
  { id: "multipart-1", category: "multi-part", question: "Who is the author and what is his profession?", expect: "answer", keywords: ["Entrepreneur", "Sakthivel"] },
  { id: "multichunk-2", category: "multi-chunk", question: "What are some of the different marketing campaigns and their results described throughout the book?", expect: "answer", keywords: ["campaign"] },
  { id: "foreword-1", category: "book introduction", question: "Who wrote the foreword of this book?", expect: "answer", keywords: ["Pravin"] },
  { id: "media-1", category: "achievements", question: "What media outlets or TV channels featured the author's work?", expect: "answer", keywords: ["BBC", "Outlook", "Vijay", "Times of India", "Hindu"] },
  { id: "offtopic-2", category: "unsupported", question: "What is the recipe for pizza dough?", expect: "decline" },
  { id: "offtopic-3", category: "unsupported", question: "Who is the president of the United States?", expect: "decline" },
];

/**
 * Standalone attribution-regression set (run via --regression), separate from
 * the 33-question QUESTIONS set above so that array stays exactly 33.
 *
 * Grounded in the real indexed text around page 80 (verified via a Qdrant
 * scroll query against the live founder_book collection, chunkId 70-76):
 * the "Myth Buster" summary box (SPENT Rs.450 / REACH 2 million / ROI
 * Articles worth of 7 lakhs) reports the results of the PRECEDING raincoat
 * campaign story. It is immediately followed, in the same chunk, by an
 * unrelated rhetorical prompt aimed at the reader ("If you are running a
 * salon can you have a series of campaigns with one agenda? What is that?")
 * that the book never answers and ties no figures to. Correct behavior is to
 * report the raincoat figures when asked about the raincoat campaign, and to
 * decline — never borrowing the raincoat figures — for anything asked about
 * "the salon campaign".
 */
const REGRESSION_QUESTIONS = [
  {
    id: "regr-salon-nonexistent",
    category: "attribution-regression",
    question: "How much money was spent on the salon campaign mentioned in the book?",
    expect: "decline",
    note: "No salon case study exists — only a rhetorical prompt to the reader. Must not borrow the raincoat campaign's Rs.450 figure.",
  },
  {
    id: "regr-raincoat-real-metrics",
    category: "attribution-regression",
    question: "What were the results of the raincoat campaign — how much was spent, what was the reach, and what was the ROI?",
    expect: "answer",
    keywords: ["450"],
    note: "Control case: real figures exist for this campaign (SPENT Rs.450, REACH 2 million, ROI 7 lakhs) and should be reported when correctly attributed.",
  },
  {
    id: "regr-salon-rhetorical-prompt",
    category: "attribution-regression",
    question: "What specific salon marketing campaign does the book describe, and what results did it achieve?",
    expect: "decline",
    note: "The salon mention is a rhetorical question posed to the reader, not a described case study with results — must not be answered as if it were one.",
  },
  {
    id: "regr-salon-roi-decline",
    category: "attribution-regression",
    question: "What was the ROI or reach of the salon campaign?",
    expect: "decline",
    note: "Same misattribution risk as spend, but for a different metric field (ROI/reach) — the adjacent figures belong to the raincoat campaign, not the salon.",
  },
];

async function askChat(question) {
  const response = await fetch(`${BASE_URL}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  const body = await response.json();
  return { status: response.status, body };
}

/**
 * Narrow, evidence-safe paraphrases of the exact fallback wording. Each
 * pattern requires the answer to explicitly claim an absence of evidence —
 * not merely sound uncertain or hedge — so a vague or wrong answer still
 * fails grading. Broadening this list should only ever add another way of
 * saying "the book does not support this claim", never a generic hedge.
 */
const DECLINE_PATTERNS = [
  /couldn.?t find that information/i,
  /not (?:explicitly |directly )?stated (?:in|within) the (?:book|context|text|provided (?:context|content))/i,
  /not available (?:in|within) the (?:book|provided context|context|text)/i,
  /(?:could not|couldn.?t|cannot|can.?t) find (?:sufficient|enough) evidence/i,
  /cannot determine (?:this |that )?from the provided (?:content|context)/i,
  /(?:context|book|text) does not mention (?:the )?(?:specific )?(?:amount|figure|number|value|reach|roi)/i,
];

function grade(item, answer, citations) {
  if (item.expect === "decline") {
    const exact = answer.trim() === NO_ANSWER_REPLY;
    const evidenceBasedDecline = DECLINE_PATTERNS.some((pattern) => pattern.test(answer));
    return { pass: exact || evidenceBasedDecline, exactMatch: exact };
  }

  const isFallback = answer.trim() === NO_ANSWER_REPLY;
  const hasCitations = citations.length > 0;
  const lower = answer.toLowerCase();
  const keywordHit = (item.keywords ?? []).some((k) => lower.includes(k.toLowerCase()));

  return { pass: !isFallback && hasCitations && keywordHit, isFallback, hasCitations, keywordHit };
}

const REGRESSION_ARG = process.argv.includes("--regression");

function resolveQuestions() {
  const pool = REGRESSION_ARG ? REGRESSION_QUESTIONS : QUESTIONS;
  if (!RANGE_ARG) return pool;

  const match = /^(\d+)-(\d+)$/.exec(RANGE_ARG);
  if (!match) throw new Error(`--range must look like "1-6" (1-indexed, inclusive), got "${RANGE_ARG}"`);

  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start < 1 || end > pool.length || start > end) {
    throw new Error(`--range=${RANGE_ARG} is out of bounds for ${pool.length} questions`);
  }

  return pool.slice(start - 1, end);
}

async function main() {
  const questions = resolveQuestions();
  const pool = REGRESSION_ARG ? REGRESSION_QUESTIONS : QUESTIONS;
  const outFile = OUT_ARG ?? (REGRESSION_ARG ? "eval-regression.json" : "eval-results.json");
  console.log(
    `Evaluating against ${BASE_URL} — ${questions.length} question(s)` +
      (REGRESSION_ARG ? " [regression set]" : "") +
      (RANGE_ARG ? ` (range ${RANGE_ARG} of ${pool.length})` : "") +
      "\n"
  );

  const results = [];

  for (const item of questions) {
    const startedAt = Date.now();
    let outcome;
    try {
      const { status, body } = await askChat(item.question);
      const elapsedMs = Date.now() - startedAt;

      if (status !== 200) {
        outcome = { ...item, pass: false, status, error: body?.error, elapsedMs };
      } else {
        const gradeResult = grade(item, body.answer, body.citations ?? []);
        outcome = {
          ...item,
          ...gradeResult,
          status,
          answer: body.answer,
          citations: body.citations,
          elapsedMs,
        };
      }
    } catch (error) {
      outcome = { ...item, pass: false, error: String(error), elapsedMs: Date.now() - startedAt };
    }

    results.push(outcome);

    const mark = outcome.pass ? "PASS" : "FAIL";
    console.log(`[${mark}] (${outcome.elapsedMs}ms) ${item.id} — ${item.category} — "${item.question}"`);
    if (outcome.answer) {
      console.log(`       answer: ${outcome.answer.replace(/\s+/g, " ").slice(0, 220)}`);
      console.log(`       citations: ${(outcome.citations ?? []).map((c) => `chunk${c.chunkId}@p${c.page ?? "?"}(${c.score?.toFixed(3)})`).join(", ") || "(none)"}`);
    } else if (outcome.error) {
      console.log(`       error: ${outcome.error}`);
    }
    console.log("");
  }

  const passCount = results.filter((r) => r.pass).length;
  console.log("=== Summary ===");
  console.log(`${passCount}/${results.length} passed`);

  const byCategory = new Map();
  for (const r of results) {
    const entry = byCategory.get(r.category) ?? { pass: 0, total: 0 };
    entry.total += 1;
    if (r.pass) entry.pass += 1;
    byCategory.set(r.category, entry);
  }
  for (const [category, { pass, total }] of byCategory) {
    console.log(`  ${category.padEnd(20)} ${pass}/${total}`);
  }

  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    console.log("\n=== Failures ===");
    for (const r of failed) {
      console.log(`  ${r.id}: "${r.question}"`);
      console.log(`    -> ${r.answer ?? r.error}`);
    }
  }

  require("fs").writeFileSync(
    require("path").join(__dirname, outFile),
    JSON.stringify(results, null, 2)
  );
  console.log(`\nFull results written to scripts/${outFile}`);

  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("Evaluation run failed:", error);
  process.exitCode = 1;
});
