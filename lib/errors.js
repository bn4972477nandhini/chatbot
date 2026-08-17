/**
 * Error carrying an HTTP status and an explicitly client-safe message.
 *
 * Anything not constructed as an AppError is treated as an internal fault: the
 * route layer logs it in full and returns a generic message, so implementation
 * details and stack traces never reach a client.
 */
class AppError extends Error {
  constructor(message, { status = 500, code = "internal_error", expose = true, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.expose = expose;
  }
}

const badRequest = (message, code = "bad_request") =>
  new AppError(message, { status: 400, code });

const configError = (message) =>
  new AppError(message, { status: 503, code: "not_configured" });

const upstreamError = (message, cause) =>
  new AppError(message, { status: 502, code: "upstream_error", cause });

const conflict = (message) => new AppError(message, { status: 409, code: "conflict" });

module.exports = { AppError, badRequest, configError, upstreamError, conflict };
