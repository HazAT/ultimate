import {
  getDefaultAutoSelectFamilyAttemptTimeout,
  setDefaultAutoSelectFamilyAttemptTimeout,
} from 'node:net'
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { afterEach, expect, it } from 'vitest'
import { configureHttpDispatcher } from '../server/http.ts'

const originalDispatcher = getGlobalDispatcher()
const originalAttemptTimeout = getDefaultAutoSelectFamilyAttemptTimeout()

afterEach(async () => {
  const dispatcher = getGlobalDispatcher()
  setDefaultAutoSelectFamilyAttemptTimeout(originalAttemptTimeout)
  setGlobalDispatcher(originalDispatcher)
  await dispatcher.close()
})

it('sets the node:net family attempt timeout for callers outside undici', () => {
  setDefaultAutoSelectFamilyAttemptTimeout(500)
  configureHttpDispatcher()
  expect(getDefaultAutoSelectFamilyAttemptTimeout()).toBe(2_000)
})
