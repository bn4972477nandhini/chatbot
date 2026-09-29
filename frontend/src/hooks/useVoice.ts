import { useCallback, useEffect, useRef, useState } from "react";

import {
  createSpeechToText,
  getMicrophonePermissionState,
  isSpeechToTextSupported,
  type SpeechToTextController,
} from "../services/speechRecognition";
import {
  createTextToSpeech,
  isTextToSpeechSupported,
  type TextToSpeechController,
} from "../services/speechSynthesis";
import type { Message } from "../types/chat";

export type VoiceState = "idle" | "listening" | "thinking" | "speaking";

// Shown when recognition ends (or never starts producing events at all)
// without ever hearing anything and without the browser reporting its own
// error — the UI must never revert to "idle" silently, so this is the
// explicit fallback message for that case.
const NO_SPEECH_DETECTED_MESSAGE = "I couldn't hear you. Please try again.";

// Bounds how long "Listening…" can show with zero lifecycle events at all
// (not even the browser's own onend) — e.g. a permission prompt that never
// resolves, or a silent platform-level mic block. Generous enough not to cut
// off a real permission-grant flow, bounded enough not to hang forever.
const LISTENING_WATCHDOG_MS = 12_000;

export interface VoiceSupport {
  stt: boolean;
  tts: boolean;
}

export interface UseVoiceOptions {
  /** Posts a transcribed question through the existing chat pipeline (useChat's `send`). */
  onFinalTranscript: (question: string) => void;
  /** useChat's `isLoading` — drives the thinking -> speaking/idle transition. */
  isAssistantResponding: boolean;
  /** useChat's `error` — a failed request goes straight to idle, never speaks. */
  hasAssistantError: boolean;
  /** useChat's `messages` — the newest assistant reply is what gets spoken. */
  messages: Message[];
}

export interface UseVoiceResult {
  state: VoiceState;
  support: VoiceSupport;
  /** Live partial transcript while listening; empty once a turn ends. */
  interimTranscript: string;
  voiceError: string | null;
  dismissVoiceError: () => void;
  startListening: () => void;
  stopListening: () => void;
  stopSpeaking: () => void;
}

/**
 * Owns the voice state machine (idle -> listening -> thinking -> speaking -> idle)
 * and wires it to the existing text chat pipeline via `onFinalTranscript`
 * (calls straight into useChat's `send`, so a spoken question produces the
 * exact same user-message bubble and /chat request a typed one would) and by
 * watching useChat's own `isAssistantResponding`/`messages`/`hasAssistantError`
 * to know when to speak the real answer. Does not call the chat API itself —
 * all RAG/network behaviour stays entirely inside useChat.
 */
export function useVoice({
  onFinalTranscript,
  isAssistantResponding,
  hasAssistantError,
  messages,
}: UseVoiceOptions): UseVoiceResult {
  const [state, setState] = useState<VoiceState>("idle");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const support = useRef<VoiceSupport>({
    stt: isSpeechToTextSupported(),
    tts: isTextToSpeechSupported(),
  }).current;

  const sttRef = useRef<SpeechToTextController | null>(null);
  const ttsRef = useRef<TextToSpeechController | null>(null);
  // True only while the in-flight /chat request was triggered by voice — so a
  // typed question's answer is never spoken aloud, keeping normal text chat
  // exactly as quiet as it already is.
  const pendingVoiceTurnRef = useRef(false);
  // Distinguishes "recognition ended because a final result arrived" (already
  // moved on to "thinking") from "recognition ended with nothing said" (must
  // fall back to "idle") inside the same onEnd callback.
  const gotFinalResultRef = useRef(false);
  // Set by onEnd/onError (whichever fires first) — lets the watchdog below
  // tell "the session ended normally, nothing left to do" apart from "no
  // browser event has fired at all", which is the failure mode a stuck
  // permission prompt or a silent platform-level mic block looks like.
  const sessionEndedRef = useRef(false);
  // True only when the user themselves clicked the mic again to stop early —
  // that end is intentional and must never surface a "couldn't hear you"
  // message, unlike every other reason recognition can end.
  const wasManuallyStoppedRef = useRef(false);
  const watchdogRef = useRef<number | null>(null);
  const wasRespondingRef = useRef(false);

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current !== null) {
      window.clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  /**
   * (Re)arms the "nothing happened at all" watchdog. Called both when
   * listening starts and again on every onaudiostart/onsoundstart/
   * onspeechstart — a session that demonstrably received audio but is
   * simply taking longer than LISTENING_WATCHDOG_MS to reach a final result
   * (a longer sentence, or the browser's own end-of-speech detection being
   * slow) must not be killed and reported as "couldn't hear you" just
   * because the ORIGINAL start() is more than the timeout ago; only true
   * silence — no activity events at all since the last arm — should trip it.
   */
  const armWatchdog = useCallback(() => {
    clearWatchdog();
    watchdogRef.current = window.setTimeout(() => {
      if (sessionEndedRef.current) return;

      console.warn("[VOICE] watchdog fired — no recognition activity within", LISTENING_WATCHDOG_MS, "ms");
      sessionEndedRef.current = true;
      sttRef.current?.stop();
      setVoiceError("Listening timed out with no response from the microphone. Check your browser's microphone permission and try again.");
      setState("idle");
    }, LISTENING_WATCHDOG_MS);
  }, [clearWatchdog]);

  const stopSpeaking = useCallback(() => {
    ttsRef.current?.cancel();
  }, []);

  const stopListening = useCallback(() => {
    wasManuallyStoppedRef.current = true;
    sttRef.current?.stop();
  }, []);

  const startListening = useCallback(() => {
    if (state === "thinking") return;

    if (state === "speaking") stopSpeaking();

    console.log("[VOICE] start requested");
    setVoiceError(null);
    setInterimTranscript("");
    gotFinalResultRef.current = false;
    sessionEndedRef.current = false;
    wasManuallyStoppedRef.current = false;
    clearWatchdog();

    // Diagnostic only — never gates whether we call start(); Chrome shows its
    // own permission prompt regardless, and this API isn't reliably supported
    // everywhere. Logged so a "denied"/"prompt" state is visible up front
    // instead of only inferred later from an error (or lack of one).
    void getMicrophonePermissionState().then((permission) =>
      console.log("[VOICE] microphone permission state", permission)
    );

    // Separate diagnostic from SpeechRecognition itself: getUserMedia exercises
    // only the OS/browser mic-capture path (permission + device), with none of
    // SpeechRecognition's own network dependency on a remote speech service.
    // Failing here points at the mic/OS/permission layer; succeeding here but
    // still getting no STT results points at SpeechRecognition's own service
    // instead. The stream is stopped immediately — this never keeps the mic open.
    if (typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia) {
      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((stream) => {
          const track = stream.getAudioTracks()[0];
          console.log("[VOICE] getUserMedia preflight OK", { label: track?.label, settings: track?.getSettings?.() });
          stream.getTracks().forEach((t) => t.stop());
        })
        .catch((error) => console.warn("[VOICE] getUserMedia preflight FAILED", error?.name, error?.message));
    } else {
      console.warn("[VOICE] getUserMedia not available for preflight check");
    }

    const controller = createSpeechToText({
      onActivity: armWatchdog,
      onResult: (transcript, isFinal) => {
        if (!isFinal) {
          setInterimTranscript(transcript);
          return;
        }

        gotFinalResultRef.current = true;
        sessionEndedRef.current = true;
        clearWatchdog();
        setInterimTranscript("");

        const trimmed = transcript.trim();
        if (!trimmed) {
          setVoiceError(NO_SPEECH_DETECTED_MESSAGE);
          setState("idle");
          return;
        }

        pendingVoiceTurnRef.current = true;
        setState("thinking");
        onFinalTranscript(trimmed);
      },
      onError: (error) => {
        sessionEndedRef.current = true;
        clearWatchdog();

        // Fired by our own stop() calls — expected, not a real failure. Also
        // ignore an error arriving after a final result was already handed
        // off to onFinalTranscript — out-of-spec, but if it happened this
        // must not stomp the "thinking" state a request is now relying on.
        if (error.code === "aborted" || gotFinalResultRef.current) return;

        setVoiceError(error.message);
        setState("idle");
      },
      onEnd: () => {
        sessionEndedRef.current = true;
        clearWatchdog();

        // A final result already moved state on to "thinking" (or, for an
        // empty transcript, already set "idle" with its own message) —
        // onEnd firing right after must not stomp either.
        if (gotFinalResultRef.current) return;

        if (wasManuallyStoppedRef.current) {
          setState("idle");
          return;
        }

        // Recognition ended with neither a result nor an onerror — some
        // browsers do this on plain silence instead of firing "no-speech".
        // Must still explain what happened, not just revert to idle.
        setVoiceError((current) => current ?? NO_SPEECH_DETECTED_MESSAGE);
        setState("idle");
      },
    });

    if (!controller) {
      // createSpeechToText already reported an "unsupported" error.
      setState("idle");
      return;
    }

    sttRef.current = controller;
    setState("listening");
    controller.start();

    // Arms the "nothing happened at all" watchdog; onActivity above re-arms
    // it on real audio activity so a session that's genuinely still being
    // heard isn't killed just for running past this initial timeout.
    armWatchdog();
  }, [state, stopSpeaking, onFinalTranscript, clearWatchdog, armWatchdog]);

  // Speaks the newest assistant reply once the request that pendingVoiceTurnRef
  // marked as voice-originated finishes — mirrors useChat's own isLoading ->
  // messages update ordering (both happen inside the same async callback, so
  // by the time isAssistantResponding flips false the new message is already
  // in `messages`).
  useEffect(() => {
    const justFinished = wasRespondingRef.current && !isAssistantResponding;
    wasRespondingRef.current = isAssistantResponding;

    if (!justFinished || !pendingVoiceTurnRef.current) return;
    pendingVoiceTurnRef.current = false;

    if (hasAssistantError) {
      setState("idle");
      return;
    }

    const latest = messages[messages.length - 1];
    if (!latest || latest.role !== "assistant") {
      setState("idle");
      return;
    }

    if (!support.tts) {
      // Graceful fallback: the text answer is already visible, just nothing
      // to speak it with.
      setState("idle");
      return;
    }

    const controller =
      ttsRef.current ??
      createTextToSpeech({
        onEnd: () => setState("idle"),
        onError: (message) => {
          setVoiceError(message);
          setState("idle");
        },
      });
    ttsRef.current = controller;

    if (!controller) {
      setState("idle");
      return;
    }

    setState("speaking");
    controller.speak(latest.content);
  }, [isAssistantResponding, hasAssistantError, messages, support.tts]);

  // Stop any in-flight listening/speaking if the page unmounts mid-turn.
  useEffect(
    () => () => {
      clearWatchdog();
      sttRef.current?.stop();
      ttsRef.current?.cancel();
    },
    [clearWatchdog]
  );

  const dismissVoiceError = useCallback(() => setVoiceError(null), []);

  return {
    state,
    support,
    interimTranscript,
    voiceError,
    dismissVoiceError,
    startListening,
    stopListening,
    stopSpeaking,
  };
}
