Voice input: a mic button beside Send records speech and puts its transcript into the draft at the cursor, unsent.

## How it works

- **Tap to record, tap to stop.** While recording the button becomes Cancel, an elapsed clock with a level meter, and
  Stop. Stop transcribes; the text is inserted at the cursor with spaces as needed and is never sent on its own, so a
  busy conversation steers or queues it like typed text. Recordings stop themselves after 10 minutes.
- **Recording** uses `MediaRecorder`: `audio/webm` (Opus) in Chrome and Firefox, `audio/mp4` in Safari, including the
  installed iOS home-screen app. The microphone is released after each recording. It needs a secure page: the tailnet
  URL or localhost.
- **Transcription** is the `transcribe` action (`{ audio: base64, mimeType }` → `{ text }`). `server.ts` is the one
  place that knows both endpoints: the ChatGPT login posts to `https://chatgpt.com/backend-api/transcribe` with
  `gpt-transcribe`, an API key to OpenAI's documented `https://api.openai.com/v1/audio/transcriptions` with
  `gpt-4o-mini-transcribe`. Recordings up to 8 MB are accepted.
- **Credentials, best first:** the ChatGPT login Pi holds (`openai-codex`, Pi refreshes it), which spends no API
  credits; then an OpenAI API key: the `OPENAI_API_KEY` secret (⌘K → Secrets), else an API key Pi's `openai` provider
  holds. Both stay on the server and are never logged or returned: the browser sends the recording and reads the text.
  A credential OpenAI refuses (an invalid login, a Cloudflare challenge, a rate limit) passes over to the next one, so a
  key with credits still transcribes when the login is spent. Without either, `status` answers
  `{ available: false, reason }`, the button is dimmed, and tapping it opens the secret's row in the Secrets panel.

`chatgpt.com/backend-api/transcribe` is ChatGPT's own endpoint, not a documented API, and the Cloudflare in front of it
can answer a session it dislikes with a challenge; the API key stays the documented path. Live voice is different: the
login is refused for OpenAI's live sessions (`HTTP 403 Voice session access denied.`), so `voice-live` needs the key.

The button lives in the generic `composer.actions` slot and writes with the SDK's `insertIntoComposer`.
