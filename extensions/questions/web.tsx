import { useEffect } from 'react'
import { defineWebExtension, provide, useDocOf, useUiState } from '@/sdk'
import { MessageAnswers, MessagesDoc } from '../messages/ui.tsx'
import { MessageQuestions } from './card.tsx'
import { forgetSettled } from './open.tsx'
import { CARDS_KEY } from './state.tsx'
import type { CardState } from './state.tsx'

/**
 * Drops the picks and notes of cards whose message settled — answered in its card, dismissed, or settled for the user
 * by @ultimate, also from another window or device. It reads the whole Messages log in every surface, since the Inbox
 * drops an answered item without rendering its card once more.
 */
function CardSweep() {
  const [, setCards] = useUiState<Record<string, CardState>>(CARDS_KEY, {})
  const messages = useDocOf(1, MessagesDoc)?.messages
  useEffect(() => {
    // Nothing is settled until the log is there: a starting server shows no messages for a moment.
    if (messages) setCards((old) => forgetSettled(old, messages))
  }, [messages, setCards])
  return null
}

export default defineWebExtension({
  slots: { overlay: [CardSweep] },
  entries: {
    // Retired cards have no interaction; hide them instead of exposing their raw JSON.
    'questions.asked': () => null,
    'questions.answers': () => null,
  },
  commands: [
    {
      id: 'questions.open',
      title: 'Show open questions',
      run: (context) => context.openPanel('todos'),
    },
  ],
  provides: [provide(MessageAnswers, (message) => <MessageQuestions message={message} />)],
})
