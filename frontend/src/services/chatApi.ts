import type { ChatResponse, Citation } from "../types/chat";

const CHAT_ENDPOINT = "/chat";
// Local Ollama inference is slower than a hosted API — mirrors the backend's
// own OLLAMA_TIMEOUT_MS so the client doesn't give up before the server does.
const REQUEST_TIMEOUT_MS = 180_000;

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

function assertValidQuestion(question: string): string {
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

  return trimmed;
}

/** Maps a non-2xx response to the same ChatApiError shape both callers use. */
async function errorFromResponse(response: Response): Promise<ChatApiError> {
  const body = await readJson(response);
  const serverMessage =
    typeof body?.error === "string" && body.error.trim() ? body.error : null;

  // 400 means the request itself was rejected; retrying it unchanged will fail
  // the same way, so the retry affordance is suppressed.
  if (response.status === 400) {
    return new ChatApiError(serverMessage ?? "That question could not be processed.", {
      status: 400,
      retryable: false,
    });
  }

  return new ChatApiError(serverMessage ?? GENERIC_ERROR, { status: response.status });
}

export interface StreamCallbacks {
  /** Fired once, as soon as retrieval finishes — before the first token, since citations never depend on generation. */
  onCitations?: (citations: Citation[]) => void;
  /** Fired for each answer fragment as the model generates it, in order. */
  onDelta?: (delta: string) => void;
}

/** One `event: ...\ndata: ...` Server-Sent Events frame. */
interface SSEFrame {
  event: string;
  data: unknown;
}

/** Splits a raw SSE frame (already isolated by a blank-line boundary) into its event name and parsed data. */
function parseSSEFrame(frame: string): SSEFrame | null {
  const eventLine = frame.split("\n").find((line) => line.startsWith("event: "));
  const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
  if (!eventLine || !dataLine) return null;

  try {
    return {
      event: eventLine.slice("event: ".length),
      data: JSON.parse(dataLine.slice("data: ".length)),
    };
  } catch {
    return null;
  }
}

/**
 * Posts a question to the backend and streams the answer as it's generated,
 * so the UI can render it token-by-token instead of waiting for the full
 * response. Resolves once the stream completes, with the same shape a
 * non-streaming call would return — callers that only need the final result
 * can ignore the callbacks entirely.
 *
 * @throws {ChatApiError} on validation (400), server (5xx), network, timeout
 *   and mid-stream failures.
 */
export async function streamQuestion(
  question: string,
  signal: AbortSignal | undefined,
  callbacks: StreamCallbacks = {}
): Promise<ChatResponse> {
  const trimmed = assertValidQuestion(question);

  // Combines the caller's signal with an internal timeout, so either can abort.
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let response: Response;

  try {
    response = await fetch(CHAT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: trimmed, stream: true }),
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

  // A failure before the server ever starts the SSE stream (bad request, rate
  // limit, a crash in the error boundary) is still plain JSON — the streaming
  // headers are only ever sent once the server has committed to streaming.
  if (!response.ok) {
    throw await errorFromResponse(response);
  }

  if (!response.body) {
    throw new ChatApiError("The server returned an unexpected response.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let citations: Citation[] = [];
  let answer = "";
  let streamErrorMessage: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const rawFrame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");

        if (!rawFrame.trim()) continue;
        const frame = parseSSEFrame(rawFrame);
        if (!frame) continue;

        if (frame.event === "citations") {
          const candidate = (frame.data as { citations?: unknown })?.citations;
          citations = Array.isArray(candidate) ? candidate.filter(isCitation) : [];
          callbacks.onCitations?.(citations);
        } else if (frame.event === "token") {
          const delta = (frame.data as { delta?: unknown })?.delta;
          if (typeof delta === "string") {
            answer += delta;
            callbacks.onDelta?.(delta);
          }
        } else if (frame.event === "error") {
          const message = (frame.data as { message?: unknown })?.message;
          streamErrorMessage = typeof message === "string" ? message : GENERIC_ERROR;
        }
        // "done" carries no payload — its only role is marking a clean end.
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error;

    if (timeoutSignal.aborted) {
      throw new ChatApiError(
        "The request timed out. The server may be busy — please try again."
      );
    }

    throw new ChatApiError("The connection was interrupted while the answer was streaming.");
  }

  if (streamErrorMessage) {
    throw new ChatApiError(streamErrorMessage);
  }

  if (!answer) {
    throw new ChatApiError("The server returned an unexpected response.");
  }

  return { answer, citations };
}
