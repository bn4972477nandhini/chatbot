export interface Citation {
  chunkId: number;
  score: number;
  page?: number | null;
  pageEnd?: number | null;
}

export interface UserMessage {
  id: string;
  role: "user";
  content: string;
  timestamp: number;
}

export interface AssistantMessage {
  id: string;
  role: "assistant";
  content: string;
  citations: Citation[];
  timestamp: number;
}

export type Message = UserMessage | AssistantMessage;

/** One earlier turn sent with a question, so the server can resolve follow-ups. */
export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

/** Shape returned by POST /chat on success. */
export interface ChatResponse {
  answer: string;
  citations: Citation[];
}
