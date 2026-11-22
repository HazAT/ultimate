import { createSignal, flush } from 'solid-js'
import { expect, it, vi } from 'vitest'

const installed = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  let records: unknown[] = []
  return {
    get: () => records,
    subscribe: (listener: () => void) => (
      listeners.add(listener),
      () => listeners.delete(listener)
    ),
    set(next: unknown[]) {
      records = next
      for (const listener of listeners) listener()
    },
  }
})
vi.mock('../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../web/src/sdk/store.ts')
  const { createUiState } = await import('../../web/src/sdk/ui-state.ts')
  return {
    store: createStore(),
    uiState: createUiState(undefined),
    api: {},
    registry: { getSnapshot: installed.get, subscribe: installed.subscribe },
  }
})

import type { CodeBlockRenderer } from '../../web/src/sdk/types.ts'
import { Markdown } from '../../web/src/components/markdown/markdown.solid.tsx'
import { createAgent } from '@ui-sdk/solid/agent'
import { settle } from '@ui-sdk/core/testing'
import { renderSolid } from './solid-dom-setup.ts'
import { expectDistinctAgentNames } from './agent-names.ts'

const agent = createAgent()

function stream(chunks: string[], { end = false } = {}) {
  const [text, setText] = createSignal('')
  const [streaming, setStreaming] = createSignal(true)
  const view = renderSolid(() => <Markdown streaming={streaming()} text={text()} />)
  let sent = ''
  for (const chunk of chunks) {
    sent += chunk
    setText(sent)
    flush()
  }
  if (end) setStreaming(false)
  flush()
  return view
}

const withoutNames = (html: string) => html.replace(/ aria-label="[^"]*"/g, '')

const finished = (text: string) => {
  const view = renderSolid(() => <Markdown text={text} />)
  flush()
  return withoutNames(view.innerHTML)
}

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

it('ends a stream as the whole text renders, wherever its chunks broke', () => {
  const texts = [
    'a\n#topic and more\n\nnext',
    'Intro\n\n   ```ts\n   let x\n   ```\n\nafter',
    '- one\n- two\n\n- three\n\nend',
    '1. one\n\n2. two',
    '[x][r]\n\n> [r]: /target',
  ]
  for (const text of texts)
    for (let cut = 1; cut < text.length; cut++)
      expect(
        withoutNames(stream([text.slice(0, cut), text.slice(cut)], { end: true }).innerHTML),
      ).toBe(finished(text))
})

it('tells a code block renderer only its own fence is unfinished', () => {
  const Probe: CodeBlockRenderer = (props) => (
    <span data-probe={props.incomplete ? 'open' : 'done'}>{props.code.trim()}</span>
  )
  installed.set([{ name: 'probe', version: 1, extension: { codeBlocks: { ts: Probe } } }])
  try {
    const probes = (chunks: string[]) =>
      [...stream(chunks).querySelectorAll('[data-probe]')].map((probe) => [
        probe.textContent,
        probe.getAttribute('data-probe'),
      ])
    expect(probes(['```ts\ndone\n```\n> ```ts\n> open'])).toEqual([
      ['done', 'done'],
      ['open', 'open'],
    ])
    expect(probes(['```ts\n    ```'])).toEqual([['```', 'open']])
    expect(probes(['> ```ts\n> one', '\n>'])).toEqual([['one', 'open']])
    expect(probes(['- > ```ts\n  > one', '\n>'])).toEqual([['one', 'done']])
    expect(probes(['- ```ts\n  one\n\n'])).toEqual([['one', 'open']])
    expect(probes(['```ts'])).toEqual([['', 'open']])
    expect(probes(['See[^a]\n\n[^a]: ~~~~ts\n    one\n'])).toEqual([['one', 'open']])
    expect(probes(['See[^long]\n\n[^long]: > ~~~~ts\n    > one\n'])).toEqual([['one', 'open']])
    expect(probes(['See[^a]\n\n> [^a]: ~~~~ts\n>     one\n'])).toEqual([['one', 'open']])
    expect(probes(['See[^a]\n\n- [^a]: ~~~~ts\n      one\n'])).toEqual([['one', 'open']])
    expect(probes(['- ```ts\n'])).toEqual([['', 'open']])
    expect(probes(['> ```ts\n> C1STREAMPROBE\noutside'])).toEqual([['C1STREAMPROBE', 'done']])
    expect(probes(['> ```ts\n> one', '\noutside\n```ts\ntwo'])).toEqual([
      ['one', 'done'],
      ['two', 'open'],
    ])
  } finally {
    installed.set([])
  }
})

it('falls back to the core rendering when an extension renderer throws', () => {
  const Broken: CodeBlockRenderer = () => {
    throw new Error('broken')
  }
  installed.set([{ name: 'broken', version: 1, extension: { codeBlocks: { ts: Broken } } }])
  try {
    const view = renderSolid(() => <Markdown text={'Before.\n\n```ts\nlet x\n```\n\nAfter.'} />)
    flush()
    expect(view.querySelector('[data-extension-error="broken"]')?.textContent).toContain('broken')
    expect(view.querySelector('.code-block pre')?.textContent).toBe('let x')
    expect(view.textContent).toContain('After.')
  } finally {
    installed.set([])
  }
})

it('aligns table cells without letting the alignment carry other CSS', () => {
  const view = renderSolid(() => (
    <Markdown
      text={'<table><tr><td align="left;background:url(https://x/y)">b</td></tr></table>'}
      without={['img']}
    />
  ))
  flush()
  const cell = view.querySelector('td')!
  expect(cell.style.length).toBeLessThanOrEqual(1)
  expect(cell.style.backgroundImage).toBe('')
})

it('resolves a reference whose definition sits in a quote', () => {
  const view = renderSolid(() => <Markdown text={'[x][r]\n\n> [r]: https://example.com/target'} />)
  flush()
  expect(view.querySelector('button.link')?.getAttribute('data-href')).toBe(
    'https://example.com/target',
  )
})

it('asks before opening an external link, which has no live destination', () => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  const view = renderSolid(() => <Markdown text="See [docs](https://example.com/docs)." />)
  flush()
  const link = view.querySelector<HTMLButtonElement>('button.link')!
  expect(link.hasAttribute('href')).toBe(false)
  link.click()
  flush()
  expect(open).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('Open external link?')
  open.mockRestore()
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

it('names each copy and link button apart, across replies and links the parser splits, and keeps a name while code streams', async () => {
  const reply = '[docs](https://example.com/docs)\n\n```sh\nnpm test\n```'
  const [code, setCode] = createSignal('```sh\nnpm te')
  renderSolid(() => (
    <>
      <Markdown text={reply} />
      <Markdown text={reply} />
      <Markdown text={'<a href="https://example.com"><div><br>'} />
      <Markdown streaming text={code()} />
    </>
  ))
  flush()
  await settle()
  await expectDistinctAgentNames(agent)
  const labels = () =>
    agent
      .snapshot()
      .filter((entry) => !entry.offPage)
      .map((entry) => entry.label)
  expect(labels()).toHaveLength(7)
  const streamed = labels().at(-1)
  setCode('```sh\nnpm test\nnpm run build\n')
  flush()
  await settle()
  expect(labels().at(-1)).toBe(streamed)
})
