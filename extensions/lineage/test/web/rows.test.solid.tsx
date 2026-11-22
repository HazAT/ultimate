import type { EntryRecord } from '@earendil-works/pi-durable'
import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { expect, it, vi } from 'vitest'
import { createTranscriptFrame, ROOT, Transcript } from '@/sdk/solid'
import { parseConversationId, parseEntryId } from '../../../../lib/ids.ts'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { RememberCall } from '../../calls.solid.tsx'
import { BranchedEntry } from '../../entries.ts'
import { AbstractEntry } from '../../refs.ts'
import { Abstract, Branched, Note } from '../../rows.solid.tsx'

const { switchConversation, overviewState } = vi.hoisted(() => ({
  switchConversation: vi.fn<typeof import('@/sdk/solid').switchConversation>(),
  overviewState: {
    conversations: {},
  },
}))
vi.mock('@/sdk/solid', async (original) => ({
  ...(await original<typeof import('@/sdk/solid')>()),
  switchConversation,
}))
vi.mock('../../../conversations/ui.solid.tsx', async (original) => ({
  ...(await original<typeof import('../../../conversations/ui.solid.tsx')>()),
  useOverview: () => () => overviewState.conversations,
}))

const agent = createAgent()

it('renders repeated branch and abstract rows by entry, and lets an agent open a branch', async () => {
  const branch = parseConversationId(42)
  const at = parseEntryId(9)
  const entry = (id: number, kind: string, data: EntryRecord['data']): EntryRecord => ({
    id: parseEntryId(id),
    conversationId: ROOT,
    kind,
    data,
  })
  const branched = (id: number) =>
    entry(id, BranchedEntry.kind, { branch, at, intent: 'Write notes' })
  const abstract = (id: number) =>
    entry(id, AbstractEntry.kind, {
      conversation: branch,
      at,
      text: 'Notes drafted',
      title: 'Write notes',
    })
  const note = entry(25, 'lineage.note', { from: branch, text: 'The notes are ready.' })
  const { frame } = createTranscriptFrame()
  const view = renderSolid(() => (
    <Transcript value={frame}>
      <Branched core={null} entry={branched(21)} />
      <Branched core={null} entry={branched(22)} />
      <Abstract core={null} entry={abstract(23)} />
      <Abstract core={null} entry={abstract(24)} />
      <Note core={null} entry={note} />
    </Transcript>
  ))
  await settle()
  expect(view.querySelectorAll(`[data-lineage-branched="${branch}"]`)).toHaveLength(2)
  expect(view.querySelectorAll(`[data-lineage-abstract="${branch}"]`)).toHaveLength(2)
  expect(view.querySelector('[data-abstract-stale="true"]')).toBeNull()
  expect(view.querySelector('[data-lineage-note="received"]')?.textContent).toContain(
    'The notes are ready.',
  )
  await expectDistinctAgentNames(agent)

  const control = agent
    .snapshot()
    .find((row) => !row.offPage && row.label === `Open #${branch} (branched at entry 22)`)
  expect(control).toBeDefined()
  expect(await agent.act({ steps: [{ ref: control!.ref, action: 'press' }] })).toMatchObject({
    ok: true,
  })
  expect(switchConversation).toHaveBeenCalledExactlyOnceWith(branch)
})

it('summarizes the changes in a remember call', () => {
  const view = renderSolid(() => (
    <RememberCall
      call={{
        id: 'remember-1',
        name: 'remember',
        status: 'done',
        args: {
          ops: [
            { op: 'add', slug: 'workspace' },
            { op: 'update', slug: 'layout' },
            { op: 'delete', slug: 'old-layout' },
          ],
        },
        output: '',
        diagnostics: [],
        images: [],
      }}
      core={null}
    />
  ))
  expect(view.querySelector('[data-ui="tool"]')?.textContent).toContain(
    'Memory · added 1 · updated 1 · deleted 1',
  )
})

it('marks an open abstract out of date when the branch summary failed', async () => {
  const branch = parseConversationId(43)
  const at = parseEntryId(12)
  const entry: EntryRecord = {
    id: parseEntryId(31),
    conversationId: ROOT,
    kind: AbstractEntry.kind,
    data: {
      conversation: branch,
      at,
      text: 'Earlier state',
      title: 'Branch work',
    },
  }
  overviewState.conversations = { [branch]: { summaryStatus: 'error', assessmentStatus: 'error' } }
  try {
    const { frame } = createTranscriptFrame()
    const view = renderSolid(() => (
      <Transcript value={frame}>
        <Abstract core={null} entry={entry} />
      </Transcript>
    ))
    await settle()
    expect(view.querySelector('[data-abstract-stale="true"]')?.textContent).toContain('out of date')
    await expectDistinctAgentNames(agent)
  } finally {
    overviewState.conversations = {}
  }
})
