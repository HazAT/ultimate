import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { createSignal, flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolImage,
  ToolOutput,
} from '@/components/ai/tool.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import { expectDistinctAgentNames } from './agent-names.ts'
import { renderSolid } from './solid-dom-setup.ts'

const agent = createAgent()

function refFor(label: string) {
  const matches = agent.snapshot().filter((entry) => !entry.offPage && entry.label === label)
  expect(matches).toHaveLength(1)
  return matches[0].ref
}

it('opens tool output by the visible header label without activating the separate action', async ({
  onTestFinished,
}) => {
  const [open, setOpen] = createSignal(false)
  const opened = vi.fn<(next: boolean, source: string) => void>()
  const pressed = vi.fn<() => void>()
  const container = renderSolid(() => (
    <Tool
      onOpenChange={(next, details) => {
        opened(next, details.source)
        setOpen(next)
      }}
      open={open()}
    >
      <ToolHeader
        action={<Button onClick={pressed}>Copy report</Button>}
        name="Read report"
        state="done"
        title={<em>Summary</em>}
      />
      <ToolContent>
        <ToolOutput output={'\x1b[1;31mReport contents\x1b[0m <img>'} />
      </ToolContent>
    </Tool>
  ))
  const changes = vi.fn<Parameters<typeof agent.subscribe>[0]>()
  onTestFinished(agent.subscribe(changes))
  await settle()
  expect(container.querySelector('pre')).toBeNull()
  const trigger = container.querySelector('[data-slot="collapsible-trigger"]')
  expect(trigger?.nextElementSibling?.textContent).toBe('Copy report')

  const result = await agent.act({
    steps: [{ ref: refFor('Read report Summary'), action: 'setOpen', args: [true] }],
  })
  expect(result.ok).toBe(true)
  flush()
  await settle()
  await expectDistinctAgentNames(agent)
  const output = container.querySelector('[data-ui="tool"][data-open] pre')
  expect(output?.textContent).toBe('Report contents <img>')
  expect(output?.querySelector('img')).toBeNull()
  expect(output?.querySelector<HTMLElement>('span[style]')?.style.fontWeight).toBe('bold')
  expect(pressed).not.toHaveBeenCalled()
  expect(opened).toHaveBeenCalledExactlyOnceWith(true, 'agent')
  expect(changes).toHaveBeenCalledWith(
    expect.objectContaining({ key: 'open', value: true, source: 'agent' }),
  )
})

it('opens the named image zoom and shows the titled dialog', async ({ onTestFinished }) => {
  const image = {
    data: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    mimeType: 'image/gif',
  }
  const container = renderSolid(() => <ToolImage alt="Build diagram" image={image} />)
  const changes = vi.fn<Parameters<typeof agent.subscribe>[0]>()
  onTestFinished(agent.subscribe(changes))
  await settle()
  expect(container.querySelector('[role="dialog"]')).toBeNull()

  const result = await agent.act({
    steps: [{ ref: refFor('Zoom Build diagram'), action: 'setOpen', args: [true] }],
  })
  expect(result.ok).toBe(true)
  flush()
  await settle()
  await expectDistinctAgentNames(agent)
  const dialog = container.querySelector('[role="dialog"][data-open]')
  expect(dialog?.querySelector('img')?.getAttribute('src')).toBe(
    `data:image/gif;base64,${image.data}`,
  )
  const titleId = dialog?.getAttribute('aria-labelledby')
  expect(titleId && document.getElementById(titleId)?.textContent).toBe('Build diagram')
  expect(changes).toHaveBeenCalledWith(
    expect.objectContaining({ key: 'open', value: true, source: 'agent' }),
  )
})
