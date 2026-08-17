import { memo, useEffect, useRef, useState, type KeyboardEvent } from "react";

import { MAX_QUESTION_LENGTH } from "../services/chatApi";

interface ChatInputProps {
  onSend: (question: string) => void;
  disabled: boolean;
}

const MAX_TEXTAREA_HEIGHT = 160;

function ChatInputComponent({ onSend, disabled }: ChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const trimmedLength = value.trim().length;
  const isTooLong = trimmedLength > MAX_QUESTION_LENGTH;
  const canSend = trimmedLength > 0 && !isTooLong && !disabled;

  // Grow the textarea with its content, up to a cap.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = "auto";
    const next = Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT);
    textarea.style.height = `${next}px`;

    // Chrome renders a permanent scrollbar track on textareas, so overflow is
    // only enabled once the content actually exceeds the cap.
    textarea.style.overflowY =
      textarea.scrollHeight > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
  }, [value]);

  // Return focus to the input once a response finishes.
  useEffect(() => {
    if (!disabled) textareaRef.current?.focus();
  }, [disabled]);

  function submit() {
    if (!canSend) return;

    onSend(value);
    setValue("");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter inserts a newline.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div className="border-t border-slate-200 bg-white/80 px-4 py-3 backdrop-blur-sm sm:px-6 sm:py-4">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="flex items-end gap-2"
      >
        <div className="flex-1">
          <label htmlFor="chat-input" className="sr-only">
            Ask a question about the Founder Book
          </label>
          <textarea
            id="chat-input"
            ref={textareaRef}
            rows={1}
            value={value}
            disabled={disabled}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={disabled ? "Waiting for a response…" : "Ask anything from the Founder Book…"}
            className="w-full resize-none rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-[0.95rem] leading-relaxed text-slate-900 placeholder:text-slate-400 focus:border-indigo-400 focus:bg-white focus:ring-2 focus:ring-indigo-100 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          />
        </div>

        <button
          type="submit"
          disabled={!canSend}
          aria-label="Send message"
          className="mb-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-sm transition-all hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none sm:w-auto sm:px-5"
        >
          <span className="hidden text-sm font-medium sm:inline">Send</span>
          <svg
            className="h-5 w-5 sm:hidden"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            aria-hidden="true"
          >
            <path d="M4 12h15m0 0-6-6m6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </form>

      <div className="mt-2 flex items-center justify-between gap-3 px-1">
        <p className="hidden text-[0.7rem] text-slate-400 sm:block">
          Press <kbd className="font-sans font-medium text-slate-500">Enter</kbd> to send,{" "}
          <kbd className="font-sans font-medium text-slate-500">Shift + Enter</kbd> for a new line
        </p>

        {/* Only surfaces as the limit approaches, so it stays out of the way. */}
        {trimmedLength > MAX_QUESTION_LENGTH * 0.8 && (
          <p
            role={isTooLong ? "alert" : undefined}
            className={`ml-auto text-[0.7rem] tabular-nums ${
              isTooLong ? "font-medium text-red-600" : "text-slate-400"
            }`}
          >
            {trimmedLength} / {MAX_QUESTION_LENGTH}
          </p>
        )}
      </div>
    </div>
  );
}

/** Owns its own draft state; memo prevents parent updates from touching it while typing. */
export const ChatInput = memo(ChatInputComponent);
