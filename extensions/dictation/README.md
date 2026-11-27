Dictation: a mic button in every prompt box records speech and puts its transcript into that box at the cursor, unsent.

## How it works

- **Click the mic to start or stop.** On touch or pen, hold the mic or tap to toggle, depending on the Talk mode.
  While recording the button becomes Cancel, an elapsed clock and Stop, and the box's bottom hairline shows the
  live voice level. Stop transcribes and inserts at the cursor with spaces as needed, never sending on its own.
  Escape cancels. Recordings stop themselves after 5 minutes.
- **Talk shortcut** (Ctrl/⌘+Shift+Space by default) goes to the focused prompt box. With none focused, it talks to
  Voice if enabled; otherwise it focuses the main composer and dictates there. The cog next to any mic changes
  the page-wide shortcut, Hold/Tap mode (Tap by default) and **Sound cues** (on by default): a soft rising
  tone when recording starts and a falling one when it stops. The tones live in `lib/cues.web.ts`; Voice mode plays the same
  ones under its own Sound cues switch. It also provides the SDK's `DictationShortcut` point (gesture `tap`, keys
  `Ctrl+Shift+Space`), which the main composer's placeholder names; a phone names only the gesture. The three live in
  the user's settings (`~/.ultimate/settings.json`, `"dictation": { "talk", "shortcut", "cues" }`), so every project on
  the machine shares them; the `settings` action reads them with the defaults filled in and `setSettings` writes a change.
- **Recording** uses `MediaRecorder`: `audio/webm` (Opus) in Chrome and Firefox, `audio/mp4` in Safari, including the
  installed iOS home-screen app. The page shares one microphone across prompt boxes and Voice mode. It releases the
  microphone after each recording unless a Voice session is active. The microphone needs a secure page: the tailnet
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
conversation, an `insert` that writes into that same box, a `level` for its hairline and an optional `sink` to receive
microphone takes instead of transcribing and inserting them.
