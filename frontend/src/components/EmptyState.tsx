import { memo } from "react";

const EXAMPLE_QUESTIONS = [
  "What is Zero Rupee Marketing?",
  "How should I acquire customers?",
  "What marketing mistakes should startups avoid?",
];

interface EmptyStateProps {
  onExampleClick: (question: string) => void;
  disabled: boolean;
}

function EmptyStateComponent({ onExampleClick, disabled }: EmptyStateProps) {
  return (
    <div className="flex animate-fade-in flex-col items-center justify-center px-4 py-10 text-center">
      <div
        aria-hidden="true"
        className="mb-5 flex h-20 w-20 items-center justify-center rounded-2xl bg-linear-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-200"
      >
        <svg className="h-10 w-10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5v-15Z" strokeLinejoin="round" />
          <path d="M19 18v3H6.5A2.5 2.5 0 0 1 4 18.5" strokeLinejoin="round" />
          <path d="M8.5 8h6M8.5 11.5h4" strokeLinecap="round" />
        </svg>
      </div>

      <h2 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">
        Founder Book AI
      </h2>
      <p className="mt-1.5 max-w-sm text-sm text-slate-500">
        Ask anything about the Founder Book.
      </p>

      <div className="mt-7 w-full max-w-md">
        <p className="mb-2.5 text-[0.7rem] font-semibold tracking-wide text-slate-400 uppercase">
          Example Questions
        </p>

        <ul className="flex flex-col gap-2">
          {EXAMPLE_QUESTIONS.map((question) => (
            <li key={question}>
              <button
                type="button"
                onClick={() => onExampleClick(question)}
                disabled={disabled}
                className="group flex w-full items-center gap-2.5 rounded-xl border border-slate-200 bg-white px-4 py-3 text-left text-sm text-slate-700 shadow-sm transition-all hover:-translate-y-0.5 hover:border-indigo-200 hover:text-slate-900 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
              >
                <span aria-hidden="true" className="text-indigo-400 transition-colors group-hover:text-indigo-600">
                  •
                </span>
                <span className="flex-1">{question}</span>
                <svg
                  className="h-4 w-4 shrink-0 text-slate-300 transition-colors group-hover:text-indigo-500"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  aria-hidden="true"
                >
                  <path d="M5 12h14m0 0-5-5m5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Its callbacks are stable, so memo keeps it out of every chat state update. */
export const EmptyState = memo(EmptyStateComponent);
