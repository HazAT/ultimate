/** @jsxImportSource @solidjs/web */
import { createAgent } from '@ui-sdk/solid/agent'
import { createSignal, flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { Toggle, ToggleGroup } from '@/components/ui/toggle.solid.tsx'
import { writerNow } from '../../web/src/sdk/writer.ts'
import { expectDistinctAgentNames } from './agent-names.ts'
import { renderSolid } from './solid-dom-setup.ts'

const agent = createAgent()

it('reports pressed state and attributes accepted changes to the agent', async () => {
  const [pressed, setPressed] = createSignal(false)
  const writes = vi.fn<(pressed: boolean, source: string) => void>()
  const changed = vi.fn<(pressed: boolean, source: string, writer: string) => void>()
  const container = renderSolid(() => (
    <Toggle
      bind={[
        pressed,
        (on) => {
          writes(on, writerNow())
          setPressed(on)
        },
      ]}
      onPressedChange={(on, details) => {
        changed(on, details.source, writerNow())
        if (!on) details.cancel()
      }}
      size="xs"
    >
      Star document
    </Toggle>
  ))
  await expectDistinctAgentNames(agent)
  const toggle = () =>
    agent.snapshot().find((entry) => !entry.offPage && entry.label === 'Star document')
  expect(toggle()).toMatchObject({
    pressed: false,
    actions: expect.arrayContaining(['setPressed']),
  })
  const ref = toggle()!.ref
  const button = container.querySelector('button')!
  expect(button.dataset.variant).toBe('ghost')
  expect(button.dataset.size).toBe('xs')
  const result = await agent.act({ steps: [{ ref, action: 'setPressed', args: [true] }] })
  expect(result.ok).toBe(true)
  flush()
  expect(toggle()?.pressed).toBe(true)
  expect(button.getAttribute('aria-pressed')).toBe('true')

  await agent.act({ steps: [{ ref, action: 'setPressed', args: [false] }] })
  flush()
  expect(toggle()?.pressed).toBe(true)
  expect(changed.mock.calls).toEqual([
    [true, 'agent', 'agent'],
    [false, 'agent', 'agent'],
  ])
  expect(writes).toHaveBeenCalledExactlyOnceWith(true, 'agent')
})

it('binds grouped toggles through the group change callback', async () => {
  const [formats, setFormats] = createSignal<string[]>(['italic'])
  const writes = vi.fn<(value: string[], source: string) => void>()
  const container = renderSolid(() => (
    <ToggleGroup
      aria-label="Text formatting"
      multiple
      bind={[
        formats,
        (value) => {
          writes(value, writerNow())
          setFormats(value)
        },
      ]}
    >
      <Toggle value="bold">Bold</Toggle>
      <Toggle value="italic">Italic</Toggle>
    </ToggleGroup>
  ))
  await expectDistinctAgentNames(agent)
  const bold = agent.snapshot().find((entry) => !entry.offPage && entry.label === 'Bold')
  expect(bold).toMatchObject({ pressed: false, actions: expect.arrayContaining(['setPressed']) })
  const result = await agent.act({
    steps: [{ ref: bold!.ref, action: 'setPressed', args: [true] }],
  })
  expect(result.ok).toBe(true)
  flush()
  expect(writes).toHaveBeenCalledExactlyOnceWith(['bold', 'italic'], 'agent')
  expect(container.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(2)
})
