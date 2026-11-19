/** @jsxImportSource @solidjs/web */
import { expect, it } from 'vitest'
import { expectApproval } from './approval-harness.solid.tsx'

it('retries pnpm install for an agent only once a person approves', async () => {
  const path = '/api/extensions/update/actions/update'
  const state = { behind: 0, commits: [], install: true }
  expect(await expectApproval('Retry pnpm install', state, path)).toEqual([
    { path, source: 'agent' },
  ])
})
