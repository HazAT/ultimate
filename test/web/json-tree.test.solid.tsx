/** @jsxImportSource @solidjs/web */
import { createSignal, flush } from 'solid-js'
import { expect, it } from 'vitest'
import { JsonTree } from '../../web/src/components/json-tree.solid.tsx'
import { renderSolid } from './solid-dom-setup.ts'

it('keeps a branch the reader opened open while a sibling updates, and names dotted keys apart', () => {
  const [value, setValue] = createSignal<unknown>({ 'a.b': 1, a: { b: { deep: true } }, count: 1 })
  const container = renderSolid(() => <JsonTree name="doc" open={1} value={value()} />)
  const trigger = (name: string) =>
    [...container.querySelectorAll('button')].find(
      (button) => button.getAttribute('aria-label') === `Inspect ${name}`,
    )!
  trigger('doc["a"]').click()
  flush()
  expect(trigger('doc["a"]["b"]')).toBeDefined()
  expect(container.textContent).toContain('a.b: 1')
  setValue({ 'a.b': 1, a: { b: { deep: true } }, count: 2 })
  flush()
  expect(trigger('doc["a"]').getAttribute('aria-expanded')).toBe('true')
  expect(container.textContent).toContain('count: 2')
})
