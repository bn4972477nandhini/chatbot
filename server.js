require("dotenv").config();

const { config, missingCredentials } = require("./config/env");
const { logger, serialiseError } = require("./lib/logger");
const { createApp } = require("./app");

const app = createApp();

const server = app.listen(config.port, () => {
  const missing = missingCredentials();

  logger.info("server started", {
    port: config.port,
    env: config.nodeEnv,
    chatModel: config.openai.chatModel,
    collection: config.qdrant.collection,
    topK: config.retrieval.topK,
    mmr: config.retrieval.useMmr,
  });

  if (missing.length > 0) {
    logger.warn("missing credentials — /chat and /index-book will fail until set", {
      missing,
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
