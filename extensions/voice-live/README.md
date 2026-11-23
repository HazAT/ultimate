Voice mode: hold to talk, and a fork of @ultimate thinks it through with you, speaks its answer and hands the outcome
back to @ultimate when you agree.

It is off by default. Enable it with `"extensions": { "enable": ["voice-live"] }` in your user or project
`.ultimate/settings.json`. It needs the voice model's login (by default Antigravity, `agy`, for
`antigravity/gemini-4-neon-low`) and an OpenAI API key for transcription (`OPENAI_API_KEY` in ⌘K → Secrets, the key
dictation uses). Pick another model with `"voice": { "model": "provider/model" }` in `~/.ultimate/settings.json`.

## Flow

1. **Open** Voice from the title bar's `voice` button or `Ctrl/⌘+Shift+V`, on any surface. The panel floats over the
   page: drag it by its header, fold it to a one-line talk bar; it says whether the session is hot or cold.
2. **Hold** the talk bar, or the talk shortcut (`Ctrl/⌘+Shift+Space`, set in Voice settings) from anywhere. It is the
   only key that talks, so Space always types. The page records Opus with a live waveform; a press cue confirms it
   hears you. Release sends. A press shorter than 0.6 s or without voice sends nothing.
3. **The turn**: the recording goes to the server (`record`), which keeps it for the session under
   `<home>/voice/` and starts a durable `voice-live.transcribe` task. Its result lands in the fork's `voice.fork`
   document (`transcripts`, or `failed` with the error), so a reload or restart shows the real state.
   - A model that hears audio (Gemini) gets the turn at once: `turn` submits the transcript placeholder as the input,
     and a `beforeRequest` hook adds the recording to that request only. Stored history stays text, so compaction,
     renderers and other models never see audio. The transcript arrives in parallel and shows as your message.
   - Any other model waits for that transcript; the trace shows the transcribe stage on the critical path.
   - Typed text, pasted text and pasted or dropped screenshots go through the same `turn`, with Enter in the prompt box.
4. **The session** is a fork of @ultimate, made on the first turn from its last finished answer, like a side chat:
   ownerless, its automatic summaries off, out of the sidebar's lists. It keeps the fork's tools and adds
   `voice_handoff`; `beforeTool` lets it only read (read, bash for reading, memory, web search and fetch) and hand off.
   Its first input carries the voice-mode prompt (`prompt.ts`) as a hidden `conversations.identity` entry; each later
   input carries a short digest of what @ultimate did since the last turn, and every turn says which surface and
   conversation are on screen. The session stays hot until it hands off or End: after a handoff the next turn
   concludes it and forks @ultimate afresh; End concludes it and deletes the session's recordings.
5. **Replies** stream from the fork's live partial. Each finished sentence is spoken by the browser's
   `speechSynthesis` at the chosen speed and highlighted word by word (word events, or an estimate when the voice sends
   none). The playback bar shows the paragraph, sentence and time left, and skips by sentence or paragraph; any
   sentence plays on click and each reply has replay. Thinking shows open while the model thinks, with a token count
   in the trace, and folds once the reply has played.
6. **Interrupting**: voice never talks over you: a reply that arrives while you hold waits, paused, and no cue plays.
   A press while it speaks pauses at once. With real speech it cuts: the reply is marked where you
   cut in, the running turn is stopped (`stop`), and the next turn carries a hint of what was played and what was not.
   Without speech it resumes where it paused.
7. **Handoff**: `voice_handoff {title, outcome, decided, open, instruction, attachments}` submits an input to
   @ultimate with a `voice.handoff` entry, shown there as a card that links back to the voice session. With `to`, it
   goes to the branch conversation on the user's screen instead (each turn records it as the fork's `screen`); a
   conversation that is not on screen, a subagent, a root, @ultimate itself or a concluded one is refused.

## Trace and cues

Every turn has a stage trace under it: mic, transcribe (only when the model waits for it), send, model, thinking with
its token count, voice; each finished stage gets a checkmark. Once heard, it folds to "✓ heard after X s" (release to
the first spoken word). Slow stages turn amber, failures red. Soft cues
mark press, send, each finished stage, the thinking pulse, the first word, done and errors; the speak, cues and speed
settings live in the UI state `ext.voice-live.settings`.

## Contract

`refs.ts`: `RecordAction`, `TurnAction`, `StopAction`, `EndAction` (user-only), `StatusAction`, `VoiceSessionDoc`
(`voice.session` on the root: the open fork) and the `VoiceTurn` and `VoiceHandoff` entry data.
