import { memo } from "react";

/** Three animated dots shown while the assistant's answer is in flight. */
function TypingIndicatorComponent() {
  return (
    <div className="flex animate-fade-in gap-3" role="status" aria-live="polite">
      <div
        aria-hidden="true"
        className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-linear-to-br from-indigo-500 to-violet-600 text-xs font-semibold text-white"
      >
        AI
      </div>

      <div className="flex items-center gap-1.5 rounded-2xl rounded-bl-md border border-slate-200 bg-white px-4 py-3.5 shadow-sm">
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            className="h-2 w-2 animate-blink rounded-full bg-slate-400"
            style={{ animationDelay: `${index * 0.18}s` }}
          />
        ))}
        <span className="sr-only">Assistant is typing…</span>
      </div>
    </div>
  );
}

/** Takes no props — memo makes it render exactly once per appearance. */
export const TypingIndicator = memo(TypingIndicatorComponent);
