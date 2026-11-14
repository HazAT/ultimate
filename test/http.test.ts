import {
  getDefaultAutoSelectFamilyAttemptTimeout,
  setDefaultAutoSelectFamilyAttemptTimeout,
} from 'node:net'
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const originalDispatcher = getGlobalDispatcher()
const originalAttemptTimeout = getDefaultAutoSelectFamilyAttemptTimeout()

beforeEach(() => {
  vi.resetModules()
  for (const name of [
    'fetch',
    'Headers',
    'Response',
    'Request',
    'FormData',
    'WebSocket',
    'CloseEvent',
    'ErrorEvent',
    'MessageEvent',
    'EventSource',
  ] as const)
    vi.stubGlobal(name, globalThis[name])
})

afterEach(async () => {
  const dispatcher = getGlobalDispatcher()
  setDefaultAutoSelectFamilyAttemptTimeout(originalAttemptTimeout)
  vi.unstubAllGlobals()
  setGlobalDispatcher(originalDispatcher)
  await dispatcher.close()
})

it('sets the node:net family attempt timeout for callers outside undici', async () => {
  setDefaultAutoSelectFamilyAttemptTimeout(500)
  const { configureHttpDispatcher } = await import('../server/http.ts')
  configureHttpDispatcher()
  expect(getDefaultAutoSelectFamilyAttemptTimeout()).toBe(2_000)
})
