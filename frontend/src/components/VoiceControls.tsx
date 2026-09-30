import { memo } from "react";

import type { VoiceState, VoiceSupport } from "../hooks/useVoice";

interface VoiceControlsProps {
  state: VoiceState;
  support: VoiceSupport;
  interimTranscript: string;
  voiceError: string | null;
  onDismissVoiceError: () => void;
  onStartListening: () => void;
  onStopListening: () => void;
  onStopSpeaking: () => void;
  /** Mirrors ChatInput's own disabled flag (isLoading) — kept consistent so the two controls never contradict each other. */
  disabled: boolean;
}

const STATE_LABEL: Record<VoiceState, string> = {
  idle: "Tap to speak",
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Speaking…",
};

function MicIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" strokeLinecap="round" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

function VoiceControlsComponent({
  state,
  support,
  interimTranscript,
  voiceError,
  onDismissVoiceError,
  onStartListening,
  onStopListening,
  onStopSpeaking,
  disabled,
}: VoiceControlsProps) {
  // No voice input at all in this browser — text chat still behaves exactly
  // as it did before voice existed, but the user should be told why there's
  // no mic button rather than have it silently absent.
  if (!support.stt) {
    return (
      <p className="px-1 pb-2 text-xs text-slate-400">
        Voice input isn't supported in this browser. Try the latest Chrome or Edge on desktop.
      </p>
    );
  }

  const micDisabled = disabled || state === "thinking";

  function handleMicClick() {
    console.log("[VOICE] button clicked");
    if (state === "listening") {
      onStopListening();
    } else {
      onStartListening();
    }
  }

  return (
    <div className="flex flex-col gap-1.5 px-1 pb-2">
      {voiceError && (
        <div
          role="alert"
          className="flex animate-rise-in items-start justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
        >
          <span>{voiceError}</span>
          <button
            type="button"
            onClick={onDismissVoiceError}
            className="shrink-0 font-medium text-amber-700 hover:text-amber-900 focus:outline-none"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={handleMicClick}
          disabled={micDisabled}
          aria-label={state === "listening" ? "Stop listening" : "Speak your question"}
          aria-pressed={state === "listening"}
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40 ${
            state === "listening"
              ? "animate-pulse bg-red-500 text-white shadow-sm"
              : "bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-700"
          }`}
        >
          <MicIcon />
        </button>

        <span
          role="status"
          aria-live="polite"
          className={`text-xs font-medium ${state === "idle" ? "text-slate-400" : "text-slate-600"}`}
        >
          {interimTranscript ? `"${interimTranscript}"` : STATE_LABEL[state]}
        </span>

        {state === "speaking" && (
          <button
            type="button"
            onClick={onStopSpeaking}
            className="ml-auto flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            <StopIcon />
            Stop speaking
          </button>
        )}

        {!support.tts && state === "idle" && (
          <span className="ml-auto text-[0.7rem] text-slate-400">Voice output unavailable</span>
        )}
      </div>
    </div>
  );
}

/** Re-renders only when voice state actually changes. */
export const VoiceControls = memo(VoiceControlsComponent);
