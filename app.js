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

  return { question: question.trim(), options };
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
      const { question, options } = parseChatBody(req.body);

      const { answer, citations } = await chatService.ask(question, options, {
        logger: req.log,
      });

      res.json({ answer, citations });
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
