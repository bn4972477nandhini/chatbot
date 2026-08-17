import { useCallback, useEffect, useRef, useState } from "react";

import { ChatApiError, GENERIC_ERROR, sendQuestion } from "../services/chatApi";
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

      try {
        const { answer, citations } = await sendQuestion(question, controller.signal);

        setMessages((current) => [
          ...current,
          {
            id: createId(),
            role: "assistant",
            content: answer,
            citations,
            timestamp: Date.now(),
          },
        ]);
      } catch (caught) {
        // Cancelled by clear() or unmount — not a failure to surface.
        if (controller.signal.aborted) return;

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
