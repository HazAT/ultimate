import type { EntryRecord } from '@earendil-works/pi-durable'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { ExtensionRecord } from '../../../../web/src/sdk/registry.ts'
import { defineWebExtension, provide } from '../../../../web/src/sdk/types.ts'
import type { EntryRenderer } from '../../../../web/src/sdk/types.ts'

const state = vi.hoisted(() => ({
  records: [] as ExtensionRecord[],
  entries: [] as EntryRecord[],
}))
// The real client and hooks connect to a server; the line needs only the loaded transcript and the installed facets.
vi.mock('../../../../web/src/sdk/client.ts', () => ({}))
vi.mock('../../../../web/src/sdk/resume.ts', () => ({ resumed: false, covered: () => false }))
vi.mock('../../../../web/src/sdk/hooks.ts', async (original) => ({
  ...(await original<typeof import('../../../../web/src/sdk/hooks.ts')>()),
  useExtensions: () => state.records,
  useSystem: () => undefined,
  useTranscript: () => state.entries,
}))

const { default: context } = await import('../../web.tsx')
const { CacheRebuiltDetail } = await import('../../ui.tsx')
const CacheRebuilt: EntryRenderer = context.entries!['pi.assistant']

const answer = (id: number, cacheRead: number, cacheWrite: number, timestamp: number) =>
  ({
    id,
    kind: 'pi.assistant',
    model: [
      {
        role: 'assistant',
        provider: 'anthropic',
        model: 'opus',
        timestamp,
        usage: { input: 2, output: 100, cacheRead, cacheWrite },
      },
    ],
  }) as unknown as EntryRecord
state.entries = [answer(1, 0, 180_000, 0), answer(2, 0, 181_000, 2 * 3600_000)]

const render = () =>
  renderToStaticMarkup(h(CacheRebuilt, { entry: state.entries[1], core: h('p', null, 'reply') }))

it('adds what other extensions provide to the end of the cache-rebuilt line', () => {
  state.records = [
    {
      name: 'cost',
      version: 1,
      loading: false,
      extension: defineWebExtension({
        provides: [
          provide(CacheRebuiltDetail, ({ bust }) => ({
            text: `${bust.written} again`,
            title: 'written twice',
          })),
        ],
      }),
    },
    {
      name: 'quiet',
      version: 1,
      loading: false,
      extension: defineWebExtension({ provides: [provide(CacheRebuiltDetail, () => undefined)] }),
    },
  ]
  expect(render()).toContain(
    'expired after 2h 00m idle</span><span class="shrink-0 tabular-nums" title="written twice">· 181002 again</span></span></div><p>reply',
  )
})
