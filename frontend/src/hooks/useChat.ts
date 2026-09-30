import { useCallback, useEffect, useRef, useState } from "react";

import { ChatApiError, GENERIC_ERROR, streamQuestion } from "../services/chatApi";
import type { Message } from "../types/chat";

function createId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export interface ChatError {
  message: string;
  /** Whether re-sending the same question is worth offering. */
  retryable: boolean;
}

export interface UseChatResult {
  messages: Message[];
  isLoading: boolean;
  error: ChatError | null;
  send: (question: string) => void;
  retry: () => void;
  clear: () => void;
  dismissError: () => void;
}

/**
 * Owns all chat state and the request lifecycle. Components stay presentational
 * and receive only values and callbacks from here.
 *
 * Every returned callback has an empty dependency list and reads mutable state
 * through refs. That keeps their identities stable for the life of the hook, so
 * memoised children (ChatInput, EmptyState, ChatHeader) do not re-render each
 * time a request starts or finishes.
 *
 * The backend is single-turn: each request sends one question with no history.
 * The answer streams in — the assistant message is created empty as soon as
 * citations arrive (which never depend on generation, so they're available
 * well before the first token on this CPU-only setup) and grows in place as
 * each fragment lands, rather than appearing all at once at the end.
 */
export function useChat(): UseChatResult {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<ChatError | null>(null);

  // Mirrors isLoading so the guards below can stay out of callback deps.
  const isLoadingRef = useRef(false);
  // Last question asked, kept so Retry can resend it.
  const lastQuestionRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const setLoading = useCallback((value: boolean) => {
    isLoadingRef.current = value;
    setIsLoading(value);
  }, []);

  // Abort any in-flight request if the component unmounts.
  useEffect(
    () => () => {
      abortRef.current?.abort();
      abortRef.current = null;
    },
    []
  );

  const runRequest = useCallback(
    async (question: string) => {
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setError(null);

      // Created lazily, on the first citations/delta callback, rather than up
      // front — an empty bubble should never appear before there is anything
      // (even just citations) to show in it.
      const assistantId = createId();
      let assistantMessageStarted = false;

      const ensureAssistantMessage = () => {
        if (assistantMessageStarted) return;
        assistantMessageStarted = true;
        setMessages((current) => [
          ...current,
          { id: assistantId, role: "assistant", content: "", citations: [], timestamp: Date.now() },
        ]);
      };

      const updateAssistantMessage = (patch: (message: Extract<Message, { role: "assistant" }>) => Extract<Message, { role: "assistant" }>) => {
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantId && message.role === "assistant" ? patch(message) : message
          )
        );
      };

      try {
        await streamQuestion(question, controller.signal, {
          onCitations: (citations) => {
            ensureAssistantMessage();
            updateAssistantMessage((message) => ({ ...message, citations }));
          },
          onDelta: (delta) => {
            ensureAssistantMessage();
            updateAssistantMessage((message) => ({ ...message, content: message.content + delta }));
          },
        });
      } catch (caught) {
        // Cancelled by clear() or unmount — not a failure to surface.
        if (controller.signal.aborted) return;

        // The banner keeps its wording short; the full error (HTTP status,
        // original exception) goes to the console for debugging.
        if (import.meta.env.DEV) console.error("[chat] request failed:", caught);

        // Whatever streamed in before the failure (if anything) stays visible
        // — losing an already-partially-correct answer on top of the error
        // would be worse than showing both.
        if (caught instanceof ChatApiError) {
          setError({ message: caught.message, retryable: caught.retryable });
        } else {
          setError({ message: GENERIC_ERROR, retryable: true });
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [setLoading]
  );

  const send = useCallback(
    (question: string) => {
      const trimmed = question.trim();

      // Empty questions never reach the network.
      if (!trimmed || isLoadingRef.current) return;

      lastQuestionRef.current = trimmed;

      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "user",
          content: trimmed,
          timestamp: Date.now(),
        },
      ]);

      void runRequest(trimmed);
    },
    [runRequest]
  );

  /** Re-sends the last question without duplicating the user's bubble. */
  const retry = useCallback(() => {
    const question = lastQuestionRef.current;
    if (!question || isLoadingRef.current) return;

    void runRequest(question);
  }, [runRequest]);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;

    lastQuestionRef.current = null;
    setMessages([]);
    setError(null);
    setLoading(false);
  }, [setLoading]);

  const dismissError = useCallback(() => setError(null), []);

  return { messages, isLoading, error, send, retry, clear, dismissError };
}
