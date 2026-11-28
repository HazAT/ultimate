Read aloud: the page's one speech player, and a speaker on each agent message's action row that plays the whole answer,
lightly rewritten for listening.

## How it works

- **The player** (`speech.ts`, `voice.solid.tsx`) is one per page and keyed by source: `load(key, …)` stops whatever
  plays (loading the same key again only replaces its queue, so a seek keeps its `idle()` waiters), and sentences pushed for another key are ignored. It plays sentence by sentence, also while a reply still
  streams, keeps a word clock, learns how fast each speed really speaks, waits until idle, steps by sentence or
  paragraph. A source can pass a hold (Side chat holds playback while it records): a sentence that would start then waits,
  paused, for that source to resume it. Side chat and the speaker both play through it;
  `ui.solid.tsx` is the contract other extensions use.
- **The voices:** the browser's `speechSynthesis`, or OpenAI's Realtime `gpt-realtime-2.1-mini` through the `speak`
  action (`openai-voice.ts`), with the `OPENAI_API_KEY` secret or an API key Pi's `openai` provider holds. The OpenAI
  voice fetches each sentence clause by clause and the next sentence while one plays; stopping aborts every request in
  flight, which cancels its response. Other extensions can `want(ReadAloudApi)` (`api.ts`) and call
  `speak(text, voice, signal)` for 24 kHz mono PCM16 (`undefined` without a key). It shares the action's connection,
  key lookup and instructions; the action wraps the PCM in WAV for the player. For browser speech,
  `speakSystem(text)` (`ui.solid.tsx`) queues the default system voice without cancelling speech already playing,
  and resolves on end or error. The narrator uses both contracts.
- **The Speech setting** is shared by read-aloud and Side chat: voice (OpenAI by default when a key is set, else the
  system voice), the OpenAI voice (cedar by default) and the speed (1.1× by default), in UI state
  `ext.read-aloud.voice`, `ext.read-aloud.openai-voice` and `ext.read-aloud.rate`. Read aloud owns their controls
  (`SpeechOptions`, `options.solid.tsx`): the playback bar's speed opens them in a small popover, and Side chat settings
  shows the same component.
- **The button** sits in the hover action row of agent answers and message cards (`messageActions`), between Go back
  and Copy reference; user messages get none. While its message plays it turns into pause.
- **The rewrite** keeps the full text: every sentence and point, in order. The summary model (`summaryModel`, see
  `docs/settings.md`) only drops what does not work heard (code blocks, paths, URLs, shas, `#123` ids, Markdown and
  table marks) and turns list bullets into sentences. Without a summary model, or when its answer is cut off, empty or
  far shorter than the text, a plain strip in code (`text.ts`) is read instead. The `prepare` action
  (`{ text, section }`) splits the message into sections, a short first one so audio starts quickly, and returns one
  rewritten section; the speaker streams each section's sentences into the player as it arrives. The last 200
  sections are cached in memory, so a replay is quick; a restart clears it.
- **The highlight** (`highlight.ts`, `useSpokenText` in `ui.solid.tsx`) marks the part being spoken in any message,
  with the CSS Custom Highlight API: no wrappers in the message's DOM. A message gives its root elements (one, or every
  message of a Side chat reply in order) and its parts in order; each part is found in the rendered text by its letters and digits, so Markdown marks, links and list
  bullets do not matter, and found again whenever the message's DOM changes (while it streams). Side chat replies are
  spoken as written, so their parts are sentences, and the player's sentence maps to its place in the reply
  (`Sentence.at`), which stays right when sentences were skipped (Speak replies turned on mid-reply). The speaker's rewrite changes the
  words, so its parts are the `prepare` sections and the player's sentence maps to the section it came from. While the
  player holds a message (its bar shows), a click on one of its parts plays from there; the speaker prepares from
  that section when it was not read yet. A click never starts reading. Code blocks, tool calls and anything `not-prose` are skipped.
- **The playback bar** (`bar.solid.tsx`) is the one bar for the player, shared with Side chat: Preparing, Reading,
  Speaking or Paused, then paragraph, sentence and time left, the speed (it opens the Speech settings), skip by paragraph or sentence, pause and
  stop, with a progress line. Above the main composer its status opens and scrolls to the message being read; a
  redirected composer shows none; the open Side chat panel shows its own bar, or the speaker's
  (`SpeakerBar`, with Stop and Resume) while the speaker prepares, reads or failed.
  Skips stay off after a failure (Resume retries). It keeps playing when you switch
  conversations. On phones the Media Session API gives lock-screen pause and stop.
