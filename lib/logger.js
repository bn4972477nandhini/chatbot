const { config } = require("../config/env");

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

// Keys whose values must never reach the logs.
const REDACTED_KEYS = /^(apikey|api_key|authorization|password|token|secret)$/i;

function redact(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = REDACTED_KEYS.test(key) ? "[redacted]" : redact(item, depth + 1);
  }
  return output;
}

/**
 * Emits one JSON object per line — the format log aggregators expect. Falls back
 * to the raw fields if serialisation fails (e.g. a circular reference), so a
 * logging problem can never crash a request.
 */
function write(level, message, fields) {
  if (LEVELS[level] < threshold) return;

  const entry = {
    level,
    time: new Date().toISOString(),
    msg: message,
    ...redact(fields ?? {}),
  };

  let line;
  try {
    line = JSON.stringify(entry);
  } catch {
    line = JSON.stringify({ level, time: entry.time, msg: message, fields: "[unserialisable]" });
  }

  // stderr for warn/error keeps them separable from the main stream.
  if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

/** Serialises an Error into loggable fields without leaking a stack to clients. */
function serialiseError(error) {
  if (!(error instanceof Error)) return { err: String(error) };

  return {
    err: {
      name: error.name,
      message: error.message,
      status: error.status,
      code: error.code,
      stack: error.stack,
    },
  };
}

function createLogger(context = {}) {
  const emit = (level) => (message, fields) =>
    write(level, message, { ...context, ...fields });

  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: (message, fields) =>
      write("error", message, { ...context, ...fields }),
    /** Derives a logger that stamps every line with extra context (e.g. requestId). */
    child: (extra) => createLogger({ ...context, ...extra }),
  };
}

const logger = createLogger();

module.exports = { logger, createLogger, serialiseError };
