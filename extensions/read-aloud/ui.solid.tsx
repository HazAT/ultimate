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
/** The voices the OpenAI voice offers. */
export { VOICES } from './voices.ts'
