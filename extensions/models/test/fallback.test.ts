import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { checkLogin, fallback, loginChecks } from '../fallback.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'

it('a placement retried after a refusal reuses the inconclusive login check instead of checking again inside it', async () => {
  let authChecks = 0
  const snapshot = [{ provider: 'other', id: 'model' }]
  const host = {
    modelRuntime: {
      getAvailableSnapshot: () => snapshot,
      getProvider: () => ({ auth: {} }),
      checkAuth: async () => {
        authChecks++
        throw new Error('timed out')
      },
    },
    notice: () => {},
  } as unknown as ExtensionHost
  const model = { provider: 'lost', modelId: 'model' }
  const tx = { doc: async () => ({ model }) } as unknown as Tx
  const id = 7 as ConversationId
  const checks = loginChecks()
  await checkLogin(host, id, model, checks)
  expect(authChecks).toBe(1)
  expect(await fallback(host, tx, id, checks)).toBeUndefined()
  expect(await fallback(host, tx, id, checks)).toBeUndefined()
  expect(authChecks).toBe(1)
})
