/**
 * Questions for other extensions' browser code: which messages wait on the user, the card that answers one, and the
 * point where an optional extension adds a control beside the card's Dismiss (side-chat's "Talk it through").
 */
import { island } from '@/sdk'
import { CardActions, MessageQuestions as SolidMessageQuestions } from './card.solid.tsx'

export { waiting } from './open.ts'
export type { Message as QuestionMessage } from './open.ts'
export const MessageQuestions = island(SolidMessageQuestions)
export { CardActions }
/** How many of `questions` the drafts answer; card state, its key and storage key. */
export { answered, cardKey, cardOf, CARDS_KEY } from './state.ts'
export type { CardState } from './state.ts'
