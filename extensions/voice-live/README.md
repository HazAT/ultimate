Voice mode: talk into its prompt box, and a fork of @ultimate thinks it through with you, speaks its answer and hands the outcome
back to @ultimate when you agree.

It is off by default. Enable it with `"extensions": { "enable": ["voice-live"] }` in your user or project
`.ultimate/settings.json`. It needs the voice model's login (by default Claude Code's, for
`claude-code/claude-opus-5-5`) and an OpenAI API key for transcription (`OPENAI_API_KEY` in ⌘K → Secrets, the key
dictation uses). The voice prompt box's model and thinking chip picks both: before a session it sets what the next
session starts on (`pick`), in an open session it sets that session's, and the next session starts from the last pick
(`model` and `thinking` in `voice.session`). Without a pick, `"voice": { "model": "provider/model" }` in
`~/.ultimate/settings.json` applies; the thinking level defaults to `low`, and a model without the picked level uses
its closest one. The voice model is a per-project pick: each project's root keeps its own.

The empty voice panel shows this setup as a checklist from `status`: the voice model's login, OpenAI transcription (required) and Jev for hands-free send in
collect mode (optional), each with what to do when it is missing.

## Flow

1. **Open** Voice from the title bar's `voice` button or `Ctrl/⌘+Shift+V`, on any surface. The panel floats over the
   page: drag it by its header, fold it to its prompt box; it says whether the session is hot or cold.
2. **Talk** with the mic in the dock's prompt box, which talks to the voice conversation instead of typing (its
   `dictation` is the voice sink), or use the talk shortcut (`Ctrl/⌘+Shift+Space` by default) while that box is
   focused or no other dictation-enabled prompt box is. The page records Opus; a press cue confirms it hears you, and
   a status line above the box shows the live waveform. Release (or the mic's stop button) sends; its X or Esc
   cancels. A press shorter than 0.6 s or without voice sends nothing. The cog next to the mic changes the shortcut
   and the Hold/Tap setting. With Talk set to **Tap** (for VR controllers and phones), one tap of the shortcut starts
   recording and the next tap sends; closing Voice discards the recording, and a held key's autorepeat never counts
   as a second tap. The status line shows only while voice has something to say: recording, sending, thinking, the
   working line, speaking, an error or collected clips.
3. **The turn**: the recording goes to the server (`record`), which keeps it for the session under
   `<home>/voice/` and starts a durable `voice-live.transcribe` task. Its result lands in the fork's `voice.fork`
   document (`transcripts`, or `failed` with the error), so a reload or restart shows the real state.
   - A model that hears audio (any Gemini model you configure) gets the turn at once: `turn` submits the transcript placeholder as the input,
     and a `beforeRequest` hook adds the recording to that request only. Stored history stays text, so compaction,
     renderers and other models never see audio. The transcript arrives in parallel and shows as your message.
   - Any other model, the default Claude Opus included, waits for that transcript; the turn shows "transcribing…" meanwhile.
   - Typed text, pasted text and pasted or dropped screenshots go through the same `turn`, with Enter in the prompt box.
     A video in the box (pasted, or recorded with its screen-record button) goes with the next spoken or typed turn as its
     `Attached video` line once it is ready, so the fork can ask about it and name its id in a handoff.
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
5. **The transcript** in the panel is the core one (`ConversationTranscript` in its compact `dock` column, scoped to
   the fork), so its own entries show and the history it forked from does not: replies, thinking, every tool call
   with its extension's card (`video_ask` included), attachment chips and message actions all come from the core. Your
   turns are `voice.turn` entries, drawn by voice's one turn renderer wherever the fork is read (the panel, the main
   transcript, a side chat): length and waveform, "transcribing…", a failure, screenshots and "sent as your answer".
   A turn shows the moment you send it: until the server stores it, voice draws it in the fork's `transcript.end`.
6. **Replies** stream from the fork's live partial. Each finished sentence is spoken through read-aloud's page-wide
   speech player (`extensions/read-aloud/README.md`), with the shared Speech setting (voice, speed) that Voice settings
   shows; read-aloud's highlight marks the sentence being read and plays any sentence on click. Starting a read-aloud elsewhere stops voice's reply, and a new voice
   reply stops a read-aloud. The highlight follows the spoken sentence across every message of that turn's reply,
   since a reply with tool calls spans several. Folded, the status line shows the whole paragraph being read with that
   sentence highlighted, and grows to fit it. The playback bar shows the paragraph, sentence and time left, and skips
   by sentence or paragraph; each reply message's speaker plays it again.
7. **Interrupting**: voice never talks over you: a reply that arrives while you hold waits, paused, and no cue plays.
   A press while it speaks pauses at once. With real speech it cuts: speech stops, the running turn is stopped
   (`stop`) and the rest of that reply stays silent. Without speech it resumes where it paused.
8. **The UI and codemode**: voice may use `codemode` (its scripts reach `tools.action`) and a `ui` tool that drives the
   user's own page. `ui {op: query | act | snapshot}` records the request on the fork's `voice.ui` document and parks
   durably; the voice panel in the user's page runs it on the page's ui-sdk bridge (`pageAgent()` from `@/sdk/solid`)
   and answers with `ui-answer`, which signals the parked call with the result. With no answer within 15 s the call
   fails with a clear message. The prompt has voice say each action in one short line before it runs it; the folded
   status line names the call running now.
9. **Handoff**: `voice_handoff {title, outcome, decided, open, instruction, attachments}` submits an input to
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
follow-up; a clip that is only a bare send command leaves the draft, a request to act stays in the message.
When voice's last reply ends with a question (its last paragraph has a `?`), a second call beside it gets that
paragraph as `assistantLastReply` and asks whether the user has finished a clean, complete answer to it; the send
question never sees the reply, since it made borderline command verdicts fire on unfinished clips. A probability of 0.85
or more sends the whole draft as a steer without a command, and the turn shows "sent as your answer". The threshold
was tuned on past voice turns, where answers cut mid-thought stayed below it. Enter in the prompt box, or the box's send and follow-up
buttons, send it too; discard drops it. The collected clips go out as one turn (`clips`): a model that hears audio gets
every recording, a text model their joined transcripts. The panel shows a Collecting box with the clips, their length
and their transcripts so far; folded, the status line shows "N collected".

## Cues

"Transcribing…" and failures show on the turn itself. Soft cues mark press, send, the thinking pulse, the first word,
done and errors; Speak replies and Sound cues are UI state (`ext.voice-live.speak`, `ext.voice-live.cues`).

## Contract

`refs.ts`: `RecordAction`, `TurnAction`, `StopAction`, `EndAction` (user-only), `StatusAction`, `VoiceSessionDoc`
(`voice.session` on the root: the open fork) and the `VoiceTurn` and `VoiceHandoff` entry data.
