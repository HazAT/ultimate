/**
 * Questions for other extensions' browser code: which messages wait on the user, the card that answers one, and the
 * point where an optional extension adds a control beside the card's Dismiss (side-chat's "Talk it through").
 */
export { waiting } from './open.tsx'
export type { Message as QuestionMessage } from './open.tsx'
export { MessageQuestions } from './card.tsx'
export { CardActions } from './points.tsx'
/** How many of `questions` the drafts answer; card state, its key and storage key. */
export { answered, cardKey, cardOf, CARDS_KEY } from './state.tsx'
export type { CardState } from './state.tsx'
