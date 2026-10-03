const crypto = require("crypto");

const compression = require("compression");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const { config, missingCredentials } = require("./config/env");
const { AppError, badRequest } = require("./lib/errors");
const { logger: rootLogger, serialiseError } = require("./lib/logger");
const { readPDF } = require("./services/pdfReader");
const { chunkText } = require("./services/chunkService");
const { indexBook: defaultIndexBook, BOOK_PATH } = require("./services/indexService");
const { createChatService } = require("./services/chatService");
const { pingQdrant } = require("./services/qdrantService");
const { MAX_HISTORY_MESSAGES } = require("./services/followUpService");

// An answer is at most CHAT_MAX_OUTPUT_TOKENS long; this is generous for that
// while keeping a full history well inside MAX_BODY_BYTES.
const MAX_HISTORY_CONTENT_LENGTH = 2000;

/**
 * Validates the /chat request body.
 *
 * The accepted contract is unchanged — `{ question: string }`. Optional tuning
 * fields are additive and may be omitted entirely.
 */
function parseChatBody(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("Request body must be a JSON object.");
  }

  const { question } = body;

  if (typeof question !== "string" || question.trim() === "") {
    throw badRequest("A non-empty 'question' string is required.");
  }

  if (question.length > config.limits.maxQuestionLength) {
    throw badRequest(
      `Question must be ${config.limits.maxQuestionLength} characters or fewer.`
    );
  }

  const options = {};

  if (body.topK !== undefined) {
    if (!Number.isInteger(body.topK) || body.topK < 1 || body.topK > 20) {
      throw badRequest("'topK' must be an integer between 1 and 20.");
    }
    options.limit = body.topK;
  }

  if (body.scoreThreshold !== undefined) {
    if (
      typeof body.scoreThreshold !== "number" ||
      Number.isNaN(body.scoreThreshold) ||
      body.scoreThreshold < 0 ||
      body.scoreThreshold > 1
    ) {
      throw badRequest("'scoreThreshold' must be a number between 0 and 1.");
    }
    options.scoreThreshold = body.scoreThreshold;
  }

  if (body.filter !== undefined) {
    if (typeof body.filter !== "object" || body.filter === null || Array.isArray(body.filter)) {
      throw badRequest("'filter' must be a JSON object.");
    }
    options.filter = body.filter;
  }

  // Delivery-mode flag only — never passed into retrieval `options`, so it
  // cannot affect what's retrieved or how it's ranked, only how the answer
  // is sent back.
  let stream = false;
  if (body.stream !== undefined) {
    if (typeof body.stream !== "boolean") {
      throw badRequest("'stream' must be a boolean.");
    }
    stream = body.stream;
  }

  // Earlier turns, for follow-up questions ("why is it useful?"). Optional,
  // and never part of retrieval `options`. chatService decides whether the
  // question needs them at all (services/followUpService.js).
  const history = [];
  if (body.history !== undefined) {
    if (!Array.isArray(body.history) || body.history.length > MAX_HISTORY_MESSAGES) {
      throw badRequest(`'history' must be an array of at most ${MAX_HISTORY_MESSAGES} messages.`);
    }
    for (const turn of body.history) {
      const valid =
        typeof turn === "object" &&
        turn !== null &&
        (turn.role === "user" || turn.role === "assistant") &&
        typeof turn.content === "string" &&
        turn.content.trim() !== "" &&
        turn.content.length <= MAX_HISTORY_CONTENT_LENGTH;
      if (!valid) {
        throw badRequest(
          `Each 'history' message needs a role of "user" or "assistant" and non-empty content of at most ${MAX_HISTORY_CONTENT_LENGTH} characters.`
        );
      }
      history.push({ role: turn.role, content: turn.content.trim() });
    }
  }

  return { question: question.trim(), options, stream, history };
}

/**
 * Builds the Express app. Services are injected so API tests can run without
 * OpenAI or Qdrant.
 */
function createApp({
  chatService = createChatService(),
  indexBook = defaultIndexBook,
  checkQdrant = pingQdrant,
  logger = rootLogger,
} = {}) {
  const app = express();

  // Behind a proxy/load balancer this makes req.ip the real client address,
  // which the rate limiter keys on.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  // This is a JSON API with no browser-rendered HTML, so CSP is unnecessary
  // while the transport and framing protections still apply.
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(compression());

  // Caps request bodies well below the default 100kb — a question never needs more.
  app.use(express.json({ limit: config.limits.jsonBodyBytes }));

  // Correlates every log line emitted while handling one request.
  app.use((req, res, next) => {
    req.id = req.get("x-request-id") || crypto.randomUUID();
    req.log = logger.child({ requestId: req.id });
    req.startedAt = Date.now();

    res.setHeader("x-request-id", req.id);

    res.on("finish", () => {
      req.log.info("request completed", {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - req.startedAt,
      });
    });

    next();
  });

  const chatLimiter = rateLimit({
    windowMs: config.limits.chatRateLimitWindowMs,
    max: config.limits.chatRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: "Too many requests. Please slow down." },
  });

  // Indexing is expensive and rarely legitimate more than a few times an hour.
  const indexLimiter = rateLimit({
    windowMs: config.limits.indexRateLimitWindowMs,
    max: config.limits.indexRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: "Too many indexing requests." },
  });

  /**
   * Liveness and readiness in one endpoint. Returns 503 when a dependency is
   * missing or unreachable so orchestrators stop routing traffic.
   */
  app.get("/health", async (req, res) => {
    const missing = missingCredentials();
    const health = {
      status: "ok",
      uptimeSeconds: Math.round(process.uptime()),
      version: process.env.npm_package_version ?? "1.0.0",
      checks: {
        config: missing.length === 0 ? "ok" : `missing: ${missing.join(", ")}`,
        qdrant: "unknown",
      },
    };

    if (missing.includes("QDRANT_URL")) {
      health.checks.qdrant = "not_configured";
    } else {
      try {
        await checkQdrant();
        health.checks.qdrant = "ok";
      } catch (error) {
        health.checks.qdrant = "unreachable";
        req.log.warn("health check: qdrant unreachable", serialiseError(error));
      }
    }

    const healthy = health.checks.config === "ok" && health.checks.qdrant === "ok";
    health.status = healthy ? "ok" : "degraded";

    res.status(healthy ? 200 : 503).json(health);
  });

  app.get("/read-pdf", async (req, res, next) => {
    try {
      const { text } = await readPDF(BOOK_PATH);
      const chunks = await chunkText(text);

      res.json({
        totalChunks: chunks.length,
        firstChunk: chunks[0].pageContent,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/index-book", indexLimiter, async (req, res, next) => {
    try {
      const { totalPages, totalChunks, indexedChunks } = await indexBook({ logger: req.log });

      res.json({ success: true, totalPages, totalChunks, indexedChunks });
    } catch (error) {
      next(error);
    }
  });

  app.post("/chat", chatLimiter, async (req, res, next) => {
    try {
      const { question, options, stream, history } = parseChatBody(req.body);

      if (!stream) {
        const { answer, citations } = await chatService.ask(question, options, {
          logger: req.log,
          history,
        });

        res.json({ answer, citations });
        return;
      }

      // Server-Sent Events. Citations are sent as soon as retrieval finishes
      // (they never depend on the model's output), then one `token` event per
      // generated fragment, then `done` — or `error` in place of `done` if
      // anything fails after streaming has already started, since headers are
      // committed by that point and the normal JSON error boundary can no
      // longer run.
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      // Some reverse proxies buffer proxied responses by default, which would
      // silently turn this back into one big delayed write; harmless to send
      // when there is no such proxy in front.
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      const send = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      // A client that navigates away or cancels mid-stream must not leave the
      // underlying Ollama call running for a response nobody is listening for
      // any more — every Ollama call is serialized through one queue, so an
      // abandoned generation would otherwise sit in front of every later
      // request too.
      // res.on("close") — not req.on("close") — is the reliable signal for an
      // early client disconnect during a streaming response; the request
      // object's own "close" event does not fire promptly (or at all, in
      // some Node versions) for this case, confirmed empirically here.
      const abortController = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) {
          req.log.info("client disconnected mid-stream; aborting the in-flight model call");
          abortController.abort();
        }
      });

      try {
        await chatService.askStream(question, options, {
          logger: req.log,
          signal: abortController.signal,
          history,
          onCitations: (citations) => send("citations", { citations }),
          onDelta: (delta) => send("token", { delta }),
          // The answer checks changed what was streamed (loop cut, or an
          // unsupported figure replaced): the client shows this text instead.
          onReplace: (answer) => send("answer", { answer }),
        });
        send("done", {});
      } catch (error) {
        if (abortController.signal.aborted) {
          // The client left, so nothing failed and nobody is listening.
          req.log.info("chat stream cancelled by client");
        } else if (error instanceof AppError && error.expose) {
          req.log[error.status >= 500 ? "error" : "warn"]("request failed", {
            status: error.status,
            code: error.code,
            ...serialiseError(error),
          });
          send("error", { message: error.message });
        } else {
          req.log.error("unhandled request error", serialiseError(error));
          send("error", { message: "Internal server error." });
        }
      } finally {
        res.end();
      }
    } catch (error) {
      next(error);
    }
  });

  app.use((req, res) => {
    res.status(404).json({ success: false, error: "Not found." });
  });

  // Single error boundary. Only messages explicitly marked safe are returned;
  // everything else is logged in full and answered generically, so stack traces
  // and internal details never reach a client.
  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    if (error instanceof SyntaxError && "body" in error) {
      return res
        .status(400)
        .json({ success: false, error: "Request body must be valid JSON." });
    }

    if (error?.type === "entity.too.large") {
      return res
        .status(413)
        .json({ success: false, error: "Request body is too large." });
    }

    const log = req.log ?? logger;

    if (error instanceof AppError && error.expose) {
      log[error.status >= 500 ? "error" : "warn"]("request failed", {
        status: error.status,
        code: error.code,
        ...serialiseError(error),
      });

      return res.status(error.status).json({ success: false, error: error.message });
    }

    log.error("unhandled request error", serialiseError(error));

    res.status(500).json({ success: false, error: "Internal server error." });
  });

  return app;
}

module.exports = { createApp, parseChatBody };
