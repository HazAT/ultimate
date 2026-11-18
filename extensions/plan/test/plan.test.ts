import { join } from 'node:path'
import {
  fauxAssistantMessage,
  fauxToolCall,
  fauxProvider,
} from '@earendil-works/pi-ai/providers/faux'
import { defineExtension, section } from '@earendil-works/pi-durable'
import type { ConversationId, JsonObject, Tx } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import type { ExtensionHost } from '../../../server/extensions.ts'
import planExtension, { Plan, Progress, TaskIndex } from '../server.ts'
import type { PlanService } from '../api.ts'
import { context, prepareHarness } from '../../../server/harness.ts'
import { Metadata } from '../../../server/metadata.ts'
import { temp, removeTemp } from '../../../test/helpers.ts'

it('shares the root ledger read-only with descendants, saves verdicts, and replays nested calls separately', async () => {
  const directory = await temp('ultimate-plan-')
  const prepared = await prepareHarness({
    ultimateRoot: directory,
    userHome: directory,
    home: join(directory, 'home'),
    faux: fauxProvider(),
  })
  const plan = planExtension({
    react: () => {},
    implement: () => {},
    metadata: Metadata,
    onOpen: () => {},
  } as unknown as ExtensionHost)
  const tool = plan.tools![0]
  const replayResults: unknown[][] = []
  let childId: ConversationId
  let grandchildId: ConversationId | undefined
  const nestedResults: unknown[][] = []
  prepared.registry.install(
    defineExtension({
      ...plan,
      tools: [
        {
          ...tool,
          execute: async (args, api, ctx) => {
            if ((args as { title?: string }).title === 'Nested') {
              const results = []
              for (const namespace of ['first', 'second']) {
                // Match codemode: one outer task ID, distinct nested memo namespaces.
                const nestedApi = {
                  ...api,
                  memo: ((name: string, valueOrContext: unknown, memoContext?: typeof ctx) =>
                    memoContext === undefined
                      ? api.memo(`${namespace}/${name}`, ctx)
                      : api.memo(
                          `${namespace}/${name}`,
                          valueOrContext as never,
                          memoContext,
                        )) as typeof api.memo,
                }
                const first = await tool.execute(args, nestedApi, ctx)
                const replayApi = {
                  ...nestedApi,
                  memo: ((name: string, ...rest: unknown[]) =>
                    name === 'result' && rest.length === 1
                      ? Promise.resolve(undefined)
                      : nestedApi.memo(name, ...(rest as [never, typeof ctx]))) as typeof api.memo,
                }
                nestedResults.push([first, await tool.execute(args, replayApi, ctx)])
                results.push(first)
              }
              return results[1]
            }
            const result = await tool.execute(args, api, ctx)
            if (api.conversationId === childId && grandchildId === undefined) {
              grandchildId = await api.commit(
                async (tx) =>
                  (
                    await tx.createConversation({
                      ownership: { kind: 'task', taskId: api.taskId },
                    })
                  ).id,
                ctx,
              )
            }
            if ((args as { action: string }).action === 'create') {
              childId = await api.commit(
                async (tx) =>
                  (
                    await tx.createConversation({
                      ownership: { kind: 'task', taskId: api.taskId },
                    })
                  ).id,
                ctx,
              )
            }
            if ((args as { action: string }).action === 'add') {
              const memoReplay = await tool.execute(args, api, ctx)
              // Simulate a crash after the edit commit but before the result memo.
              const replayApi = {
                ...api,
                memo: ((name: string, ...rest: unknown[]) =>
                  name === 'result' && rest.length === 1
                    ? Promise.resolve(undefined)
                    : api.memo(name, rest[0] as never, ctx)) as typeof api.memo,
              }
              replayResults.push([result, memoReplay, await tool.execute(args, replayApi, ctx)])
            }
            return result
          },
        },
      ],
    }),
  )
  let opened = await prepared.open()
  const call = async (args: JsonObject, conversationId = opened.root.id) => {
    const conversation = (await opened.harness.conversation(conversationId, context))!
    prepared.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall('plan', args)], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('Complete'),
    ])
    await (
      await conversation.submit({ type: 'input', content: 'Update plan' }, context)
    ).wait(context)
    await opened.harness.waitForIdle(context)
    const view = await conversation.context(context)
    const result = view.entries.findLast((entry) => entry.kind === 'pi.tool-result')!.model![0]
    if (result.role !== 'toolResult') throw new Error('Missing tool result')
    return result
  }
  try {
    await call({
      action: 'create',
      title: 'Ship ledger',
      body: '## Request\nDurable plans',
    })
    await call({
      action: 'add',
      epic: 'E1',
      title: 'Implement',
      role: 'worker',
      description: 'Build it',
    })
    await call({
      action: 'add',
      epic: 'E1',
      title: 'Review',
      role: 'reviewer',
      description: 'Check it',
      deps: ['E1.1'],
    })
    await call({
      action: 'update',
      key: 'E1.1',
      status: 'in_review',
      child: 42,
      verdict: 'Checks passed',
    })
    await call({ action: 'note', key: 'E1.1', text: 'Checks passed' })
    const saved = await opened.harness.snapshot(Plan, opened.root.id, context)
    expect(saved).toMatchObject({
      next: 2,
      epics: {
        E1: {
          title: 'Ship ledger',
          tasks: {
            'E1.1': {
              status: 'in_review',
              child: 42,
              verdict: 'Checks passed',
              notes: [{ text: 'Checks passed', at: expect.any(String) }],
            },
            'E1.2': { deps: ['E1.1'], role: 'reviewer' },
          },
        },
      },
    })
    expect(Object.keys(saved!.epics.E1.tasks)).toEqual(['E1.1', 'E1.2'])
    expect(replayResults).toHaveLength(2)
    expect(replayResults.map(([_result, memo, receipt]) => [memo, receipt])).toEqual(
      replayResults.map(([result]) => [result, result]),
    )
    for (const key of ['E1', 'E1.1']) {
      const shown = await call({ action: 'show', key }, childId!)
      expect(shown.isError).not.toBe(true)
      expect(shown.content).toEqual([
        {
          type: 'text',
          text: JSON.stringify(key === 'E1' ? saved!.epics.E1 : saved!.epics.E1.tasks[key]),
        },
      ])
    }
    const mutations: JsonObject[] = [
      { action: 'create', title: 'Forbidden', body: 'No' },
      {
        action: 'add',
        epic: 'E1',
        title: 'Forbidden',
        role: 'worker',
        description: 'No',
      },
      { action: 'update', key: 'E1.1', status: 'done' },
      { action: 'note', key: 'E1.1', text: 'No' },
    ]
    for (const args of mutations) {
      const denied = await call(args, childId!)
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain(
        `Only conversation ${opened.root.id} edits this plan; report to it instead`,
      )
    }
    if (grandchildId === undefined) throw new Error('Missing grandchild fixture')
    const grandchildShown = await call({ action: 'show', key: 'E1.1' }, grandchildId)
    expect(grandchildShown.isError).not.toBe(true)
    expect(grandchildShown.content).toEqual([
      { type: 'text', text: JSON.stringify(saved!.epics.E1.tasks['E1.1']) },
    ])
    const grandchildDenied = await call({ action: 'note', key: 'E1.1', text: 'No' }, grandchildId)
    expect(grandchildDenied.isError).toBe(true)
    expect(JSON.stringify(grandchildDenied.content)).toContain(
      `Only conversation ${opened.root.id} edits this plan; report to it instead`,
    )
    expect(await opened.harness.snapshot(Plan, opened.root.id, context)).toEqual(saved)
    expect((await call({ action: 'update', key: 'E1.1', body: 'No' })).isError).toBe(true)
    await opened.close()
    opened = await prepared.open()
    expect(await opened.harness.snapshot(Plan, opened.root.id, context)).toEqual(saved)
    expect((await call({ action: 'update', key: 'E1', status: 'todo' })).isError).toBe(true)
    expect((await call({ action: 'show', key: 'E99' })).isError).toBe(true)
    expect(await opened.harness.snapshot(Plan, opened.root.id, context)).toEqual(saved)
    await call({
      action: 'update',
      key: 'E1',
      status: 'done',
      verdict: 'Approved',
    })
    await call({ action: 'show' })
    await call({
      action: 'add',
      epic: 'E1',
      title: 'Nested',
      role: 'worker',
      description: 'Separate calls',
    })
    expect(nestedResults).toHaveLength(2)
    expect(nestedResults[0][0]).not.toEqual(nestedResults[1][0])
    for (const [first, replay] of nestedResults) expect(replay).toEqual(first)
    const nested = await opened.harness.snapshot(Plan, opened.root.id, context)
    expect(Object.keys(nested!.epics.E1.tasks)).toEqual(['E1.1', 'E1.2', 'E1.3', 'E1.4'])
    expect(nested!.epics.E1.tasks['E1.3'].title).toBe('Nested')
    expect(nested!.epics.E1.tasks['E1.4'].title).toBe('Nested')
  } finally {
    await opened.close()
    await removeTemp(directory)
  }
})

it('indexes linked children with their task and renames them after it', async () => {
  const directory = await temp('ultimate-plan-index-')
  const prepared = await prepareHarness({
    ultimateRoot: directory,
    userHome: directory,
    home: join(directory, 'home'),
    faux: fauxProvider(),
  })
  let opened!: Awaited<ReturnType<typeof prepared.open>>
  const openers: (() => Promise<void>)[] = []
  prepared.registry.install(
    planExtension({
      react: () => {},
      implement: () => {},
      metadata: Metadata,
      harness: () => opened.harness,
      onOpen: (callback: () => Promise<void>) => openers.push(callback),
    } as unknown as ExtensionHost),
  )
  const open = async () => {
    opened = await prepared.open()
    for (const callback of openers) await callback()
  }
  await open()
  const call = async (args: JsonObject) => {
    const conversation = (await opened.harness.conversation(opened.root.id, context))!
    prepared.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall('plan', args)], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('Complete'),
    ])
    await (
      await conversation.submit({ type: 'input', content: 'Update plan' }, context)
    ).wait(context)
    await opened.harness.waitForIdle(context)
  }
  const index = async () =>
    (await opened.harness.snapshot(TaskIndex, opened.root.id, context))?.children
  const title = async (id: ConversationId) =>
    (await opened.harness.snapshot(Metadata, id, context))?.title
  try {
    const [first, second] = await opened.harness.commit(
      async (tx) => [
        (await tx.createConversation({ ownership: { kind: 'ownerless' } })).id,
        (await tx.createConversation({ ownership: { kind: 'ownerless' } })).id,
      ],
      context,
    )
    await call({ action: 'create', title: 'Index', body: 'Body' })
    await call({
      action: 'add',
      epic: 'E1',
      title: 'Build it',
      role: 'worker',
      description: 'D',
    })
    await call({ action: 'update', key: 'E1.1', child: first })
    expect(await index()).toEqual({
      [first]: {
        coordinator: 1,
        epic: 'E1',
        key: 'E1.1',
        title: 'Build it',
        status: 'backlog',
      },
    })
    expect(await title(first)).toBe('Build it')

    await call({
      action: 'update',
      key: 'E1.1',
      status: 'in_progress',
      title: 'Build it well',
    })
    expect((await index())![first]).toMatchObject({
      status: 'in_progress',
      title: 'Build it well',
    })
    expect(await title(first)).toBe('Build it well')

    // A title the user gives the child stays until the task's title changes.
    await opened.harness.commit(async (tx) => {
      ;(await tx.doc(Metadata, first)).title = 'Renamed by hand'
    }, context)
    await call({ action: 'note', key: 'E1.1', text: 'Progress' })
    expect(await title(first)).toBe('Renamed by hand')

    await call({ action: 'update', key: 'E1.1', child: second })
    expect(Object.keys((await index())!)).toEqual([String(second)])
    expect(await title(second)).toBe('Build it well')
  } finally {
    await opened.close()
    await removeTemp(directory)
  }
})

it('confirms criteria with met, raises estimates only upward, drops changed criteria and records them at landing', async () => {
  const directory = await temp('ultimate-plan-criteria-')
  const prepared = await prepareHarness({
    ultimateRoot: directory,
    userHome: directory,
    home: join(directory, 'home'),
    faux: fauxProvider(),
  })
  let opened!: Awaited<ReturnType<typeof prepared.open>>
  let service!: PlanService
  let landed!: (
    tx: Tx,
    event: { data: { conversationId: ConversationId; sha: string; submission: string } },
  ) => Promise<void>
  prepared.registry.install(
    planExtension({
      react: (_name: string, _tokens: unknown, handler: typeof landed) => {
        landed = handler
      },
      implement: (_api: unknown, value: PlanService) => {
        service = value
      },
      metadata: Metadata,
      harness: () => opened.harness,
      onOpen: () => {},
    } as unknown as ExtensionHost),
  )
  opened = await prepared.open()
  const failed: string[] = []
  const call = async (args: JsonObject) => {
    const conversation = (await opened.harness.conversation(opened.root.id, context))!
    prepared.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall('plan', args)], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Complete'),
    ])
    await (
      await conversation.submit({ type: 'input', content: 'Update plan' }, context)
    ).wait(context)
    await opened.harness.waitForIdle(context)
    const results = await opened.root.entries({ order: 'descending' }, 4, undefined, context)
    for (const entry of results.items)
      for (const message of entry.model ?? [])
        if (message.role === 'toolResult' && message.isError)
          failed.push(
            message.content.map((block) => (block.type === 'text' ? block.text : '')).join(''),
          )
  }
  const id = opened.root.id
  const body = (criteria: string[]) =>
    `Request: r\nAcceptance criteria:\n${criteria.map((text, i) => `${i + 1}. ${text}`).join('\n')}`
  const estimates = async () =>
    (await opened.harness.snapshot(Progress, id, context))?.epics.E1?.estimates
  try {
    expect(await service.openCriteria(id, context)).toBeUndefined()
    expect(await opened.harness.snapshot(Plan, id, context)).toBeUndefined()
    await call({ action: 'create', title: 'Criteria', body: body(['A', 'B', 'C']) })
    expect(await service.openCriteria(id, context)).toEqual({
      epic: 'E1',
      revision: 0,
      criteria: [
        { n: 1, text: 'A' },
        { n: 2, text: 'B' },
        { n: 3, text: 'C' },
      ],
    })
    expect(await opened.harness.snapshot(Progress, id, context)).toBeUndefined()

    await call({ action: 'update', key: 'E1', met: [4] })
    expect(failed.pop()).toContain('E1 has 3 acceptance criteria, not 4')
    await call({ action: 'update', key: 'E1', met: [3, 1, 1] })
    const met = async () => (await opened.harness.snapshot(Plan, id, context))?.epics.E1.met
    expect(await met()).toEqual([1, 3])

    const estimate = (
      revision: number,
      next: Record<string, { state: 'in_progress' | 'looks_done'; at?: number }>,
    ) => opened.harness.commit((tx) => service.estimate(tx, id, 'E1', revision, next), context)
    await estimate(0, { B: { state: 'looks_done', at: 7 } })
    await estimate(0, { B: { state: 'in_progress' } })
    expect(await estimates()).toEqual({ B: { state: 'looks_done', at: 7 } })
    expect(await service.openCriteria(id, context)).toEqual({
      epic: 'E1',
      revision: 0,
      criteria: [{ n: 2, text: 'B', estimate: 'looks_done' }],
    })

    const land = (submission: string) =>
      opened.harness.commit(
        (tx) => landed(tx, { data: { conversationId: id, sha: 'abc1234', submission } }),
        context,
      )
    await land('s1')
    await call({ action: 'add', epic: 'E1', title: 'T', role: 'worker', description: 'D' })
    expect((await service.openCriteria(id, context))?.criteria).toHaveLength(1)

    // Confirmations follow their criterion's text, each at most once; estimates of changed text go at once.
    await call({ action: 'update', key: 'E1', body: body(['B changed', 'C', 'A', 'A']) })
    expect(await met()).toEqual([2, 3])
    expect(await estimates()).toEqual({})
    await call({ action: 'update', key: 'E1', body: body(['A', 'B', 'C']) })
    expect(await met()).toEqual([1, 3])
    await call({ action: 'update', key: 'E1', body: body(['A', 'B', 'A']), met: [3] })
    await call({ action: 'update', key: 'E1', body: `${body(['A', 'B', 'A'])}\nRisks: none.` })
    expect(await met()).toEqual([3])
    await call({ action: 'update', key: 'E1', body: body(['A', 'B', 'C']), met: [1, 3] })

    // An answer to the criteria as they were before an edit is dropped, even when the text came back.
    await estimate(0, { B: { state: 'looks_done', at: 9 } })
    expect(await estimates()).toEqual({})
    const revision = (await service.openCriteria(id, context))!.revision
    expect(revision).toBe(4)
    await estimate(revision, { B: { state: 'in_progress' } })
    expect(await estimates()).toEqual({ B: { state: 'in_progress' } })

    await call({ action: 'update', key: 'E1', met: [1, 2, 3] })
    await land('s2')
    expect((await opened.harness.snapshot(Progress, id, context))?.epics.E1?.landed).toEqual({
      s1: { total: 3, confirmed: 2, estimated: 1 },
      s2: { total: 3, confirmed: 3, estimated: 0 },
    })

    await call({ action: 'update', key: 'E1', status: 'done' })
    expect(await service.openCriteria(id, context)).toBeUndefined()
    expect(failed).toEqual([])
  } finally {
    await opened.close()
    await removeTemp(directory)
  }
})

// Pi removes and re-adds every section when one would land out of order, sending the whole system prompt again (40 times
// in two days, #558178); the plan keeps an empty slot instead (#573861).
it('patches only the plan section, in its declared place, when it appears, leaves and returns', async () => {
  const directory = await temp('ultimate-plan-prompt-')
  const prepared = await prepareHarness({
    ultimateRoot: directory,
    userHome: directory,
    home: join(directory, 'home'),
    faux: fauxProvider(),
  })
  prepared.registry.install(
    planExtension({
      react: () => {},
      implement: () => {},
      metadata: Metadata,
      onOpen: () => {},
    } as unknown as ExtensionHost),
  )
  prepared.registry.install(
    defineExtension({ name: 'tail', sections: [section('tail', async () => 'Always here.')] }),
  )
  const opened = await prepared.open()
  const call = async (args: JsonObject) => {
    prepared.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall('plan', args)], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Complete'),
    ])
    await (
      await opened.root.submit({ type: 'input', content: 'Update plan' }, context)
    ).wait(context)
    await opened.harness.waitForIdle(context)
  }
  try {
    await call({ action: 'create', title: 'One', body: 'Body' })
    await call({ action: 'update', key: 'E1', status: 'done' })
    await call({ action: 'create', title: 'Two', body: 'Body' })
    const patches = (await opened.root.context(context)).messages.flatMap((message) =>
      message.role === 'system' && message.sections !== undefined ? [message.sections] : [],
    )
    const [baseline, ...later] = patches
    expect(baseline).toEqual({ plan: '', tail: '<tail>\nAlways here.\n</tail>' })
    expect(later.map((patch) => patch.plan === '')).toEqual([false, true, false])
    for (const patch of later) expect(Object.keys(patch)).toEqual(['plan'])
    expect(later.at(-1)!.plan).toMatch(/^<plan>\nE2 planning Two\n<\/plan>$/)
  } finally {
    await opened.close()
    await removeTemp(directory)
  }
})
