# Founder Book AI Assistant

A retrieval-augmented chatbot that answers questions **only** from `uploads/founder.pdf`. The PDF is
chunked and embedded into Qdrant; each question is embedded, matched against those vectors, and
answered by a chat model constrained to the retrieved passages. If the answer isn't in the book, it
says so rather than guessing.

- **Backend** — Node.js + Express 5, Qdrant vector store
- **LLM provider** — pluggable: **Ollama** (local, free, default — no API key) or **OpenAI**
- **Frontend** — React 19 + TypeScript + Vite + Tailwind v4
- **Single-turn** — no conversation memory, no streaming, no auth

---

## Table of contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Environment variables](#environment-variables)
- [Indexing the book](#indexing-the-book)
- [Running](#running)
- [API](#api)
- [Testing](#testing)
- [Deployment](#deployment)
- [Folder structure](#folder-structure)
- [How retrieval works](#how-retrieval-works)
- [Troubleshooting](#troubleshooting)

---

## Requirements

- **Node.js 20+** (uses the built-in test runner and `AbortSignal.any`)
- A **Qdrant** instance — local via Docker, or Qdrant Cloud
- An LLM provider — either:
  - **Ollama**, running locally (default, free, no API key), or
  - An **OpenAI API key**, if you set `LLM_PROVIDER=openai`

---

## Installation

```bash
# Backend (from the repo root)
npm install

# Frontend
cd frontend && npm install
```

Then create your environment file:

```bash
cp .env.example .env
```

The example file ships with `LLM_PROVIDER=ollama` — fill in `QDRANT_URL` and you're done. Everything
else has a working default. Switch `LLM_PROVIDER=openai` and fill in `OPENAI_API_KEY` instead if you'd
rather use OpenAI.

> **Note on `.npmrc`** — the repo sets `legacy-peer-deps=true`. `@langchain/community` declares a
> hard peer on `@browserbasehq/stagehand`, which pins `openai@^4` and `dotenv@^16`, far behind what
> this project uses. Nothing imports stagehand, so those peers are ignored rather than downgrading.

Need a local Qdrant?

```bash
docker run -p 6333:6333 -v qdrant_storage:/qdrant/storage qdrant/qdrant
```

(No Docker? A native Windows/Linux/macOS binary is published on the
[Qdrant releases page](https://github.com/qdrant/qdrant/releases) — download it and run
`qdrant.exe` / `./qdrant` directly; it listens on `:6333` with no further setup.)

---

## Running fully locally with Ollama (Windows)

This is the zero-cost, zero-API-key path — everything runs on your machine.

**1. Install Ollama.**

```powershell
winget install Ollama.Ollama
```

(Or download the installer from [ollama.com/download](https://ollama.com/download).) Installing it
also starts a background service listening on `http://localhost:11434`.

**2. Pull the two models this project uses.**

```powershell
ollama pull llama3.2          # chat model, ~2GB
ollama pull nomic-embed-text  # embedding model, ~275MB
```

**3. Confirm Ollama is reachable.**

```powershell
curl http://localhost:11434/api/version
```

**4. Set your `.env`.** `.env.example` already defaults to this setup:

```
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_LLM_MODEL=llama3.2
OLLAMA_EMBEDDING_MODEL=nomic-embed-text
OLLAMA_EMBEDDING_DIMENSIONS=768
QDRANT_URL=http://localhost:6333
```

No `OPENAI_API_KEY` needed — `missingCredentials()` in `config/env.js` only requires it when
`LLM_PROVIDER=openai`.

**5. Start Qdrant, then the app**, as described in [Running](#running). Index the book, then chat —
same `/index-book` and `/chat` endpoints either way; only the provider behind them changed.

Want a stronger model and have the RAM for it? `ollama pull llama3.1:8b` and set
`OLLAMA_LLM_MODEL=llama3.1:8b`. Any model pulled into Ollama works — the chat quality/speed tradeoff
is yours to make.

---

## Environment variables

`QDRANT_URL` is always required. `OPENAI_API_KEY` is only required when `LLM_PROVIDER=openai`. All
values are validated at boot — a malformed number or an out-of-range value fails immediately with a
precise message rather than at first request.

### Required

| Variable | Description |
| --- | --- |
| `QDRANT_URL` | e.g. `http://localhost:6333`, or `http://qdrant:6333` under compose |

### LLM provider

| Variable | Default | Description |
| --- | --- | --- |
| `LLM_PROVIDER` | `openai`* | `ollama` or `openai`. *`.env.example` ships with `ollama`. |

### Qdrant

| Variable | Default | Description |
| --- | --- | --- |
| `QDRANT_API_KEY` | — | Optional; omit for a local instance without auth |
| `QDRANT_COLLECTION` | `founder_book` | Collection name |
| `QDRANT_TIMEOUT_MS` | `20000` | Per-request timeout |

### Models — Ollama (`LLM_PROVIDER=ollama`)

| Variable | Default | Description |
| --- | --- | --- |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama's HTTP API; `/v1` is appended automatically |
| `OLLAMA_LLM_MODEL` | `llama3.2` | Chat model — must be `ollama pull`ed first |
| `OLLAMA_EMBEDDING_MODEL` | `nomic-embed-text` | Embedding model — must be `ollama pull`ed first |
| `OLLAMA_EMBEDDING_DIMENSIONS` | `768` | Must match the model; changing it requires a fresh collection |
| `OLLAMA_TIMEOUT_MS` | `120000` | Per-request timeout — local inference is slower than a hosted API |

### Models — OpenAI (`LLM_PROVIDER=openai`)

| Variable | Default | Description |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | Required for this provider |
| `CHAT_MODEL` | `gpt-5.5` | Chat completion model |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model |
| `EMBEDDING_DIMENSIONS` | `1536` | Must match the model; changing it requires a fresh collection |
| `OPENAI_TIMEOUT_MS` | `60000` | Per-request timeout |

### Shared

| Variable | Default | Description |
| --- | --- | --- |
| `CHAT_TEMPERATURE` | `0.2` | Applies to whichever provider is active. See [Troubleshooting](#troubleshooting) |

### Retrieval

| Variable | Default | Description |
| --- | --- | --- |
| `RETRIEVAL_TOP_K` | `5` | Chunks passed to the model |
| `RETRIEVAL_SCORE_THRESHOLD` | `0.65`* | Minimum cosine score; below this a chunk is discarded. *`.env.example` ships `0.55`, tuned for Ollama's `nomic-embed-text` — see the comment there. `0.65` (this code default) fits OpenAI's `text-embedding-3-small` better. |
| `RETRIEVAL_USE_MMR` | `true` | Diversity re-ranking (see [How retrieval works](#how-retrieval-works)) |
| `RETRIEVAL_MMR_LAMBDA` | `0.7` | `1.0` = pure relevance, `0.0` = pure diversity |
| `RETRIEVAL_MMR_POOL_MULTIPLIER` | `4` | Candidate pool = `topK × this`, capped at 100 |

### Chunking

| Variable | Default | Description |
| --- | --- | --- |
| `CHUNK_SIZE` | `1000` | Characters per chunk |
| `CHUNK_OVERLAP` | `200` | Must be smaller than `CHUNK_SIZE` |

> Changing either **renumbers every chunk**. Delete the collection and re-index, or stale points
> beyond the new count will survive.

### Server and limits

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | |
| `NODE_ENV` | `development` | |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` \| `silent` |
| `MAX_QUESTION_LENGTH` | `1000` | Characters; caps token spend per request |
| `MAX_BODY_BYTES` | `16384` | JSON body limit |
| `CHAT_RATE_WINDOW_MS` / `CHAT_RATE_MAX` | `60000` / `20` | Per-IP rate limit on `/chat` |
| `INDEX_RATE_WINDOW_MS` / `INDEX_RATE_MAX` | `3600000` / `5` | Per-IP rate limit on `/index-book` |

---

## Indexing the book

The vector store starts empty. Before `/chat` can answer anything, index the PDF:

```bash
npm start                                   # terminal 1
curl -X POST http://localhost:3000/index-book   # terminal 2
```

```json
{ "success": true, "totalChunks": 86, "indexedChunks": 86 }
```

This reads the PDF, splits it into 86 chunks, embeds them, and upserts them into Qdrant.

**Re-indexing is safe.** A chunk's array index is its Qdrant point ID, so a second run overwrites
the existing vectors instead of appending duplicates. Concurrent runs are rejected with `409` rather
than interleaving writes.

---

## Running

Two processes:

```bash
# Terminal 1 — backend on :3000
npm start

# Terminal 2 — frontend on :5173
cd frontend && npm run dev
```

Open <http://localhost:5173>.

The Vite dev server proxies `/chat` to `localhost:3000`, so the browser stays same-origin and the
API needs no CORS configuration. If you change the backend port, update the proxy target in
`frontend/vite.config.ts`.

| Command | Description |
| --- | --- |
| `npm start` | Start the API |
| `npm run dev` | Start the API with `--watch` |
| `npm test` | Full test suite |
| `cd frontend && npm run dev` | Frontend dev server |
| `cd frontend && npm run build` | Type-check and build the frontend |
| `cd frontend && npm run lint` | Lint the frontend |

---

## API

### `POST /chat`

```json
{ "question": "What is Zero Rupee Marketing?" }
```

```json
{
  "answer": "…",
  "citations": [{ "chunkId": 12, "score": 0.92 }]
}
```

Optional tuning fields — omit them and the configured defaults apply:

| Field | Type | Description |
| --- | --- | --- |
| `topK` | integer 1–20 | Override chunks retrieved |
| `scoreThreshold` | number 0–1 | Override the minimum score |
| `filter` | object | Qdrant payload filter, e.g. `{"must":[{"key":"source","match":{"value":"Founder.pdf"}}]}` |

Errors return `{ "success": false, "error": "…" }` with status `400` (validation), `429`
(rate limited), `502` (upstream) or `500`. Stack traces are never returned.

### `POST /index-book`

Returns `{ "success": true, "totalChunks": 86, "indexedChunks": 86 }`.

### `GET /read-pdf`

Extraction and chunking only — no network calls. Useful for verifying PDF parsing in isolation.

### `GET /health`

```json
{
  "status": "ok",
  "uptimeSeconds": 42,
  "version": "1.0.0",
  "checks": { "config": "ok", "qdrant": "ok" }
}
```

Returns `503` with `"status": "degraded"` when credentials are missing or Qdrant is unreachable, so
orchestrators stop routing traffic to a broken instance.

---

## Testing

```bash
npm test                  # everything (~35s)
npm run test:unit         # pure logic, fast
npm run test:integration  # full indexing pipeline, mocked network
npm run test:api          # real Express stack over HTTP
```

97 tests, no network access required. OpenAI and Qdrant are replaced with fakes at the **client**
boundary, so batching, retry, ordering and error mapping all execute for real. The integration suite
indexes the actual `founder.pdf`.

---

## Deployment

### Docker Compose (API + Qdrant)

```bash
export OPENAI_API_KEY=sk-...
docker compose up --build
docker compose exec api node -e "fetch('http://127.0.0.1:3000/index-book',{method:'POST'}).then(r=>r.json()).then(console.log)"
```

Compose starts Qdrant with a persistent volume, waits for it to become healthy, then starts the API.
Both containers have health checks; the API gets a 15-second grace period on stop so in-flight
requests can drain.

### Docker only

```bash
docker build -t founder-book-api .
docker run -p 3000:3000 --env-file .env founder-book-api
```

The image is multi-stage, installs production dependencies only, runs as the unprivileged `node`
user, and uses `dumb-init` so `SIGTERM` reaches Node and the graceful shutdown handler runs.

### Frontend

`cd frontend && npm run build` produces static assets in `frontend/dist/` for any static host. Point
`/chat` at your API — either via a reverse proxy on the same origin (recommended, no CORS needed) or
by adding CORS to the API.

### Production notes

- Set `NODE_ENV=production` and a real `LOG_LEVEL`.
- Logs are JSON, one object per line, ready for any aggregator. Secrets are redacted.
- `trust proxy` is enabled so rate limiting keys on the real client IP behind a load balancer.
- Run `/index-book` once per deployment target — the vector store is the source of truth, not the image.

---

## Folder structure

```
.
├── server.js               Bootstrap: listen + graceful shutdown
├── app.js                  Express app: middleware, routes, error boundary
├── config/
│   └── env.js              Environment parsing and validation
├── lib/
│   ├── errors.js           AppError with HTTP status and client-safe messages
│   └── logger.js           Structured JSON logging with redaction
├── services/
│   ├── openaiClient.js     Shared client — OpenAI, or Ollama via its OpenAI-compatible API
│   ├── pdfReader.js        PDF → text (async, non-blocking)
│   ├── chunkService.js     Text → overlapping chunks
│   ├── embeddingService.js Batching, retry, query cache
│   ├── qdrantService.js    Collection management, upsert, search
│   ├── mmr.js              Maximal Marginal Relevance (pure functions)
│   ├── retrievalService.js Embed → search → re-rank
│   ├── promptService.js    Prompt assembly and injection hardening
│   ├── chatService.js      RAG orchestration
│   └── indexService.js     Indexing pipeline
├── tests/
│   ├── unit/  integration/  api/
│   ├── helpers/mocks.js    Fake OpenAI and Qdrant clients
│   └── setup-env.js        Deterministic test environment
├── uploads/founder.pdf
└── frontend/
    └── src/
        ├── components/     Presentational only
        ├── hooks/useChat.ts   All chat state and request lifecycle
        ├── services/chatApi.ts Network, timeout, error mapping
        ├── pages/ChatPage.tsx
        ├── types/  utils/
```

The layering rule: **routes are thin, components are presentational**. Business logic lives in
`services/` on the backend and in `hooks/` + `services/` on the frontend.

---

## How retrieval works

1. The question is embedded (`nomic-embed-text`/768 dims on Ollama, or `text-embedding-3-small`/1536
   dims on OpenAI). Repeat questions are served from a small in-process LRU cache.
2. Qdrant returns a candidate pool — `topK × 4` when MMR is enabled, `topK` otherwise — filtered by
   `scoreThreshold`.
3. **MMR** re-ranks that pool down to `topK`. With 200 characters of overlap between neighbouring
   chunks, plain top-k often returns the same passage twice; MMR trades a little relevance for
   diversity so the model sees several distinct passages.
4. The chunks are wrapped in delimiters and sent with a system prompt that constrains the model to
   the supplied context.
5. If nothing clears the threshold, the fallback answer is returned **without** calling the model.

**Hybrid search** is architecturally ready but not implemented: `retrievalService` exposes a strategy
seam and a tested `reciprocalRankFusion` merge. Requesting a non-dense strategy throws rather than
silently degrading. To add sparse retrieval, implement the strategy and register it — no changes to
`chatService` or the routes.

**Metadata filtering** is live: pass `filter` on `/chat`. Payload indexes on `source` and `chunkId`
are created with the collection so filters use an index rather than a scan.

---

## Troubleshooting

**`/chat` returns "Collection … does not exist"** — run `POST /index-book` first.

**`/health` reports `degraded`** — check `config` (missing credentials) and `qdrant` (unreachable)
in the response body.

**Model rejects `temperature`** (OpenAI only) — some newer OpenAI models accept only their default
temperature and return a 400 for an explicit value. The service detects that specific error, retries
once without the parameter, and logs a warning; all other errors propagate. If this happens, answers
use the model default rather than `0.2`.

**`model_not_found` for `gpt-5.5`** (OpenAI only) — set `CHAT_MODEL` in `.env` to a model your account
can access.

**`/chat` or `/index-book` fails with a connection error to `localhost:11434`** (Ollama) — Ollama
isn't running. Check `curl http://localhost:11434/api/version`; if that fails, start Ollama (the
winget install runs it as a background service, so check the Ollama tray icon, or run `ollama serve`
manually).

**`model not found` from Ollama** — the model in `OLLAMA_LLM_MODEL` / `OLLAMA_EMBEDDING_MODEL` hasn't
been pulled yet. Run `ollama pull <model>` and `ollama list` to confirm.

**A new route 404s** — a stale server may still hold port 3000. `setInterval` keeps the process alive
past a closed shell. Check for listeners on 3000 and kill them.

**Dimension mismatch on index** — the collection was created with a different embedding model.
Delete it, or point `QDRANT_COLLECTION` at a new name.
