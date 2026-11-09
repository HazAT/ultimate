import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { ToolCallView } from '../../../../web/src/sdk/types.ts'

vi.mock('@/sdk', async () => ({
  api: { action: () => new Promise(() => {}) },
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  defineWebExtension: (extension: unknown) => extension,
  formatBytes: (bytes: number) => `${bytes} B`,
  shortenPath: (path: string) => path,
  useConversation: () => undefined,
  useStore: () => undefined,
  useToolDuration: () => undefined,
}))

const { default: codingTools } = await import('../../web.tsx')
const tools = codingTools.tools as Record<string, (props: { call: ToolCallView }) => unknown>

const render = (name: string, args: ToolCallView['args'], status: ToolCallView['status']) =>
  renderToStaticMarkup(
    createElement(tools[name] as never, {
      call: { id: 'c1', name, args, status, output: '', images: [], diagnostics: [] },
    }),
  )
const rows = (html: string) => html.match(/text-diff-(add|del)/g)?.length ?? 0

it('renders a streaming edit with no text yet as a caret, without placeholder rows or counts', () => {
  const empty: ToolCallView['args'][] = [
    {},
    { path: 'a.ts', edits: [{ oldText: '', newText: '' }] },
  ]
  for (const args of empty) {
    const html = render('edit', args, 'streaming')
    expect(rows(html)).toBe(0)
    expect(html).not.toMatch(/\+\d|−\d/)
    expect(html).toContain('animate-pulse-dot')
  }
  expect(render('edit', {}, 'streaming')).toContain('editing…')
})

it('streams only the text that arrived and counts changes once the call is written', () => {
  const args = { path: 'a.ts', edits: [{ oldText: 'one\ntwo', newText: 'uno' }] }
  const streaming = render('edit', args, 'streaming')
  expect(streaming).toContain('uno')
  expect(streaming).not.toContain('−2')
  expect(render('edit', args, 'pending')).toContain('−2')
})
