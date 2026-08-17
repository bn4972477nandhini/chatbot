import { memo } from "react";

interface ChatHeaderProps {
  onClear: () => void;
  canClear: boolean;
}

function ChatHeaderComponent({ onClear, canClear }: ChatHeaderProps) {
  return (
    <header className="flex items-center gap-3 border-b border-slate-200 bg-white/80 px-5 py-4 backdrop-blur-sm sm:px-6">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-linear-to-br from-indigo-500 to-violet-600 text-white shadow-sm">
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5v-15Z" strokeLinejoin="round" />
          <path d="M19 18v3H6.5A2.5 2.5 0 0 1 4 18.5" strokeLinejoin="round" />
        </svg>
      </div>

      <div className="min-w-0 flex-1">
        <h1 className="truncate text-base font-semibold tracking-tight text-slate-900 sm:text-lg">
          Founder Book AI Assistant
        </h1>
        <p className="truncate text-xs text-slate-500 sm:text-sm">
          Ask anything from the Founder Book
        </p>
      </div>

      <button
        type="button"
        onClick={onClear}
        disabled={!canClear}
        className="shrink-0 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-40 sm:text-sm"
      >
        Clear Chat
      </button>
    </header>
  );
}

/** Static apart from canClear; memoised so header does not re-render per message. */
export const ChatHeader = memo(ChatHeaderComponent);
