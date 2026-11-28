import { expect, it } from 'vitest'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import { createUiAgent } from '../../web/src/sdk/agent.ts'
import { renderSolid } from './solid-dom-setup.ts'

// Side chat's `ui` act on 'System' had no exact-label resolution: ui-sdk refuses the label as naming two
// components while a transcript row 'Read live-system.png' sits open beside the System button.
it('acts on the control a label names exactly, beside an open one holding it as a word', async () => {
  let pressed = 'none'
  renderSolid(() => (
    <>
      <Button aria-label="System" onClick={() => (pressed = 'system')}>
        System
      </Button>
      <Collapsible defaultOpen aria-label="Read live-system.png">
        <CollapsibleTrigger>read live-system.png</CollapsibleTrigger>
        <CollapsibleContent>image</CollapsibleContent>
      </Collapsible>
    </>
  ))
  const result = await createUiAgent().act({ steps: [{ ref: 'System', action: 'press' }] })
  expect(result).toMatchObject({ ok: true })
  expect(pressed).toBe('system')
})
