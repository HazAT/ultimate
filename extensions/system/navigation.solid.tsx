/** @jsxImportSource @solidjs/web */
import { createEffect, createSignal, onSettled } from 'solid-js'
import { api, useConversationId, useSurface } from '@/sdk/solid'
import { deadline } from '../../lib/timers.ts'
import { NavigatedAction } from './refs.ts'

const VISIBLE_VIEW_MINIMUM_MS = 1000

export function useVisible() {
  const [visible, setVisible] = createSignal(document.visibilityState === 'visible')
  const sync = () => setVisible(document.visibilityState === 'visible')
  onSettled(() => {
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  })
  return visible
}

export function NavigationReporter() {
  const surface = useSurface()
  const id = useConversationId()
  const isVisible = useVisible()
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
