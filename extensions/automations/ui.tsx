/** Automation subscriptions and upcoming times for other extensions' browser code. */
import { useEffect, useSyncExternalStore } from 'react'
import { api } from '@/sdk'
import { get, subscribe, want } from './poll.ts'

export { timerWaits } from './waits.ts'

export function useAutomations(ms: number | false) {
  useEffect(() => want(ms, api.action), [ms])
  return useSyncExternalStore(subscribe, get)
}
