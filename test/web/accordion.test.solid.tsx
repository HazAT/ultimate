import { createAgent } from '@ui-sdk/solid/agent'
import { createSignal, flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
} from '@/components/ui/accordion.solid.tsx'
import { writerNow } from '../../web/src/sdk/writer.ts'
import { expectDistinctAgentNames } from './agent-names.ts'
import { renderSolid } from './solid-dom-setup.ts'

const agent = createAgent()

it('opens and closes a named accordion section with attributed writes', async () => {
  const [open, setOpen] = createSignal<string[]>([])
  const writes = vi.fn<(value: string[], source: string) => void>()
  const changed = vi.fn<(expanded: boolean, source: string, writer: string) => void>()
  const container = renderSolid(() => (
    <Accordion
      aria-label="Order help"
      bind={[
        open,
        (value) => {
          writes(value, writerNow())
          setOpen(value)
        },
      ]}
    >
      <AccordionItem
        value="shipping"
        onOpenChange={(expanded, details) => changed(expanded, details.source, writerNow())}
      >
        <AccordionHeader>
          <AccordionTrigger>Shipping</AccordionTrigger>
        </AccordionHeader>
        <AccordionPanel>Delivery takes five days.</AccordionPanel>
      </AccordionItem>
    </Accordion>
  ))
  await expectDistinctAgentNames(agent)
  const accordion = agent.snapshot().find((entry) => !entry.offPage && entry.label === 'Order help')
  expect(accordion).toMatchObject({
    value: [],
    actions: expect.arrayContaining(['open', 'close']),
    items: expect.arrayContaining([
      expect.objectContaining({ label: 'Shipping', value: 'shipping' }),
    ]),
  })
  const ref = accordion!.ref
  const shipping = accordion!.items!.find((item) => item.label === 'Shipping')!.value
  const trigger = container.querySelector('button')!
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  const opened = await agent.act({ steps: [{ ref, action: 'open', args: [shipping] }] })
  expect(opened.ok).toBe(true)
  flush()
  expect(trigger.hasAttribute('data-open')).toBe(true)
  expect(container.textContent).toContain('Delivery takes five days.')

  const closed = await agent.act({ steps: [{ ref, action: 'close', args: [shipping] }] })
  expect(closed.ok).toBe(true)
  flush()
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(writes.mock.calls).toEqual([
    [['shipping'], 'agent'],
    [[], 'agent'],
  ])
  expect(changed.mock.calls).toEqual([
    [true, 'agent', 'agent'],
    [false, 'agent', 'agent'],
  ])
})
