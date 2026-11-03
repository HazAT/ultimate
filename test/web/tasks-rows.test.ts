import { createElement } from 'react'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { ConversationId, TaskGraphNode, TaskId } from '@earendil-works/pi-durable'

vi.mock('@/sdk', () => ({
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  defineWebExtension: (extension: unknown) => extension,
  formatDuration: (ms: number) => `${ms}ms`,
  provide: () => ({}),
  RunStart: {},
}))
vi.mock('@/components/ai/tool', () => ({
  ToolStatusIcon: ({ state }: { state: string }) => createElement('i', { 'data-state': state }),
}))
vi.mock('../../extensions/workspaces/ui.tsx', () => ({}))
vi.mock('../../extensions/conversations/ui.tsx', () => ({}))
vi.mock('../../extensions/plan/ui.tsx', () => ({}))
vi.mock('../../extensions/messages/ui.tsx', () => ({}))
vi.mock('@/components/ui/collapsible', () => ({}))
const { TaskRow } = await import('../../extensions/tasks/web.tsx')

const task = (blocked?: TaskGraphNode['blocked']): TaskGraphNode => ({
  id: 7 as TaskId,
  kind: 'pi.generation',
  conversationId: 3 as ConversationId,
  background: false,
  abortRequested: false,
  state: { status: 'running', phase: 'stream' },
  conversations: [],
  ...(blocked ? { blocked } : {}),
})
const tree = {
  children: new Map(),
  roots: new Map(),
  summaries: new Map(),
  meanings: new Map(),
  started: {},
  features: new Map(),
  now: 0,
}

it('names why a blocked task cannot run', () => {
  const html = renderToStaticMarkup(
    createElement(TaskRow, { task: task('missing_task'), tree, depth: 0 }) as ReactNode,
  )
  expect(html).toContain('blocked · missing task')
  expect(html).toContain('data-state="interrupted"')
})

it('draws elbows to children, a rail past an ancestor with siblings below, and none at the top', () => {
  const child = (id: number) => ({ ...task(), id: id as TaskId })
  const nested = {
    ...tree,
    children: new Map([
      [7, [child(8), child(9)]],
      [8, [child(10)]],
    ]),
  }
  const html = renderToStaticMarkup(
    createElement(TaskRow, { task: task(), tree: nested, depth: 0 }) as ReactNode,
  )
  // Rows in order 7, 8, 10, 9: the top row has no lines; 8 continues down to its sibling 9 (full height), 9 is last
  // (half height); 10 is last under 8 but keeps 8's rail because 9 follows.
  const rows = html.split('<div class="relative').slice(1)
  expect(rows).toHaveLength(4)
  expect(rows[0]).not.toContain('border-dashed')
  expect(rows[1]).toContain('bottom-0')
  expect(rows[2]).toContain('inset-y-0')
  expect(rows[2]).toContain('h-1/2')
  expect(rows[3]).toContain('h-1/2')
  expect(rows[3]).not.toContain('inset-y-0')
})
