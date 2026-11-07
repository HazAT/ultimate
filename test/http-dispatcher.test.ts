import {
  getDefaultAutoSelectFamilyAttemptTimeout,
  setDefaultAutoSelectFamilyAttemptTimeout,
} from 'node:net'
import { afterEach, expect, test } from 'vitest'
import { configureHttpDispatcher } from '../server/http.ts'

const original = getDefaultAutoSelectFamilyAttemptTimeout()
afterEach(() => setDefaultAutoSelectFamilyAttemptTimeout(original))

test('configureHttpDispatcher raises the node:net dual-stack attempt timeout to 2000 ms', () => {
  setDefaultAutoSelectFamilyAttemptTimeout(500)
  configureHttpDispatcher()
  expect(getDefaultAutoSelectFamilyAttemptTimeout()).toBe(2000)
})
