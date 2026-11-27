import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import {
  fauxAssistantMessage,
  fauxToolCall,
  fauxProvider,
} from '@earendil-works/pi-ai/providers/faux'
import {
  defineDoc,
  defineExtension,
  defineTask,
  GenerationTask,
  hook,
  hookTask,
  InboxDoc,
} from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { prepareHarness } from '../server/harness.ts'
import { temp, until } from './helpers.ts'

const Placed = defineDoc<{ count: number }>({
  kind: 'input-test.placed',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ count: 0 }),
})

it('places hook entries transactionally before initial and queued run inputs, not steering', async () => {
  const home = await temp()
  const gate = Promise.withResolvers<void>()
  let held = false
  let reject = false
  let calls = 0
  const open = async () => {
    const prepared = await prepareHarness({
      ultimateRoot: home,
      userHome: home,
      home,
      faux: fauxProvider(),
    })
    prepared.registry.install(
      defineExtension({
        name: 'input-test',
        hooks: [
          hook(GenerationTask, {
            beforeInput: async (_input, { tx, conversationId }) => {
              calls++
              const state = await tx.doc(Placed, conversationId)
              state.count++
              if (reject) throw new Error('reject placement')
              return {
                entries: [
                  {
                    kind: 'input-test.note',
                    data: { count: state.count },
                    model: [{ role: 'user', content: `before ${state.count}`, timestamp: 1 }],
                  },
                ],
              }
            },
          }),
        ],
      }),
    )
    prepared.faux!.setResponses([
      async () => {
        held = true
        await gate.promise
        return fauxAssistantMessage([fauxToolCall('unknown', {})], { stopReason: 'toolUse' })
      },
      fauxAssistantMessage('answer'),
      fauxAssistantMessage('next answer'),
    ])
    return prepared.open()
  }
  const f = await open()
  try {
    const first = await f.root.submit(
      { type: 'input', content: 'first', requestId: 'one' },
      context,
    )
    await until(() => held)
    const steer = await f.root.submit(
      { type: 'input', content: 'steer', whenBusy: 'steer' },
      context,
    )
    const next = await f.root.submit({ type: 'input', content: 'next' }, context)
    expect(calls).toBe(1)
    gate.resolve()
    await Promise.all([first.wait(context), steer.wait(context), next.wait(context)])
    const view = await f.root.context(context)
    expect(
      view.messages.filter((message) => message.role === 'user').map((message) => message.content),
    ).toEqual(['before 1', 'first', 'steer', 'before 2', 'next'])
    const notes = view.entries.filter((entry) => entry.kind === 'input-test.note')
    expect(notes).toHaveLength(2)
    expect(notes.every((entry) => entry.edits === undefined)).toBe(true)
    expect(calls).toBe(2)
    await f.root.submit({ type: 'input', content: 'first', requestId: 'one' }, context)
    expect(calls).toBe(2)
    reject = true
    await expect(f.root.submit({ type: 'input', content: 'rejected' }, context)).rejects.toThrow(
      'reject placement',
    )
    expect((await f.harness.snapshot(Placed, f.root.id, context))?.count).toBe(2)
    expect(
      (await f.root.context(context)).entries.filter((entry) => entry.kind === 'input-test.note'),
    ).toHaveLength(2)
  } finally {
    gate.resolve()
    await f.close()
  }
})

it('places hook entries before a follow-up queued while an onYield task decides', async () => {
  const home = await temp()
  const gate = Promise.withResolvers<void>()
  let deciding = false
  const decided = {
    status: 'terminal' as const,
    outcome: { status: 'completed' as const, result: null },
  }
  const Decide = defineTask<null, { phase: 'decide' }, null>({
    name: 'input-test.decide',
    version: 1,
    initial: () => ({ phase: 'decide' }),
    abort: async (_task, runtime, ctx) => runtime.commit(() => decided, ctx),
    phases: {
      decide: async (_task, runtime, ctx) => {
        deciding = true
        await gate.promise
        await runtime.commit(() => decided, ctx)
      },
    },
  })
  const prepared = await prepareHarness({
    ultimateRoot: home,
    userHome: home,
    home,
    faux: fauxProvider(),
  })
  let yields = 0
  prepared.registry.install(
    defineExtension({
      name: 'input-test',
      tasks: [Decide],
      hooks: [
        hook(GenerationTask, {
          beforeInput: async () => ({
            entries: [
              {
                kind: 'input-test.note',
                data: {},
                model: [{ role: 'user', content: 'before', timestamp: 1 }],
              },
            ],
          }),
          onYield: () => (yields++ === 0 ? { tasks: [hookTask(Decide, null)] } : undefined),
        }),
      ],
    }),
  )
  prepared.faux!.setResponses([fauxAssistantMessage('first answer'), fauxAssistantMessage('next')])
  const f = await prepared.open()
  try {
    const first = await f.root.submit({ type: 'input', content: 'first' }, context)
    await until(() => deciding)
    const next = await f.root.submit(
      { type: 'input', content: 'next', whenBusy: 'followUp' },
      context,
    )
    gate.resolve()
    await Promise.all([first.wait(context), next.wait(context)])
    const messages = (await f.root.context(context)).messages
    expect(
      messages.flatMap((message) => (message.role === 'user' ? [message.content] : [])),
    ).toEqual(['before', 'first', 'before', 'next'])
  } finally {
    gate.resolve()
    await f.close()
  }
})

it('keeps a finished answer when a hook refuses or throws for the follow-up queued behind it', async () => {
  const home = await temp()
  const prepared = await prepareHarness({
    ultimateRoot: home,
    userHome: home,
    home,
    faux: fauxProvider(),
  })
  let gate = Promise.withResolvers<void>()
  let held = false
  let ended = false
  let throwing = false
  prepared.registry.install(
    defineExtension({
      name: 'input-test',
      hooks: [
        hook(GenerationTask, {
          refuseInput: () => (ended ? 'this conversation has ended' : undefined),
          beforeInput: async (_input, { tx, conversationId }) => {
            ;(await tx.doc(Placed, conversationId)).count++
            if (throwing) throw new Error('note failed')
            return undefined
          },
        }),
      ],
    }),
  )
  const firstAnswer = async () => {
    held = true
    await gate.promise
    return fauxAssistantMessage('first answer')
  }
  prepared.faux!.setResponses([
    firstAnswer,
    fauxAssistantMessage('after refusal'),
    firstAnswer,
    fauxAssistantMessage('after throw'),
  ])
  const f = await prepared.open()
  const answers = async () =>
    (await f.root.context(context)).messages.flatMap((message) =>
      message.role === 'assistant'
        ? message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
        : [],
    )
  try {
    const first = await f.root.submit({ type: 'input', content: 'first' }, context)
    await until(() => held)
    const queued = await f.root.submit(
      { type: 'input', content: 'queued', whenBusy: 'followUp' },
      context,
    )
    ended = true
    gate.resolve()
    expect(await first.wait(context)).toMatchObject({ status: 'done' })
    expect(await queued.wait(context)).toMatchObject({
      status: 'unanswered',
      reason: 'refused',
      detail: 'this conversation has ended',
    })
    await expect(f.root.submit({ type: 'input', content: 'later' }, context)).rejects.toThrow(
      'this conversation has ended',
    )
    ended = false
    await (await f.root.submit({ type: 'input', content: 'again' }, context)).wait(context)
    expect(await answers()).toEqual(['first answer', 'after refusal'])

    held = false
    gate = Promise.withResolvers<void>()
    const third = await f.root.submit({ type: 'input', content: 'third' }, context)
    await until(() => held)
    const thrown = await f.root.submit(
      { type: 'input', content: 'thrown', whenBusy: 'followUp' },
      context,
    )
    const placedBeforeThrow = (await f.harness.snapshot(Placed, f.root.id, context))?.count
    throwing = true
    gate.resolve()
    expect(await third.wait(context)).toMatchObject({ status: 'done' })
    expect(await thrown.wait(context)).toMatchObject({
      status: 'unanswered',
      reason: 'refused',
      detail: 'note failed',
    })
    // The throwing placement's writes roll back with it: a note it would have placed is not marked as placed.
    expect((await f.harness.snapshot(Placed, f.root.id, context))?.count).toBe(placedBeforeThrow)
    throwing = false
    await (await f.root.submit({ type: 'input', content: 'last' }, context)).wait(context)
    expect(await answers()).toEqual([
      'first answer',
      'after refusal',
      'first answer',
      'after throw',
    ])
  } finally {
    gate.resolve()
    await f.close()
  }
})

it('refuses a steer queued before its conversation refuses input, at the tool round that would place it', async () => {
  const home = await temp()
  const prepared = await prepareHarness({
    ultimateRoot: home,
    userHome: home,
    home,
    faux: fauxProvider(),
  })
  const gate = Promise.withResolvers<void>()
  let held = false
  let ended = false
  prepared.registry.install(
    defineExtension({
      name: 'input-test',
      hooks: [
        hook(GenerationTask, {
          refuseInput: () => (ended ? 'this conversation has ended' : undefined),
        }),
      ],
    }),
  )
  prepared.faux!.setResponses([
    async () => {
      held = true
      await gate.promise
      return fauxAssistantMessage([fauxToolCall('unknown', {})], { stopReason: 'toolUse' })
    },
    fauxAssistantMessage('answer'),
  ])
  const f = await prepared.open()
  try {
    const first = await f.root.submit({ type: 'input', content: 'first' }, context)
    await until(() => held)
    const steer = await f.root.submit(
      { type: 'input', content: 'steer', whenBusy: 'steer' },
      context,
    )
    ended = true
    gate.resolve()
    expect(await steer.wait(context)).toMatchObject({ status: 'unanswered', reason: 'refused' })
    expect(await first.wait(context)).toMatchObject({ status: 'done' })
    const users = (await f.root.context(context)).messages.flatMap((message) =>
      message.role === 'user' ? [message.content] : [],
    )
    expect(users).toEqual(['first'])
  } finally {
    gate.resolve()
    await f.close()
  }
})

it('refuses only the steer its tool round places, leaving the next one queued', async () => {
  const home = await temp()
  const prepared = await prepareHarness({
    ultimateRoot: home,
    userHome: home,
    home,
    faux: fauxProvider(),
  })
  const gate = Promise.withResolvers<void>()
  let held = false
  let ended = false
  prepared.registry.install(
    defineExtension({
      name: 'input-test',
      hooks: [
        hook(GenerationTask, {
          refuseInput: (input) =>
            ended && JSON.stringify(input.model).includes('steer one') ? 'refused one' : undefined,
        }),
      ],
    }),
  )
  prepared.faux!.setResponses([
    async () => {
      held = true
      await gate.promise
      return fauxAssistantMessage([fauxToolCall('unknown', {})], { stopReason: 'toolUse' })
    },
    fauxAssistantMessage('answer'),
    fauxAssistantMessage('answer two'),
  ])
  const f = await prepared.open()
  try {
    const first = await f.root.submit({ type: 'input', content: 'first' }, context)
    await until(() => held)
    const steer = await f.root.submit(
      { type: 'input', content: 'steer one', whenBusy: 'steer' },
      context,
    )
    const second = await f.root.submit(
      { type: 'input', content: 'steer two', whenBusy: 'steer' },
      context,
    )
    ended = true
    gate.resolve()
    expect(await steer.wait(context)).toMatchObject({ status: 'unanswered', reason: 'refused' })
    expect(await first.wait(context)).toMatchObject({ status: 'done' })
    await second.wait(context)
    const users = (await f.root.context(context)).messages.flatMap((message) =>
      message.role === 'user' ? [message.content] : [],
    )
    expect(await second.wait(context)).toMatchObject({ status: 'done' })
    expect(users).toEqual(['first', 'steer two'])
  } finally {
    gate.resolve()
    await f.close()
  }
})

it('places a compaction summary when a hook throws for the input a failed run left queued', async () => {
  const home = await temp()
  const prepared = await prepareHarness({
    ultimateRoot: home,
    userHome: home,
    home,
    faux: fauxProvider(),
  })
  let throwing = false
  prepared.registry.install(
    defineExtension({
      name: 'input-test',
      hooks: [
        hook(GenerationTask, {
          beforeInput: () => {
            if (throwing) throw new Error('note failed')
            return undefined
          },
        }),
      ],
    }),
  )
  const gate = Promise.withResolvers<void>()
  let held = false
  prepared.faux!.setResponses([
    async () => {
      held = true
      await gate.promise
      return fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'bad request 400' })
    },
    fauxAssistantMessage('Summary'),
  ])
  const f = await prepared.open()
  try {
    await f.harness.commit(async (tx) => {
      for (let n = 0; n < 8; n++)
        await tx.appendEntry(f.root.id, {
          kind: 'pi.user',
          model: [{ role: 'user', content: `Part ${n} ${'word '.repeat(4000)}`, timestamp: n }],
        })
    }, context)
    const first = await f.root.submit({ type: 'input', content: 'first' }, context)
    await until(() => held)
    const queued = await f.root.submit(
      { type: 'input', content: 'queued', whenBusy: 'followUp' },
      context,
    )
    gate.resolve()
    expect(await first.wait(context)).toMatchObject({ status: 'unanswered', reason: 'model_error' })
    throwing = true
    const compaction = await f.root.compact(undefined, context)
    expect((await f.harness.waitForTask(compaction, context)).state).toMatchObject({
      outcome: { status: 'completed' },
    })
    expect((await f.root.context(context)).entries[0].kind).toBe('pi.compaction')
    expect(await queued.wait(context)).toMatchObject({
      status: 'unanswered',
      reason: 'refused',
      detail: 'note failed',
    })
  } finally {
    gate.resolve()
    await f.close()
  }
})

it('starts the next run with what a refusal leaves queued when an answer ends the run', async () => {
  const home = await temp()
  const prepared = await prepareHarness({
    ultimateRoot: home,
    userHome: home,
    home,
    faux: fauxProvider(),
  })
  const gate = Promise.withResolvers<void>()
  let held = false
  let refusing = false
  prepared.registry.install(
    defineExtension({
      name: 'input-test',
      hooks: [
        hook(GenerationTask, {
          refuseInput: (input) =>
            refusing && JSON.stringify(input.model).includes('refused steer')
              ? 'refused'
              : undefined,
        }),
      ],
    }),
  )
  prepared.faux!.setResponses([
    async () => {
      held = true
      await gate.promise
      return fauxAssistantMessage('first answer')
    },
    fauxAssistantMessage('second answer'),
  ])
  const f = await prepared.open()
  try {
    const first = await f.root.submit({ type: 'input', content: 'first' }, context)
    await until(() => held)
    const refused = await f.root.submit(
      { type: 'input', content: 'refused steer', whenBusy: 'steer' },
      context,
    )
    const next = await f.root.submit(
      { type: 'input', content: 'next steer', whenBusy: 'steer' },
      context,
    )
    refusing = true
    gate.resolve()
    expect(await first.wait(context)).toMatchObject({ status: 'done' })
    expect(await refused.wait(context)).toMatchObject({ status: 'unanswered', reason: 'refused' })
    expect(await next.wait(context)).toMatchObject({ status: 'done' })
  } finally {
    gate.resolve()
    await f.close()
  }
})

it('places idle input behind what a refusal took out of the queue', async () => {
  const home = await temp()
  const prepared = await prepareHarness({
    ultimateRoot: home,
    userHome: home,
    home,
    faux: fauxProvider(),
  })
  let refusing = false
  prepared.registry.install(
    defineExtension({
      name: 'input-test',
      hooks: [
        hook(GenerationTask, {
          refuseInput: (input) =>
            refusing && JSON.stringify(input.model).includes('left queued') ? 'refused' : undefined,
        }),
      ],
    }),
  )
  const gate = Promise.withResolvers<void>()
  let held = false
  prepared.faux!.setResponses([
    async () => {
      held = true
      await gate.promise
      return fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'bad request 400' })
    },
    fauxAssistantMessage('answer'),
  ])
  const f = await prepared.open()
  try {
    const first = await f.root.submit({ type: 'input', content: 'first' }, context)
    await until(() => held)
    const left = await f.root.submit(
      { type: 'input', content: 'left queued', whenBusy: 'steer' },
      context,
    )
    gate.resolve()
    expect(await first.wait(context)).toMatchObject({ status: 'unanswered', reason: 'model_error' })
    refusing = true
    const fresh = await f.root.submit({ type: 'input', content: 'fresh' }, context)
    expect(await left.wait(context)).toMatchObject({ status: 'unanswered', reason: 'refused' })
    expect(await fresh.wait(context)).toMatchObject({ status: 'done' })
  } finally {
    gate.resolve()
    await f.close()
  }
})

it('checks every queued input a batch boundary would place', async () => {
  const home = await temp()
  const prepared = await prepareHarness({
    ultimateRoot: home,
    userHome: home,
    home,
    faux: fauxProvider(),
  })
  const gate = Promise.withResolvers<void>()
  let held = false
  let refusing = false
  prepared.registry.install(
    defineExtension({
      name: 'input-test',
      hooks: [
        hook(GenerationTask, {
          refuseInput: (input) =>
            refusing && JSON.stringify(input.model).includes('refused') ? 'refused' : undefined,
        }),
      ],
    }),
  )
  prepared.faux!.setResponses([
    async () => {
      held = true
      await gate.promise
      return fauxAssistantMessage('first answer')
    },
    fauxAssistantMessage('batch answer'),
  ])
  const f = await prepared.open()
  try {
    const first = await f.root.submit({ type: 'input', content: 'first' }, context)
    await until(() => held)
    const queued = []
    for (const content of ['refused A', 'allowed B', 'refused C'])
      queued.push(await f.root.submit({ type: 'input', content, whenBusy: 'followUp' }, context))
    refusing = true
    gate.resolve()
    await first.wait(context)
    const [a, b, c] = await Promise.all(queued.map((submission) => submission.wait(context)))
    expect([a.status, b.status, c.status]).toEqual(['unanswered', 'done', 'unanswered'])
    const users = (await f.root.context(context)).messages.flatMap((message) =>
      message.role === 'user' ? [message.content] : [],
    )
    expect(users).toEqual(['first', 'allowed B'])
  } finally {
    gate.resolve()
    await f.close()
  }
})

it.each([false, true])(
  'takes an onYield continuation when the follow-up queued while it decided is refused (afterRun hook: %s)',
  async (withAfterRun) => {
    const home = await temp()
    const gate = Promise.withResolvers<void>()
    let deciding = false
    let refusing = false
    const Decide = defineTask<null, { phase: 'decide' }, { continue: string }>({
      name: 'input-test.continue',
      version: 1,
      initial: () => ({ phase: 'decide' }),
      abort: async (_task, runtime, ctx) =>
        runtime.commit(
          () => ({ status: 'terminal', outcome: { status: 'aborted' } }) as const,
          ctx,
        ),
      phases: {
        decide: async (_task, runtime, ctx) => {
          deciding = true
          await gate.promise
          await runtime.commit(
            () =>
              ({
                status: 'terminal',
                outcome: { status: 'completed', result: { continue: 'continue please' } },
              }) as const,
            ctx,
          )
        },
      },
    })
    const prepared = await prepareHarness({
      ultimateRoot: home,
      userHome: home,
      home,
      faux: fauxProvider(),
    })
    let yields = 0
    prepared.registry.install(
      defineExtension({
        name: 'input-test',
        tasks: [Decide],
        hooks: [
          hook(GenerationTask, {
            refuseInput: () => (refusing ? 'refused' : undefined),
            onYield: () =>
              yields++ === 0 ? { kind: 'tasks', tasks: [hookTask(Decide, null)] } : undefined,
            ...(withAfterRun ? { afterRun: () => undefined } : {}),
          }),
        ],
      }),
    )
    prepared.faux!.setResponses([
      fauxAssistantMessage('first answer'),
      fauxAssistantMessage('continued'),
    ])
    const f = await prepared.open()
    try {
      const first = await f.root.submit({ type: 'input', content: 'first' }, context)
      await until(() => deciding)
      const followUp = await f.root.submit(
        { type: 'input', content: 'follow-up', whenBusy: 'followUp' },
        context,
      )
      refusing = true
      gate.resolve()
      expect(await followUp.wait(context)).toMatchObject({
        status: 'unanswered',
        reason: 'refused',
      })
      await first.wait(context)
      await f.harness.waitForIdle(context)
      const messages = (await f.root.context(context)).messages.flatMap((message) =>
        message.role === 'user'
          ? [message.content]
          : message.role === 'assistant'
            ? message.content.flatMap((part) => (part.type === 'text' ? [`> ${part.text}`] : []))
            : [],
      )
      expect(messages).toEqual(['first', '> first answer', 'continue please', '> continued'])
    } finally {
      gate.resolve()
      await f.close()
    }
  },
)

it('starts one run with every follow-up queued while busy, and steers join the current run', async () => {
  const home = await temp()
  const prepared = await prepareHarness({
    ultimateRoot: home,
    userHome: home,
    home,
    faux: fauxProvider(),
  })
  const gate = Promise.withResolvers<void>()
  let held = false
  prepared.faux!.setResponses([
    async () => {
      held = true
      await gate.promise
      return fauxAssistantMessage([fauxToolCall('unknown', {})], { stopReason: 'toolUse' })
    },
    fauxAssistantMessage('first answer'),
    fauxAssistantMessage('follow-ups answer'),
    // Spare answers let one-at-a-time delivery finish and fail on the transcript instead of hanging.
    fauxAssistantMessage('extra'),
    fauxAssistantMessage('extra'),
  ])
  const f = await prepared.open()
  try {
    const first = await f.root.submit({ type: 'input', content: 'first' }, context)
    await until(() => held)
    const queued = []
    for (const content of ['one', 'two', 'three'])
      queued.push(await f.root.submit({ type: 'input', content, whenBusy: 'followUp' }, context))
    const steer = await f.root.submit(
      { type: 'input', content: 'steer', whenBusy: 'steer' },
      context,
    )
    gate.resolve()
    await Promise.all([first, steer, ...queued].map((submission) => submission.wait(context)))
    const messages = (await f.root.context(context)).messages
    expect(
      messages.flatMap((message) =>
        message.role === 'user'
          ? [message.content]
          : message.role === 'assistant'
            ? message.content.flatMap((part) => (part.type === 'text' ? [`> ${part.text}`] : []))
            : [],
      ),
    ).toEqual(['first', 'steer', '> first answer', 'one', 'two', 'three', '> follow-ups answer'])
    expect(await f.harness.snapshot(InboxDoc, f.root.id, context)).toEqual({ items: [] })
  } finally {
    gate.resolve()
    await f.close()
  }
})

it('records the thinking level each request asked for on its response', async () => {
  const home = await temp()
  const prepared = await prepareHarness({
    ultimateRoot: home,
    userHome: home,
    home,
    faux: fauxProvider(),
  })
  prepared.faux!.setResponses([fauxAssistantMessage('unset'), fauxAssistantMessage('high')])
  const f = await prepared.open()
  try {
    await (await f.root.submit({ type: 'input', content: 'one' }, context)).wait(context)
    await f.root.configure({ thinkingLevel: 'high' }, context)
    await (await f.root.submit({ type: 'input', content: 'two' }, context)).wait(context)
    const levels = (await f.root.context(context)).messages.flatMap((message) =>
      message.role === 'assistant' ? [message.thinkingLevel] : [],
    )
    expect(levels).toEqual(['off', 'high'])
  } finally {
    await f.close()
  }
})
