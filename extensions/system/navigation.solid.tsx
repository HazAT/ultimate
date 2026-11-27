import { createEffect } from 'solid-js'
import { api, useConversationId, usePageVisible, useSurface } from '@/sdk/solid'
import { deadline } from '../../lib/timers.shared.ts'
import { NavigatedAction } from './refs.ts'

const VISIBLE_VIEW_MINIMUM_MS = 1000

export function NavigationReporter() {
  const surface = useSurface()
  const id = useConversationId()
  const isVisible = usePageVisible()
  let reported: string | undefined
  createEffect(
    () => ({
      shown: surface(),
      conversation: surface() === 'agent' ? id() : undefined,
      visible: isVisible(),
    }),
    ({ shown, conversation, visible }) => {
      const key = `${shown}:${conversation ?? ''}`
      if (navigator.webdriver || !visible || key === reported) return undefined
      return deadline(VISIBLE_VIEW_MINIMUM_MS, () => {
        reported = key
        void api.action(NavigatedAction, { surface: shown, conversation }).catch(() => {
          reported = undefined
        })
      })
    },
  )
  return null
}
