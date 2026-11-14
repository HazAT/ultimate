import { createElement } from 'react'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { spliced } from '../../../../web/src/app/queued.ts'

const status = vi.hoisted(() => ({ data: undefined as unknown }))
vi.mock('@/sdk', () => ({
  api: {},
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  defineWebExtension: (facet: unknown) => facet,
  errorMessage: String,
  events: { emit: () => {} },
  insertIntoComposer: () => {},
  useAction: () => ({ data: status.data, loading: false, refetch: async () => undefined }),
  useConversation: () => ({ id: 7 }),
  useEvent: () => {},
  useNow: () => 0,
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: unknown }) => children,
  TooltipTrigger: ({ children }: { children: unknown }) => children,
  TooltipContent: () => null,
}))

async function button(data: unknown) {
  status.data = data
  vi.stubGlobal('window', { isSecureContext: true })
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => {} } })
  vi.stubGlobal('MediaRecorder', function MediaRecorder() {})
  const facet = (await import('../../web.tsx')).default as unknown as {
    slots: { 'composer.actions': ComponentType[] }
  }
  const html = renderToStaticMarkup(createElement(facet.slots['composer.actions'][0]))
  vi.unstubAllGlobals()
  return html
}

it('dims the mic and says why while no credential is set', async () => {
  const reason =
    'Voice needs a ChatGPT login or an OpenAI API key: sign in with ChatGPT, or add OPENAI_API_KEY in ⌘K → Secrets'
  const html = await button({ available: false, reason })
  expect(html).toContain('data-voice="blocked"')
  expect(html).toContain('aria-disabled="true"')
  expect(html).toContain(`aria-label="${reason}"`)
})

it('offers the mic once a credential is set', async () => {
  const html = await button({ available: true })
  expect(html).toContain('data-voice="idle"')
  expect(html).toContain('aria-label="Voice input"')
  expect(html).toContain('aria-disabled="false"')
})

it('spaces inserted words from their neighbours and puts the cursor after them', () => {
  expect(spliced('', 0, 0, 'Hello')).toEqual({ text: 'Hello', cursor: 5 })
  expect(spliced('Fix the', 7, 7, 'login bug')).toEqual({ text: 'Fix the login bug', cursor: 17 })
  expect(spliced('Fix bug', 3, 3, 'the')).toEqual({ text: 'Fix the bug', cursor: 7 })
  expect(spliced('Fixbug', 3, 3, 'the')).toEqual({ text: 'Fix the bug', cursor: 8 })
  expect(spliced('Fix  bug', 4, 4, 'the')).toEqual({ text: 'Fix the bug', cursor: 7 })
  expect(spliced('Fix XXX bug', 4, 7, 'the')).toEqual({ text: 'Fix the bug', cursor: 7 })
})
