/**
 * Questions for other extensions' browser code: which messages wait on the user, the card that answers one, and the
 * point where an optional extension adds a control beside the card's Dismiss (Side chat's "Talk it through").
 */
export { CardActions, MessageQuestions } from './card.solid.tsx'
export { waiting } from './open.web.ts'
export type { Message as QuestionMessage } from './open.web.ts'
/** How many of `questions` the drafts answer; card state, its key and storage key. */
export { answered, cardKey, cardOf, CARDS_KEY } from './state.web.ts'
export type { CardState } from './state.web.ts'
