Read aloud: the page's one speech player, and a speaker on each agent message's action row that plays the whole answer,
lightly rewritten for listening.

## How it works

- **The player** (`speech.ts`, `voice.solid.tsx`) is one per page and keyed by source: `load(key, …)` stops whatever
  plays, and sentences pushed for another key are ignored. It plays sentence by sentence, also while a reply still
  streams, keeps a word clock, learns how fast each speed really speaks, waits until idle, steps by sentence or
  paragraph. A source can pass a hold (voice passes its own microphone): a sentence that would start then waits,
  paused, for that source to resume it. Voice mode and the speaker both play through it;
  `ui.solid.tsx` is the contract other extensions use.
- **The voices:** the browser's `speechSynthesis`, or OpenAI's Realtime `gpt-realtime-2.1-mini` through the `speak`
  action (`openai-voice.ts`), with the `OPENAI_API_KEY` secret or an API key Pi's `openai` provider holds. The OpenAI
  voice fetches each sentence clause by clause and the next sentence while one plays; stopping aborts every request in
  flight, which cancels its response.
- **The Speech setting** is shared by read-aloud and voice: voice (OpenAI by default when a key is set, else the
  system voice), the OpenAI voice (cedar by default) and the speed (1.1× by default), in UI state
  `ext.read-aloud.voice`, `ext.read-aloud.openai-voice` and `ext.read-aloud.rate`. Voice settings shows them all;
  the reading strip cycles the speed.
- **The button** sits in the hover action row of agent answers and message cards (`messageActions`), between Go back
  and Copy reference; user messages get none. While its message plays it turns into pause.
- **The rewrite** keeps the full text: every sentence and point, in order. The summary model (`summaryModel`, see
  `docs/settings.md`) only drops what does not work heard (code blocks, paths, URLs, shas, `#123` ids, Markdown and
  table marks) and turns list bullets into sentences. Without a summary model, or when its answer is cut off, empty or
  far shorter than the text, a plain strip in code (`text.ts`) is read instead. The `prepare` action
  (`{ text, section }`) splits the message into sections, a short first one so audio starts quickly, and returns one
  rewritten section; the speaker streams each section's sentences into the player as it arrives. The last 200
  sections are cached in memory, so a replay is quick; a restart clears it.
- **The strip** above the composer shows Preparing, Reading or Paused with a link to the message
  (`#conversation/entry`, which opens and scrolls to it), the speed, pause and stop. It keeps playing when you switch
  conversations. On phones the Media Session API gives lock-screen pause and stop.
