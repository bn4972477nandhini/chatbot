require("dotenv").config();

const { config, missingCredentials } = require("./config/env");
const { logger, serialiseError } = require("./lib/logger");
const { createApp } = require("./app");
const { createChatService } = require("./services/chatService");

// Built here rather than inside createApp so the warm-up below goes through
// the very same service instance — and so the same request shape — that
// /chat uses.
const chatService = createChatService();
const app = createApp({ chatService });

const server = app.listen(config.port, () => {
  const missing = missingCredentials();

  logger.info("server started", {
    port: config.port,
    env: config.nodeEnv,
    llmProvider: config.llm.provider,
    chatModel: config.llm.chatModel,
    collection: config.qdrant.collection,
    topK: config.retrieval.topK,
    mmr: config.retrieval.useMmr,
  });

  if (missing.length > 0) {
    logger.warn("missing credentials — /chat and /index-book will fail until set", {
      missing,
    });
  }

  // Loads the model and pre-processes the shared system prompt before the
  // first real request, which would otherwise pay a cold load (~12.5s
  // measured) plus the whole system-prompt prefill on CPU. Sends the same
  // keep_alive as real requests, so the model stays loaded until the first
  // question arrives. Purely a latency nicety: failure (Ollama not up yet) is
  // logged and swallowed, never blocks startup or affects request handling.
  if (config.llm.provider === "ollama") {
    const warmupStartedAt = Date.now();
    chatService
      .warmUp()
      .then(() => {
        logger.info("model warm-up complete", { durationMs: Date.now() - warmupStartedAt });
      })
      .catch((error) => {
        logger.warn("model warm-up failed — first real request will pay the load cost", serialiseError(error));
      });
  }
});

// Requests are given a window to finish before the process exits, so a deploy or
// container stop does not sever in-flight answers mid-response.
const SHUTDOWN_GRACE_MS = 10_000;

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info("shutdown signal received", { signal });

  const forceExit = setTimeout(() => {
    logger.error("graceful shutdown timed out; forcing exit");
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);

  // Does not keep the event loop alive if everything else has already closed.
  forceExit.unref();

  server.close((error) => {
    if (error) {
      logger.error("error while closing server", serialiseError(error));
      process.exit(1);
    }

    logger.info("server closed cleanly");
    process.exit(0);
  });

  // Stops keep-alive connections from holding the server open for the full grace
  // period after their current response completes.
  server.closeIdleConnections?.();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// A crash with an unknown state is not safe to continue from; log it fully and
// let the orchestrator restart the process.
process.on("uncaughtException", (error) => {
  logger.error("uncaught exception", serialiseError(error));
  shutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
  logger.error("unhandled rejection", serialiseError(reason));
});

module.exports = { app, server };
