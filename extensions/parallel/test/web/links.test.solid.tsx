/** @jsxImportSource @solidjs/web */
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import type { ToolCallView } from '@/sdk/solid'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { Search } from '../../calls.solid.tsx'

vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  return {
    store: createStore({
      eventSource: () => new EventTarget() as never,
      fetch: async () => Response.json({}),
    }),
    registry: createRegistry(),
    uiState: createUiState(undefined),
  }
})

const page = (url: string) => ({ url, title: url, publish_date: null, excerpts: ['excerpt'] })

it('links a search result only when its address is http or https', () => {
  const call: ToolCallView = {
    id: 'search-1',
    name: 'web_search',
    args: { query: 'links' },
    status: 'done',
    output: '',
    images: [],
    diagnostics: [],
    details: {
      status: 'success',
      results: [page('https://example.com/a'), page('javascript:alert(1)')],
    },
  }
  const container = renderSolid(() => <Search call={call} core={null} />)
  container.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')!.click()
  flush()
  const hrefs = [...container.querySelectorAll('a')].map((link) => link.getAttribute('href'))
  expect(hrefs).toContain('https://example.com/a')
  expect(hrefs.some((href) => href?.startsWith('javascript:'))).toBe(false)
  expect(container.textContent).toContain('javascript:alert(1)')
})
