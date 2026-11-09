Live voice pairs GPT-Live's audio with a fast Luna agent that decides what to pass to @ultimate.

This built-in is off by default. Enable it with `"extensions": { "enable": ["voice-live"] }` in your user or
project `.ultimate/settings.json`. Its Voice agent loads only while the extension is enabled; user/project agent
overlays still apply.

Nothing is billable until a session starts or the Voice agent receives input. GPT-Live uses `OPENAI_API_KEY` from
Secrets (⌘K → Secrets), or Pi's OpenAI **API key**, never its OAuth login. The key stays on the server. The Voice
agent uses `openai-codex/gpt-6-luna` through Pi's existing ChatGPT login, low thinking and the fast tier.

## Flow

1. The browser acquires the microphone, adds its track to a peer connection and creates `oai-events` before its
   offer. `start` looks up `subagents.standing('voice')` and exchanges SDP through OpenAI's live sessions endpoint
   (`gpt-live-1`, voice `marin`). It seeds at most ten recent Voice lines, each clipped to 200 characters.
2. While the session connects, `start` also puts together Voice's **context brief** in code, without a model
   (`brief.ts`): the project memory a branch starts from (`LineageApi.memoryBrief`), the user's last five requests
   to @ultimate with the first line of each answer, and up to eight open branches with their state. It goes into
   Voice's transcript as a `voice.context` write after the session divider, a quiet folded card ("Context · memory
   N · N recent requests · N open branches") that opens to the text Voice was given. Every session start, a reopen
   after the idle-close included, places a fresh one. Its edit omits the previous brief, so only the newest reaches
   the model; earlier cards stay in the transcript, dimmed. A `heard` line waits for the brief still being put
   together, and the dock says "Loading context…" meanwhile. Briefs are `transient`: lineage leaves them out of
   compaction summaries, and when a compaction cut the newest one, Voice's next request places it again after the
   summary. A brief that fails says so on its card; the session still starts.
3. After `session.started`, remote audio plays through an autoplay element. GPT-Live only listens, backchannels,
   answers connection checks and greetings itself, and speaks received commentary. It never handles work questions
   or decides to delegate; Voice stays silent on the small talk GPT-Live already answered, so a line gets one answer.
4. `Relay` joins transcript fragments after 1,200 ms quiet when the line ends a sentence, 2,800 ms when it trails
   off, so a breath mid-thought does not split it. The transcriber's `[unintelligible]` and `[inaudible]` markers
   become "…". GPT-Live has no transcription, language or turn-detection settings; this is the only place to tune
   it. The line being said grows at the end of Voice's transcript (`transcript.end`) word by word, its start fading
   out toward the top, and stays until its `voice.heard` entry arrives. A spoken Voice line fills in word by word as
   GPT-Live's `output_transcript.delta` reads it out. Every finished user line goes through `heard` as a
   `voice.heard` input to Voice (`whenBusy: 'steer'`). GPT-Live's own speech can be logged as `live` lines;
   commentary output is not logged twice. Delegation events are ignored.
5. `extensions/voice-live/agents/voice.md` configures the standing agent with three deferred tools and codemode:
   - `voice_say {text}` writes an `ultimate` `voice.line` with `speech: true`. The browser sends it as commentary.
   - `voice_ask_ultimate {request}` writes a forwarded user line and schedules the durable answer task. It answers
     @ultimate's newest open question through Messages, or submits a typed `voice.utterance` with the clean request.
     The task follows that specific input receipt, including Messages delivery, not idle or an arbitrary delay.
   - `voice_note {text}` writes a quiet `note` line, forwarded by the browser as `session.thinking.append`.
     Tool names are prefixed to avoid colliding with other agents' tools (especially lineage's `note`).
   - `codemode` answers status questions (what is running, did something land, open to-dos) with one script of
     `ultimate.*` reads, then `voice_say`, without an @ultimate turn. It stays read-only by instruction, not by a
     code guard: the definition tells Voice never to start, change, message or write anything, and to pass
     anything that needs doing or judgement, or that it is unsure about, to @ultimate.
6. The answer task sends @ultimate's full answer back as a `voice.answer` input to Voice. A tool-terminated message
   uses its user-facing text and numbered questions/options. Voice speaks the conclusion in 2–4 short sentences,
   preserving decisions without reading Markdown, paths or code aloud. There is no summary-model speech rewrite.
   Failed/unanswered inputs leave a notice linked to the forwarded line and tell Voice to explain the failure.
   `voice_say` derives `re` from the input preceding its own tool round, so speech answers the right forwarded line.
   Request ids and a transactional scheduling receipt keep forwards and answer delivery safe across task replay.

## Browser and transcript

`Standing.voice` is the only Voice conversation index. Its `Unlisted` provider removes it from other sidebar lists;
the Voice row nests under @ultimate. The dock under the transcript says what is happening now in large words: connecting,
listening, hearing the user, Voice deciding, @ultimate on a request (its phase and time), an answer ready, speaking.
Each forwarded request is one @ultimate message card (`Bubble` from messages): what was asked, then working (the
sidebar's phase and elapsed time), then the spoken answer, unfolding to @ultimate's full answer (`voice.answer`, whose
`source` is the answer entry) with Open in @ultimate; a notice turns it failed. Heard lines and Voice's own small
talk stay quiet, tool cards are hidden and ordinary agent prose is quiet.

Collapse (or Alt+V) sends Voice back without stopping it: on @ultimate's conversation a small card at the top right
(full width under the header on phones) shows the step and the words being heard, with Mute, End and expand. Elsewhere
the title-bar pill says voice is live; on @ultimate the card replaces it, so there is one indicator at a time.

Voice mode outlasts individual sessions. After two quiet minutes the session closes and listening pauses; an answer
wakes it (or waits for a tap if browser activation blocks it). A pending forwarded request gets a short “Still on it”
after 20 seconds, then every 45 seconds. Acknowledgements do not clear that pending state. Mute, End, the level meter,
front/back sheet and tones remain browser-side: a quiet pulsing hum while connecting, stopped by any phase change
(the ready tone, a low failed tone, End, page hide), and ready/pause/end tones. Closing waits for `session.closed`, records usage
seconds and releases the microphone even on failure. No session survives its page.

`extensions/voice-live/test/voice-live.test.ts` exercises the agent/Ultimate round trip with faux models, including spoken question answers.
`extensions/voice-live/test/voice-live-relay.test.ts` exercises quiet-line joining, commentary suppression and idle tracking with a supplied
clock. Neither contacts OpenAI.
