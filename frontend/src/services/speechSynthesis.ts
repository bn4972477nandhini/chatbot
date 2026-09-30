/**
 * Thin wrapper around the browser's native Web Speech API
 * (window.speechSynthesis). Mirrors speechRecognition.ts's shape so a future
 * cloud TTS provider (e.g. a server-side voice endpoint returning audio to
 * play) can be swapped in behind the same `TextToSpeechController` interface
 * without changing `useVoice` or any component.
 */

export interface TextToSpeechCallbacks {
  onEnd: () => void;
  onError: (message: string) => void;
}

export interface TextToSpeechController {
  speak: (text: string) => void;
  cancel: () => void;
}

export function isTextToSpeechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/**
 * Creates one text-to-speech controller bound to the given callbacks. Safe to
 * create once and reuse across multiple `speak` calls — unlike
 * SpeechRecognition, SpeechSynthesis does not need a fresh instance per turn.
 */
export function createTextToSpeech(callbacks: TextToSpeechCallbacks): TextToSpeechController | null {
  if (!isTextToSpeechSupported()) {
    callbacks.onError("Voice output isn't supported in this browser.");
    return null;
  }

  const synth = window.speechSynthesis;

  return {
    speak: (text: string) => {
      // Never overlap two utterances — a fresh answer always replaces
      // whatever is (or was queued to be) spoken before it.
      synth.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.onend = () => callbacks.onEnd();
      utterance.onerror = (event) => {
        // "interrupted" and "canceled" fire from our own cancel()/stop() calls
        // — expected, not a real failure to surface.
        if (event.error === "interrupted" || event.error === "canceled") {
          callbacks.onEnd();
          return;
        }
        callbacks.onError("Could not play the voice response.");
      };

      synth.speak(utterance);
    },
    cancel: () => synth.cancel(),
  };
}
