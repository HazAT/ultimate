/** @jsxImportSource @solidjs/web */
import { createSignal, flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
vi.mock('../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../web/src/sdk/store.ts')
  const { createUiState } = await import('../../web/src/sdk/ui-state.ts')
  return { store: createStore(), uiState: createUiState(undefined), api: {}, registry: { getSnapshot: () => [], subscribe: () => () => {} } }
})
import { Markdown } from '../../web/src/components/markdown/markdown.solid.tsx'
import { renderSolid } from './solid-dom-setup.ts'

it('renders', () => {
  const md = "# H\n\nHello **bold** and `code` [l](http://x.y) <kbd>K</kbd> see #760041 https://auto.link\n\n- a\n  - b\n\n| a | b |\n|:--|--:|\n| 1 | 2 |\n\n```ts\nconst x = 1\n```\n\n- [ ] task\n\n<details><summary>S</summary>\n\ninner\n\n</details>\n\n<script>alert(1)</script>"
  const el = renderSolid(() => <Markdown text={md} />)
  flush()
  console.log(el.innerHTML.replace(/></g, '>\n<'))
  expect(el.innerHTML).toContain('<h1')
})

it('streams', () => {
  const [text, setText] = createSignal('Para one.\n\nPara **two')
  const el = renderSolid(() => <Markdown text={text()} streaming />)
  flush()
  const first = el.querySelector('p')!
  console.log(el.innerHTML)
  setText('Para one.\n\nPara **two** done.\n\nThree')
  flush()
  console.log(el.innerHTML, el.querySelector('p') === first)
})
