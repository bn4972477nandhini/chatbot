# CAP-2: `llama3.2` (3B) vs `llama3.2:1b` on the current code

Spec: `_bmad-output/implementation-artifacts/spec-cap-2-llama-1b.md`. Measured 2026-09-29.

## Verdict

| Bar (human decision, 2026-09-29) | 3B | 1B | Met? |
|---|---|---|---|
| 1B median `elapsedMs` ≤ 60% of 3B's | 59,306 ms | 34,083 ms (**57.5%**) | Yes |
| 1B pass count at most 1 below 3B's | **30/33** | **25/33** (5 below) | **No** |

**Result: keep `llama3.2` (3B) as the default. `llama3.2:1b` is documented as an opt-in.**

1B is faster: its median time is 57.5% of 3B's, which clears the 60% bar. But it fails the quality bar by a wide margin. The quality result holds even after the adjustments described under "Run conditions": with the re-run results swapped in, 1B scores 26/33, still 4 below 3B. 1B also fails 3 of the 4 decline questions, and one of those failures is a made-up spend figure. That finding went to `deferred-work.md` as a prompt fix.

## Run conditions

| | 3B | 1B |
|---|---|---|
| Commit | `cf502cf` (+ untracked files only) | same |
| Index | `founder_book` (87 points, 768-dim `nomic-embed-text`) | same |
| `.env` | as checked in locally (`RETRIEVAL_USE_QUERY_EXPANSION=true`, `CHAT_MAX_OUTPUT_TOKENS=150`, `CHAT_SEED=7`, `CHAT_TEMPERATURE=0.1`, `OLLAMA_KEEP_ALIVE=30m`) | same, plus `OLLAMA_LLM_MODEL=llama3.2:1b` **set in the process environment only** |
| Server | fresh `node server.js`, log `scripts/cap2-server-3b.log` | fresh `OLLAMA_LLM_MODEL=llama3.2:1b node server.js`, log `scripts/cap2-server-1b.log` |
| `server started` → `chatModel` | `"llama3.2"` | `"llama3.2:1b"` |
| CAP-1 warm-up | complete, 1,618 ms (3B was already resident in Ollama) | complete, 26,959 ms (cold 1B load + system-prompt prefill) |
| Command | `node scripts/evaluate-chat.js --out=eval-cap2-3b.json` | `node scripts/evaluate-chat.js --out=eval-cap2-1b.json` |
| Results | `scripts/eval-cap2-3b.json`, `scripts/eval-cap2-3b.log` | `scripts/eval-cap2-1b.json`, `scripts/eval-cap2-1b.log` |

`npm test` was run beforehand: 264/264 passing. No benchmark or test was running during either eval.

**Benchmark environment:**
- Hardware: Intel i5-7300U (2 cores, 4 threads), 16 GB RAM, no usable GPU (Intel HD 620; `ollama ps` shows 100% CPU).
- Ollama: 0.34.4.
- `llama3.2:latest`: 3.2B, Q4_K_M, digest `a80c4f17acd55265feec403c7aef86be0c25983ab279d83f3bcd3abbcb5b8b72`.
- `llama3.2:1b`: 1.2B, Q8_0, digest `baf6a787fdffd633537aa2eb51cfd54cb93ff08e28040095462bb63daf552878`.
- `nomic-embed-text:latest`: 137M, F16.
- Model digests and quantizations were read from `GET /api/tags`.

The raw run artifacts are local-only and not in the repository: `scripts/eval-cap2-*.json`/`.log`, the `eval-cap2-1b-rerun-*` files and the `scripts/cap2-server-*.log` server logs. They are untracked and won't be committed.

**What went wrong during the 1B run (the 3B run was clean):**

1. **Outside UI traffic.** Someone used the frontend during the 1B run. Its requests were `stream: true`, and these eval runs didn't use `--stream`, so they came from outside the eval. One UI request arrived at 11:53:11Z. The client disconnected at 11:53:21.242Z, but the aborted model call didn't return its error until 11:53:43.423Z, so it held Ollama for about 32 s. Eval #6 `req-examples-1` started right after that, at 11:53:43.427Z. One cache hit came at 12:01:55Z. One full 64 s answer ran from 12:02:04Z to 12:03:08Z. These overlapped eval questions #5 `req-concept-1`, #18 `casestudy-2`, #19 `achievements-1` and #20 `personal-1`, so those four timings are inflated. During the 3B run the only UI request arrived at 11:49:56Z, after the last eval question had finished at 11:49:26Z, so it didn't affect any timing.
2. **Temporary Qdrant failure.** Question #7 `req-marketing-1` failed with `502 Qdrant search failed: fetch failed` after 5,080 ms. That is an infrastructure fault, not a model failure.

To measure how much these problems mattered, those five questions were re-run on a new 1B server (fresh response cache, no UI traffic in `scripts/cap2-server-1b-rerun.log`). Results are in `scripts/eval-cap2-1b-rerun-5-6.json` (#6 was re-run too by accident, and it passed again), `eval-cap2-1b-rerun-7.json` and `eval-cap2-1b-rerun-18-20.json`. The main `eval-cap2-1b.json` was left unchanged.

## Summary numbers (`elapsedMs`, all 33 questions)

| | Pass | Median | p90 | Max | Mean | Min |
|---|---|---|---|---|---|---|
| 3B `eval-cap2-3b.json` | **30/33** | 59,306 | 91,998 | 93,868 | 61,718 | 27,040 |
| 1B `eval-cap2-1b.json` (as run) | **25/33** | 34,083 | 49,748 | 63,000 | 34,366 | 5,080 |
| 1B with the 5 affected questions replaced by their re-runs | 26/33 | 31,887 | 49,551 | 63,000 | 34,903 | 15,183 |
| 1B vs 3B, affected questions left out of both (n=28) | — | 30,762 vs 53,574 (57.4%) | — | — | — | — |

p90 is the nearest-rank value (the 30th of 33 sorted values). The median ratio stays between 53.8% and 57.5% under every adjustment (31,887 / 59,306 = 53.8% with the re-runs substituted), and the pass-count gap stays between 4 and 5. The verdict is the same in every case.

**Output-cap hits.** `CHAT_MAX_OUTPUT_TOKENS=150` cut off some answers. The server logs show `completion_tokens` = 150 on 7 of 33 answered requests for 3B and 6 of 32 for 1B (the 33rd 1B request is the Qdrant failure). Because those answers were cut off, the p90 and max timings are lower than uncapped generation would give. The keyword grader still passes a truncated answer if a keyword appears before the cut.

**Grader sensitivity.** 1B's two refusals in its own words ("The passage does not mention…") don't match `DECLINE_PATTERNS`, so they are graded as failures. Counting both as passes would give 1B at most 28/33 (27 as run, 28 with the re-runs) against 3B's 30. That is still more than 1 below, so the verdict doesn't change. 3B's `multipart-1` failure looks like an artifact of the keyword grader: it said "Outlier Marketer", a reasonable description the book gives, and the grader wanted "Entrepreneur".

**Sample size.** Each model had one run of 33 questions, with no repeat runs. The claim that 1B misattributes authorship more often rests on 2 questions (`paraphrase-1`, `business-companies-1`), and the decline result rests on 4. Treat these as indications, not stable rates.

For comparison, the August runs used an older prompt, so they are not directly comparable: 3B `eval-baseline-full.json` scored 27/33 with a 72.6 s median and 152.7 s max, and 1B `eval-1b-final.json` scored 26/33 with a 35.7 s median and 74.5 s max. On the current code, 3B got both faster and more accurate. 1B's speed stayed about the same, but it now declines less reliably.

## Failures by category

| Category | 3B | 1B | 1B failures |
|---|---|---|---|
| author | 3/3 | 3/3 | |
| biography | 1/2 | 2/2 | |
| concept | 1/1 | 1/1 | |
| examples | 1/1 | 1/1 | |
| marketing | 1/1 | 0/1 | `req-marketing-1`: Qdrant `fetch failed` (infrastructure; passed on re-run) |
| campaigns | 1/1 | 1/1 | |
| numbers/trap | 1/1 | 0/1 | `req-salon-1`: made up "Rs. 300" |
| business | 2/2 | 1/2 | `business-companies-1`: named the foreword writer "Pravin Sekar" as the author and listed his ventures |
| multi-chunk | 3/3 | 3/3 | |
| unsupported | 3/3 | 1/3 | `req-offtopic-1`, `offtopic-2`: refused, but not with the fallback string |
| dates | 1/1 | 1/1 | |
| locations | 1/1 | 1/1 | |
| numbers | 1/1 | 0/1 | `numbers-1`: pasted the page-14 passage verbatim (mentions a "worth 40k" barter) without giving the 6,000 spend |
| case study | 2/2 | 2/2 | |
| achievements | 2/2 | 2/2 | |
| personal story | 0/1 | 0/1 | both models (see below) |
| definition | 1/1 | 1/1 | |
| why | 1/1 | 1/1 | |
| how | 1/1 | 1/1 | |
| paraphrased | 2/2 | 1/2 | `paraphrase-1`: "penned by Dhivya Balaji", the editor, not the author |
| multi-part | 0/1 | 1/1 | |
| book introduction | 1/1 | 1/1 | |

3B's three failures:
- `req-bio-1`: returned `NO_ANSWER_REPLY` for "Tell me about Sakthi Anna." 1B passed this one.
- `personal-1`: gave the parents' sacrifice from the dedication page instead of the flood/quit/salary story. 1B also failed, with the #HappyDoll page 30.
- `multipart-1`: "Outlier Marketer" instead of the expected "Entrepreneur" keyword. 1B passed this one.

1B's errors that 3B doesn't make are mostly **wrong attribution**: it names the editor or the foreword writer as the author (`paraphrase-1`, `business-companies-1`). It also invents a figure where the book gives none (`req-salon-1`).

## Off-topic and trap questions, answers quoted verbatim

Each question below expects the model to decline. A decline passes when it is the exact `NO_ANSWER_REPLY` or matches one of `DECLINE_PATTERNS`. Every answer below came back with 5 citations attached.

| Question | 3B answer | 3B declined? | 1B answer | 1B declined? |
|---|---|---|---|---|
| `req-salon-1` (trap): "What was spent on the salon campaign?" | "I couldn't find that information in the Founder Book." | **Yes** (exact) | "According to the context, the money spent on the salon campaign was Rs. 300." | **No**: made up a figure |
| `req-offtopic-1`: "What is the capital of France?" | "I couldn't find that information in the Founder Book." | **Yes** (exact) | "The passage does not mention the capital of France." | **No**: refused, but not in the required fallback wording |
| `offtopic-2`: "What is the recipe for pizza dough?" | "I couldn't find that information in the Founder Book." | **Yes** (exact) | "The passage does not mention pizza dough at all. It talks about social experiments, marketing campaigns, and collaborations with famous brands, but not about pizza dough." | **No**: refused, but not in the required fallback wording |
| `offtopic-3`: "Who is the president of the United States?" | "I couldn't find that information in the Founder Book." | **Yes** (exact) | "I couldn't find that information in the Founder Book." | **Yes** (exact) |

1B failed 3 of 4. A prompt fix was logged in `_bmad-output/implementation-artifacts/deferred-work.md`. CAP-2 did not change the prompt. The US-president question that 1B answered from general knowledge in August is now declined correctly.

## Acceptance criteria

- **Setting `OLLAMA_LLM_MODEL=llama3.2:1b` only in the environment switches the model.** `scripts/cap2-server-1b.log` shows `"chatModel":"llama3.2:1b"` and `model warm-up complete`, and `/chat` answered all 33 eval questions (one hit the Qdrant infrastructure error). No code or `.env` edits were made. Met.
- **Both pass counts are shown, and 1B's median is compared with 60% of 3B's, with a verdict.** See "Verdict" above. Met.
- **Every decline question lists each model's answer and whether it declined.** See the table above. Met.
