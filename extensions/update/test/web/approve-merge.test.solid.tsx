/** @jsxImportSource @solidjs/web */
import { expect, it } from 'vitest'
import { expectApproval } from './approval-harness.solid.tsx'

it('asks @ultimate to merge for an agent only once a person approves', async () => {
  const path = '/api/extensions/update/actions/merge'
  const button = 'Update with @ultimate'
  const state = { refused: 'diverged', merge: true, ahead: 1 } as const
  expect(await expectApproval(button, state, path)).toEqual([{ path, source: 'agent' }])
})
