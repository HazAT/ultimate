import { deadline } from '../../lib/timers.ts'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { api, useUltimate } from '@/sdk'
import { NavigatedAction } from './refs.ts'

const VISIBLE_VIEW_MINIMUM_MS = 1000

const subscribe = (listener: () => void) => {
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
}

export function NavigationReporter() {
  const { surface, conversationId } = useUltimate()
  const visible = useSyncExternalStore(subscribe, () => document.visibilityState === 'visible')
  const conversation = surface === 'agent' ? conversationId : undefined
  const reported = useRef<string | undefined>(undefined)
  useEffect(() => {
    const key = `${surface}:${conversation ?? ''}`
    if (navigator.webdriver || !visible || key === reported.current) return undefined
    return deadline(VISIBLE_VIEW_MINIMUM_MS, () => {
      reported.current = key

      api
        .action(NavigatedAction, {
          surface,
          ...(conversation === undefined ? {} : { conversation }),
        })
        .catch(() => (reported.current = undefined))
    })
  }, [surface, conversation, visible])
  return null
}
