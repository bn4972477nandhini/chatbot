import { memo } from "react";
import type { ChatError } from "../hooks/useChat";
import { GENERIC_ERROR } from "../services/chatApi";

interface ErrorBannerProps {
  error: ChatError;
  onRetry: () => void;
  onDismiss: () => void;
  isLoading: boolean;
}

function ErrorBannerComponent({ error, onRetry, onDismiss, isLoading }: ErrorBannerProps) {
  return (
    <div
      role="alert"
      className="flex animate-rise-in items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3"
    >
      <svg
        className="mt-0.5 h-5 w-5 shrink-0 text-red-500"
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm0-11a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 7Zm0 7.5a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8Z"
          clipRule="evenodd"
        />
      </svg>

      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-red-800">{GENERIC_ERROR}</p>
        {error.message !== GENERIC_ERROR && (
          <p className="mt-0.5 text-sm break-words text-red-700">{error.message}</p>
        )}

        <div className="mt-2.5 flex items-center gap-2">
          {error.retryable && (
            <button
              type="button"
              onClick={onRetry}
              disabled={isLoading}
              className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Retry
            </button>
          )}
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

/** Re-renders only when the error object or loading flag actually changes. */
export const ErrorBanner = memo(ErrorBannerComponent);
