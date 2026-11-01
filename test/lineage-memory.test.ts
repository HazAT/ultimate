import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import {
  CompactionTask,
  configure,
  defineExtension,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  applyMemoryOps,
  Memory,
  MEMORY_LIMIT,
  MEMORIZE_TOKENS,
  normalizeMemoryOp,
  parseMemoryOps,
} from '../extensions/lineage/memory.ts'
import { Seen } from '../extensions/lineage/catchup.ts'
import { abstract, Tally } from '../extensions/lineage/server.ts'
import { Roots } from '../extensions/lineage/api.ts'
import { estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate'
import { Standing } from '../extensions/subagents/api.ts'
import { SubmissionLanded } from '../extensions/workspaces/api.ts'
import type { LandedData } from '../extensions/workspaces/api.ts'
import { emit, EventFeed, EventLog } from '../server/events.ts'
import { context } from '../server/harness.ts'
import { branchProbe, fauxServer, post, seedTally, sourceCopy, temp, until } from './helpers.ts'
import { anchor } from './lineage-fixture.ts'

let ultimateRoot: string
beforeAll(async () => {
  ultimateRoot = await sourceCopy(await temp())
  await branchProbe(ultimateRoot)
  // The default summary model is faux's own on a faux server.
  await writeFile(join(ultimateRoot, '.ultimate/settings.json'), JSON.stringify({}))
})
type Server = Awaited<ReturnType<typeof fauxServer>>
const servers: Server[] = []
afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const textOf = (content: unknown) =>
  typeof content === 'string'
    ? content
    : ((content ?? []) as { type: string; text?: string }[])
        .flatMap((part) => (part.type === 'text' ? [part.text!] : []))
        .join('')

/** A faux server that echoes; memorize requests answer `state.memorize` and are counted. */
async function fixture(settings?: object) {
  const home = await temp('ultimate-memory-')
  if (settings) {
    await mkdir(join(home, '.ultimate'), { recursive: true })
    await writeFile(join(home, '.ultimate/settings.json'), JSON.stringify(settings))
  }
  const server = await fauxServer({ ultimateRoot, home, userHome: home })
  servers.push(server)
  const state = {
    memorize: '{"ops":[]}',
    // Answers to the next memorize requests, before `memorize`; `length` ends one cut off at the output budget.
    queued: [] as (string | { text: string; stopReason: 'length' })[],
    asked: [] as string[],
    // The output budget of each memorize request.
    budgets: [] as (number | undefined)[],
    condensed: [] as string[],
    // Holds a compaction's summary request until it resolves.
    gate: undefined as Promise<void> | undefined,
  }
  const route: FauxResponseFactory = async (transcript, options) => {
    server.host.faux!.appendResponses([route])
    const [system, first] = transcript.messages
    if (system?.role === 'system' && textOf(system.content).startsWith('You keep a software')) {
      state.asked.push(textOf(first.content))
      state.budgets.push(options?.maxTokens)
      const answer = state.queued.shift() ?? state.memorize
      return typeof answer === 'string'
        ? fauxAssistantMessage(answer)
        : fauxAssistantMessage(answer.text, { stopReason: answer.stopReason })
    }
    if (system?.role === 'system' && textOf(system.content).startsWith('You condense')) {
      state.condensed.push(textOf(first.content))
      await state.gate
    }
    // Titles, reply summaries and compactions carry a system prompt of their own.
    if (system?.role === 'system' && textOf(system.content)) return fauxAssistantMessage('{}')
    const last = transcript.messages.findLast((message) => message.role === 'user')
    return fauxAssistantMessage(`echo ${textOf(last?.content)}`)
  }
  server.host.faux!.setResponses([route])
  await seedTally(server.harness)
  return { server, state }
}

const memories = async (server: Server, root = ROOT_CONVERSATION_ID) =>
  (await server.harness.snapshot(Memory, root, context))?.memories ?? {}
const apply = (server: Server, ops: unknown[], root = 1) =>
  server.harness.commit((tx) => applyMemoryOps(tx, root, ops, Date.UTC(2026, 9, 21)), context)
const add = (slug: string, line = `About ${slug}`) => ({
  op: 'add',
  slug,
  kind: 'fact',
  line,
  body: `${line}, in full.`,
})
const branch = async (server: Server, prompt: string, from = 1, at?: number) => {
  const { status, data } = await post(server, '/api/extensions/branch-probe/actions/branch', {
    args: { from, prompt, ...(at === undefined ? {} : { at }) },
  })
  expect([status, data.error]).toEqual([200, undefined])
  const id = data.result.id as ConversationId
  const conversation = (await server.harness.conversation(id, context))!
  await conversation.waitForIdle(context)
  return { id, conversation }
}
const tool = (server: Server, name: string) =>
  server.host.registry
    .snapshot()
    .extension('lineage')!
    .tools!.find((candidate) => candidate.name === name)!
const run = async (server: Server, name: string, args: object, caller: number) => {
  const found = tool(server, name)
  const api = {
    conversationId: caller,
    commit: (change: Parameters<typeof server.harness.commit>[0]) =>
      server.harness.commit(change, context),
  } as unknown as Parameters<typeof found.execute>[1]
  const result = await found.execute(args, api, context)
  return textOf(result.output)
}

it.concurrent('applies memory ops atomically and holds the cap', async () => {
  const { server } = await fixture()
  expect(await apply(server, [add('pnpm'), add('node')])).toBe("Added pnpm, node in #1's memory.")
  expect(
    await apply(server, [
      { op: 'update', slug: 'pnpm', line: 'Use pnpm 11' },
      { op: 'delete', slug: 'node' },
    ]),
  ).toBe("updated pnpm; deleted node in #1's memory.")
  expect(await memories(server)).toEqual({
    pnpm: {
      kind: 'fact',
      line: 'Use pnpm 11',
      body: 'About pnpm, in full.',
      updated: Date.UTC(2026, 9, 21),
    },
  })

  // Any invalid op refuses the whole batch: the valid add before it is not written either.
  for (const [ops, error] of [
    [[add('fine'), add('pnpm')], 'pnpm exists'],
    [[add('fine'), { op: 'update', slug: 'missing', line: 'x' }], 'no memory missing'],
    [[add('fine'), { op: 'delete', slug: 'missing' }], 'no memory missing'],
    [[add('fine'), add('Bad_Slug')], 'slug must match'],
    [[add('fine'), add('long', 'x'.repeat(121))], 'line is 121 characters; it must be at most 120'],
    [[add('fine'), { ...add('multi'), line: 'one\ntwo' }], 'one non-empty line'],
    [
      [add('fine'), { ...add('big'), body: 'x'.repeat(2001) }],
      'body is 2001 characters; it must be at most 2000',
    ],
    [[add('fine'), { ...add('odd'), kind: 'opinion' }], 'kind must be'],
  ] as const)
    await expect(apply(server, [...ops])).rejects.toThrow(error)
  expect(Object.keys(await memories(server))).toEqual(['pnpm'])
  await expect(apply(server, [add('x')], 99)).rejects.toThrow('not a listed root')

  // At the cap a further add refuses; a delete and an add in one batch pass.
  await apply(
    server,
    Array.from({ length: MEMORY_LIMIT - 1 }, (_, index) => add(`m-${index}`)),
  )
  expect(Object.keys(await memories(server))).toHaveLength(MEMORY_LIMIT)
  await expect(apply(server, [add('one-more')])).rejects.toThrow('exceed the limit of 150')
  await apply(server, [{ op: 'delete', slug: 'm-0' }, add('one-more')])
  const after = await memories(server)
  expect(Object.keys(after)).toHaveLength(MEMORY_LIMIT)
  expect(after['one-more']).toBeDefined()
  expect(after['m-0']).toBeUndefined()
})

it.concurrent('starts a branch from the memory brief, and without memories from the tally', async () => {
  const { server } = await fixture()
  // Without memories a branch inherits the tally, as before.
  const plain = await branch(server, 'Plain branch')
  const marker = 'TALLY ABSTRACT TEXT'
  await server.harness.commit(
    (tx) => abstract(tx, plain.id, { text: marker, at: 3, title: 'Plain' }),
    context,
  )
  const inherited = await branch(server, 'Inherits the tally')
  expect(JSON.stringify((await inherited.conversation.context(context)).messages)).toContain(marker)

  await apply(server, [add('pnpm', 'Use pnpm for everything')])
  const tip = (await server.harness.commit(
    async (tx) => (await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 1)).items[0].id,
    context,
  )) as number
  const briefed = await branch(server, 'Briefed branch')
  const view = await briefed.conversation.context(context)
  const said = view.messages.filter((message) => message.role !== 'system')
  // The model context begins at the brief, then the identity note and prompt: none of the tally.
  expect(textOf(said[0].content)).toMatch(
    /^<project_memory root="#1">\npnpm \[fact\] — Use pnpm for everything \(updated 2026-10-21\)\n<\/project_memory>\n/,
  )
  expect(textOf(said[0].content)).toContain('ultimate.entries(1)')
  expect(textOf(said[1].content)).toBe(`You are conversation #${briefed.id}.`)
  expect(textOf(said[2].content)).toBe('Briefed branch')
  expect(JSON.stringify(view.messages)).not.toContain(marker)
  expect(view.entries[0]).toMatchObject({ kind: 'pi.reset' })
  // Catch-up starts after the root's tip at the fork, not from the tally's start.
  const seen = await server.harness.snapshot(Seen, briefed.id, context)
  expect(seen?.tally).toBeGreaterThanOrEqual(tip)
  // The brief records the root tip it covers, for forks of this branch.
  expect(view.entries[0]).toMatchObject({ data: { lineage: { brief: { tally: tip } } } })
  // The root's footer counts the brief a branch receives, recounted when memory changes.
  const briefTokens = async () =>
    (await server.harness.snapshot(Tally, ROOT_CONVERSATION_ID, context))?.briefTokens
  await until(async () => (await briefTokens()) === estimateTextTokens(textOf(said[0].content)))
  await apply(server, [{ op: 'delete', slug: 'pnpm' }])
  await until(async () => (await briefTokens()) === undefined)
  const lineage = server.host.registry.snapshot().extension('lineage')!.sections![0]
  expect(
    await lineage.render(
      { conversationId: briefed.id } as Parameters<typeof lineage.render>[0],
      context,
    ),
  ).toContain("starts with your project's memory index")
})

it('finds the one batch of ops in a memorize answer, wrapped or not', () => {
  const ops = [
    { op: 'delete', slug: 'pnpm' },
    { op: 'update', slug: 'git', body: 'a {b} [c]' },
  ]
  const json = JSON.stringify({ ops })
  for (const answer of [
    json,
    `\`\`\`json\n${json}\n\`\`\``,
    `Here is the batch:\n\`\`\`json\n${json}\n\`\`\`\nDone.`,
    `Here is the batch: ${json} — two memories change.`,
    JSON.stringify({ ops, reason: 'the landing replaced pnpm' }),
    JSON.stringify(ops),
    `Ops: ${JSON.stringify(ops)}`,
  ])
    expect(parseMemoryOps(answer)).toEqual(ops)
  expect(parseMemoryOps('{"ops":[]}\nNothing here is worth remembering.')).toEqual([])
  for (const answer of [
    'null',
    '{"op":"delete","slug":"pnpm"}',
    'Sure! Here are the ops: none',
    `\`\`\`json\n${json}\n\`\`\`\n\`\`\`json\n{"ops":[]}\n\`\`\``,
    `${json}\n${json}`,
  ])
    expect(() => parseMemoryOps(answer)).toThrow('expected {"ops": [...]}')
  // A raw newline inside a string is not JSON; the reason names the JSON error so the retry can fix it.
  expect(() => parseMemoryOps('{"ops":[{"op":"update","slug":"git","body":"a\nb"}]}')).toThrow(
    /not valid JSON: .*control character/i,
  )
})

it('normalises what a landing writes: long lines and bodies are cut, slugs kebab-cased', () => {
  const words = (count: number) => Array.from({ length: count }, (_, i) => `w${i}`).join(' ')
  const exact = 'x'.repeat(120)
  expect(normalizeMemoryOp({ op: 'update', slug: 'ok', line: exact })).toEqual({
    op: 'update',
    slug: 'ok',
    line: exact,
  })
  // One over the limit cuts at the last word boundary that fits, ending with an ellipsis.
  const spaced = `${words(30)} ${'y'.repeat(121 - words(30).length - 1)}`
  expect(spaced).toHaveLength(121)
  expect(normalizeMemoryOp({ op: 'update', slug: 'ok', line: spaced })).toEqual({
    op: 'update',
    slug: 'ok',
    line: `${words(30)}…`,
  })
  // Without a usable space the cut is hard, still within the limit.
  const solid = normalizeMemoryOp({ op: 'update', slug: 'ok', line: 'z'.repeat(140) }) as {
    line: string
  }
  expect(solid.line).toBe(`${'z'.repeat(119)}…`)
  expect(solid.line).toHaveLength(120)
  // Whitespace collapses to one line first; a body is cut at its own limit; a bad slug is kebab-cased.
  expect(
    normalizeMemoryOp({
      op: 'add',
      slug: 'Pnpm Only!',
      kind: 'fact',
      line: '  two\n  lines\there ',
      body: `${words(400)} ${'b'.repeat(2000)}`,
    }),
  ).toEqual({
    op: 'add',
    slug: 'pnpm-only',
    kind: 'fact',
    line: 'two lines here',
    body: `${words(400)}…`,
  })
  // What is not a string, or not an object, passes through for applyMemoryOps to refuse.
  expect(normalizeMemoryOp({ op: 'delete', slug: 7 })).toEqual({ op: 'delete', slug: 7 })
  expect(normalizeMemoryOp('nope')).toBe('nope')
})

it.concurrent('forks of a briefed branch inherit the tally tip its brief covers', async () => {
  const { server } = await fixture()
  const older = (await server.harness.commit(
    async (tx) => (await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 1)).items[0].id,
    context,
  )) as number
  await branch(server, 'Moves the root on')
  await apply(server, [add('pnpm')])
  const b = await branch(server, 'Briefed from an older entry', 1, older)
  const [reset] = (await b.conversation.context(context)).entries
  const briefTip = (reset.data as { lineage: { brief: { tally: number } } }).lineage.brief.tally
  expect(briefTip).toBeGreaterThan(older)
  // C's tally position is B's brief tip, so its catch-up does not report the branch the brief already covered.
  const c = await branch(server, 'Fork of the briefed branch', b.id)
  const notes = (
    await server.harness.commit(
      async (tx) =>
        (await tx.scanEntries({ conversationId: c.id, minEntryId: reset.id }, 50)).items,
      context,
    )
  ).filter((entry) => entry.kind === 'lineage.note')
  expect(JSON.stringify(notes)).not.toContain('Moves the root on')
  expect((await server.harness.snapshot(Seen, c.id, context))?.tally).toBeGreaterThan(briefTip)
})

it.concurrent('reads memories with memory; only @ultimate writes them with remember', async () => {
  const { server } = await fixture()
  const { id } = await branch(server, 'Reader')
  expect(await run(server, 'memory', {}, id)).toBe('#1 has no memories yet.')
  // A branch finds the deferred tool with tool_search, so the call itself is refused.
  await expect(run(server, 'remember', { ops: [add('pnpm')] }, id)).rejects.toThrow(
    'Only @ultimate writes project memory',
  )
  expect(await memories(server)).toEqual({})
  const standing = await post(server, '/api/extensions/subagents/actions/standing', {
    args: { name: 'ultimate' },
  })
  const ultimate = standing.data.result as number
  // @ultimate is in no tree: without `root` it writes and reads the project's only root.
  expect(
    await run(
      server,
      'remember',
      { ops: [add('pnpm'), { ...add('lint'), source: '#2/3' }] },
      ultimate,
    ),
  ).toBe("Added pnpm, lint in #1's memory.")
  expect(await run(server, 'memory', {}, ultimate)).toMatch(/^#1's memory \(2\):/)
  await expect(
    run(
      server,
      'remember',
      { root: 1, ops: [add('new'), { op: 'delete', slug: 'gone' }] },
      ultimate,
    ),
  ).rejects.toThrow('no memory gone')
  expect(Object.keys(await memories(server)).toSorted()).toEqual(['lint', 'pnpm'])
  expect(await run(server, 'memory', {}, id)).toMatch(
    /^#1's memory \(2\):\nlint \[fact\] — About lint \(updated \d{4}-\d\d-\d\d\)\npnpm \[fact\]/,
  )
  expect(await run(server, 'memory', { read: 'lint' }, id)).toMatch(
    /^lint \[fact\] — About lint \(updated [\d-]+\)\nSource: #2\/3\n\nAbout lint, in full\.$/,
  )
  await expect(run(server, 'memory', { read: 'nope' }, id)).rejects.toThrow('no memory nope')
  // The user's forget goes through the same write path.
  const forgot = await post(server, '/api/extensions/lineage/actions/forget', {
    args: { root: 1, slug: 'lint' },
  })
  expect(forgot.data.result).toEqual({ summary: "deleted lint in #1's memory." })
  expect(Object.keys(await memories(server))).toEqual(['pnpm'])

  // With no root or several, a caller outside any tree has to name one.
  const setRoots = (roots: number[]) =>
    server.harness.commit(async (tx) => {
      ;(await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots = roots
    }, context)
  await setRoots([1, id])
  await expect(run(server, 'memory', {}, ultimate)).rejects.toThrow(
    `#${ultimate} is in no tree and the project has several roots; name one of #1, #${id}`,
  )
  await expect(run(server, 'remember', { ops: [add('x')] }, ultimate)).rejects.toThrow(
    'several roots',
  )
  expect(await run(server, 'memory', { root: 1 }, ultimate)).toMatch(/^#1's memory \(1\):/)
  await setRoots([])
  await expect(run(server, 'memory', {}, ultimate)).rejects.toThrow(
    `#${ultimate} is in no tree and the project has no root yet`,
  )
})

const landing = (submission: string, conversationId: number): LandedData => ({
  submission,
  conversationId,
  at: 3,
  sha: `${submission}abcdef0`,
  base: '0000000',
  target: 'main',
  lander: 2,
  divergence: 'None',
  title: 'Land me',
  feature: 'Landing',
  commits: [{ sha: 'abc1234', subject: `feat: ${submission}` }],
  commitCount: 1,
  paths: ['landed.txt'],
})
const memorizeTasks = (server: Server) =>
  server.harness.commit(
    async (tx) =>
      (await tx.scanTasks({ conversationId: ROOT_CONVERSATION_ID, kind: 'lineage.memorize' }, 500))
        .items,
    context,
  )
const settledTasks = async (server: Server, count: number) => {
  await until(async () => {
    const tasks = await memorizeTasks(server)
    return tasks.length === count && tasks.every((task) => task.state.status === 'terminal')
  })
  for (const task of await memorizeTasks(server))
    expect(task.state).toMatchObject({ outcome: { status: 'completed' } })
}

it.concurrent('distils each landing into memory once and writes nothing from a refused answer', async () => {
  const { server, state } = await fixture()
  const { id } = await branch(server, 'Land me')
  await server.harness.commit((tx) => abstract(tx, id, { text: 'State: done.', at: 3 }), context)
  await apply(server, [add('old-tool', 'Uses old-tool')])
  state.memorize = `\`\`\`json\n${JSON.stringify({
    ops: [
      { op: 'delete', slug: 'old-tool' },
      {
        op: 'add',
        slug: 'new-tool',
        kind: 'decision',
        line: 'Use new-tool',
        body: 'old-tool was replaced by new-tool.',
      },
    ],
  })}\n\`\`\``
  const land = (data: LandedData) =>
    server.harness.commit((tx) => emit(tx, SubmissionLanded, data), context)
  await land(landing('s1', id))
  await settledTasks(server, 1)
  expect(await memories(server)).toEqual({
    'new-tool': {
      kind: 'decision',
      line: 'Use new-tool',
      body: 'old-tool was replaced by new-tool.',
      source: `#${id}/3`,
      updated: expect.any(Number),
    },
  })
  // The model read the landing, the submitter's abstract frozen into it, and the memory with bodies.
  expect(state.asked).toHaveLength(1)
  expect(state.asked[0]).toContain('Landed s1abcde on main')
  expect(state.asked[0]).toContain('State: done.')
  expect(state.asked[0]).toContain('old-tool [fact] — Uses old-tool')

  // The same landing again starts no second task, so its ops apply once.
  const again = (await land(landing('s1', id))).id
  await until(
    async () =>
      ((await server.harness.snapshot(EventLog, ROOT_CONVERSATION_ID, context))?.cursors[
        'lineage/memorize'
      ] ?? 0) >= again,
  )
  expect(await memorizeTasks(server)).toHaveLength(1)

  // A batch applyMemoryOps refuses is asked once more with the reason; a valid retry is written.
  state.queued.push(
    JSON.stringify({ ops: [{ ...add('retried', 'An opinion'), kind: 'opinion' }] }),
    JSON.stringify({ ops: [add('retried', 'Short enough')] }),
  )
  await land(landing('retry', id))
  await settledTasks(server, 2)
  expect(state.asked).toHaveLength(3)
  expect(state.asked[2]).toContain('Op 1: kind must be decision, fact or lesson')
  expect(state.asked[2]).toContain('An opinion')
  expect((await memories(server)).retried).toMatchObject({ line: 'Short enough' })
  // Distillation asks with a budget far over a summary's 2048 tokens, which batches of long bodies ran out of.
  expect(state.budgets.every((budget) => budget! > 2048)).toBe(true)

  // A line over 120 characters, which the model keeps writing on a retry too, is cut short and written the first
  // time, so there is no retry and no notice.
  const long = `${'word '.repeat(27)}and-then-some-more`
  expect(long).toHaveLength(153)
  state.memorize = JSON.stringify({ ops: [add('long', long)] })
  await land(landing('long', id))
  await settledTasks(server, 3)
  expect(state.asked).toHaveLength(4)
  expect((await memories(server)).long).toMatchObject({
    line: `${'word '.repeat(22)}word…`,
    body: `${long}, in full.`,
  })
  const notices = async () =>
    ((await server.harness.snapshot(EventFeed, ROOT_CONVERSATION_ID, context))?.events ?? [])
      .filter((event) => event.name === 'ultimate.notice')
      .map((event) => event.data as { extension: string; message: string })
      .filter((data) => data.extension === 'lineage')
      .map((data) => data.message)
  expect(await notices()).toEqual([])

  // An answer cut off at the output budget is asked again, told so; the shorter retry is written.
  state.queued.push(
    { text: '{"ops":[{"op":"add","slug":"cut","kind":"fact","line":"Cut', stopReason: 'length' },
    JSON.stringify({ ops: [add('cut', 'Cut short, retried')] }),
  )
  await land(landing('cut', id))
  await settledTasks(server, 4)
  expect(state.asked).toHaveLength(6)
  expect(state.asked[5]).toContain(
    `the answer was cut off at the output limit of ${MEMORIZE_TOKENS} tokens, reasoning included: answer with fewer, shorter ops`,
  )
  expect((await memories(server)).cut).toMatchObject({ line: 'Cut short, retried' })

  // An empty batch with commentary writes nothing and is not retried, so it leaves no notice.
  state.memorize = '{"ops":[]}\nNothing here is worth remembering.'
  await land(landing('empty', id))
  await settledTasks(server, 5)
  expect(state.asked).toHaveLength(7)

  // A malformed answer, and a batch applyMemoryOps refuses, write nothing, retried or not.
  const before = await memories(server)
  state.memorize = 'Sure! Here are the ops: none'
  await land(landing('s2', id))
  await settledTasks(server, 6)
  state.memorize = JSON.stringify({
    ops: [
      { op: 'add', slug: 'fine', kind: 'fact', line: 'Fine', body: 'Fine.' },
      { op: 'update', slug: 'missing', line: 'x' },
    ],
  })
  await land(landing('s3', id))
  await settledTasks(server, 7)
  expect(state.asked).toHaveLength(11)
  expect(state.asked[10]).toContain('Op 2: no memory missing')
  expect(await memories(server)).toEqual(before)
  await until(async () => (await notices()).length === 2)
  expect(await notices()).toEqual([
    expect.stringContaining(
      'Memory from landing s2 in #1 was not written: Error: expected {"ops": [...]}',
    ),
    expect.stringContaining(
      'Memory from landing s3 in #1 was not written: Error: Op 2: no memory missing',
    ),
  ])

  // Receipts are never evicted: after more than 100 further landings, the first again starts no task.
  state.memorize = '{"ops":[]}'
  await server.harness.commit(async (tx) => {
    for (let index = 0; index < 101; index++)
      await emit(tx, SubmissionLanded, landing(`bulk-${index}`, id))
  }, context)
  await settledTasks(server, 108)
  const repeat = (await land(landing('s1', id))).id
  await until(
    async () =>
      ((await server.harness.snapshot(EventLog, ROOT_CONVERSATION_ID, context))?.cursors[
        'lineage/memorize'
      ] ?? 0) >= repeat,
  )
  expect(await memorizeTasks(server)).toHaveLength(108)
})

it.concurrent('a fresh memorize reactor skips landings from before it and distils new ones', async () => {
  const { server, state } = await fixture()
  const { id } = await branch(server, 'Land me')
  state.memorize = JSON.stringify({ ops: [add('fresh')] })
  // Past landings with no memorize cursor, as on a fresh install: the reactor starts after them.
  await server.harness.commit(async (tx) => {
    for (let index = 0; index < 3; index++)
      await emit(tx, SubmissionLanded, landing(`past-${index}`, id))
    delete (await tx.doc(EventLog, ROOT_CONVERSATION_ID)).cursors['lineage/memorize']
  }, context)
  const cursor = async () =>
    (await server.harness.snapshot(EventLog, ROOT_CONVERSATION_ID, context))?.cursors[
      'lineage/memorize'
    ]
  await until(async () => (await cursor()) !== undefined)
  expect(await memorizeTasks(server)).toEqual([])
  await server.harness.commit((tx) => emit(tx, SubmissionLanded, landing('new', id)), context)
  await settledTasks(server, 1)
  expect(state.asked).toHaveLength(1)
  expect(state.asked[0]).toContain('Landed newabcd on main')
  expect(Object.keys(await memories(server))).toEqual(['fresh'])
})

it.concurrent('ends a compaction of @ultimate with its project memory', async () => {
  const { server, state } = await fixture()
  await apply(server, [add('kept-fact', 'The project keeps this fact')])
  const ultimate = await server.harness.createConversation(
    { ownership: { kind: 'ownerless' } },
    context,
  )
  const { model } = await server.root.agent(context)
  await server.harness.commit(async (tx) => {
    await configure(tx, ultimate.id, { model })
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = ultimate.id
    for (let n = 0; n < 8; n++)
      await tx.appendEntry(ultimate.id, {
        kind: 'pi.user',
        model: [{ role: 'user', content: `Part ${n} ${'word '.repeat(4000)}`, timestamp: n }],
      })
  }, context)
  await server.harness.waitForTask(await ultimate.compact(undefined, context), context)
  // The summary prompt carries the memory and says to leave out what it states.
  expect(state.condensed).toHaveLength(1)
  expect(state.condensed[0]).toContain('leave out what it already states')
  expect(state.condensed[0]).toContain('kept-fact [fact]')
  const marker = (await ultimate.context(context)).entries[0]
  expect(marker.kind).toBe('pi.compaction')
  const summary = textOf(marker.model?.[0]?.content)
  // The summary model's answer (faux answers `{}`), then the memory block.
  expect(summary).toMatch(
    /<summary>\n\{\}\n\n<project_memory root="#1">\nkept-fact \[fact\] — The project keeps this fact \(updated [\d-]+\)\n<\/project_memory>\nThe full project context[^\n]*`ultimate.entries\(1\)`[^\n]*\n<\/summary>$/,
  )
})

it.concurrent('wakes @ultimate once after its manual compaction, never after an automatic one', async () => {
  const { server, state } = await fixture()
  const ultimate = await server.harness.createConversation(
    { ownership: { kind: 'ownerless' } },
    context,
  )
  const { model } = await server.root.agent(context)
  const fill = (from: number) =>
    server.harness.commit(async (tx) => {
      for (let n = from; n < from + 8; n++)
        await tx.appendEntry(ultimate.id, {
          kind: 'pi.user',
          model: [{ role: 'user', content: `Part ${n} ${'word '.repeat(4000)}`, timestamp: n }],
        })
    }, context)
  await server.harness.commit(async (tx) => {
    await configure(tx, ultimate.id, { model })
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = ultimate.id
  }, context)
  await fill(0)
  const kinds = async () => (await ultimate.context(context)).entries.map((entry) => entry.kind)
  const wakeTasks = () =>
    server.harness.commit(
      async (tx) =>
        (await tx.scanTasks({ conversationId: ultimate.id, kind: 'lineage.woken' }, 10)).items,
      context,
    )
  // A threshold compaction of @ultimate is declined: it compacts in place (extensions/compact). An automatic
  // compaction continues the run it interrupted, so it wakes nothing.
  for (const reason of ['threshold', 'overflow'] as const) {
    const automatic = await server.harness.commit(
      (tx) =>
        tx.createTask(
          CompactionTask,
          { reason },
          { ownership: { kind: 'conversation' }, conversationId: ultimate.id, background: true },
        ),
      context,
    )
    await server.harness.waitForTask(automatic, context)
    expect((await kinds())[0]).toBe(reason === 'threshold' ? 'pi.user' : 'pi.compaction')
    await fill(10)
  }
  expect(await wakeTasks()).toEqual([])
  expect(await kinds()).not.toContain('lineage.woken')

  // A second call while one runs is refused.
  const { taskId } = JSON.parse(await run(server, 'compact', {}, ultimate.id))
  await expect(run(server, 'compact', {}, ultimate.id)).rejects.toThrow('Already compacting')
  await server.harness.waitForTask(taskId, context)
  await until(async () => (await kinds()).includes('lineage.woken'))
  await ultimate.waitForIdle(context)
  const tasks = await wakeTasks()
  expect(tasks.map((task) => task.input)).toEqual([{ id: ultimate.id, compaction: taskId }])
  const view = await ultimate.context(context)
  const woken = view.entries.filter((entry) => entry.kind === 'lineage.woken')
  expect(woken).toHaveLength(1)
  expect(textOf(woken[0].model?.[0]?.content)).toContain('Your context was just compacted')
  // It follows the manual summary, which now heads the context, and started a turn that answered it.
  expect(view.entries[0].kind).toBe('pi.compaction')
  expect(view.entries[0].data).toEqual({ reason: 'manual' })
  const last = (await ultimate.context(context)).entries.at(-1)!
  expect(last.kind).toBe('pi.assistant')

  // A summary that goes stale, because a reset replaced its context while it was written, wakes nothing.
  await fill(20)
  const release = Promise.withResolvers<void>()
  state.gate = release.promise
  const asked = state.condensed.length
  const stale = await ultimate.compact(undefined, context)
  await until(() => state.condensed.length > asked)
  await ultimate.reset(undefined, context)
  release.resolve()
  await server.harness.waitForTask(stale, context)
  await until(async () => (await wakeTasks()).every((task) => task.state.status === 'terminal'))
  expect((await wakeTasks()).map((task) => task.input)).toContainEqual({
    id: ultimate.id,
    compaction: stale,
  })
  expect(await kinds()).toEqual(['pi.reset'])
})

it.concurrent('lets any conversation compact itself with the tool and wakes it to continue', async () => {
  const { server } = await fixture()
  const other = await server.harness.createConversation(
    { ownership: { kind: 'ownerless' } },
    context,
  )
  const { model } = await server.root.agent(context)
  await server.harness.commit(async (tx) => {
    await configure(tx, other.id, { model })
    for (let n = 0; n < 8; n++)
      await tx.appendEntry(other.id, {
        kind: 'pi.user',
        model: [{ role: 'user', content: `Part ${n} ${'word '.repeat(4000)}`, timestamp: n }],
      })
  }, context)
  const { taskId } = JSON.parse(await run(server, 'compact', {}, other.id))
  await server.harness.waitForTask(taskId, context)
  const kinds = async () => (await other.context(context)).entries.map((entry) => entry.kind)
  await until(async () => (await kinds()).includes('lineage.woken'))
  await other.waitForIdle(context)
  const view = await other.context(context)
  expect(view.entries[0].kind).toBe('pi.compaction')
  const woken = view.entries.filter((entry) => entry.kind === 'lineage.woken')
  expect(woken).toHaveLength(1)
  expect(textOf(woken[0].model?.[0]?.content)).toBe(
    'Your context was just compacted. Read the summary above, then continue where you left off.',
  )
  // A subagent's report is its run's answer: it does not compact itself into a second run.
  server.host.registry.install(defineExtension({ name: 'lineage-test', tasks: [anchor] }))
  const child = await server.harness.commit(async (tx) => {
    const owner = await tx.createTask(anchor, null, {
      ownership: { kind: 'conversation' },
      conversationId: other.id,
      background: true,
    })
    return (await tx.createConversation({ ownership: { kind: 'task', taskId: owner } })).id
  }, context)
  await expect(run(server, 'compact', {}, child)).rejects.toThrow('A subagent does not compact')
})

it.concurrent('completes a landing task without asking when no summary model runs', async () => {
  const { server, state } = await fixture({ summaryModel: 'not a model' })
  const { id } = await branch(server, 'Land me')
  state.memorize = JSON.stringify({ ops: [add('never')] })
  await server.harness.commit((tx) => emit(tx, SubmissionLanded, landing('s1', id)), context)
  await settledTasks(server, 1)
  expect(state.asked).toEqual([])
  expect(await memories(server)).toEqual({})
})
