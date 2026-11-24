Voice input: a mic button in every prompt box records speech and puts its transcript into that box at the cursor, unsent.

## How it works

- **Tap to record, tap to stop.** While recording the button becomes Cancel, an elapsed clock and Stop, and the
  box's bottom hairline shows the live voice level. Stop transcribes; the text is inserted at the cursor with spaces as needed and is never sent on its own, so a
  busy conversation steers or queues it like typed text. Recordings stop themselves after 5 minutes.
- **Recording** uses `MediaRecorder`: `audio/webm` (Opus) in Chrome and Firefox, `audio/mp4` in Safari, including the
  installed iOS home-screen app. The microphone is released after each recording. It needs a secure page: the tailnet
  URL or localhost.
- **Transcription** is the `transcribe` action (`{ audio: base64, mimeType }` → `{ text }`), which posts the audio to
  OpenAI's documented `https://api.openai.com/v1/audio/transcriptions` with `gpt-4o-mini-transcribe`
  (`openaiTranscribe` in `lib/openai.ts` is the one place that knows the endpoint). Recordings up to 8 MB are accepted.
- **Key:** the `OPENAI_API_KEY` secret (⌘K → Secrets), else an API key Pi's `openai` provider holds while it points at OpenAI's own endpoint. The key is never
  logged or returned. Without one, `status` answers `{ available: false, reason }`, the button is dimmed, and tapping it
  opens the secret's row in the Secrets panel.

The ChatGPT login (`openai-codex`) cannot transcribe from a server: `chatgpt.com/backend-api/transcribe` answers every
non-browser request with a Cloudflare challenge (bb hits the same wall), so voice uses the API key instead.

The button is the provider of the SDK's `Dictation` point, which every `PromptBox` renders: the box hands it its
conversation, an `insert` that writes into that same box and a `level` for its hairline.
