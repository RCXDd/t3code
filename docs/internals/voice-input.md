# Voice input

Transcription edits a composer draft. It does not submit an agent turn. Audio is
temporary client input, and only normal message submission sends the resulting
text. Supported iOS devices can transcribe locally; every client can transcribe
through the environment when it has a speech-to-text service configured.

The [shared controller](../../packages/client-runtime/src/voice-input/controller.ts)
owns the operation while the client supplies capture and transcription. Preparation
binds the transcriber and resolved locale for the whole recording. Draft ownership,
text, and revision are captured before recording and checked before insertion, so
a late transcript cannot overwrite a draft that was edited or replaced.

Cancellation invalidates a result immediately, but resources stay owned until the
underlying work settles. Apple's native transcription call cannot be interrupted
once started. Releasing the session or deleting its recording when the abort signal
fires would race that work. The [transcription contract](../../packages/client-runtime/src/voice-input/transcription.ts)
therefore requires implementations to settle only after their work has stopped;
the [Apple binding](../../apps/mobile/src/native/voiceTranscription.ios.ts) checks
cancellation between native calls and discards late results.

## Environment transcription

The service and its API key are environment settings, not client preferences: the
key must stay in the environment's secret store, and the environment, not each
device, is what reaches the provider. Clients never see the key, only the
redaction marker, so they offer dictation from
[`isSpeechToTextConfigured`](../../packages/contracts/src/speechToText.ts) plus the
`speechToText` capability.

Recordings do not travel over the WebSocket. A client mints a short-lived signed
upload URL with `speechToText.createUploadUrl`, then POSTs the bytes to
[the route](../../apps/server/src/speechToText/SpeechToTextRoute.ts), which forwards
them to the provider and answers with the transcript. The URL is the credential,
as with attachment uploads, so the same request works for local, remote, and
relayed connections without each client building auth headers. The claims pin
the size and MIME type, and the route caps the body at that size.

Cleanup runs on the server after transcription, inside the same request, so every
client gets it without another round trip. It is best-effort: a failed or empty
rewrite returns the raw transcript with `cleanupError` rather than failing the
dictation. Thread context goes only to tool-free chat completions models: agent
CLIs used as text generation models keep read and shell tools even in their
read-only modes, and the context can contain agent and tool output, so a prompt
label alone is not a boundary there.
