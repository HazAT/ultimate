import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { ConversationScope, type ToolCallView } from '@/sdk/solid'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'

const shown = vi.hoisted(() => [] as unknown[])
vi.mock('@/sdk/solid', async (original) => ({
  ...(await original<typeof import('@/sdk/solid')>()),
  showSurface: (surface: string) => shown.push(surface),
  switchConversation: (id: number) => shown.push(id),
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
  const branch = call('call-branch', { args: { ...brief, to: 55 }, output: 'Sent to #55.' })
  const root = renderSolid(() => (
    <>
      <HandoffCall call={call('call-ultimate', {})} core={null} />
      <HandoffCall call={branch} core={null} />
      <ConversationScope value={40 as never}>
        <HandoffCall call={branch} core={null} />
      </ConversationScope>
      <HandoffCall
        call={call('call-refused', {
          args: { ...brief, to: 9 },
          status: 'error',
          output: '',
          diagnostics: [{ severity: 'error', message: '#9 is not a branch on the screen' }],
        })}
        core={null}
      />
      <HandoffCall
        call={call('call-result-only', { args: {}, output: 'Sent to #55.' })}
        core={<p data-core-card>core</p>}
      />
    </>
  ))
  flush()
  const [ultimate, sent, , refused] = root.querySelectorAll('[data-voice-handoff]')
  expect(ultimate.textContent).toContain('Omacut hangs')
  expect(ultimate.textContent).toContain('Capture its state, then fix it')
  expect(ultimate.textContent).toContain('sent to @ultimate')
  expect(sent.textContent).toContain('sent to #55')
  expect(refused.textContent).toContain('#9 is not a branch on the screen')
  expect(refused.textContent).toContain('not sent')
  expect(root.querySelectorAll('[data-voice-handoff]')).toHaveLength(4)
  expect(root.querySelector('[data-core-card]')).not.toBeNull()

  await expectDistinctAgentNames(agent)
  await agent.act({
    steps: [
      {
        ref: 'Open @ultimate that handoff call-ultimate went to, in the transcript',
        action: 'press',
      },
      { ref: 'Open #55 that handoff call-branch went to, in the voice dock', action: 'press' },
    ],
  })
  expect(shown).toEqual(['agent', 7, 'agent', 55])
})
