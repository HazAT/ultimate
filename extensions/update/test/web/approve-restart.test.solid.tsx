/** @jsxImportSource @solidjs/web */
import { expect, it } from 'vitest'
import { expectApproval } from './approval-harness.solid.tsx'

it('restarts for an agent only once a person approves', async () => {
  const path = '/api/restart'
  const state = { behind: 0, commits: [], restart: true }
  expect(await expectApproval('Restart now', state, path)).toEqual([{ path, source: 'agent' }])
})
