import type { EntryRecord } from '@earendil-works/pi-durable'
import { createAgent } from '@ui-sdk/solid/agent'
import { expect, it } from 'vitest'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { createTranscriptFrame, Transcript } from '@/sdk/solid'
import { RecallBubble } from '../../bubble.solid.tsx'

const agent = createAgent()

it('shows the memories recalled for a message as chips that keep their slug and name the message', () => {
  const user = { id: 9, kind: 'pi.user' } as EntryRecord
  const recalled = {
    id: 10,
    kind: 'recall.memories',
    data: { input: 9, root: 1, memories: [{ slug: 'ui-taste', line: 'quiet', confidence: 1 }] },
  } as unknown as EntryRecord
  const { frame } = createTranscriptFrame(() => [user, recalled])
  const container = renderSolid(() => (
    <Transcript value={frame}>
      <RecallBubble entry={user} />
    </Transcript>
  ))
  expect(container.querySelector('[data-recall-memory="ui-taste"]')?.tagName).toBe('BUTTON')
  expect(
    agent
      .snapshot()
      .filter((entry) => !entry.offPage)
      .map((entry) => entry.label),
  ).toEqual(['Open recalled memory ui-taste from message #9'])
})
