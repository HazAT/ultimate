import { useEffect, useRef, useSyncExternalStore } from 'react'
import { api, useUltimate } from '@/sdk'
import { NavigatedAction } from './refs.ts'

/** How long a view must stay before it counts: passing through a surface on the way to another is no navigation. */
const SETTLE_MS = 1000

const subscribe = (listener: () => void) => {
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
}

/**
 * Reports what the user looks at, for `ui.navigated`: the surface, and on Agent the open conversation. Only a view
 * that stays a second in a visible tab and differs from the last one this tab reported; the server drops repeats of
 * other tabs. A tab opened in the background reports once it is shown. An automated browser (an agent's screenshot or
 * script) is not the user and reports nothing.
 */
export function NavigationReporter() {
  const { surface, conversationId } = useUltimate()
  const visible = useSyncExternalStore(subscribe, () => document.visibilityState === 'visible')
  const conversation = surface === 'agent' ? conversationId : undefined
  const reported = useRef<string | undefined>(undefined)
  useEffect(() => {
    const key = `${surface}:${conversation ?? ''}`
    if (navigator.webdriver || !visible || key === reported.current) return undefined
    const timer = setTimeout(() => {
      reported.current = key
      // A missed report only leaves a gap in the debug log; it never needs the user's attention.
      api
        .action(NavigatedAction, {
          surface,
          ...(conversation === undefined ? {} : { conversation }),
        })
        .catch(() => (reported.current = undefined))
    }, SETTLE_MS)
    return () => clearTimeout(timer)
  }, [surface, conversation, visible])
  return null
}
