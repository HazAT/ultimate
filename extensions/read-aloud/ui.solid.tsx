/**
 * Read aloud's speech for other extensions' browser code: the one page-wide player, keyed by source so starting one
 * stops the other, with the shared Speech setting (voice, OpenAI voice, speed), and the sentence splitting it plays.
 */

/**
 * The page's one speech player. `load(key, sentences, streaming, hold?)` takes over from whatever plays; `push(key, sentence)`
 * adds a streamed sentence for that key only; `streaming(false)` ends the stream; `pause`, `resume`, `stop`, `toggle`,
 * `play(index)`, `sentence(step)`, `paragraph(step)`; `state` (a cell: `key`, `index`, `charIndex`, `playing`,
 * `paused`, `blocked`, `streaming`) and `items()`; `idle()` resolves once it is done or another source took over. A source may
 * pass `hold` to `load`: while it returns true, a sentence that would start waits paused for that source's `resume`. `voice`, `openaiVoice`, `rate` and their setters are the shared Speech setting;
 * `setKeyed` records whether the OpenAI voice has a key; `warm()` opens its connection early; `failure` holds the last
 * error with the key it stopped.
 */
export { speech } from './voice.solid.tsx'
/** What to show while `state().blocked`: the browser refused to play sound before a tap; the player waits paused for `resume` or `toggle`. */
export { BLOCKED as SOUND_BLOCKED } from './voice.solid.tsx'
/** The page's speech player and its settings. */
export type { Speech } from './voice.solid.tsx'
/** Split streamed reply parts, or one text, into sentences with their paragraphs; `estimate` gives a sentence's seconds. */
export { estimate, splitReply, splitSentences } from './speech.web.ts'
/** One spoken sentence: its text, paragraph, word starts and its place in its reply (`at`). */
export type { Sentence } from './speech.web.ts'
/**
 * Mark what the player speaks in a rendered message: `useSpokenText(elements, spoken)` with the message's root elements
 * (one message, or every message of a reply in order) and, while it has a source, `{ key, spans, span?, play? }`.
 * `spans` are the message's parts in order (its sentences, or its sections), found in the elements' text: each one's
 * `.markdown` blocks when it has any, else all of it. Changes under the elements' parents find them again.
 * `span(item)` maps the player's item to a span, by default the sentence's place in its reply (`Sentence.at`). The span
 * being spoken carries the `read-aloud` CSS highlight; with `play`, a click on a span calls `play(span)` while
 * the player holds this source (its bar shows), never to start one.
 */
export { useSpokenText } from './spoken.solid.tsx'
/** What a message being read gives the highlight. */
export type { SpokenText } from './highlight.web.ts'
/**
 * The one playback bar for the page's player: `status` (Speaking, Reading, Paused…), then paragraph, sentence and time
 * left, the speed, skip by paragraph or sentence, `toggle` (pause or resume), and `stop` when given. `onShow` makes the
 * status a link to the source; `loading` shows a spinner on the toggle; `error` colours the icon and titles the bar; `name`,
 * where it shows, names its controls apart from another bar beside it (`Pause speech in Voice dock`).
 */
export { PlaybackBar } from './bar.solid.tsx'
/**
 * The speaker's bar while it reads a message, for a box that hides the composer's own (the voice panel); `name` names
 * its controls apart from the composer's.
 */
export { SpeakerBar } from './reading-bar.solid.tsx'
/**
 * The Speech setting's controls (Voice, OpenAI voice, Speed), for a settings popover that shows them among its own;
 * `name`, where they show, names them apart from another copy on the page. The playback bar opens the same controls from its speed.
 */
export { SpeechOptions } from './options.solid.tsx'
