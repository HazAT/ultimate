/** @jsxImportSource @solidjs/web */
import { createSignal, flush } from 'solid-js'
import { expect, it } from 'vitest'
import type { ToolCallView } from '@/sdk/solid'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { Edit } from '../../files.solid.tsx'

const render = (args: ToolCallView['args'], status: ToolCallView['status']) => {
  const [call, setCall] = createSignal<ToolCallView>({
    id: 'c1',
    name: 'edit',
    args,
    status,
    output: '',
    images: [],
    diagnostics: [],
  })
  const container = renderSolid(() => <Edit call={call()} core={null} />)
  return { container, setCall }
}

it('renders a streaming edit with no text yet as a caret, without placeholder rows or counts', () => {
  const empty: ToolCallView['args'][] = [
    {},
    { path: 'a.ts', edits: [{ oldText: '', newText: '' }] },
  ]
  for (const args of empty) {
    const { container } = render(args, 'streaming')
    expect(container.querySelector('.text-diff-add, .text-diff-del')).toBeNull()
    expect(container.textContent).not.toMatch(/\+\d|−\d/)
    expect(container.querySelector('.animate-pulse-dot')).not.toBeNull()
  }
  expect(render({}, 'streaming').container.textContent).toContain('editing…')
})

it('streams only the text that arrived and counts changes once the call is written', () => {
  const args = { path: 'a.ts', edits: [{ oldText: 'one\ntwo', newText: 'uno' }] }
  const { container, setCall } = render(args, 'streaming')
  expect(container.textContent).toContain('uno')
  expect(container.textContent).not.toContain('−2')
  setCall((call) => ({ ...call, status: 'pending' }))
  flush()
  expect(container.textContent).toContain('−2')
})
