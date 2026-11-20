/** @jsxImportSource @solidjs/web */
import { createSignal, flush } from 'solid-js'
import { expect, it, vi } from 'vitest'

vi.mock('../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../web/src/sdk/store.ts')
  const { createUiState } = await import('../../web/src/sdk/ui-state.ts')
  return {
    store: createStore(),
    uiState: createUiState(undefined),
    api: {},
    registry: { getSnapshot: () => [], subscribe: () => () => {} },
  }
})

import { Markdown } from '../../web/src/components/markdown/markdown.solid.tsx'
import { renderSolid } from './solid-dom-setup.ts'

it('streams into the last block only, closing what it leaves open', () => {
  const [text, setText] = createSignal('# Plan\n\nFirst paragraph.\n\nSecond **bold')
  const view = renderSolid(() => <Markdown streaming text={text()} />)
  flush()
  const [heading, first] = [view.querySelector('h1')!, view.querySelector('p')!]
  expect(view.querySelector('p:last-child strong')?.textContent).toBe('bold')

  const changes: MutationRecord[] = []
  const observer = new MutationObserver((records) => changes.push(...records))
  observer.observe(view, { subtree: true, childList: true, characterData: true, attributes: true })
  setText('# Plan\n\nFirst paragraph.\n\nSecond **bold** text, `co')
  flush()
  changes.push(...observer.takeRecords())

  expect(view.querySelector('h1')).toBe(heading)
  expect(view.querySelector('p')).toBe(first)
  const tail = view.querySelectorAll('p')[1]
  expect(changes.every((change) => tail.contains(change.target))).toBe(true)
  expect(tail.querySelector('code')?.textContent).toBe('co')

  setText('# Plan\n\nFirst paragraph.\n\nSecond **bold** text, `code` and *one star')
  flush()
  expect(view.querySelector('p')).toBe(first)
  expect(view.querySelector('em')?.textContent).toBe('one star')
})

it('leaves a finished message as written', () => {
  const view = renderSolid(() => (
    <Markdown text="Workers edit extensions/conversations/*, web/src/sdk." />
  ))
  flush()
  expect(view.querySelector('em')).toBeNull()
  expect(view.textContent).toContain('conversations/*,')
})

it('checks the done items of a task list', () => {
  const view = renderSolid(() => <Markdown text={'- [x] done\n- [ ] open'} />)
  flush()
  const boxes = [...view.querySelectorAll('input')]
  expect(boxes.map((box) => [box.checked, box.disabled])).toEqual([
    [true, true],
    [false, true],
  ])
})

it('shows a long table at full height, not in a scrolled box', () => {
  const rows = Array.from({ length: 20 }, (_, index) => `| ${index} | row ${index} |`)
  const view = renderSolid(() => (
    <Markdown text={['| # | Name |', '| - | - |', ...rows].join('\n')} />
  ))
  flush()
  expect(view.querySelectorAll('tbody tr')).toHaveLength(20)
  expect(view.innerHTML).not.toMatch(/max-height/)
})

it('keeps sanitized raw HTML and drops what could run', () => {
  const view = renderSolid(() => (
    <Markdown
      text={
        '<details><summary>More</summary>\n\nInside **bold**\n\n</details>\n\n<img src=x onerror="alert(1)"><script>alert(1)</script>'
      }
    />
  ))
  flush()
  expect(view.querySelector('details summary')?.textContent).toBe('More')
  expect(view.querySelector('details strong')?.textContent).toBe('bold')
  expect(view.querySelector('script, [onerror]')).toBeNull()
})
