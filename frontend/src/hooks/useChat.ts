import { useCallback, useEffect, useRef, useState } from "react";

import { ChatApiError, GENERIC_ERROR, streamQuestion } from "../services/chatApi";
import type { Citation, HistoryTurn, Message } from "../types/chat";

function createId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// Two exchanges, so a follow-up of a follow-up ("why is it useful?" then
// "Tanglish la sollu") can still be traced back to the question that named
// the topic. Matches the server's MAX_HISTORY_MESSAGES (4).
const HISTORY_EXCHANGES = 2;

/**
 * The last completed question/answer pairs, oldest first, sent so the server
 * can resolve a follow-up. The server only uses them when the new question
 * actually is a follow-up, so sending them always costs nothing extra.
 */
function recentExchanges(messages: Message[]): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  for (let index = messages.length - 1; index > 0 && turns.length < HISTORY_EXCHANGES * 2; index--) {
    const answer = messages[index];
    const question = messages[index - 1];
    if (answer.role === "assistant" && answer.content.trim() && question.role === "user") {
      turns.unshift(
        { role: "user", content: question.content },
        { role: "assistant", content: answer.content }
      );
      index--;
    }
  }
  return turns;
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
 * Each request sends the question plus the last completed exchanges, for
 * follow-ups. The answer streams in: the assistant message is created on the
 * first token and grows in place as each fragment lands. Citations arrive
 * tens of seconds earlier on this CPU-only setup (they need only retrieval),
 * but they are held until then, so the typing indicator stays up while the
 * model reads the prompt instead of an empty bubble that looks stuck.
 */
export function useChat(): UseChatResult {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<ChatError | null>(null);

  // Mirrors isLoading so the guards below can stay out of callback deps.
  const isLoadingRef = useRef(false);
  // Last question asked and the history it was sent with, kept so Retry can
  // resend exactly the same request.
  const lastQuestionRef = useRef<string | null>(null);
  const lastHistoryRef = useRef<HistoryTurn[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  // Mirrors messages so send() can read the transcript without depending on it.
  const messagesRef = useRef<Message[]>([]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

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
    async (question: string, history: HistoryTurn[]) => {
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setError(null);

      // Created lazily, on the first token, rather than up front: an empty
      // bubble should never appear before there is answer text to show in it.
      const assistantId = createId();
      let assistantMessageStarted = false;
      let pendingCitations: Citation[] = [];

      const ensureAssistantMessage = () => {
        if (assistantMessageStarted) return;
        assistantMessageStarted = true;
        const citations = pendingCitations;
        setMessages((current) => [
          ...current,
          { id: assistantId, role: "assistant", content: "", citations, timestamp: Date.now() },
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
        await streamQuestion(
          question,
          controller.signal,
          {
            // Can fire twice: once after retrieval, and again with [] when
            // the reply turns out to be "couldn't find that".
            onCitations: (citations) => {
              pendingCitations = citations;
              if (assistantMessageStarted) {
                updateAssistantMessage((message) => ({ ...message, citations }));
              }
            },
            onDelta: (delta) => {
              ensureAssistantMessage();
              updateAssistantMessage((message) => ({ ...message, content: message.content + delta }));
            },
            onReplace: (answer) => {
              ensureAssistantMessage();
              updateAssistantMessage((message) => ({ ...message, content: answer }));
            },
          },
          history
        );
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
      const history = recentExchanges(messagesRef.current);
      lastHistoryRef.current = history;

      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "user",
          content: trimmed,
          timestamp: Date.now(),
        },
      ]);

      void runRequest(trimmed, history);
    },
    [runRequest]
  );

  /** Re-sends the last question without duplicating the user's bubble. */
  const retry = useCallback(() => {
    const question = lastQuestionRef.current;
    if (!question || isLoadingRef.current) return;

    void runRequest(question, lastHistoryRef.current);
  }, [runRequest]);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;

    lastQuestionRef.current = null;
    lastHistoryRef.current = [];
    setMessages([]);
    setError(null);
    setLoading(false);
  }, [setLoading]);

  const dismissError = useCallback(() => setError(null), []);

  return { messages, isLoading, error, send, retry, clear, dismissError };
}
