import { createElement } from 'react'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { ToolCallBlock } from '../../web/src/app/tool-call.tsx'
import { createRegistry } from '../../web/src/sdk/registry.ts'
import type { ToolCallView } from '../../web/src/sdk/types.ts'

const hooks = vi.hoisted(() => ({ records: [] as unknown[] }))
vi.mock('../../web/src/sdk/hooks.ts', async () => ({
  ExtensionNameContext: (await import('react')).createContext(''),
  useExtensions: () => hooks.records,
  useToolDuration: () => '',
}))

const wrap =
  (tag: string) =>
  ({ core }: { core: ReactNode }) =>
    createElement(tag, null, core)

it('passes the generic card through tool decorators in discovery order, allowing replacement', async () => {
  const registry = createRegistry()
  await registry.setLoaders({
    'extensions/builtin-z/web.tsx': async () => ({ default: { tools: { demo: wrap('section') } } }),
    'extensions/project-a/web.tsx': async () => ({ default: { tools: { demo: wrap('article') } } }),
  })
  hooks.records = [...registry.getSnapshot()]
  const call: ToolCallView = {
    id: 'demo-1',
    name: 'demo',
    args: {},
    status: 'done',
    output: '',
    images: [],
    diagnostics: [],
  }
  const html = renderToStaticMarkup(createElement(ToolCallBlock, { call }))
  expect(html).toContain('<article><section>')
  expect(html).toContain('demo')
  expect(html).toContain('</section></article>')

  await registry.setLoaders({
    'extensions/builtin-z/web.tsx': async () => ({ default: { tools: { demo: wrap('section') } } }),
    'extensions/project-a/web.tsx': async () => ({
      default: { tools: { demo: () => createElement('p', null, 'replacement') } },
    }),
  })
  hooks.records = [...registry.getSnapshot()]
  const replaced = renderToStaticMarkup(createElement(ToolCallBlock, { call }))
  expect(replaced).toContain('<p>replacement</p>')
  expect(replaced).not.toContain('<section>')
})
