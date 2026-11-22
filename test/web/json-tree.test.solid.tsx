import { createSignal, flush } from 'solid-js'
import { expect, it } from 'vitest'
import { JsonTree } from '../../web/src/components/json-tree.solid.tsx'
import { renderSolid } from './solid-dom-setup.ts'

it('keeps a branch the reader opened open while a sibling updates, and names dotted keys apart', () => {
  const [value, setValue] = createSignal<unknown>({
    'a.b': { flat: true },
    a: { b: { deep: true } },
    count: 1,
  })
  const container = renderSolid(() => <JsonTree name="doc" open={1} value={value()} />)
  const trigger = (name: string) =>
    [...container.querySelectorAll('button')].find(
      (button) => button.getAttribute('aria-label') === `Inspect ${name}`,
    )!
  trigger('doc["a"]').click()
  flush()
  trigger('doc["a.b"]').click()
  trigger('doc["a"]["b"]').click()
  flush()
  expect(trigger('doc["a.b"]')).not.toBe(trigger('doc["a"]["b"]'))
  expect(container.textContent).toContain('flat: true')
  expect(container.textContent).toContain('deep: true')
  setValue({ 'a.b': { flat: true }, a: { b: { deep: true } }, count: 2 })
  flush()
  expect(trigger('doc["a"]').getAttribute('aria-expanded')).toBe('true')
  expect(container.textContent).toContain('count: 2')
})
