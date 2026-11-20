import { ROOT } from '@/sdk'
import { useEffect } from 'react'
import { defineWebExtension, island, provide, useDocOf, useUiState, writingAs } from '@/sdk'
import { MessageAnswers, MessagesDoc } from '../messages/ui.tsx'
import { HiddenQuestionEntry, MessageQuestions } from './card.solid.tsx'
import { forgetSettled } from './open.ts'
import { CARDS_KEY } from './state.ts'
import type { CardState } from './state.ts'

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
    'questions.asked': island(HiddenQuestionEntry),
    'questions.answers': island(HiddenQuestionEntry),
  },
  commands: [
    {
      id: 'questions.open',
      title: 'Show open questions',
      run: (context) => context.openPanel('todos'),
    },
  ],
  provides: [provide(MessageAnswers, island(MessageQuestions))],
})
