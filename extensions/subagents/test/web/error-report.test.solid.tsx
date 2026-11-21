/** @jsxImportSource @solidjs/web */
import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { act } from 'react'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'

const harness = vi.hoisted(() => ({
  actions: [] as { path: string; source: string | null }[],
  writes: [] as { key: string; who: string }[],
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    harness.actions.push({
      path: input as string,
      source: new Headers(init?.headers).get('x-ultimate-source'),
    })
    return Response.json({ result: 77 })
  }
  const store = createStore({ fetch })
  return {
    store,
    api: createApi(store, { fetch }),
    registry: createRegistry(),
    uiState: createUiState(
      async (request, who) => {
        for (const op of request.ops) harness.writes.push({ key: op.key, who })
        return { ok: true, rev: harness.writes.length }
      },
      { delayMs: 0 },
    ),
  }
})
vi.stubGlobal('matchMedia', () => ({
  matches: true,
  addEventListener() {},
  removeEventListener() {},
}))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

import { getDraft } from '../../../../web/src/app/drafts.ts'
import { ReportedErrorCard } from '../../../../web/src/app/error-stack.solid.tsx'
import { registry, uiState } from '../../../../web/src/sdk/client.ts'
import { ErrorReport, provide } from '../../../../web/src/sdk/types.ts'
import { useErrorReport } from '../../error-report.tsx'

const agent = createAgent()

it('opens @ultimate with the report as the agent that pressed Debug with @ultimate', async () => {
  await registry.setLoaders({
    'extensions/subagents/web.tsx': async () => ({
      default: { provides: [provide(ErrorReport, useErrorReport)] },
    }),
  })
  act(() => {
    renderSolid(() => <ReportedErrorCard error="it broke" extension="broken" />)
    flush()
  })
  await settle()
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }))
  const result = await agent.act({
    steps: [{ ref: 'Debug with @ultimate: broken failed', action: 'press' }],
  })
  expect(result.ok).toBe(true)
  await vi.waitFor(() => expect(getDraft(77).get().text).toContain('it broke'))
  await uiState.flush()
  expect(harness.actions).toEqual([
    { path: '/api/extensions/subagents/actions/standing', source: 'agent' },
  ])
  expect(harness.writes).toEqual([
    { key: 'shell.surface', who: 'agent' },
    { key: 'shell.conversation', who: 'agent' },
  ])
})
