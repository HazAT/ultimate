import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  configure,
  createRegistry,
  Harness,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord'
import type { ConversationId, TaskGraphNode, TaskId, Tx } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import type { ActionContext } from '../server/actions.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { Standing } from '../extensions/subagents/api.ts'
import dream, {
  actions,
  decide,
  fileJournal,
  journalText,
  landed,
  reachable,
  reportPass,
  Sessions,
  startDreamIn,
  startSession,
  toolStats,
} from '../extensions/dream/server.ts'
import { busyElsewhere, working } from '../extensions/dream/types.ts'
import { git } from '../lib/git.ts'
import { temp, until } from './helpers.ts'

/** A transaction over plain documents, keyed by kind and conversation. */
function fakeTx() {
  const docs = new Map<string, object>()
  return {
    doc: async (
      { definition: def }: { definition: { kind: string; initial: () => object } },
      id: number,
    ) => {
      const key = `${def.kind}:${id}`
      if (!docs.has(key)) docs.set(key, def.initial())
      return docs.get(key)
    },
  } as unknown as Tx
}
const session = async (tx: Tx, id = 1) =>
  (await tx.doc(Sessions, 1 as never)).sessions.find((item) => item.id === id)!

const journal = {
  session: 1,
  learned: ['I learned to read the trace.', 'I keep editing stale text.', "I'd like a diff tool."],
  text: '## Memory\nNothing stale.',
  proposals: [
    {
      id: 'fast-default',
      pass: 'codify',
      title: 'Default fast for Sol',
      size: 'S',
      retire: 'sol-runs-fast',
    },
    { id: 'drop-stale', pass: 'memory', title: 'Delete memory demo', risk: 'none' },
  ],
}

it('lets one session run at a time, with every pass waiting', async () => {
  const tx = fakeTx()
  expect(await startSession(tx, 10)).toBe(1)
  expect((await session(tx)).passes).toEqual({
    memory: { status: 'waiting' },
    failures: { status: 'waiting' },
    tools: { status: 'waiting' },
    corrections: { status: 'waiting' },
    codify: { status: 'waiting' },
    project: { status: 'waiting' },
  })
  await expect(startSession(tx, 11)).rejects.toThrow('Dream session 1 is still open')
})

it('names the first pass reporter the dreamer and refuses unknown passes', async () => {
  const tx = fakeTx()
  await startSession(tx, 1)
  await reportPass(tx, { session: 1, pass: 'tools', status: 'running' }, 40)
  await reportPass(tx, { session: 1, pass: 'tools', status: 'done', note: '12 unused' }, 41)
  const found = await session(tx)
  expect(found.dreamer).toBe(40)
  expect(found.passes.tools).toEqual({ status: 'done', note: '12 unused' })
  await expect(reportPass(tx, { session: 1, pass: 'dreams', status: 'done' }, 40)).rejects.toThrow(
    'pass must be one of',
  )
  await expect(reportPass(tx, { session: 2, pass: 'tools', status: 'done' }, 40)).rejects.toThrow(
    'No dream session 2',
  )
})

it('files the journal once, validating its three lines and proposal ids', async () => {
  const tx = fakeTx()
  await startSession(tx, 1)
  await expect(fileJournal(tx, { ...journal, learned: ['one'] }, 2)).rejects.toThrow('3 lines')
  await expect(
    fileJournal(tx, { ...journal, proposals: [journal.proposals[0], journal.proposals[0]] }, 2),
  ).rejects.toThrow('unique slug')
  const { found, filed } = await fileJournal(tx, journal, 2)
  expect(filed).toBe(true)
  expect(found.proposals.map((item) => [item.id, item.status, item.retire])).toEqual([
    ['fast-default', 'open', 'sol-runs-fast'],
    ['drop-stale', 'open', undefined],
  ])
  // A second filing (a retried action) keeps the first.
  expect((await fileJournal(tx, { ...journal, text: 'other' }, 3)).filed).toBe(false)
  expect((await session(tx)).journal?.text).toBe(journal.text)
  expect(journalText(await session(tx))).toContain(
    '- fast-default [codify] (S): Default fast for Sol — retires memory sol-runs-fast once landed',
  )
})

it('follows approved proposals to landing and ends the session when all are settled', async () => {
  const tx = fakeTx()
  await startSession(tx, 1)
  await fileJournal(tx, journal, 2)
  await expect(
    decide(tx, { session: 1, proposal: 'fast-default', status: 'approved' }, 3),
  ).rejects.toThrow('branch must be a positive integer')
  await decide(tx, { session: 1, proposal: 'fast-default', status: 'approved', branch: 77 }, 3)
  await decide(tx, { session: 1, proposal: 'drop-stale', status: 'applied' }, 4)
  expect((await session(tx)).endedAt).toBeUndefined()
  await landed(tx, 99, 'abc', 5)
  expect((await session(tx)).proposals[0].status).toBe('approved')
  await landed(tx, 77, 'def', 6)
  const found = await session(tx)
  expect(found.proposals[0]).toMatchObject({ status: 'landed', sha: 'def' })
  expect(found.endedAt).toBe(6)
  await expect(reportPass(tx, { session: 1, pass: 'tools', status: 'done' }, 1)).rejects.toThrow(
    'has ended',
  )
  expect(await startSession(tx, 7)).toBe(2)
})

it('lands a proposal by a sha reachable from HEAD and refuses an unreachable or unknown one', async () => {
  const repo = await temp()
  await git(repo, 'init', '-q', '-b', 'main')
  const commit = async (message: string) => {
    await git(
      repo,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      message,
    )
    return git(repo, 'rev-parse', 'HEAD')
  }
  const merged = await commit('fix')
  await git(repo, 'checkout', '-q', '-b', 'side')
  const aside = await commit('aside')
  await git(repo, 'checkout', '-q', 'main')
  expect(await reachable(repo, merged.slice(0, 8))).toBe(merged)
  await expect(reachable(repo, aside)).rejects.toThrow('not reachable from HEAD')
  await expect(reachable(repo, 'deadbeef')).rejects.toThrow('Unknown commit deadbeef')

  const tx = fakeTx()
  await startSession(tx, 1)
  await fileJournal(tx, journal, 2)
  await expect(
    decide(tx, { session: 1, proposal: 'fast-default', status: 'landed', sha: merged }, 3),
  ).rejects.toThrow('must be approved before it lands')
  await decide(tx, { session: 1, proposal: 'fast-default', status: 'approved', branch: 77 }, 3)
  await decide(tx, { session: 1, proposal: 'drop-stale', status: 'rejected' }, 3)
  await decide(tx, { session: 1, proposal: 'fast-default', status: 'landed', sha: merged }, 4)
  const found = await session(tx)
  expect(found.proposals[0]).toMatchObject({ status: 'landed', sha: merged, branch: 77 })
  expect(found.endedAt).toBe(4)
})

it('refuses approved → applied without a reason naming what was written', async () => {
  const tx = fakeTx()
  await startSession(tx, 1)
  await fileJournal(tx, journal, 2)
  await decide(tx, { session: 1, proposal: 'fast-default', status: 'approved', branch: 77 }, 3)
  await expect(
    decide(tx, { session: 1, proposal: 'fast-default', status: 'applied' }, 4),
  ).rejects.toThrow('reason must name what was written')
  const reason = 'files in ~/sk/.ultimate/skills/sk-verify'
  await decide(tx, { session: 1, proposal: 'fast-default', status: 'applied', reason }, 4)
  expect((await session(tx)).proposals[0]).toMatchObject({ status: 'applied', reason })
})

it('settles an ended session in one direction: approved proposals land or apply, nothing reopens', async () => {
  const tx = fakeTx()
  await startSession(tx, 1)
  await fileJournal(
    tx,
    {
      ...journal,
      proposals: [
        ...journal.proposals,
        { id: 'by-branch', pass: 'tools', title: 'Land through a workspace' },
      ],
    },
    2,
  )
  await decide(tx, { session: 1, proposal: 'fast-default', status: 'approved', branch: 77 }, 3)
  await decide(tx, { session: 1, proposal: 'drop-stale', status: 'approved', branch: 78 }, 3)
  await decide(tx, { session: 1, proposal: 'by-branch', status: 'approved', branch: 79 }, 3)
  ;(await session(tx)).endedAt = 4
  await decide(tx, { session: 1, proposal: 'fast-default', status: 'landed', sha: 'abc' }, 5)
  await decide(tx, { session: 1, proposal: 'drop-stale', status: 'applied', reason: 'notes' }, 5)
  for (const status of ['approved', 'rejected'])
    await expect(
      decide(tx, { session: 1, proposal: 'drop-stale', status, branch: 1 }, 6),
    ).rejects.toThrow('has ended')
  expect(await landed(tx, 79, 'def', 7)).toEqual([await session(tx)])
  const found = await session(tx)
  expect(found.proposals.map((item) => [item.id, item.status, item.sha])).toEqual([
    ['fast-default', 'landed', 'abc'],
    ['drop-stale', 'applied', undefined],
    ['by-branch', 'landed', 'def'],
  ])
  expect(found.endedAt).toBe(4)
})

it('returns a journal with no proposals again after its session ended', async () => {
  const tx = fakeTx()
  await startSession(tx, 1)
  await fileJournal(tx, { ...journal, proposals: [] }, 2)
  expect((await session(tx)).endedAt).toBe(2)
  expect((await fileJournal(tx, { ...journal, proposals: [] }, 3)).filed).toBe(false)
})

it('delivers the start and the journal to @ultimate once, through a real harness', async () => {
  const storage = new MemoryStorage()
  const registry = createRegistry()
  const harness = await Harness.open(storage, { models: createModels(), registry }, context)
  await harness.root(context)
  const ultimate = await harness.commit(async (tx) => {
    const created = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    await configure(tx, created.id, {})
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = created.id
    return created.id
  }, context)
  const host = {
    harness: () => harness,
    conversations: () => [],
    need: () => ({ standing: async () => ultimate }),
    react: () => {},
    implement: () => {},
    onOpen: () => {},
    resource: (_key: string, create: () => unknown) => create(),
  } as unknown as ExtensionHost
  registry.install(dream(host))
  const call = { host } as ActionContext
  expect(await harness.commit((tx) => startDreamIn(host, tx), context)).toEqual({ session: 1 })
  const filing = JSON.parse(JSON.stringify(journal)) as JsonValue
  expect(await actions.journal(filing, call)).toEqual({ session: 1, proposals: 2 })
  expect(await actions.journal(filing, call)).toEqual({ session: 1, proposals: 2 })
  // The input starts a run that cannot finish without a model, so the write is admitted but waits in the inbox.
  const submitted = () =>
    harness.commit(
      async (tx) =>
        (
          await Promise.all(
            ['dream.started:1', 'dream.journal:1'].map((id) =>
              tx.submissionByRequest(ultimate, id),
            ),
          )
        ).map((submission) => submission?.type),
      context,
    )
  await until(async () => !(await submitted()).includes(undefined))
  expect(await submitted()).toEqual(['input', 'write'])
  const deliveries = await harness.commit(
    (tx) => tx.scanTasks({ kind: 'dream.deliver' }, 10),
    context,
  )
  expect(deliveries.items).toHaveLength(2)
  await harness.close(context)
})

it('counts top-level conversations at work besides @ultimate', () => {
  expect(
    busyElsewhere(
      [
        { id: 5, busy: true, title: '@ultimate' },
        { id: 8, busy: true, title: 'Fix it' },
        { id: 9, busy: true, parentConversationId: 8 },
        { id: 10, busy: false, title: 'Idle' },
      ],
      5,
    ),
  ).toEqual([{ id: 8, title: 'Fix it' }])
})

it('counts only conversations actively working once given the live tasks', () => {
  const node = (
    id: number,
    conversationId: number,
    state: TaskGraphNode['state'],
    kind = 'pi.generation',
    background = false,
  ): TaskGraphNode => ({
    id: id as TaskId,
    kind,
    conversationId: conversationId as ConversationId,
    background,
    abortRequested: false,
    state,
    conversations: [],
  })
  const waits = (on: number) =>
    ({ status: 'waiting', phase: 'tools', on: [on as TaskId], policy: 'failFast' }) as const
  const running = { status: 'running', phase: 'execute' } as const
  const tasks = Object.fromEntries(
    [
      // 8 waits on its worker 30's run; 9 on its own running tool; 10 answers; 11 only has background work; 12 sleeps.
      node(1, 8, waits(7)),
      node(7, 30, running),
      node(2, 9, waits(3)),
      node(3, 9, running, 'pi.tool'),
      node(4, 10, { status: 'running', phase: 'request' }),
      node(5, 11, running, 'dream.handoff-wait', true),
      node(6, 12, { status: 'sleeping', phase: 'retry', until: 1 }),
    ].map((item) => [item.id, item]),
  )
  const conversations = [8, 9, 10, 11, 12].map((id) => ({ id, busy: true, title: `#${id}` }))
  conversations.push({ id: 30, busy: true, title: 'Worker', parentConversationId: 8 } as never)
  expect(busyElsewhere(conversations, 5, tasks).map((item) => item.id)).toEqual([9, 10])
  // A running worker works, though it is not top-level; without the tasks every busy one counts, as a switch needs.
  expect(working(tasks, 30)).toBe(true)
  expect(working(tasks, 8)).toBe(false)
  expect(busyElsewhere(conversations, 5).map((item) => item.id)).toEqual([8, 9, 10, 11, 12])
})

it('reads tool numbers from the trace, with unused tools and frequent errors', async () => {
  const file = join(await temp(), 'trace.sqlite')
  const db = new DatabaseSync(file)
  db.exec(
    'CREATE TABLE calls (id TEXT, at REAL, ms REAL, kind TEXT, name TEXT, ok INTEGER, error TEXT)',
  )
  const insert = db.prepare('INSERT INTO calls VALUES (?, ?, ?, ?, ?, ?, ?)')
  insert.run('1', 100, 10, 'tool', 'edit', 1, null)
  insert.run('2', 200, 30, 'tool', 'edit', 0, 'Could not find the exact text')
  insert.run('3', 300, 5, 'tool', 'read', 1, null)
  insert.run('4', 50, 5, 'action', 'dream/stats', 1, null)
  db.close()
  expect(toolStats(file, ['edit', 'read', 'notify'])).toEqual({
    since: 100,
    calls: 3,
    tools: [
      { name: 'edit', calls: 2, failed: 1, avgMs: 20 },
      { name: 'read', calls: 1, failed: 0, avgMs: 5 },
    ],
    unused: ['notify'],
    errors: [{ name: 'edit', error: 'Could not find the exact text', count: 1 }],
  })
  expect(toolStats(join(await temp(), 'none.sqlite'), ['read']).unused).toEqual(['read'])
})
