import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { parseConversationId, parseEntryId } from '../../../../lib/ids.ts'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { Player } from '../../player.solid.tsx'

vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  return { store: createStore(), uiState: createUiState(undefined) }
})
vi.mock('../../frames.solid.tsx', () => ({
  imageOf: async (): Promise<string> => 'data:image/png;base64,AA==',
}))

const agent = createAgent()

it('shows the inline answer on the last paused screenshot and hides it on resume', async () => {
  const conversation = parseConversationId(2)
  const frames = ['First screenshot', 'Second screenshot'].map((step, index) => ({
    conversation,
    entry: parseEntryId(index + 1),
    image: 0,
    step,
    agent: 'worker',
    count: 1,
  }))
  const close = vi.fn<(open: boolean) => void>()
  const container = renderSolid(() => (
    <Player
      answer={() => <span>Answer here</span>}
      earlier={0}
      frames={frames}
      onOpenChange={close}
      title="A branch"
    />
  ))
  expect(container.querySelector('[data-reel-answer]')).toBeNull()
  await expectDistinctAgentNames(agent)
  const second = agent
    .snapshot()
    .find((item) => !item.offPage && item.label === 'Reel frame 2: Second screenshot')
  expect(await agent.act({ steps: [{ ref: second!.ref, action: 'press' }] })).toMatchObject({
    ok: true,
  })
  flush()
  expect(container.querySelector('[data-reel-answer]')?.textContent).toBe('Answer here')
  container.querySelector<HTMLButtonElement>('[aria-label="Play reel"]')!.click()
  flush()
  expect(container.querySelector('[data-reel-answer]')).toBeNull()
  container.querySelector<HTMLButtonElement>('[aria-label="Close reel"]')!.click()
  expect(close).toHaveBeenCalledWith(false)
})
