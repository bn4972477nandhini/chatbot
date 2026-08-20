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

/** Shape returned by POST /chat on success. */
export interface ChatResponse {
  answer: string;
  citations: Citation[];
}
