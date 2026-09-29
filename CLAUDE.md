# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Two processes — backend at the repo root, frontend in `frontend/`.

```bash
npm start                 # API on :3000
npm run dev               # API with --watch
npm test                  # whole suite (~35s)
npm run test:watch        # whole suite, re-run on change
npm run test:unit         # pure logic
npm run test:integration  # indexing pipeline over the real founder.pdf, mocked network
npm run test:api          # full Express stack over HTTP

cd frontend && npm run dev     # Vite on :5173, proxies /chat to :3000
cd frontend && npm run build   # tsc -b && vite build — the only type-check gate
cd frontend && npm run lint    # oxlint
```

Run a single test file or a single test:

```bash
node --test --require ./tests/setup-env.js tests/unit/mmr.test.js
node --test --require ./tests/setup-env.js --test-name-pattern "widens the candidate pool" tests/unit/retrievalService.test.js
```

The `--require ./tests/setup-env.js` is not optional. `config/env.js` reads `process.env` **once at
require time**, so the environment must be pinned before any application module loads. A test run
without it picks up the developer's real `.env`.

The backend has no linter. The frontend has no test runner — `npm run build` is what catches type
errors there.

Requires `.env` (copy `.env.example`). `QDRANT_URL` is always required; `OPENAI_API_KEY` is only
required when `LLM_PROVIDER=openai`. `.env.example` ships with `LLM_PROVIDER=ollama` (no API key
needed). Everything else has a validated default. The full variable table lives in `README.md` —
don't duplicate it here.

Local Qdrant: `docker run -p 6333:6333 -v qdrant_storage:/qdrant/storage qdrant/qdrant`.
Or `docker compose up --build` for API + Qdrant together.

The vector store starts empty — `POST /index-book` must run once before `/chat` can answer anything.

CI (`.github/workflows/ci.yml`) runs backend tests and the frontend build+lint on Node 24, on every
push/PR to `main`/`master`.

`scripts/` are standalone dev tools, run directly with `node`, not part of the app or the test
suite:

```bash
node scripts/verify-extraction.js   # page-by-page PDF extraction report; flags near-empty pages
node scripts/verify-index.js        # confirms every extracted page has >=1 indexed Qdrant chunk
node scripts/tune-threshold.js      # prints real cosine-score distributions to (re)derive RETRIEVAL_SCORE_THRESHOLD
node scripts/evaluate-chat.js       # end-to-end grading over real HTTP against a running server + Ollama
```

`tune-threshold.js` and `evaluate-chat.js` need a live server/Qdrant/Ollama and the book already
indexed; re-run `tune-threshold.js` after any re-chunk or embedding-model change rather than
guessing a new `RETRIEVAL_SCORE_THRESHOLD`.

## Architecture

Single-turn RAG over one book (`uploads/founder.pdf`). No conversation memory and no auth: `/chat`
sends one question and nothing carries between requests (apart from a short-lived response cache —
see `chatService.js`).

`/chat` has two response modes. The default is one JSON body `{ answer, citations }`. With
`"stream": true` it answers as Server-Sent Events: `citations` (sent as soon as retrieval finishes),
then one `token` event per model fragment, then `done` — or `error` in place of `done`, because
once SSE headers are committed the JSON error boundary can no longer run, so the route applies the
same `AppError.expose` rule itself. A client disconnect (`res.on("close")`, not `req`) aborts the
in-flight model call. The frontend always uses the streaming mode (`chatApi.streamQuestion`).

`server.js` is bootstrap only — listen, log startup, graceful shutdown. `app.js` owns the Express
app: middleware, routes, and a single error boundary. Routes validate, call a service, shape a
response; all business logic lives in `services/`.

Four routes: `GET /health`, `GET /read-pdf` (raw extracted text, no indexing), `POST /index-book`,
`POST /chat`.

**Indexing** — `services/indexService.js`:

```
uploads/founder.pdf
  → pdfReader.readPDF         { text, pages } — pages is 1-indexed, per-page text
  → chunkService.chunkPages   ~86 LangChain Documents (1000 chars / 200 overlap),
                               each attributed back to page/section metadata
  → ensureCollection          before any embedding spend, so a dimension mismatch is free
  → embed + upsert in slices of 96
```

**Retrieval + chat** — `services/chatService.js`:

```
question
  → conversationalIntentService   exact-match small talk ("hi", "thanks", "bye") → canned reply, stop
  → response cache                LRU (100) + 10-min TTL keyed on question + options → stop on hit
  → retrievalService  embed → Qdrant query (pool = topK×4 when MMR) → MMR re-rank to topK
                      (topK+2 for whole-book "summarize / main idea" questions — isAbstractQuestion)
  → promptService     system prompt + sanitised context block + question
  → chatService       chat completion (CHAT_TEMPERATURE, default 0.2), buffered or streamed
  → { answer, citations: [{ chunkId, score, page, pageEnd }] }
```

`ask()` and `askStream()` share one `prepareRequest()` (small talk → cache → retrieval → prompt), so
the two paths can't drift apart. Only how the model gets called differs between them.

### Configuration

`config/env.js` is the only place `process.env` is read. Everything — ports, models, thresholds,
chunk sizes, rate limits — is parsed and range-validated at boot, so a bad value fails immediately
with a precise message rather than as a confusing runtime error later. Do not add
`process.env.SOMETHING` anywhere else; add it to `buildConfig()`.

Credentials are validated *separately* from shape: the server boots without them so `/health` and
`/read-pdf` still work. `missingCredentials()` is what `/health` and the startup warning consult.

### Errors and logging

`lib/errors.js` — `AppError` carries an HTTP status and an `expose` flag. The error boundary in
`app.js` returns **only** `AppError` messages marked safe; anything else is logged in full and
answered with a generic 500, so stack traces never reach a client. Use the helpers (`badRequest`,
`configError` → 503, `upstreamError` → 502, `conflict` → 409) rather than constructing statuses ad
hoc.

`lib/logger.js` — structured JSON, one object per line, with secret redaction. Every request gets a
`req.log` child logger carrying a `requestId` (echoed back as the `x-request-id` header), so all
lines from one request correlate. Pass `{ logger: req.log }` down into services; they accept it.

### LLM provider: Ollama or OpenAI

`LLM_PROVIDER` (`ollama` default, or `openai`) picks the backend for both chat and embeddings.
Ollama exposes an OpenAI-compatible HTTP surface (`/v1/chat/completions`, `/v1/embeddings`), so
`services/openaiClient.js` points the same `openai` SDK client at Ollama's base URL instead of
implementing a separate client — Ollama ignores the API key, so a placeholder is sent. `config.llm`
in `config/env.js` is the provider-resolved view (`chatModel`, `embeddingModel`,
`embeddingDimensions`, `timeoutMs`, `baseUrl`) that `embeddingService`/`chatService` read from, so
the rest of the pipeline never branches on which provider is active. The two providers use
different embedding dimensions (Ollama's `nomic-embed-text` = 768, OpenAI's
`text-embedding-3-small` = 1536) — switching providers needs a fresh Qdrant collection.

### Client construction

`services/openaiClient.js` is the single source of the OpenAI-compatible client — embeddings and
chat both go through `getOpenAIClient()`. Never `new OpenAI()` elsewhere. It sets `maxRetries: 0`
because `embeddingService` implements its own backoff; letting the SDK also retry would multiply
attempts.

With Ollama, the client is wrapped (`serializeOllamaClient`) so that **every** chat and embedding
call runs through a single FIFO queue, one at a time. Concurrent calls measurably slowed each other
down on local inference, to the point of hitting `OLLAMA_TIMEOUT_MS`. So firing several LLM calls in
parallel gains nothing under Ollama — batch into one call instead (retrieval does this for query
embeddings). It also means an abandoned generation blocks every later request, which is why the
streaming route aborts on disconnect. Ollama requests also send `keep_alive` (`OLLAMA_KEEP_ALIVE`,
default `30m`); an optional `CHAT_SEED` pins sampling for reproducible evals.

Both it and the Qdrant client are built **lazily** on first use. Both expose `setOpenAIClient` /
`setQdrantClient` as test seams.

`server.js` fires a one-token warm-up completion against `config.llm.chatModel` right after
`app.listen`, but only when `config.llm.provider === "ollama"` — a cold Ollama model load measured
at ~12.5s would otherwise land on whichever user asks the first real question. Fire-and-forget:
failure is logged and swallowed, never blocks startup or delays `/health`.

### Dependency injection

`createChatService`, `createRetrievalService`, `createIndexService`, `createEmbeddingService`,
`createQdrantService` and `createApp` are all factories whose dependencies default to the real
implementations. This is the seam the entire test suite runs through — fakes stand in at the
**client** boundary (`tests/helpers/mocks.js`), so batching, retry, sorting and error mapping all
execute for real without network access. Keep new services in this shape.

`app.js` builds one `chatService` at startup and reuses it across requests.

### Service notes

- **`pdfReader.js`** — uses a **dynamic `import()` of `pdfjs-dist/legacy/build/pdf.mjs`** because the
  package is ESM-only and this project is CommonJS; the promise is cached. Keep that pattern for any
  new pdfjs usage. Calls `page.cleanup()` per page and `pdf.destroy()` at the end — without them a
  large PDF stays fully resident. `readPDF` returns `{ text, pages }`: `text` is the same joined
  string callers always got (page texts + `"\n"`, one trailing newline); `pages` is 1-indexed
  per-page text, added so a character offset in `text` can be mapped back to a PDF page.
  `joinTextItems` joins pdf.js's positioned text items with a space only when they're actually on
  different lines or have a real horizontal gap — some PDFs split one word across two items at a
  font/style boundary, and naively `.join(" ")`-ing every item corrupts that word (`"foreword"` →
  `"fore word"`) for both embedding and exact keyword matching.
- **`chunkService.js`** — `chunkText` (plain string → `Document[]`) is the original entry point;
  `chunkPages(pages)` is what indexing actually uses now — it chunks the same joined text but
  attributes each resulting `Document` back to `metadata.{page, pageEnd, section, sectionTitle}` by
  re-locating the chunk's text inside a reconstructed offset index (`buildPageIndex`). `detectSections`
  finds chapter/section boundaries purely from page-length layout (a near-empty "divider" page
  followed by a short "title" page) — no book-specific strings — so a PDF that doesn't use that
  layout just degrades to everything in section 0. Both return LangChain `Document` objects
  (`.pageContent`), not plain strings. Before chunking, `augmentPagesWithStructuredData` appends any
  label/value table rows a page contains (`labelValueExtractor.js` detects the wide-gap column layout
  a flattened PDF table/infographic leaves behind and pairs each ALL-CAPS label with its value) as
  plain "Label: Value" lines, and any chunk containing that appended text is flagged
  `metadata.hasStructuredData` — consumed by `retrievalService.js`'s directness bonus for
  quantity-asking questions.
- **`embeddingService.js`** — exports `EMBEDDING_DIMENSIONS` so the collection is created from the
  model's real vector size. Batches 96 inputs, **re-sorts responses by `index`** so vectors can't
  drift out of alignment with their chunks, and retries only 429/5xx/network — config errors and
  `TypeError`/`ReferenceError` fail immediately. *Query* embeddings go through a 256-entry LRU;
  chunk embeddings deliberately do not.
- **`qdrantService.js`** — Cosine. Search uses **`client.query()`** — `client.search()` does not
  exist in `@qdrant/js-client-rest` 1.19 — and results come back under `points`. Upserts in batches
  of 256 with `wait: true`. A 404 on search is translated to a "run POST /index-book first" 503.
  `ensureCollection` verifies an existing collection's vector size, so a mismatch fails clearly.
  Payload indexes are created on `source` (keyword), `chunkId` and `page` (integer).
- **`mmr.js`** — pure vector maths, no Qdrant or OpenAI coupling, unit-tested directly. With 200
  chars of overlap between neighbours, plain top-k often returns the same passage twice; MMR trades
  a little relevance for diversity.
- **`retrievalService.js`** — exposes a `strategy` seam (`dense` / `sparse` / `hybrid`) and a
  tested `reciprocalRankFusion` merge. Only `dense` is implemented; the others **throw** rather than
  silently degrading. Adding sparse retrieval should be purely additive — no changes to
  `chatService` or the routes. The widened, unfiltered pool (`FALLBACK_POOL_SIZE`) runs whenever the
  dense pass found *anything*, **or** the question has distinctive keywords at all (`extractKeywords`)
  — the keyword-only trigger exists so a term dense search misses entirely (wrong topic vector, but
  right words) can still be recovered by exact match. Up to four ranked lists get RRF-fused: the dense
  pool always; the wide pool ranked by BM25 (`lexicalRetrievalService.js`) against the extracted
  keywords whenever there are any; the wide pool's raw similarity order only if the dense pass was
  non-empty (a "best guess" signal, so a genuinely off-topic question — no dense hits and no keyword
  hits — still declines rather than resurrecting its nearest, irrelevant chunks); and, if
  `useQueryExpansion` is on (`RETRIEVAL_USE_QUERY_EXPANSION`, off by default) and the dense pass's top
  hit isn't already lexically confirmed, up to two LLM-generated paraphrases of the question
  (`queryExpansionService.js`) searched the same way — skipped whenever lexical and dense already agree
  on the same top chunk, since there's nothing left for a paraphrase to rescue and the extra chat +
  embedding round trip is the most expensive part of the pipeline on local Ollama. Independently of
  fusion, a capped number of lexical/paraphrase-corroborated chunks and one same-section runner-up are
  carried through **untouched by MMR** (`guaranteedCorroborated` / `guaranteedSection`) before MMR
  re-ranks the rest to fill the remaining `topK` slots — plain RRF fusion alone still let MMR's
  diversity trade-off rank a corroborated chunk (e.g. "who wrote the foreword?") below one that only
  *looked* more diverse, or let one dominant chunk claim the whole corroboration budget and starve a
  different chunk that also needed rescuing. A chunk matched by `hasInlineLabelValue` — an explicit
  "Label: Value" line in ordinary prose (e.g. a copyright page's "Author: Jane Doe") that isn't the
  wide-gap table shape `labelValueExtractor.js` looks for, so the indexer never flags it — gets one
  guaranteed slot the same way, capped separately from the lexical/section guarantees so it can't
  displace them. Lexical top-chunk agreement (gating query expansion) requires *every* extracted
  keyword to appear in the top dense chunk's own text once there are enough keywords to make that
  meaningful (≥4, majority match), not just that chunk's membership in a pooled BM25 ranking — BM25
  can rank a chunk highly off a single shared keyword even when it's about something else entirely.
  The final list is re-sorted by score plus a small "directness" bonus — larger for a question
  `queryUnderstanding.isNumericQuestion` flags as asking for a quantity — for a chunk that's an exact
  lexical match, an inline label/value match, or that the indexer flagged `hasStructuredData` (see
  `chunkService.js`/`labelValueExtractor.js`); the bonus is small enough to only reorder near-ties,
  never to override a clearly higher-scoring, unconfirmed chunk.
- **`lexicalRetrievalService.js`** — ranks a candidate pool by Okapi BM25 (via the retriever already
  bundled in `@langchain/community`) rather than a raw term-frequency count, so a keyword common
  across most of the pool doesn't crowd out a genuinely rare, on-topic hit. Lowercases its own scoring
  copy of chunk text before matching — the underlying `okapibm25` package matches case-sensitively, but
  source PDF text routinely capitalizes the exact words a question asks about (labels, headers, proper
  nouns), so without this a keyword can silently score zero against a chunk that contains it verbatim
  in a different case.
- **`queryExpansionService.js`** — generates up to two alternative phrasings of the question via the
  configured chat model to rescue a chunk dense search under-ranks for the exact wording asked (e.g.
  "who wrote this book?" vs. "who is the author?"). Purely a recall aid: any failure (timeout, bad
  response) is caught and logged, returning `[]` rather than failing the request. Off by default
  because it costs one extra chat completion per question.
- **`queryUnderstanding.js`** — purely structural question classification (leading wh-word, presence
  of a digit/currency symbol, person-question phrasing, multi-part, short) with no book-specific
  keyword lists, so it applies identically to a question about any book. Two classifiers are consumed:
  `isNumericQuestion` by `retrievalService.js`'s structured-data bonus, and `isAbstractQuestion` by
  `chatService.js` to widen the evidence limit (only when the caller passed no explicit `limit`; an
  experiment that also widened for multi-part questions made answers worse, so that is deliberately
  excluded).
- **`conversationalIntentService.js`** — deterministic small-talk detection that runs before the
  cache and retrieval. It matches the *whole* normalised question, never a substring, so "Hi, who is
  the author?" still goes through RAG.
- **`promptService.js`** — owns `SYSTEM_PROMPT` and `NO_ANSWER_REPLY` (the exact fallback string,
  which must stay identical to the wording inside the system prompt). Context is wrapped in
  `<<<CONTEXT_START>>>` / `<<<CONTEXT_END>>>` markers, and `sanitiseText` strips control characters,
  zero-width/bidi code points, and any occurrence of the markers themselves so retrieved text cannot
  close the context block early. Both the context and the question are treated as untrusted data.
  It's a single code-point scan, not several regex passes — keep it that way. Each context block is
  labelled with the chunk's page (`page` alone, or `page-pageEnd` when a chunk spans pages) when that
  metadata exists. The prompt also tells the model to attribute quotes/descriptions to whichever
  person they actually concern rather than defaulting to the question's subject, and to prefer a
  fact's complete form (full name, exact figure) over a short form when the context gives both.
- **`chatService.js`** — short-circuits to `NO_ANSWER_REPLY` with empty citations when retrieval
  returns nothing, rather than spending a model call on empty context. Sends `max_tokens:
  CHAT_MAX_OUTPUT_TOKENS` (both the normal call and the temperature-fallback retry) to bound
  worst-case generation time — most load-bearing on CPU-only local Ollama inference, where output
  length dominates latency. Citations include `page`/`pageEnd` alongside `chunkId`/`score`. The
  response cache is invalidated only by its TTL: the service has no dependency on the indexer, so
  after a `/index-book` re-index, repeated questions can return stale answers for up to 10 minutes.
- **`indexService.js`** — a module-level in-flight guard rejects a concurrent `/index-book` with
  409 rather than interleaving writes to the same deterministic IDs.

### Temperature fallback

`chatService` sends an explicit `temperature` (`CHAT_TEMPERATURE`, default 0.2), but some newer OpenAI models accept only their default and
reject an explicit value with a 400. That specific error triggers one retry without the parameter;
all other errors propagate untouched.

### Re-indexing is idempotent

The chunk's array index is the Qdrant point ID (also stored as `payload.chunkId`), so `/index-book`
overwrites rather than appends. This also means IDs are only stable while the chunker's output is
stable — changing `CHUNK_SIZE`/`CHUNK_OVERLAP` renumbers everything and stale points beyond the new
count survive. Delete the collection when changing chunking parameters or the embedding model.

Payload per vector: `{ chunkId, pageContent, source: "Founder.pdf", page, pageEnd, section,
sectionTitle }`. Payload indexes on `source`, `chunkId` and `page` are created with the collection so
the `filter` option on `/chat` uses an index.

### Dependency constraint

`.npmrc` sets `legacy-peer-deps=true`. `@langchain/community` declares a hard peer on
`@browserbasehq/stagehand`, which pins `openai@^4` and `dotenv@^16` — both far behind what this
project uses. Nothing imports stagehand, so the peers are ignored rather than downgrading. Note that
`langchain` needs `@langchain/core` as an explicit dependency; pruning it breaks the text splitter at
require time. `@langchain/community` itself is currently unused — the direct `@qdrant/js-client-rest`
and `openai` clients are used instead of LangChain's vector-store wrappers.

## Frontend (`frontend/`)

React 19 + TypeScript + Vite 8, styled with **Tailwind v4** — configured via the `@tailwindcss/vite`
plugin and `@import "tailwindcss"` in `src/index.css`. There is no `tailwind.config.js`; custom
animations are declared in an `@theme` block as `--animate-*` variables. Zero runtime dependencies
beyond React: the Markdown renderer is hand-written (`components/Markdown.tsx`) rather than a library.

Layering, strictly enforced — no business logic in components:

```
services/chatApi.ts   fetch + SSE parsing (streamQuestion), timeout, HTTP status → ChatApiError (retryable flag)
hooks/useChat.ts      messages, loading, error state; owns the request lifecycle
services/speechRecognition.ts / speechSynthesis.ts   Web Speech API wrappers
hooks/useVoice.ts     idle→listening→thinking→speaking state machine, wired to useChat
components/*          presentational only, driven by props
pages/ChatPage.tsx    composition + autoscroll
```

**Voice input/output** (`useVoice.ts`, `VoiceControls.tsx`) layers on top of the existing text
pipeline rather than replacing it — `onFinalTranscript` calls straight into `useChat`'s `send`, so a
spoken question produces the exact same request and message bubble a typed one would; `useVoice`
never calls `/chat` itself. `speechRecognition.ts`/`speechSynthesis.ts` wrap the browser's native Web
Speech API (`SpeechRecognition`/`webkitSpeechRecognition`, `window.speechSynthesis`) behind a
provider-agnostic controller shape, so swapping in a cloud STT/TTS provider later means writing a new
file with the same shape, not touching the hook or UI. `pendingVoiceTurnRef` gates speaking the
answer aloud so a *typed* question's response is never read out; `isSpeechToTextSupported` /
`isTextToSpeechSupported` feature-detect independently, and `VoiceControls` disappears entirely (not
just disabled) when STT is unsupported. A `LISTENING_WATCHDOG_MS` (12s) timeout exists because some
platforms fire neither a result nor `onerror` on a stuck permission prompt or a silent mic block, so
without it "Listening…" could hang forever. Every recognition lifecycle event logs a
`[VOICE]`-prefixed console line — deliberate temporary diagnostic instrumentation for a
"microphone isn't picking up speech" investigation; safe to trim once voice is confirmed working
end-to-end.

`vite.config.ts` proxies `/chat` to `localhost:3000`, so the browser stays same-origin and the
Express server needs no CORS handling. Changing the backend port means changing the proxy target too.

`useChat` returns callbacks with **empty dependency lists** that read mutable state through refs, so
their identities stay stable and memoised children don't re-render on every request. Preserve that
when adding to the hook. A caller-initiated abort (`clear()`, unmount) is deliberately not surfaced
as an error.

`chatApi.ts` duplicates `MAX_QUESTION_LENGTH = 1000` to catch over-long input before a round trip —
it mirrors the server's `MAX_QUESTION_LENGTH` and must be updated alongside it. A 400 is marked
non-retryable so the retry affordance is suppressed for requests that will fail identically.
`REQUEST_TIMEOUT_MS = 180_000` gives the client more headroom than the backend's `OLLAMA_TIMEOUT_MS`
default (120,000ms) — local Ollama inference is slow enough that the client must not give up before
the server would; keep the client value at or above the server's if either changes. `Citation` (`types/chat.ts`) carries optional `page`/`pageEnd`; `ChatMessage`
renders them as a `p.N` / `p.N-M` suffix on the source badge when present.

Two UI details worth preserving: `ChatInput` toggles `overflowY` on the textarea because Chrome
otherwise paints a permanent scrollbar track on a one-row textarea; and `ChatMessage` puts the
`group/message` hover scope on the column wrapper, not the bubble, since the copy button sits outside
the bubble in the timestamp row.
