import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import {
  fauxAssistantMessage,
  fauxToolCall,
  fauxProvider,
} from '@earendil-works/pi-ai/providers/faux'
import {
  defineDoc,
  defineExtension,
  GenerationTask,
  hook,
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
