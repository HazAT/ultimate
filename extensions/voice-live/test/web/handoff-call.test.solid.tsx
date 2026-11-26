import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import type { ToolCallView } from '@/sdk/solid'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'

const opened = vi.hoisted(() => [] as number[])
vi.mock('@/sdk/solid', async (original) => ({
  ...(await original<typeof import('@/sdk/solid')>()),
  switchConversation: (id: number) => opened.push(id),
  useConversationId: () => () => 40,
  useDocOf: (_id: unknown, ref: { kind: string }) => () =>
    ref.kind === 'voice.fork' ? { of: 7 } : undefined,
}))

import { HandoffCall } from '../../handoff.solid.tsx'

const agent = createAgent()
const brief = { title: 'Omacut hangs', outcome: 'Capture its state, then fix it', instruction: 'I' }
const call = (id: string, patch: Partial<ToolCallView>): ToolCallView => ({
  id,
  name: 'voice_handoff',
  args: brief,
  status: 'done',
  output: 'Sent to @ultimate.',
  images: [],
  diagnostics: [],
  ...patch,
})

it('a voice_handoff call shows what went where, opens the target, and shows a refusal', async () => {
  const root = renderSolid(() => (
    <>
      <HandoffCall call={call('call-ultimate', {})} core={null} />
      <HandoffCall
        call={call('call-branch', { args: { ...brief, to: 55 }, output: 'Sent to #55.' })}
        core={null}
      />
      <HandoffCall
        call={call('call-refused', {
          args: { ...brief, to: 9 },
          status: 'error',
          output: '',
          diagnostics: [{ severity: 'error', message: '#9 is not a branch on the screen' }],
        })}
        core={null}
      />
    </>
  ))
  flush()
  const [ultimate, branch, refused] = root.querySelectorAll('[data-voice-handoff]')
  expect(ultimate.textContent).toContain('Omacut hangs')
  expect(ultimate.textContent).toContain('Capture its state, then fix it')
  expect(ultimate.textContent).toContain('sent to @ultimate')
  expect(branch.textContent).toContain('sent to #55')
  expect(refused.textContent).toContain('#9 is not a branch on the screen')
  expect(refused.textContent).toContain('not sent')

  await expectDistinctAgentNames(agent)
  await agent.act({
    steps: [
      { ref: 'Open @ultimate that handoff call-ultimate went to', action: 'press' },
      { ref: 'Open #55 that handoff call-branch went to', action: 'press' },
    ],
  })
  expect(opened).toEqual([7, 55])
})
