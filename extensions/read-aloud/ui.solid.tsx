/**
 * Read aloud's speech for other extensions' browser code: the one page-wide player, keyed by source so starting one
 * stops the other, with the shared Speech setting (voice, OpenAI voice, speed), and the sentence splitting it plays.
 */

/**
 * The page's one speech player. `load(key, sentences, streaming, hold?)` takes over from whatever plays; `push(key, sentence)`
 * adds a streamed sentence for that key only; `streaming(false)` ends the stream; `pause`, `resume`, `stop`, `toggle`,
 * `play(index)`, `sentence(step)`, `paragraph(step)`; `state` (a cell: `key`, `index`, `charIndex`, `playing`,
 * `paused`, `streaming`) and `items()`; `idle()` resolves once it is done or another source took over. A source may
 * pass `hold` to `load`: while it returns true, a sentence that would start waits paused for that source's `resume`. `voice`, `openaiVoice`, `rate` and their setters are the shared Speech setting;
 * `setKeyed` records whether the OpenAI voice has a key; `warm()` opens its connection early; `failure` holds the last
 * error with the key it stopped.
 */
export { speech } from './voice.solid.tsx'
/** The page's speech player and its settings. */
export type { Speech } from './voice.solid.tsx'
/** Split streamed reply parts, or one text, into sentences with their paragraphs; `estimate` gives a sentence's seconds. */
export { estimate, splitReply, splitSentences } from './speech.ts'
/** One spoken sentence: its text, paragraph and word starts. */
export type { Sentence } from './speech.ts'
/**
 * Mark what the player speaks in a rendered message: `useSpokenText(element, spoken)` with the message's root element
 * and, while it has a source, `{ key, spans, clickable, span?, play }`. `spans` are the message's parts in order (its
 * sentences, or its sections), found in the element's text; `span(item)` maps the player's item to a span, by default
 * the span with the item's text. The span being spoken carries the `read-aloud` CSS highlight; with `clickable`, a
 * click on a span calls `play(span)`.
 */
export { useSpokenText } from './spoken.solid.tsx'
/** What a message being read gives the highlight. */
export type { SpokenText } from './highlight.ts'
/** The voices the OpenAI voice offers. */
export { VOICES } from './voices.ts'
