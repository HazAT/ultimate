import { createEffect } from 'solid-js'
import { ROOT, useDocOf, useUiState, writingAs } from '@/sdk/solid'
import { MessagesDoc } from '../messages/refs.ts'
import { forgetSettled } from './open.web.ts'
import { CARDS_KEY } from './state.web.ts'
import type { CardState } from './state.web.ts'

export function CrossSurfaceDraftSweep() {
  const [cards, setCards] = useUiState<Record<string, CardState>>(CARDS_KEY, {})
  const log = useDocOf(() => ROOT, MessagesDoc)
  createEffect(
    () => {
      const current = cards()
      const messages = log()?.messages
      if (!messages || Object.keys(current).length === 0) return undefined
      const kept = forgetSettled(current, messages)
      return kept === current ? undefined : kept
    },
    (kept) => {
      if (kept) writingAs('app', () => setCards(kept))
    },
  )
  return null
}
