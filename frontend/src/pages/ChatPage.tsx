import { useEffect, useRef } from "react";

import { ChatHeader } from "../components/ChatHeader";
import { ChatInput } from "../components/ChatInput";
import { ChatMessage } from "../components/ChatMessage";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { TypingIndicator } from "../components/TypingIndicator";
import { VoiceControls } from "../components/VoiceControls";
import { useChat } from "../hooks/useChat";
import { useVoice } from "../hooks/useVoice";

export function ChatPage() {
  const { messages, isLoading, error, send, retry, clear, dismissError } = useChat();
  const voice = useVoice({
    onFinalTranscript: send,
    isAssistantResponding: isLoading,
    hasAssistantError: error !== null,
    messages,
  });
  const bottomRef = useRef<HTMLDivElement>(null);

  // Keep the newest message, the typing indicator and any error in view.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isLoading, error]);

  const hasMessages = messages.length > 0;
  // The streaming assistant bubble already shows progress once it exists —
  // showing the typing dots underneath it too would be redundant. Only show
  // them until the first token creates that bubble (useChat holds citations
  // back until then).
  const isStreamingReply = isLoading && messages[messages.length - 1]?.role === "assistant";

  return (
    <div className="flex h-full justify-center bg-slate-100">
      <div className="flex h-full w-full max-w-3xl flex-col bg-white shadow-sm sm:my-4 sm:h-[calc(100%-2rem)] sm:rounded-2xl sm:border sm:border-slate-200">
        <ChatHeader onClear={clear} canClear={hasMessages || isLoading} />

        <main className="flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          {hasMessages ? (
            <div className="flex flex-col gap-5">
              {messages.map((message) => (
                <ChatMessage key={message.id} message={message} />
              ))}

              {isLoading && !isStreamingReply && <TypingIndicator />}

              {error && (
                <ErrorBanner
                  error={error}
                  onRetry={retry}
                  onDismiss={dismissError}
                  isLoading={isLoading}
                />
              )}
            </div>
          ) : (
            <div className="flex h-full flex-col justify-center">
              <EmptyState onExampleClick={send} disabled={isLoading} />

              {error && (
                <div className="mt-4">
                  <ErrorBanner
                    error={error}
                    onRetry={retry}
                    onDismiss={dismissError}
                    isLoading={isLoading}
                  />
                </div>
              )}
            </div>
          )}

          <div ref={bottomRef} />
        </main>

        <VoiceControls
          state={voice.state}
          support={voice.support}
          interimTranscript={voice.interimTranscript}
          voiceError={voice.voiceError}
          onDismissVoiceError={voice.dismissVoiceError}
          onStartListening={voice.startListening}
          onStopListening={voice.stopListening}
          onStopSpeaking={voice.stopSpeaking}
          disabled={isLoading}
        />
        <ChatInput onSend={send} disabled={isLoading} />
      </div>
    </div>
  );
}
