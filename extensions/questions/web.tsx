import { ROOT } from '@/sdk'
import { useEffect } from 'react'
import { defineWebExtension, provide, useDocOf, useUiState, writingAs } from '@/sdk'
import { MessageAnswers, MessagesDoc } from '../messages/ui.tsx'
import { MessageQuestions } from './card.tsx'
import { forgetSettled } from './open.tsx'
import { CARDS_KEY } from './state.tsx'
import type { CardState } from './state.tsx'

function CrossSurfaceDraftSweep() {
  const [cards, setCards] = useUiState<Record<string, CardState>>(CARDS_KEY, {})
  const messages = useDocOf(ROOT, MessagesDoc)?.messages

  useEffect(() => {
    const logAndStoredCardsLoaded = messages && Object.keys(cards).length
    if (logAndStoredCardsLoaded)
      writingAs('app', () => setCards((old) => forgetSettled(old, messages)))
  }, [cards, messages, setCards])
  return null
}

export default defineWebExtension({
  slots: { overlay: [CrossSurfaceDraftSweep] },
  entries: {
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
