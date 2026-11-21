/** @jsxImportSource @solidjs/web */
import type { EntryRecord } from '@earendil-works/pi-durable'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { events, ExtensionName, writingAs } from '@/sdk/solid'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { store, uiState } from '../../../../web/src/sdk/client.ts'
import { writerNow } from '../../../../web/src/sdk/writer.ts'
import { ReviewCard } from '../../card.solid.tsx'
import { getTarget } from '../../link-state.ts'
import { ReviewLink } from '../../link.solid.tsx'

vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  return {
    api: {},
    registry: createRegistry(),
    reportCompact: () => {},
    store: createStore(),
    uiState: createUiState(undefined),
  }
})

const agent = createAgent()

it('handles review:open by selecting the requested spec and line, then updates the address', ({
  onTestFinished,
}) => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  const address = location.href
  onTestFinished(() => {
    history.replaceState(history.state, '', address)
    vi.unstubAllGlobals()
  })
  renderSolid(() => (
    <ExtensionName value="review">
      <ReviewLink />
    </ExtensionName>
  ))
  const at = { file: 'src/main.ts', line: 4, side: 'old' }
  writingAs('agent', () => events.emit('review:open', { spec: 'main...branch', at }))
  expect(uiState.get('ext.review.spec')).toBe('main...branch')
  expect(uiState.get('shell.surface')).toBe('review')
  expect(getTarget()).toEqual(at)
  store.setUi({ surface: { id: 'review', title: 'Review' } })
  flush()
  expect(new URL(location.href).searchParams.get('review')).toBe('main...branch')
})

it('opens a sent review at the chosen comment, even when both sides share the same line number', async ({
  onTestFinished,
}) => {
  const line = { file: 'src/main.ts', start: 4, end: 4, text: 'Please update this line.' }
  const entry = {
    id: 10,
    kind: 'review.comments',
    data: {
      spec: 'main...branch',
      comments: [
        { ...line, side: 'new' },
        { ...line, side: 'old', excerpt: 'const count = 0' },
      ],
    },
  } as unknown as EntryRecord
  const container = renderSolid(() => <ReviewCard entry={entry} />)
  expect(container.querySelector('[data-review-chip="src/main.ts:4"]')).not.toBeNull()
  expect(container.textContent).toContain('const count = 0')
  await expectDistinctAgentNames(agent)
  const open = agent
    .snapshot()
    .find((item) => !item.offPage && item.label?.startsWith('Jump to comment 2'))!
  const requests: unknown[] = []
  onTestFinished(events.on('review:open', (data) => requests.push({ data, source: writerNow() })))
  expect(await agent.act({ steps: [{ ref: open.ref, action: 'press' }] })).toMatchObject({
    ok: true,
  })
  expect(requests).toEqual([
    {
      data: { spec: 'main...branch', at: { file: 'src/main.ts', line: 4, side: 'old' } },
      source: 'agent',
    },
  ])
})
