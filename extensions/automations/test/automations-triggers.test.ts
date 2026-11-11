import { join } from 'node:path'
import { fauxProvider, fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai/providers/faux'
import { configure, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord/json'
import { afterEach, expect, it, vi } from 'vitest'
import { context, prepareHarness } from '../../../server/harness.ts'
import type { OpenHost } from '../../../server/harness.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import type { ActionContext } from '../../../server/actions.ts'
import { callTrace } from '../../../server/trace.ts'
import { Metadata } from '../../../server/metadata.ts'
import { defineEvent, UserInputEvent } from '../../../shared/events.ts'
import { ContextUsageDoc } from '../../conversations/api.ts'
import { Standing } from '../../subagents/api.ts'
import type { SubagentsService } from '../../subagents/api.ts'
import { createChild } from '../../subagents/children.ts'
import automations, { actions, Automations } from '../server.ts'
import type { Automation } from '../types.ts'
import { IDLE_TICK } from '../triggers.ts'
import { temp, eventHost, until, apis } from '../../../test/helpers.ts'

const closes: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closes.splice(0)) await close()
  vi.useRealTimers()
})

async function fixture() {
  const root = await temp('ultimate-triggers-')
  const prepared = await prepareHarness({
    ultimateRoot: root,
    userHome: root,
    home: root,
    faux: fauxProvider(),
  })
  let opened: OpenHost
  const events = eventHost(() => opened.harness, 'automations')
  const resources = new Map<string, unknown>()
  let opener: () => Promise<void>
  let closer: () => Promise<void>
  let fail = false
  let rolledBack = false
  const send = vi.fn<() => Promise<object>>(async () => ({}))
  const host = {
    ...prepared,
    ...events,
    react: ((name, tokens, handler) =>
      events.react(name, tokens, async (tx, event) => {
        await handler(tx, event)
        if (fail) {
          fail = false
          rolledBack = true
          throw new Error('Rollback after fire')
        }
      })) satisfies ExtensionHost['react'],
    harness: () => opened.harness,
    metadata: Metadata,
    resource: (key: string, create: () => unknown) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key)
    },
    onOpen: (fn: () => Promise<void>) => {
      opener = fn
    },
    onRelease: () => {},
    onClose: (fn: () => Promise<void>) => {
      closer = fn
    },
    ...apis(new Map<string, unknown>([['messages', { send }]])),
    extensions: () => [{ name: 'subagents', enabled: true }],
    projectSetup: async () => ({ decision: false }),
    notice: (message: string) => {
      throw new Error(message)
    },
  }
  host.provided.set('subagents', {
    // As the real one: the standing agent's conversation of the moment, the fixture's target before one is recorded.
    standing: async (name: string) =>
      name === 'ultimate'
        ? ((await opened.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))?.ultimate ??
          target)
        : undefined,
    createChild: (tx: Tx, options: Parameters<SubagentsService['createChild']>[1]) =>
      createChild(host, tx, options),
  })
  prepared.registry.install(automations(host as unknown as ExtensionHost))
  const answer = () => {
    prepared.faux!.appendResponses([answer])
    return fauxAssistantMessage([fauxText('OK')])
  }
  prepared.faux!.setResponses([answer])
  opened = await prepared.open()
  const target = await opened.harness.commit(async (tx) => {
    const child = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    await configure(tx, child.id, {})
    return child.id
  }, context)
  await opener!()
  await events.start()
  closes.push(async () => {
    await events.stop()
    await closer!()
    await opened.close()
  })
  const action = (name: keyof typeof actions, args: JsonValue = {}) =>
    actions[name](args, { host, conversationId: target } as unknown as ActionContext)
  const records = async () => (await opened.harness.snapshot(Automations, context))!.automations
  const record = async (id: string) => (await records())[id]
  const emit = (name: string, data: JsonValue = {}) =>
    opened.harness.commit((tx) => host.emit(tx, defineEvent(name), data), context)
  const settle = () => until(events.settled)
  const usage = (percent: number) =>
    opened.harness.commit(async (tx) => {
      Object.assign(await tx.doc(ContextUsageDoc, target), {
        percent,
        tokens: percent * 10000,
        window: 1000000,
        at: Date.now(),
      })
    }, context)
  return {
    root,
    host,
    action,
    records,
    record,
    target,
    emit,
    settle,
    startEvents: events.start,
    stopEvents: events.stop,
    usage,
    send,
    get harness() {
      return opened.harness
    },
    opener: () => opener!(),
    closer: () => closer!(),
    fail: () => {
      fail = true
    },
    rolledBack: () => rolledBack,
  }
}

it('matches only new events, strict filters and excludes its own run conversations', async () => {
  const f = await fixture()
  await f.stopEvents()
  await f.emit('workspaces.check', { result: 'failed' })
  const a = (await f.action('create', {
    name: 'Check',
    event: { name: 'workspaces.check', where: { result: 'failed' } },
  })) as Automation
  await f.startEvents()
  await f.settle()
  expect((await f.record(a.id)).fires).toBe(0)
  await f.emit('workspaces.check', { result: 'passed' })
  await f.settle()
  expect((await f.record(a.id)).fires).toBe(0)
  await f.emit('workspaces.check', { result: 'failed' })
  await f.settle()
  expect((await f.record(a.id)).fires).toBe(1)
  await f.action('pause', { id: a.id })
  await f.stopEvents()
  await f.emit('workspaces.check', { result: 'failed' })
  await f.action('resume', { id: a.id })
  await f.startEvents()
  await f.settle()
  expect((await f.record(a.id)).fires).toBe(1)
  await f.action('run', { id: a.id })
  expect((await f.record(a.id)).fires).toBe(2)
})

it("matches @ultimate's compaction by its conversation when the event comes, across a chapter change", async () => {
  const f = await fixture()
  const a = (await f.action('create', {
    name: 'Dream after compaction',
    event: { name: 'conversations.compacted', where: { conversation: '@ultimate' } },
  })) as Automation
  // No @ultimate yet: nothing matches, not even an event without a conversation.
  await f.emit('conversations.compacted', { conversation: f.target, entry: 1 })
  await f.settle()
  expect((await f.record(a.id)).fires).toBe(0)
  const standing = (id: number) =>
    f.harness.commit(async (tx) => {
      ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = id as never
    }, context)
  await standing(f.target)
  // Another conversation (a root's tally compacted from its footer) is not @ultimate.
  await f.emit('conversations.compacted', { conversation: 1, entry: 2 })
  await f.emit('conversations.compacted', { conversation: f.target, entry: 3 })
  await f.settle()
  expect((await f.record(a.id)).fires).toBe(1)
  // A new chapter gives @ultimate a new conversation: the old one no longer fires, the new one does.
  await standing(f.target + 100)
  await f.emit('conversations.compacted', { conversation: f.target, entry: 4 })
  await f.emit('conversations.compacted', { conversation: f.target + 100, entry: 5 })
  await f.settle()
  expect((await f.record(a.id)).fires).toBe(2)
})

it('wakes an @name subscriber in the conversation the agent has when it fires, across a chapter change', async () => {
  const f = await fixture()
  const wake = async (id: ConversationId) =>
    (await (await f.harness.conversation(id, context))!.context(context)).entries.filter(
      (e) => e.kind === 'automations.fired',
    ).length
  const next = await f.harness.commit(async (tx) => {
    const child = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    await configure(tx, child.id, {})
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = f.target
    return child.id
  }, context)
  const a = (await f.action('create', {
    name: 'Remind',
    schedule: 'every 1d',
    subscribers: ['@ultimate'],
  })) as Automation
  expect(a.subscribers).toEqual(['@ultimate'])
  await f.action('run', { id: a.id })
  await until(async () => (await wake(f.target)) === 1)
  // A new chapter gives @ultimate a new conversation: the next fire goes there.
  await f.harness.commit(async (tx) => {
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = next
  }, context)
  await f.action('run', { id: a.id })
  await until(async () => (await wake(next)) === 1)
  expect(await wake(f.target)).toBe(1)
  // An automation that would reach nobody is refused.
  await expect(f.action('unsubscribe', { id: a.id, to: '@ultimate' })).rejects.toThrow(
    'At least one of prompt or subscribers',
  )
})

it('returns the automation a key made instead of a second one, as a create that lost its receipt retries', async () => {
  const f = await fixture()
  const args = { name: 'Once', schedule: 'every 1d', key: 'caller:1' }
  const first = (await f.action('create', args)) as Automation
  const again = (await f.action('create', { ...args, name: 'Renamed' })) as Automation
  expect(again).toMatchObject({ id: first.id, name: 'Once', key: 'caller:1' })
  expect(Object.keys(await f.records())).toEqual([first.id])
})

it('skips events from its own prompt runs, by trace or by the conversation they name, however old', async () => {
  const f = await fixture()
  const own = (await f.action('create', {
    name: 'Own',
    event: { name: 'conversations.compacted' },
    prompt: 'Look at the compaction',
  })) as Automation
  await f.action('run', { id: own.id })
  await until(async () => (await f.record(own.id)).runs[0]?.status === 'done')
  const run = (await f.record(own.id)).runs[0].conversationId!
  // Pushed out of the bounded run history: ownership, not the history, says it is this automation's run.
  await f.harness.commit(async (tx) => {
    ;(await tx.doc(Automations)).automations[own.id].runs = []
  }, context)
  await f.emit('conversations.compacted', { conversation: run, reason: 'threshold' })
  const trace = callTrace(join(f.root, 'trace.sqlite'))
  await trace.run(
    { kind: 'action', caller: 'test', callee: 'test', name: 'emit', conversationId: run },
    () => f.emit('conversations.compacted', { conversation: f.target }),
  )
  await f.settle()
  expect((await f.record(own.id)).fires).toBe(1)
  // Removing the prompt later does not make its old runs' events its own triggers.
  await f.action('subscribe', { id: own.id })
  await f.action('update', { id: own.id, prompt: '' })
  await f.emit('conversations.compacted', { conversation: run, reason: 'threshold' })
  await f.settle()
  expect((await f.record(own.id)).fires).toBe(1)
  // Another conversation's compaction does fire it.
  await f.emit('conversations.compacted', { conversation: f.target })
  await f.settle()
  expect((await f.record(own.id)).fires).toBe(2)
})

it('fires multiple prompt automations for one event in the same transaction', async () => {
  const f = await fixture()
  const first = (await f.action('create', {
    name: 'First',
    event: { name: 'update.applied' },
    prompt: 'First',
  })) as Automation
  const second = (await f.action('create', {
    name: 'Second',
    event: { name: 'update.applied' },
    prompt: 'Second',
  })) as Automation
  await f.emit('update.applied')
  await f.settle()
  expect((await f.record(first.id)).fires).toBe(1)
  expect((await f.record(second.id)).fires).toBe(1)
  await until(
    async () =>
      (await f.record(first.id)).runs[0]?.status === 'done' &&
      (await f.record(second.id)).runs[0]?.status === 'done',
  )
  expect((await f.record(first.id)).runs[0].conversationId).not.toBe(
    (await f.record(second.id)).runs[0].conversationId,
  )
})

it('uses strict top-level filter equality and bounded one-line event summaries', async () => {
  const f = await fixture()
  const compacted = (await f.action('create', {
    name: 'Compacted',
    event: { name: 'conversations.compacted', where: { conversation: f.target } },
  })) as Automation
  await f.emit('conversations.compacted', { conversation: String(f.target) })
  await f.settle()
  expect((await f.record(compacted.id)).fires).toBe(0)
  await f.emit('conversations.compacted', { conversation: f.target, reason: 'Many\n'.repeat(100) })
  await f.settle()
  expect((await f.record(compacted.id)).fires).toBe(1)
  const fired = await f.host.eventLog.recent({ events: [defineEvent('automations.fired')] })
  const text = (fired[0].data as { text: string }).text
  expect(text.length).toBeLessThanOrEqual(200)
  expect(text).not.toContain('\n')
  await f.action('create', { name: 'Landed', event: { name: 'workspaces.landed' } })
  await f.emit('workspaces.landed', { sha: 'abc1234567', title: 'Title' })
  await f.settle()
  expect(
    (await f.host.eventLog.recent({ events: [defineEvent('automations.fired')] }))[0].data,
  ).toMatchObject({ text: 'workspaces.landed abc1234 "Title"' })
})

it('rolls back a fire and its cursor together, then retries exactly once', async () => {
  const f = await fixture()
  const a = (await f.action('create', {
    name: 'Update',
    event: { name: 'update.applied' },
  })) as Automation
  f.fail()
  await f.emit('update.applied')
  await until(f.rolledBack)
  await until(async () => (await f.host.eventLog.reactors()).some((r) => !!r.failure))
  expect((await f.record(a.id)).fires).toBe(0)
  await f.emit('update.refused')
  await f.settle()
  expect((await f.record(a.id)).fires).toBe(1)
  await f.stopEvents()
  await f.startEvents()
  await f.settle()
  expect((await f.record(a.id)).fires).toBe(1)
})

it('uses context hysteresis and cooldown and catches a missed crossing on open once', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const f = await fixture()
  const a = (await f.action('create', {
    name: 'Context',
    condition: { metric: 'context', of: '@ultimate', above: 80 },
  })) as Automation
  for (const [percent, fires, armed] of [
    [79, 0, true],
    [81, 1, false],
    [85, 1, false],
    [75, 1, false],
    [69, 1, true],
    [81, 1, true],
  ] as const) {
    await f.usage(percent)
    await until(async () => (await f.record(a.id)).condition?.value === percent)
    expect((await f.record(a.id)).fires).toBe(fires)
    expect((await f.record(a.id)).condition?.armed).toBe(armed)
  }
  vi.setSystemTime(Date.now() + 3600001)
  await f.usage(82)
  await until(async () => (await f.record(a.id)).fires === 2)
  await f.usage(69)
  await until(async () => (await f.record(a.id)).condition?.armed === true)
  await f.closer()
  vi.setSystemTime(Date.now() + 3600001)
  await f.usage(81)
  expect((await f.record(a.id)).fires).toBe(2)
  await f.opener()
  expect((await f.record(a.id)).fires).toBe(3)
  await f.opener()
  expect((await f.record(a.id)).fires).toBe(3)
})

it('fires an idle condition only after the pause, at the threshold, and re-arms below the line', async () => {
  // The minute look is an interval: faked, so a tick runs when the test says.
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  const f = await fixture()
  await f.harness.commit(async (tx) => {
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = f.target
  }, context)
  const HOUR = 3600_000
  const a = (await f.action('create', {
    name: 'Pause',
    condition: { metric: 'context', of: '@ultimate', above: 50, idleFor: 8 * HOUR, cooldownMs: 0 },
  })) as Automation
  const plain = (await f.action('create', {
    name: 'Plain',
    condition: { metric: 'context', of: '@ultimate', above: 90 },
  })) as Automation
  const input = () =>
    f.harness.commit(
      (tx) =>
        f.host.emit(tx, UserInputEvent, { conversation: f.target, kind: 'prompt', length: 1 }),
      context,
    )
  const tick = async () => {
    // The minute look reads only the idle condition: it measures it again, and leaves the plain one as it was.
    await f.harness.commit(async (tx) => {
      const ledger = (await tx.doc(Automations)).automations
      delete ledger[a.id].condition!.value
      delete ledger[plain.id].condition!.value
    }, context)
    vi.advanceTimersByTime(IDLE_TICK)
    await until(async () => (await f.record(a.id)).condition?.value !== undefined)
    expect((await f.record(plain.id)).condition?.value).toBeUndefined()
  }
  // Above the threshold right away: no pause yet.
  await f.usage(60)
  await until(async () => (await f.record(a.id)).condition?.value === 60)
  expect((await f.record(a.id)).fires).toBe(0)
  // The user writes at 7 h; at 14 h (7 h after it) it is still silent, then time alone crosses 8 h.
  vi.setSystemTime(Date.now() + 7 * HOUR)
  await input()
  await f.settle()
  expect((await f.record(a.id)).condition?.inputAt).toBe(Date.now())
  vi.setSystemTime(Date.now() + 7 * HOUR)
  await tick()
  expect((await f.record(a.id)).fires).toBe(0)
  vi.setSystemTime(Date.now() + HOUR + 1)
  await tick()
  expect((await f.record(a.id)).fires).toBe(1)
  expect((await f.record(a.id)).condition?.armed).toBe(false)
  // Disarmed: further pauses and ticks above the line do not fire again; dropping to 45% does not re-arm.
  vi.setSystemTime(Date.now() + 9 * HOUR)
  await f.usage(45)
  await until(async () => (await f.record(a.id)).condition?.value === 45)
  await tick()
  expect((await f.record(a.id)).condition?.armed).toBe(false)
  // Below 40% re-arms; past the pause but under the threshold stays silent.
  await f.usage(39)
  await until(async () => (await f.record(a.id)).condition?.armed === true)
  await tick()
  expect((await f.record(a.id)).fires).toBe(1)
  // Back over 50% after the pause: the second fire.
  await f.usage(51)
  await until(async () => (await f.record(a.id)).fires === 2)
  // Retargeted: the old target's input no longer counts; the pause starts afresh from the update.
  await f.action('update', {
    id: a.id,
    condition: { metric: 'context', of: `#${f.target}`, above: 50, idleFor: 8 * HOUR },
  })
  expect((await f.record(a.id)).condition?.inputAt).toBe(Date.now())
})

it('sees a re-arm and the crossing after it even when both commit before evaluation', async () => {
  const f = await fixture()
  const a = (await f.action('create', {
    name: 'Lagging',
    condition: { metric: 'context', of: '@ultimate', above: 80, cooldownMs: 0 },
  })) as Automation
  await f.usage(81)
  await until(async () => (await f.record(a.id)).fires === 1)
  // Both measurements are in before the watcher's queue reaches either.
  await Promise.all([f.usage(69), f.usage(81)])
  await until(async () => (await f.record(a.id)).fires === 2)
  expect((await f.record(a.id)).condition?.armed).toBe(false)
})

it('evaluates on create and resume, including a numeric conversation target', async () => {
  const f = await fixture()
  await f.usage(81)
  const a = (await f.action('create', {
    name: 'Full',
    condition: { metric: 'context', of: `#${f.target}`, above: 80, cooldownMs: 0 },
  })) as Automation
  expect((await f.record(a.id)).fires).toBe(1)
  await f.action('pause', { id: a.id })
  await f.harness.commit(async (tx) => {
    ;(await tx.doc(Automations)).automations[a.id].condition!.armed = true
  }, context)
  await f.action('resume', { id: a.id })
  expect((await f.record(a.id)).fires).toBe(2)
})

const floodTriggers: { kind: string; trigger: Record<string, JsonValue> }[] = [
  { kind: 'event', trigger: { event: { name: 'update.applied' } } },
  { kind: 'schedule', trigger: { schedule: 'every 1d' } },
  { kind: 'context', trigger: { condition: { metric: 'context', of: '@ultimate', above: 80 } } },
]
it.each(floodTriggers)(
  'pauses the seventh $kind fire in an hour and delivers escalation to subscribers',
  async ({ trigger }) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const f = await fixture()
    const a = (await f.action('create', {
      name: 'Flood',
      ...trigger,
    })) as Automation
    for (let i = 0; i < 7; i++) await f.action('run', { id: a.id })
    expect(await f.record(a.id)).toMatchObject({ fires: 6, enabled: false })
    expect(
      (await f.host.eventLog.recent({ events: [defineEvent('automations.escalated')] }))[0].data,
    ).toEqual({ id: a.id, reason: 'Fired more than 6 times in an hour; paused' })
    await until(async () => {
      const target = (await f.harness.conversation(f.target, context))!
      return (await target.context(context)).entries.some((e) => e.kind === 'automations.escalated')
    })
    expect(f.send).toHaveBeenCalled()
    vi.setSystemTime(Date.now() + 3600001)
    await f.action('run', { id: a.id })
    expect((await f.record(a.id)).fires).toBe(7)
    expect((await f.record(a.id)).recentFires).toHaveLength(1)
  },
)

it('lists ten event definitions and validates trigger inputs and kind changes', async () => {
  const f = await fixture()
  const events = (await f.action('events')) as {
    name: string
    description: string
    fields: object
  }[]
  expect(events).toHaveLength(10)
  expect(new Set(events.map((e) => e.name)).size).toBe(10)
  for (const event of events) {
    expect(event.description).toBeTruthy()
    expect(event.fields).toBeTypeOf('object')
  }
  const invalid: JsonValue[] = [
    { event: { name: 'unknown' } },
    { event: { name: 'health.changed', where: { unknown: 'x' } } },
    { condition: { metric: 'context', of: '@ultimate', above: 100 } },
    { condition: { metric: 'context', of: '#99999', above: 80 } },
    { condition: { metric: 'context', of: '@missing', above: 80 } },
    { event: { name: 'update.applied' }, schedule: 'every 1h' },
  ]
  for (const args of invalid)
    await expect(f.action('create', { name: 'Bad', ...(args as object) })).rejects.toThrow(/.+/)
  const a = (await f.action('create', {
    name: 'Event',
    event: { name: 'health.changed' },
  })) as Automation
  await f.action('update', {
    id: a.id,
    event: { name: 'health.changed', where: { provider: 'openai' } },
  })
  expect((await f.record(a.id)).event?.where).toEqual({ provider: 'openai' })
  // An event may become a condition (one trigger at a time), never a script.
  await expect(
    f.action('update', {
      id: a.id,
      event: { name: 'health.changed' },
      condition: { metric: 'context', of: '@ultimate', above: 80 },
    }),
  ).rejects.toThrow('Cannot change trigger kind')
  await expect(f.action('update', { id: a.id, ask: 'Watch something' })).rejects.toThrow(
    'Cannot change trigger kind',
  )
  await f.action('update', {
    id: a.id,
    condition: { metric: 'context', of: '@ultimate', above: 80 },
  })
  const changed = await f.record(a.id)
  expect(changed.event).toBeUndefined()
  expect(changed.condition).toMatchObject({ of: '@ultimate', above: 80, armed: true })
})
