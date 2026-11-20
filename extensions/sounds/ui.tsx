/** Sounds for other extensions' browser code: synthesized bell notes, outside the notification cues and their switch. */
export { playNotes } from './tones.ts'
export type { Note } from './tones.ts'

/**
 * Tells the narrator whether another voice speaks the user's questions in this tab (live voice, while its mode is on):
 * the narrator then keeps the question's sound and leaves its words to that voice, so two voices never talk at once.
 */
export { voiceQuestions } from './voiced.ts'
