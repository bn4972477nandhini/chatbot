import type { ChatResponse, Citation } from "../types/chat";

const CHAT_ENDPOINT = "/chat";
// Local Ollama inference is slower than a hosted API — mirrors the backend's
// own OLLAMA_TIMEOUT_MS so the client doesn't give up before the server does.
const REQUEST_TIMEOUT_MS = 120_000;

// Mirrors the server's MAX_QUESTION_LENGTH so an over-long question is caught
// before it costs a round trip. The server still enforces its own limit.
export const MAX_QUESTION_LENGTH = 1000;

/** Generic message shown for failures the user can do nothing about. */
export const GENERIC_ERROR = "Something went wrong.";

export class ChatApiError extends Error {
  /** HTTP status, or undefined for network/timeout failures. */
  readonly status?: number;

  /** True when retrying the same question could plausibly succeed. */
  readonly retryable: boolean;

  constructor(message: string, options: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = "ChatApiError";
    this.status = options.status;
    this.retryable = options.retryable ?? true;
  }
}

function isCitation(value: unknown): value is Citation {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.chunkId === "number" && typeof candidate.score === "number"
  );
}

/**
 * The server always intends to send JSON, but a proxy error or a crash can still
 * produce HTML. Parsing defensively keeps those from surfacing as a raw parse
 * exception.
 */
async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Posts a question to the backend.
 *
 * @throws {ChatApiError} on validation (400), server (5xx), network and timeout failures.
 */
export async function sendQuestion(
  question: string,
  signal?: AbortSignal
): Promise<ChatResponse> {
  const trimmed = question.trim();

  if (!trimmed) {
    throw new ChatApiError("Please enter a question.", { retryable: false });
  }

  if (trimmed.length > MAX_QUESTION_LENGTH) {
    throw new ChatApiError(
      `Question must be ${MAX_QUESTION_LENGTH} characters or fewer.`,
      { retryable: false }
    );
  }

  // Combines the caller's signal with an internal timeout, so either can abort.
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  let response: Response;

  try {
    response = await fetch(CHAT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: trimmed }),
      signal: combinedSignal,
    });
  } catch (error) {
    // A caller-initiated abort is not an error to report — let it propagate.
    if (signal?.aborted) throw error;

    if (timeoutSignal.aborted) {
      throw new ChatApiError(
        "The request timed out. The server may be busy — please try again."
      );
    }

    throw new ChatApiError(
      "Could not reach the server. Check that the backend is running on port 3000."
    );
  }

  const body = await readJson(response);

  if (!response.ok) {
    const serverMessage =
      typeof body?.error === "string" && body.error.trim() ? body.error : null;

    // 400 means the request itself was rejected; retrying it unchanged will fail
    // the same way, so the retry affordance is suppressed.
    if (response.status === 400) {
      throw new ChatApiError(serverMessage ?? "That question could not be processed.", {
        status: 400,
        retryable: false,
      });
    }

    throw new ChatApiError(serverMessage ?? GENERIC_ERROR, {
      status: response.status,
    });
  }

  if (typeof body?.answer !== "string") {
    throw new ChatApiError("The server returned an unexpected response.");
  }

  return {
    answer: body.answer,
    citations: Array.isArray(body.citations) ? body.citations.filter(isCitation) : [],
  };
}
