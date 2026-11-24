Voice mode: hold to talk, and a fork of @ultimate thinks it through with you, speaks its answer and hands the outcome
back to @ultimate when you agree.

It is off by default. Enable it with `"extensions": { "enable": ["voice-live"] }` in your user or project
`.ultimate/settings.json`. It needs the voice model's login (by default Antigravity, `agy`, for
`antigravity/gemini-4-neon-low`) and an OpenAI API key for transcription (`OPENAI_API_KEY` in ⌘K → Secrets, the key
dictation uses). Pick another model with `"voice": { "model": "provider/model" }` in `~/.ultimate/settings.json`.

The empty voice panel shows this setup as a checklist from `status`: the voice model's login (Gemini 4 Neon through
Antigravity recommended, since it hears the recording), OpenAI transcription (required) and Jev for hands-free send in
collect mode (optional), each with what to do when it is missing.

## Flow

1. **Open** Voice from the title bar's `voice` button or `Ctrl/⌘+Shift+V`, on any surface. The panel floats over the
   page: drag it by its header, fold it to a one-line talk bar; it says whether the session is hot or cold.
2. **Hold** the talk bar, or the talk shortcut (`Ctrl/⌘+Shift+Space`, set in Voice settings) from anywhere. It is the
   only key that talks, so Space always types. The page records Opus with a live waveform; a press cue confirms it
   hears you. Release sends. A press shorter than 0.6 s or without voice sends nothing. With Talk set to **Tap** in
   Voice settings (for VR controllers and phones), one tap of the bar or the shortcut starts recording and the next
   tap sends; the bar says "tap to send" while it records, closing Voice discards the recording, and a held key's autorepeat never counts as a second tap.
3. **The turn**: the recording goes to the server (`record`), which keeps it for the session under
   `<home>/voice/` and starts a durable `voice-live.transcribe` task. Its result lands in the fork's `voice.fork`
   document (`transcripts`, or `failed` with the error), so a reload or restart shows the real state.
   - A model that hears audio (Gemini) gets the turn at once: `turn` submits the transcript placeholder as the input,
     and a `beforeRequest` hook adds the recording to that request only. Stored history stays text, so compaction,
     renderers and other models never see audio. The transcript arrives in parallel and shows as your message.
   - Any other model waits for that transcript; the trace shows the transcribe stage on the critical path.
   - Typed text, pasted text and pasted or dropped screenshots go through the same `turn`, with Enter in the prompt box.
4. **The session** is a fork of @ultimate, made on the first turn from its last finished answer, like a side chat:
   ownerless, its automatic summaries off. Every fork is recorded in `voice.session` `forks` and kept out of the
   sidebar's lists (`Unlisted`); while a session is open, one live row under @ultimate (`UnderUltimate`) shows it
   instead, with a small level that follows the mic while you talk and sways while voice speaks; clicking it shows or
   hides the panel. It keeps the fork's tools and adds
   `voice_handoff` and `ui`; `beforeTool` lets it only read (read, memory, web search and fetch), run codemode, drive the UI and hand off: no bash, no file edits.
   Its first input carries the voice-mode prompt (`prompt.ts`) as a hidden `conversations.identity` entry; each later
   input carries a short digest of what @ultimate did since the last turn, and every turn says which surface and
   conversation are on screen. The session stays hot until it hands off or End: after a handoff the next turn
   concludes it and forks @ultimate afresh; End concludes it and deletes the session's recordings.
5. **Replies** stream from the fork's live partial. Each finished sentence is spoken by the browser's
   `speechSynthesis` at the chosen speed, and the sentence being read is highlighted: word timing from the browser's
   voices is too unreliable to follow word by word. Voice settings → Voice switches to OpenAI (UI state
   `ext.voice-live.voice`, the voice in `ext.voice-live.openai-voice`, cedar by default; it needs `OPENAI_API_KEY`).
   Then `speak` reads each sentence on the server through one Realtime connection to `gpt-realtime-2.1-mini`, which
   the first turn opens early, and returns WAV the page plays at the chosen speed. While one sentence plays the next
   is already being read; a cut-in pauses the audio and aborts every request in flight, which cancels its response. Folded, the talk bar shows the whole paragraph being read with that
   sentence highlighted, and grows to fit it. The playback bar shows the paragraph, sentence and time left, and skips by sentence or paragraph; any
   sentence plays on click and each reply has replay. Thinking shows open while the model thinks, with a token count
   in the trace, and folds once the reply has played.
6. **Interrupting**: voice never talks over you: a reply that arrives while you hold waits, paused, and no cue plays.
   A press while it speaks pauses at once. With real speech it cuts: the reply is marked where you
   cut in, the running turn is stopped (`stop`), and the next turn carries a hint of what was played and what was not.
   Without speech it resumes where it paused.
7. **The UI and codemode**: voice may use `codemode` (its scripts reach `tools.action`) and a `ui` tool that drives the
   user's own page. `ui {op: query | act | snapshot}` records the request on the fork's `voice.ui` document and parks
   durably; the voice panel in the user's page runs it on the page's ui-sdk bridge (`pageAgent()` from `@/sdk/solid`)
   and answers with `ui-answer`, which signals the parked call with the result. With no answer within 15 s the call
   fails with a clear message. The prompt has voice say each action in one short line before it runs it, and the reply
   lists every tool call it made, each with a checkmark.
8. **Handoff**: `voice_handoff {title, outcome, decided, open, instruction, attachments}` submits an input to
   @ultimate with a `voice.handoff` entry, shown there as a card that links back to the voice session. With
   `attachments`, the images the user pasted into the session's turns (the latest four) go along with it. With `to`, it
   goes to the branch conversation on the user's screen instead (each turn records it as the fork's `screen`), as a
   steer a busy coordinator reads after its current tool round; a conversation that is not on screen, a subagent, a root, @ultimate itself or a concluded one is refused.

## Collect until send

A setting (Voice settings → Collect until send, UI state `ext.voice-live.collect`) keeps every recording instead of
sending it. `record` with `collect` appends the clip to the fork's `voice.fork` `draft`, so the collection survives a
reload, and each clip is transcribed as usual. After each clip, `intent` asks Jev (classify) whether the latest
recording hands the message over: a send command ("send it", "go") or a turn to voice to act on it ("let's
brainstorm this", "let's think it through", "what do you think?") sends it as a steer, "follow up" or "queue it" as a
follow-up; a clip that is only a bare send command leaves the draft, a request to act stays in the message. Enter in the prompt box, or the box's send and follow-up
buttons, send it too; discard drops it. The collected clips go out as one turn (`clips`): a model that hears audio gets
every recording, a text model their joined transcripts. The panel shows a Collecting box with the clips, their length
and their transcripts so far; folded, the talk bar shows "N collected" and the phone button a count badge.

## Trace and cues

Every turn has a stage trace under it: mic, transcribe (only when the model waits for it), send, model, thinking with
its token count, voice; each finished stage gets a checkmark. Once heard, it folds to "✓ heard after X s" (release to
the first spoken word). Slow stages turn amber, failures red. Soft cues
mark press, send, each finished stage, the thinking pulse, the first word, done and errors; the speak, cues and speed
settings live in the UI state `ext.voice-live.settings`.

## Contract

`refs.ts`: `RecordAction`, `TurnAction`, `StopAction`, `EndAction` (user-only), `StatusAction`, `VoiceSessionDoc`
(`voice.session` on the root: the open fork) and the `VoiceTurn` and `VoiceHandoff` entry data.
