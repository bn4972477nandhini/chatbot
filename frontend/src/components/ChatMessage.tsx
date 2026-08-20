import { memo, lazy, Suspense } from "react";
import { CopyButton } from "./CopyButton";
import { formatFullTime, formatTime } from "../utils/formatTime";
import type { Citation, Message } from "../types/chat";

// The Markdown renderer is only needed once an assistant answer exists, so it is
// split out of the initial bundle — the empty state and input ship without it.
const Markdown = lazy(() => import("./Markdown"));

function pageLabel(citation: Citation): string {
  if (citation.page == null) return "";
  if (citation.pageEnd != null && citation.pageEnd !== citation.page) {
    return ` · p.${citation.page}-${citation.pageEnd}`;
  }
  return ` · p.${citation.page}`;
}

/** Small badges listing the chunks (and pages) an answer drew from. */
function Sources({ citations }: { citations: Citation[] }) {
  if (citations.length === 0) return null;

  return (
    <div className="mt-3 border-t border-slate-100 pt-3">
      <p className="mb-1.5 text-[0.7rem] font-semibold tracking-wide text-slate-400 uppercase">
        Sources
      </p>
      <ul className="flex flex-wrap gap-1.5">
        {citations.map((citation) => (
          <li key={citation.chunkId}>
            <span
              title={`Relevance score ${citation.score.toFixed(3)}`}
              className="inline-flex items-center rounded-md bg-indigo-50 px-2 py-1 text-[0.7rem] font-medium text-indigo-700 ring-1 ring-indigo-100 ring-inset"
            >
              Chunk {citation.chunkId}
              {pageLabel(citation)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChatMessageComponent({ message }: { message: Message }) {
  const isUser = message.role === "user";

  return (
    <div
      className={`flex animate-rise-in gap-3 ${isUser ? "justify-end" : "justify-start"}`}
    >
      {!isUser && (
        <div
          aria-hidden="true"
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-linear-to-br from-indigo-500 to-violet-600 text-xs font-semibold text-white"
        >
          AI
        </div>
      )}

      <div
        className={`group/message flex max-w-[85%] flex-col sm:max-w-[75%] ${isUser ? "items-end" : "items-start"}`}
      >
        <div
          className={
            isUser
              ? "rounded-2xl rounded-br-md bg-indigo-600 px-4 py-2.5 text-[0.95rem] leading-relaxed whitespace-pre-wrap text-white shadow-sm"
              : "w-full rounded-2xl rounded-bl-md border border-slate-200 bg-white px-4 py-3 text-slate-800 shadow-sm"
          }
        >
          {isUser ? (
            message.content
          ) : (
            <>
              {/* Falls back to plain text for the frame before the chunk lands,
                  so the answer is never briefly blank. */}
              <Suspense
                fallback={
                  <div className="text-[0.95rem] leading-relaxed whitespace-pre-wrap">
                    {message.content}
                  </div>
                }
              >
                <Markdown content={message.content} />
              </Suspense>
              <Sources citations={message.citations} />
            </>
          )}
        </div>

        <div className={`mt-1 flex items-center gap-1 px-1 ${isUser ? "flex-row-reverse" : ""}`}>
          <time
            dateTime={new Date(message.timestamp).toISOString()}
            title={formatFullTime(message.timestamp)}
            className="text-[0.7rem] text-slate-400"
          >
            {formatTime(message.timestamp)}
          </time>

          {!isUser && (
            <CopyButton
              value={message.content}
              label="Copy"
              className="text-slate-400 opacity-0 transition-opacity group-hover/message:opacity-100 hover:text-slate-600 focus-visible:opacity-100"
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** Messages are immutable once added: memo stops the whole transcript re-rendering when a new message arrives or the typing indicator toggles. */
export const ChatMessage = memo(ChatMessageComponent);
