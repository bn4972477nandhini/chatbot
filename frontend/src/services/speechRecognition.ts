/**
 * Thin wrapper around the browser's native Web Speech API (SpeechRecognition /
 * webkitSpeechRecognition). This is the only STT provider today, but nothing
 * outside this file knows that — `useVoice` talks to the
 * `SpeechToTextController` shape below, so swapping in a cloud STT provider
 * (e.g. streaming audio to a server-side Whisper endpoint) later only means
 * writing a new file with this same shape, not touching the hook or UI.
 *
 * Every lifecycle event logs a `[VOICE]`-prefixed line to the console. This
 * is deliberate, temporary-by-design diagnostic instrumentation for the
 * "microphone isn't picking up speech" investigation — the browser's speech
 * events are otherwise invisible, so without this there is no way to tell
 * whether the mic never got permission, got permission but heard nothing, or
 * heard something but never produced a result. Safe to trim once voice input
 * is confirmed working end-to-end.
 */

export type SpeechToTextErrorCode =
  | "not-allowed"
  | "no-speech"
  | "audio-capture"
  | "network"
  | "aborted"
  | "unsupported"
  | "insecure-context"
  | "start-failed"
  | "unknown";

export interface SpeechToTextError {
  code: SpeechToTextErrorCode;
  message: string;
}

export interface SpeechToTextCallbacks {
  /** Fired for both interim and final results; `isFinal` distinguishes them. */
  onResult: (transcript: string, isFinal: boolean) => void;
  onError: (error: SpeechToTextError) => void;
  /** Fired when listening stops for any reason (silence, stop(), or an error). */
  onEnd: () => void;
  /**
   * Fired on the browser's own onaudiostart/onsoundstart/onspeechstart —
   * i.e. real evidence the recognizer is actually receiving audio, as
   * distinct from having merely been told to start. Lets a caller-side
   * "nothing happened at all" watchdog reset on genuine activity instead of
   * firing on a session that is legitimately still listening.
   */
  onActivity?: () => void;
}

export interface SpeechToTextController {
  start: () => void;
  stop: () => void;
}

const ERROR_MESSAGES: Record<SpeechToTextErrorCode, string> = {
  "not-allowed":
    "Microphone access was denied. Click the padlock/site-info icon in the address bar, allow microphone access, then try again.",
  "no-speech": "I couldn't hear you. Please try again.",
  "audio-capture": "No microphone was found. Check that one is connected, enabled, and selected as the default input device.",
  network: "A network error interrupted speech recognition. Voice input needs an internet connection even though the rest of this app runs locally.",
  aborted: "Listening was stopped.",
  unsupported: "Voice input isn't supported in this browser. Try the latest Chrome or Edge on desktop.",
  "insecure-context":
    "Voice input needs a secure connection. This page must be served over HTTPS, or opened via localhost/127.0.0.1, for the browser to allow microphone access.",
  "start-failed": "Couldn't start listening. Please try again.",
  unknown: "Something went wrong with voice input.",
};

/**
 * True only for a secure context — HTTPS, or the browser's built-in
 * localhost/127.0.0.1 exception. SpeechRecognition is restricted to secure
 * contexts; on an insecure origin the browser can fail silently or with a
 * confusing native error instead of a clear one, which is why this is
 * checked explicitly up front rather than left to whatever happens to
 * surface from start().
 */
function isSecureContext(): boolean {
  return typeof window !== "undefined" && window.isSecureContext === true;
}

function toSpeechToTextErrorCode(rawError: string): SpeechToTextErrorCode {
  switch (rawError) {
    case "not-allowed":
    case "service-not-allowed":
      return "not-allowed";
    case "no-speech":
      return "no-speech";
    case "audio-capture":
      return "audio-capture";
    case "network":
      return "network";
    case "aborted":
      return "aborted";
    default:
      return "unknown";
  }
}

function getSpeechRecognitionConstructor(): typeof SpeechRecognition | null {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

export function isSpeechToTextSupported(): boolean {
  return getSpeechRecognitionConstructor() !== null;
}

/**
 * Best-effort read of the browser's microphone permission state via the
 * Permissions API. Not all browsers support querying `"microphone"` this way
 * (Firefox/Safari commonly throw or don't expose it) — this is diagnostic
 * only, never gates whether we attempt to start listening.
 */
export async function getMicrophonePermissionState(): Promise<
  "granted" | "denied" | "prompt" | "unknown"
> {
  try {
    if (typeof navigator === "undefined" || !navigator.permissions?.query) return "unknown";
    const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
    return status.state;
  } catch {
    return "unknown";
  }
}

/**
 * en-IN/en-GB/etc. and ta-IN speakers get better recognition from their own
 * locale than a hardcoded en-US. Limited by the Web Speech API itself: `lang`
 * is one fixed tag per session, so genuine code-switching within a single
 * sentence (Tanglish) isn't something any browser's SpeechRecognition
 * supports natively — whichever language is picked here still governs the
 * whole utterance. Tamil is recognised specifically (rather than only
 * gating on English) because it's this app's other realistic input
 * language; any other locale still falls back to en-US.
 */
function resolveLang(): string {
  const browserLang = typeof navigator !== "undefined" ? navigator.language : "";
  const lower = browserLang.toLowerCase();
  if (lower.startsWith("en") || lower.startsWith("ta")) return browserLang;
  return "en-US";
}

/**
 * Creates one speech-to-text session. Each call builds a fresh recognizer —
 * the browser API does not reliably support restarting a finished instance.
 * Returns `null` when the browser has no speech recognition support at all;
 * callers should feature-detect with `isSpeechToTextSupported` before
 * offering voice input in the UI, and treat `null` here as a belt-and-braces
 * fallback.
 */
export function createSpeechToText(callbacks: SpeechToTextCallbacks): SpeechToTextController | null {
  // Checked before the constructor: SpeechRecognition can be constructable
  // on an insecure origin (the object exists) while still being blocked from
  // actually starting — so isSpeechToTextSupported() alone would report
  // "supported" here even though tapping the mic could otherwise fail with
  // no clear explanation.
  if (!isSecureContext()) {
    console.warn("[VOICE] insecure context — voice input requires HTTPS or localhost", {
      protocol: typeof location !== "undefined" ? location.protocol : "unknown",
      hostname: typeof location !== "undefined" ? location.hostname : "unknown",
    });
    callbacks.onError({ code: "insecure-context", message: ERROR_MESSAGES["insecure-context"] });
    return null;
  }

  const Recognition = getSpeechRecognitionConstructor();

  if (!Recognition) {
    console.warn("[VOICE] unsupported — no SpeechRecognition/webkitSpeechRecognition constructor on window");
    callbacks.onError({ code: "unsupported", message: ERROR_MESSAGES.unsupported });
    return null;
  }

  const recognition = new Recognition();
  const lang = resolveLang();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = lang;
  recognition.maxAlternatives = 1;
  console.log("[VOICE] recognition created", { lang });

  recognition.onstart = () => console.log("[VOICE] onstart");
  recognition.onaudiostart = () => {
    console.log("[VOICE] onaudiostart");
    callbacks.onActivity?.();
  };
  recognition.onsoundstart = () => {
    console.log("[VOICE] onsoundstart");
    callbacks.onActivity?.();
  };
  recognition.onspeechstart = () => {
    console.log("[VOICE] onspeechstart");
    callbacks.onActivity?.();
  };
  recognition.onspeechend = () => console.log("[VOICE] onspeechend");
  recognition.onaudioend = () => console.log("[VOICE] onaudioend");

  recognition.onresult = (event) => {
    // Only the most recent result is relevant to a single-question voice turn.
    const result = event.results[event.results.length - 1];
    if (!result) return;

    const transcript = result[0]?.transcript ?? "";
    console.log("[VOICE] onresult", { isFinal: result.isFinal, transcript });
    callbacks.onResult(transcript, result.isFinal);
  };

  recognition.onerror = (event) => {
    const code = toSpeechToTextErrorCode(event.error);
    console.error("[VOICE] onerror", { rawError: event.error, message: event.message, mappedCode: code });
    callbacks.onError({ code, message: event.message || ERROR_MESSAGES[code] });
  };

  recognition.onend = () => {
    console.log("[VOICE] onend");
    callbacks.onEnd();
  };

  return {
    start: () => {
      console.log("[VOICE] start requested");
      try {
        recognition.start();
      } catch (thrown) {
        // Per spec, start() throws synchronously (InvalidStateError) if the
        // recognizer is already running — should not happen for a session we
        // just constructed, but without this the click would silently do
        // nothing and the UI would be stuck showing "Listening…" forever.
        console.error("[VOICE] start() threw synchronously", thrown);
        callbacks.onError({ code: "start-failed", message: ERROR_MESSAGES["start-failed"] });
      }
    },
    stop: () => {
      console.log("[VOICE] stop requested");
      try {
        recognition.stop();
      } catch (thrown) {
        console.error("[VOICE] stop() threw", thrown);
      }
    },
  };
}
