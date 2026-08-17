# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Two processes — backend at the repo root, frontend in `frontend/`.

```bash
npm start                 # API on :3000
npm run dev               # API with --watch
npm test                  # all 97 tests (~20s)
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

Requires `.env` (copy `.env.example`). Only `OPENAI_API_KEY` and `QDRANT_URL` are required;
everything else has a validated default. The full variable table lives in `README.md` — don't
duplicate it here.

Local Qdrant: `docker run -p 6333:6333 -v qdrant_storage:/qdrant/storage qdrant/qdrant`.
Or `docker compose up --build` for API + Qdrant together.

The vector store starts empty — `POST /index-book` must run once before `/chat` can answer anything.

## Architecture

Single-turn RAG over one book (`uploads/founder.pdf`). No conversation memory, no streaming, no
auth: `/chat` sends one question and nothing carries between requests.

`server.js` is bootstrap only — listen, log startup, graceful shutdown. `app.js` owns the Express
app: middleware, routes, and a single error boundary. Routes validate, call a service, shape a
response; all business logic lives in `services/`.

Four routes: `GET /health`, `GET /read-pdf` (raw extracted text, no indexing), `POST /index-book`,
`POST /chat`.

**Indexing** — `services/indexService.js`:

```
uploads/founder.pdf
  → pdfReader.readPDF        raw text
  → chunkService.chunkText   ~86 LangChain Documents (1000 chars / 200 overlap)
  → ensureCollection         before any embedding spend, so a dimension mismatch is free
  → embed + upsert in slices of 96
```

**Retrieval + chat** — `services/chatService.js`:

```
question
  → retrievalService  embed → Qdrant query (pool = topK×4 when MMR) → MMR re-rank to topK
  → promptService     system prompt + sanitised context block + question
  → chatService       chat completion, temperature 0.2
  → { answer, citations: [{ chunkId, score }] }
```

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

### Client construction

`services/openaiClient.js` is the single source of the OpenAI client — embeddings and chat both go
through `getOpenAIClient()`. Never `new OpenAI()` elsewhere. It sets `maxRetries: 0` because
`embeddingService` implements its own backoff; letting the SDK also retry would multiply attempts.

Both it and the Qdrant client are built **lazily** on first use. Both expose `setOpenAIClient` /
`setQdrantClient` as test seams.

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
  large PDF stays fully resident.
- **`chunkService.js`** — returns LangChain `Document` objects (`.pageContent`), not plain strings.
- **`embeddingService.js`** — exports `EMBEDDING_DIMENSIONS` so the collection is created from the
  model's real vector size. Batches 96 inputs, **re-sorts responses by `index`** so vectors can't
  drift out of alignment with their chunks, and retries only 429/5xx/network — config errors and
  `TypeError`/`ReferenceError` fail immediately. *Query* embeddings go through a 256-entry LRU;
  chunk embeddings deliberately do not.
- **`qdrantService.js`** — Cosine. Search uses **`client.query()`** — `client.search()` does not
  exist in `@qdrant/js-client-rest` 1.19 — and results come back under `points`. Upserts in batches
  of 256 with `wait: true`. A 404 on search is translated to a "run POST /index-book first" 503.
  `ensureCollection` verifies an existing collection's vector size, so a mismatch fails clearly.
- **`mmr.js`** — pure vector maths, no Qdrant or OpenAI coupling, unit-tested directly. With 200
  chars of overlap between neighbours, plain top-k often returns the same passage twice; MMR trades
  a little relevance for diversity.
- **`retrievalService.js`** — exposes a `strategy` seam (`dense` / `sparse` / `hybrid`) and a
  tested `reciprocalRankFusion` merge. Only `dense` is implemented; the others **throw** rather than
  silently degrading. Adding sparse retrieval should be purely additive — no changes to
  `chatService` or the routes.
- **`promptService.js`** — owns `SYSTEM_PROMPT` and `NO_ANSWER_REPLY` (the exact fallback string,
  which must stay identical to the wording inside the system prompt). Context is wrapped in
  `<<<CONTEXT_START>>>` / `<<<CONTEXT_END>>>` markers, and `sanitiseText` strips control characters,
  zero-width/bidi code points, and any occurrence of the markers themselves so retrieved text cannot
  close the context block early. Both the context and the question are treated as untrusted data.
  It's a single code-point scan, not several regex passes — keep it that way.
- **`chatService.js`** — short-circuits to `NO_ANSWER_REPLY` with empty citations when retrieval
  returns nothing, rather than spending a model call on empty context.
- **`indexService.js`** — a module-level in-flight guard rejects a concurrent `/index-book` with
  409 rather than interleaving writes to the same deterministic IDs.

### Temperature fallback

`chatService` sends `temperature: 0.2`, but some newer OpenAI models accept only their default and
reject an explicit value with a 400. That specific error triggers one retry without the parameter;
all other errors propagate untouched.

### Re-indexing is idempotent

The chunk's array index is the Qdrant point ID (also stored as `payload.chunkId`), so `/index-book`
overwrites rather than appends. This also means IDs are only stable while the chunker's output is
stable — changing `CHUNK_SIZE`/`CHUNK_OVERLAP` renumbers everything and stale points beyond the new
count survive. Delete the collection when changing chunking parameters or the embedding model.

Payload per vector: `{ chunkId, pageContent, source: "Founder.pdf" }`. Payload indexes on `source`
and `chunkId` are created with the collection so the `filter` option on `/chat` uses an index.

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
services/chatApi.ts   fetch, timeout, HTTP status → ChatApiError (retryable flag)
hooks/useChat.ts      messages, loading, error state; owns the request lifecycle
components/*          presentational only, driven by props
pages/ChatPage.tsx    composition + autoscroll
```

`vite.config.ts` proxies `/chat` to `localhost:3000`, so the browser stays same-origin and the
Express server needs no CORS handling. Changing the backend port means changing the proxy target too.

`useChat` returns callbacks with **empty dependency lists** that read mutable state through refs, so
their identities stay stable and memoised children don't re-render on every request. Preserve that
when adding to the hook. A caller-initiated abort (`clear()`, unmount) is deliberately not surfaced
as an error.

`chatApi.ts` duplicates `MAX_QUESTION_LENGTH = 1000` to catch over-long input before a round trip —
it mirrors the server's `MAX_QUESTION_LENGTH` and must be updated alongside it. A 400 is marked
non-retryable so the retry affordance is suppressed for requests that will fail identically.

Two UI details worth preserving: `ChatInput` toggles `overflowY` on the textarea because Chrome
otherwise paints a permanent scrollbar track on a one-row textarea; and `ChatMessage` puts the
`group/message` hover scope on the column wrapper, not the bubble, since the copy button sits outside
the bubble in the timestamp row.
