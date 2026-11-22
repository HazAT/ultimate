import { createEffect, createMemo } from 'solid-js'
import {
  ROOT,
  api,
  switchConversation,
  useDocOf,
  useStore,
  useUiState,
  writingAs,
} from '@/sdk/solid'
import { landing } from './landing.ts'
import { StandingAction, StandingDoc } from './refs.ts'

export function LandOnUltimate() {
  const loaded = useStore((state) => state.shared !== undefined)
  const [chosen] = useUiState<number | null>('shell.conversation', null)
  const standing = useDocOf(() => ROOT, StandingDoc)
  const target = createMemo(() => landing(loaded(), chosen() ?? undefined, standing()))
  createEffect(target, (value) => {
    if (value === undefined) return
    if (value !== 'create') {
      writingAs('app', () => switchConversation(value, { replace: true }))
      return
    }
    writingAs('app', () => api.action(StandingAction, { name: 'ultimate' }))
      .then((id) => writingAs('app', () => switchConversation(id, { replace: true })))
      .catch((error: unknown) => console.error('Could not open @ultimate', error))
  })
  return null
}
