Voice input: a mic button beside Send records speech and puts its transcript into the draft at the cursor, unsent.

## How it works

- **Tap to record, tap to stop**, or `mod+shift+v` (the `voice.toggle` command): the shortcut drives the same
  recorder the button does, works while typing in the composer, and is hidden where no composer offers voice. While
  recording the button becomes Cancel, an elapsed clock with a level meter, and Stop; Escape cancels while idle.
  Stop transcribes; the text is inserted at the cursor with spaces as needed and is never sent on its own, so a
  busy conversation steers or queues it like typed text. Recordings stop themselves after 10 minutes.
- **Recording** uses `MediaRecorder`: `audio/webm` (Opus) in Chrome and Firefox, `audio/mp4` in Safari, including the
  installed iOS home-screen app. The microphone is released after each recording. It needs a secure page: the tailnet
  URL or localhost.
- **Transcription** is the `transcribe` action (`{ audio: base64, mimeType }` → `{ text }`), which posts the audio to
  OpenAI's documented `https://api.openai.com/v1/audio/transcriptions` with `gpt-4o-mini-transcribe`
  (`openaiTranscribe` in `server.ts` is the one place that knows the endpoint). Recordings up to 8 MB are accepted.
- **Key:** the `OPENAI_API_KEY` secret (⌘K → Secrets), else an API key Pi's `openai` provider holds. The key is never
  logged or returned. Without one, `status` answers `{ available: false, reason }`, the button is dimmed, and tapping it
  opens the secret's row in the Secrets panel.

The ChatGPT login (`openai-codex`) cannot transcribe from a server: `chatgpt.com/backend-api/transcribe` answers every
non-browser request with a Cloudflare challenge (bb hits the same wall), so voice uses the API key instead.

The button lives in the generic `composer.actions` slot and writes with the SDK's `insertIntoComposer`.
