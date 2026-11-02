import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { Type } from 'typebox'
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  fauxProvider,
} from '@earendil-works/pi-ai/providers/faux'
import {
  defineExtension,
  defineTask,
  defineTool,
  GenerationTask,
  hook,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, Harness } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import { prepareHarness } from '../server/harness.ts'
import type { OpenHost } from '../server/harness.ts'
import type { ActionContext } from '../server/actions.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import pauseExtension, {
  actions,
  autoPlay,
  passive,
  userActions,
} from '../extensions/pause/server.ts'
import { lasted } from '../extensions/pause/lasted.ts'
import { PauseApi } from '../extensions/pause/api.ts'
import { apis, removeTemps, temp, until } from './helpers.ts'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Standing } from '../extensions/subagents/api.ts'

const hosts: OpenHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  await removeTemps()
})

/** A background task that executes until `released`, as a summary streaming a model response does. */
const streamTask = (released: Promise<void>) =>
  defineTask<null, { phase: 'stream' }, null>({
    name: 'pause-test.stream',
    version: 1,
    initial: () => ({ phase: 'stream' }),
    phases: {
      stream: async (_task, runtime, ctx) => {
        await released
        await runtime.commit(
          () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
          ctx,
        )
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })

/** A faux harness with the pause extension and a `work` tool that runs until the test releases it, as bash would. */
async function fixture(home?: string, retry: { maxRetries?: number } = {}) {
  home ??= await temp('ultimate-pause-')
  // Pi's retry backoff in 1 ms, so a retry the pause held runs at once after Play.
  await mkdir(join(home, '.pi'), { recursive: true })
  await writeFile(
    join(home, '.pi/settings.json'),
    JSON.stringify({ retry: { baseDelayMs: 1, ...retry } }),
  )
  const prepared = await prepareHarness({
    ultimateRoot: home,
    userHome: home,
    home,
    faux: fauxProvider(),
  })
  let finish: (() => void) | undefined
  let finished = 0
  const background = Promise.withResolvers<void>()
  prepared.registry.install(
    defineExtension({
      name: 'pause-test',
      tasks: [streamTask(background.promise)],
      tools: [
        defineTool({
          name: 'work',
          description: 'Work until released',
          parameters: Type.Object({}),
          execute: async () => {
            await new Promise<void>((resolve) => {
              finish = resolve
            })
            finished++
            return { output: [{ type: 'text', text: 'worked' }] }
          },
        }),
      ],
    }),
  )
  let opened: OpenHost | undefined
  const services = apis()
  const openers: (() => Promise<void>)[] = []
  const host = {
    ...services,
    harness: () => opened!.harness,
    resource: (() => {
      const resources = new Map<string, unknown>()
      return <T>(key: string, create: () => T) => {
        if (!resources.has(key)) resources.set(key, create())
        return resources.get(key) as T
      }
    })(),
    onOpen: (callback: () => Promise<void>) => void openers.push(callback),
    onClose: () => {},
    onRelease: () => {},
    conversations: () => [],
  } as unknown as ExtensionHost
  prepared.registry.install(pauseExtension(host))
  /** Open as the server does: the openers settle first, then scheduling resumes. */
  const open = async () => {
    opened = await prepared.open(false)
    hosts.push(opened)
    for (const callback of openers) await callback()
    opened.harness.resume()
    return opened
  }
  const action = (name: keyof typeof actions) =>
    actions[name](null, { host } as unknown as ActionContext)
  return {
    home,
    prepared,
    open,
    action,
    setAutoPlay: (minutes: number | null) =>
      actions.autoPlay({ minutes }, { host } as unknown as ActionContext),
    autoPlay: (now: number) => autoPlay(host, now),
    paused: () => services.want(PauseApi)!.paused(),
    get opened() {
      return opened!
    },
    get finish() {
      return finish
    },
    finished: () => finished,
    background,
    stream: streamTask(background.promise),
    async close() {
      await opened!.close()
      hosts.splice(hosts.indexOf(opened!), 1)
    },
  }
}

const generations = async (harness: Harness) =>
  (await harness.inspect(context)).tasks.filter(({ record }) => record.kind === 'pi.generation')

it('lets a running tool finish, starts no generation after it while paused, and continues on play', async () => {
  const f = await fixture()
  let responses = 0
  f.prepared.faux!.setResponses([
    () => {
      responses++
      return fauxAssistantMessage([fauxToolCall('work', {})], { stopReason: 'toolUse' })
    },
    () => {
      responses++
      return fauxAssistantMessage([fauxText('done')])
    },
  ])
  const { root, harness } = await f.open()
  const submission = await root.submit({ type: 'input', content: 'go' }, context)
  await until(() => f.finish !== undefined)

  const pausing = await f.action('pause')
  expect(pausing.paused).toBe(true)
  expect(pausing.running.map((task) => task.what)).toEqual(['work'])
  expect(f.paused()).toBe(true)
  expect((await harness.inspect(context)).scheduling).toBe('paused')

  // The tool finishes on its own; the generation that waited for it parks instead of asking for the next response.
  f.finish!()
  await until(async () => (await f.action('state')).running.length === 0)
  expect(f.finished()).toBe(1)
  expect(responses).toBe(1)
  // Its tool ended, so the generation could take its next step; held, it is only ready.
  const [generation] = await generations(harness)
  expect(generation.state.kind).toBe('ready')
  // A submit or wait asks Pi to resume scheduling; the hold wins.
  await root.submit({ type: 'input', content: 'queued meanwhile' }, context)
  harness.resume()
  await Promise.resolve()
  expect((await harness.inspect(context)).scheduling).toBe('paused')
  expect(responses).toBe(1)

  const played = await f.action('play')
  expect(played.paused).toBe(false)
  expect(f.paused()).toBe(false)
  await submission.wait(context)
  expect(responses).toBeGreaterThanOrEqual(2)
  const notes = (await root.context(context)).entries.filter((entry) => entry.kind === 'pause.note')
  expect(notes).toHaveLength(1)
  expect(notes[0].model?.[0]?.content).toMatch(/^Paused for \d+s; the run continued after Play\.$/)
})

it('reopens paused: nothing starts until play', async () => {
  const f = await fixture()
  let responses = 0
  f.prepared.faux!.setResponses([
    () => {
      responses++
      return fauxAssistantMessage([fauxText('answer')])
    },
  ])
  await f.open()
  await f.action('pause')
  await f.close()

  const reopened = await f.open()
  expect(f.paused()).toBe(true)
  expect((await reopened.harness.inspect(context)).scheduling).toBe('paused')
  const submission = await reopened.root.submit({ type: 'input', content: 'hello' }, context)
  await new Promise((resolve) => setImmediate(resolve))
  expect(responses).toBe(0)
  const [generation] = await generations(reopened.harness)
  expect(generation.record.state.status).toBe('pending')
  expect(generation.state.kind).toBe('ready')

  await f.action('play')
  await submission.wait(context)
  expect(responses).toBe(1)
  // Idle when paused: no note.
  const entries = (await reopened.root.context(context)).entries
  expect(entries.some((entry) => entry.kind === 'pause.note')).toBe(false)
})

it('leaves a note only on runs that were mid-turn, once, and none on idle conversations', async () => {
  const f = await fixture()
  f.prepared.faux!.setResponses([
    () => fauxAssistantMessage([fauxToolCall('work', {})], { stopReason: 'toolUse' }),
    () => fauxAssistantMessage([fauxText('done')]),
  ])
  const { root, harness } = await f.open()
  const idle = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
  const submission = await root.submit({ type: 'input', content: 'go' }, context)
  await until(() => f.finish !== undefined)
  await f.action('pause')
  f.finish!()
  await until(async () => (await f.action('state')).running.length === 0)
  await f.action('play')
  // A second Play finds nothing paused and leaves nothing.
  await f.action('play')
  await submission.wait(context)
  const notes = async (id: ConversationId) =>
    (await (await harness.conversation(id, context))!.context(context)).entries.filter(
      (entry) => entry.kind === 'pause.note',
    )
  expect(await notes(root.id)).toHaveLength(1)
  expect(await notes(idle.id)).toEqual([])
  expect((await harness.snapshot(LiveDoc, root.id, context))?.run).toBeUndefined()
})

it('serializes overlapping pause and play: the doc and the scheduler always agree', async () => {
  const f = await fixture()
  const { harness } = await f.open()
  const agree = async () => {
    const doc = (await f.action('state')).paused
    expect((await harness.inspect(context)).scheduling).toBe(doc ? 'paused' : 'running')
    expect(f.paused()).toBe(doc)
    return doc
  }
  await Promise.all([f.action('pause'), f.action('play')])
  expect(await agree()).toBe(false)
  await Promise.all([f.action('play'), f.action('pause')])
  expect(await agree()).toBe(true)
  await Promise.all([f.action('pause'), f.action('play'), f.action('pause'), f.action('play')])
  expect(await agree()).toBe(false)
})

it('leaves no note on a run that started after the paused one was stopped', async () => {
  const f = await fixture()
  f.prepared.faux!.setResponses([
    () => fauxAssistantMessage([fauxToolCall('work', {})], { stopReason: 'toolUse' }),
    () => fauxAssistantMessage([fauxText('B done')]),
  ])
  const { root } = await f.open()
  await root.submit({ type: 'input', content: 'A' }, context)
  await until(() => f.finish !== undefined)
  await f.action('pause')
  // Stop A while paused: abort handlers run under the hold.
  const stopping = root.abort(context)
  f.finish!()
  await stopping
  const b = await root.submit({ type: 'input', content: 'B' }, context)
  await f.action('play')
  await b.wait(context)
  const entries = (await root.context(context)).entries
  expect(entries.filter((entry) => entry.kind === 'pause.note')).toEqual([])
})

it('notes a run whose last answer arrived while the pause drained', async () => {
  const f = await fixture()
  const answer = Promise.withResolvers<void>()
  let asked = false
  f.prepared.faux!.setResponses([
    async () => {
      asked = true
      await answer.promise
      return fauxAssistantMessage([fauxText('final answer')])
    },
  ])
  const { root, harness } = await f.open()
  const submission = await root.submit({ type: 'input', content: 'go' }, context)
  await until(() => asked)
  const pausing = await f.action('pause')
  expect(pausing.running.map((task) => task.what)).toEqual(['model response'])
  answer.resolve()
  await submission.wait(context)
  expect((await harness.snapshot(LiveDoc, root.id, context))?.run).toBeUndefined()
  await f.action('play')
  const notes = (await root.context(context)).entries.filter((entry) => entry.kind === 'pause.note')
  expect(notes).toHaveLength(1)
  expect(notes[0].data).toMatchObject({ finished: true })
  expect(notes[0].model?.[0]?.content).toMatch(/^Paused for \d+s after this run's last answer\.$/)
})

it('leaves no note when the run handed over during the drain and its successor was stopped', async () => {
  const f = await fixture()
  // The first answer continues the run: its generation completes and hands the run to a successor, while paused.
  let continued = false
  f.prepared.registry.install(
    defineExtension({
      name: 'pause-handover',
      hooks: [
        hook(GenerationTask, {
          onYield: () => {
            if (continued) return undefined
            continued = true
            return { continue: 'keep going' }
          },
        }),
      ],
    }),
  )
  const answer = Promise.withResolvers<void>()
  let asked = false
  f.prepared.faux!.setResponses([
    async () => {
      asked = true
      await answer.promise
      return fauxAssistantMessage([fauxText('first answer')])
    },
    () => fauxAssistantMessage([fauxText('B done')]),
  ])
  const { root, harness } = await f.open()
  const a = await root.submit({ type: 'input', content: 'A' }, context)
  await until(() => asked)
  await f.action('pause')
  const recorded = (await f.action('state')).running[0].task
  answer.resolve()
  // The recorded generation completed by handing over; the successor is held.
  await until(
    async () => (await harness.getTask(recorded as never, context))?.state.status === 'terminal',
  )
  expect(continued).toBe(true)
  await root.abort(context)
  expect((await a.wait(context)).status).toBe('unanswered')
  const b = await root.submit({ type: 'input', content: 'B' }, context)
  await f.action('play')
  await b.wait(context)
  const entries = (await root.context(context)).entries
  expect(entries.filter((entry) => entry.kind === 'pause.note')).toEqual([])
})

const limit =
  "Incomplete Claude Code upstream response (status 429, capture incomplete, upstream said: This request would exceed your account's rate limit. Please try again later.)"

it('pauses on the first rate-limited answer: the run waits in its retry, fails nothing, and continues on play', async () => {
  const f = await fixture()
  let responses = 0
  f.prepared.faux!.setResponses([
    () => {
      responses++
      return fauxAssistantMessage('', { stopReason: 'error', errorMessage: limit })
    },
    () => {
      responses++
      return fauxAssistantMessage([fauxText('done')])
    },
  ])
  const { root, harness } = await f.open()
  const ultimate = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
  await harness.commit(async (tx) => {
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = ultimate.id
  }, context)
  const submission = await root.submit({ type: 'input', content: 'go' }, context)
  await until(async () => (await f.action('state')).limit !== undefined)
  expect(await f.action('state')).toMatchObject({
    paused: true,
    limit: { error: limit, conversationId: root.id },
  })
  expect(f.paused()).toBe(true)
  // Pi's retry was due after 1 ms; held, it never asks again, and the run neither fails nor ends.
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve))
  expect(responses).toBe(1)
  const [generation] = await generations(harness)
  expect(generation.record.state.status).not.toBe('terminal')
  expect((await harness.snapshot(LiveDoc, root.id, context))?.run).toBeDefined()
  const cards = async () =>
    (await ultimate.context(context)).entries.filter((entry) => entry.kind === 'pause.limit')
  await until(async () => (await cards()).length === 1)
  expect((await cards())[0].data).toMatchObject({ error: limit, conversationId: root.id })

  const played = await f.action('play')
  expect(played.limit).toBeUndefined()
  expect((await submission.wait(context)).status).toBe('done')
  expect(responses).toBe(2)
  const notes = (await root.context(context)).entries.filter((entry) => entry.kind === 'pause.note')
  expect(notes).toHaveLength(1)
  // The held run's model learns why it was paused.
  expect(notes[0].model?.[0]?.content).toMatch(
    /^Paused for \d+s \(faux rate limited [\w-]+\); the run continued after Play\.$/,
  )
  expect(await cards()).toHaveLength(1)
})

it('does not pause again for the rate limit that ends its run: the failure reaches the watchdog without another Play', async () => {
  const f = await fixture(undefined, { maxRetries: 1 })
  let responses = 0
  const limited = () => {
    responses++
    return fauxAssistantMessage('', { stopReason: 'error', errorMessage: limit })
  }
  f.prepared.faux!.setResponses([limited, limited])
  const { root } = await f.open()
  const submission = await root.submit({ type: 'input', content: 'go' }, context)
  await until(async () => (await f.action('state')).limit !== undefined)
  // Play spends Pi's last retry into the limit, which ends the run: nothing is left to hold.
  await f.action('play')
  expect(await submission.wait(context)).toMatchObject({
    status: 'unanswered',
    reason: 'model_error',
  })
  expect(responses).toBe(2)
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve))
  expect(f.paused()).toBe(false)
  expect((await f.action('state')).paused).toBe(false)
})

it('tells a held parent which subagent hit the limit, once across re-pauses, and nothing after Play', async () => {
  const f = await fixture()
  const limitedResponse = () =>
    fauxAssistantMessage('', { stopReason: 'error', errorMessage: limit })
  f.prepared.faux!.setResponses([
    // The parent calls a tool; while it runs, its subagent's first request hits the limit, twice across a Play.
    () => fauxAssistantMessage([fauxToolCall('work', {})], { stopReason: 'toolUse' }),
    limitedResponse,
    limitedResponse,
    () => fauxAssistantMessage([fauxText('child done')]),
    () => fauxAssistantMessage([fauxText('parent done')]),
  ])
  const { root: parent, harness } = await f.open()
  const parentRun = await parent.submit({ type: 'input', content: 'go' }, context)
  await until(() => f.finish !== undefined)
  const [tool] = (await harness.inspect(context)).tasks.filter(
    ({ record }) => record.kind === 'pi.tool',
  )
  const child = await harness.commit(
    (tx) => tx.createConversation({ ownership: { kind: 'task', taskId: tool.record.id } }),
    context,
  )
  const childRun = await (await harness.conversation(child.id, context))!.submit(
    { type: 'input', content: 'research' },
    context,
  )
  const held = async () =>
    (await parent.context(context)).entries.filter((entry) => entry.kind === 'pause.held')
  await until(async () => (await held()).length === 1)
  expect((await held())[0].data).toMatchObject({ child: child.id, provider: 'faux' })
  // Play retries into the limit and pauses again: the same run, so no second note.
  const { since } = await f.action('state')
  await f.action('play')
  await until(
    async () =>
      (await f.action('state')).since !== undefined && (await f.action('state')).since !== since,
  )
  expect(await held()).toHaveLength(1)
  await f.action('play')
  expect((await childRun.wait(context)).status).toBe('done')
  f.finish!()
  expect((await parentRun.wait(context)).status).toBe('done')
  expect(await held()).toHaveLength(1)
})

it('leaves ordinary provider errors to Pi’s retry without pausing', async () => {
  const f = await fixture()
  f.prepared.faux!.setResponses([
    () =>
      fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: 'Our servers are currently overloaded. Please try again later.',
      }),
    () => fauxAssistantMessage([fauxText('done')]),
  ])
  const { root } = await f.open()
  expect(
    (await (await root.submit({ type: 'input', content: 'go' }, context)).wait(context)).status,
  ).toBe('done')
  expect(f.paused()).toBe(false)
})

it('lets a quota error fail its run without pausing: Pi never retries it, so Play would continue nothing', async () => {
  const f = await fixture()
  f.prepared.faux!.setResponses([
    () =>
      fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: '429 You exceeded your current quota (insufficient_quota)',
      }),
  ])
  const { root } = await f.open()
  const submission = await root.submit({ type: 'input', content: 'go' }, context)
  expect(await submission.wait(context)).toMatchObject({
    status: 'unanswered',
    reason: 'model_error',
  })
  expect(f.paused()).toBe(false)
})

it('records a limit into a pause the user started, so it still shows', async () => {
  const f = await fixture()
  let asked = false
  const answer = Promise.withResolvers<void>()
  f.prepared.faux!.setResponses([
    async () => {
      asked = true
      await answer.promise
      return fauxAssistantMessage('', { stopReason: 'error', errorMessage: limit })
    },
    () => fauxAssistantMessage([fauxText('done')]),
  ])
  const { root } = await f.open()
  const submission = await root.submit({ type: 'input', content: 'go' }, context)
  await until(() => asked)
  await f.action('pause')
  // The request in flight hits the limit after the user paused: the pause stands, now with the limit.
  answer.resolve()
  await until(async () => (await f.action('state')).limit !== undefined)
  await f.action('play')
  expect((await submission.wait(context)).status).toBe('done')
})

it('plays a rate-limit pause by itself once, N minutes in, only when the user switched it on', async () => {
  const f = await fixture()
  let responses = 0
  f.prepared.faux!.setResponses([
    () => {
      responses++
      return fauxAssistantMessage('', { stopReason: 'error', errorMessage: limit })
    },
    () => {
      responses++
      return fauxAssistantMessage([fauxText('done')])
    },
  ])
  const { root, harness } = await f.open()
  const ultimate = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
  await harness.commit(async (tx) => {
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = ultimate.id
  }, context)
  const submission = await root.submit({ type: 'input', content: 'go' }, context)
  await until(async () => (await f.action('state')).limit !== undefined)
  const { since } = await f.action('state')
  // Off by default: no time ever plays it.
  expect((await f.action('state')).autoPlay).toBeUndefined()
  expect(await f.autoPlay(since! + 365 * 86_400_000)).toBe(false)
  expect(f.paused()).toBe(true)

  const set = await f.setAutoPlay(30)
  expect(set).toMatchObject({ autoPlay: 30, autoPlayAt: since! + 30 * 60_000 })
  // Not yet due.
  expect(await f.autoPlay(since! + 29 * 60_000)).toBe(false)
  expect(f.paused()).toBe(true)
  expect(await f.autoPlay(since! + 30 * 60_000)).toBe(true)
  expect(f.paused()).toBe(false)
  expect((await submission.wait(context)).status).toBe('done')
  expect(responses).toBe(2)
  // Once: the pause is over, so a second due timer finds nothing to play.
  expect(await f.autoPlay(since! + 31 * 60_000)).toBe(false)
  const played = (await ultimate.context(context)).entries.filter(
    (entry) => entry.kind === 'pause.autoplay',
  )
  expect(played).toHaveLength(1)
  expect(played[0].data).toMatchObject({ since, at: since! + 30 * 60_000, minutes: 30 })
  const notes = (await root.context(context)).entries.filter((entry) => entry.kind === 'pause.note')
  expect(notes[0].data).toMatchObject({ auto: true })
  expect(notes[0].model?.[0]?.content).toMatch(/continued after Ultimate played by itself\.$/)
  // The setting stays for the next limit.
  expect((await f.action('state')).autoPlay).toBe(30)
})

it('never plays a pause the user pressed, also when a rate limit joins it', async () => {
  const f = await fixture()
  let asked = false
  const answer = Promise.withResolvers<void>()
  f.prepared.faux!.setResponses([
    async () => {
      asked = true
      await answer.promise
      return fauxAssistantMessage('', { stopReason: 'error', errorMessage: limit })
    },
    () => fauxAssistantMessage([fauxText('done')]),
  ])
  const { root } = await f.open()
  await f.setAutoPlay(1)
  const submission = await root.submit({ type: 'input', content: 'go' }, context)
  await until(() => asked)
  const { since } = await f.action('pause')
  answer.resolve()
  await until(async () => (await f.action('state')).limit !== undefined)
  expect((await f.action('state')).autoPlayAt).toBeUndefined()
  expect(await f.autoPlay(since! + 86_400_000)).toBe(false)
  expect(f.paused()).toBe(true)
  await f.action('play')
  expect((await submission.wait(context)).status).toBe('done')
})

it('keeps Pause, Play and the play-by-itself setting from agents, and checks the minutes', async () => {
  expect(userActions).toEqual(expect.arrayContaining(['pause', 'play', 'autoPlay']))
  const f = await fixture()
  await f.open()
  await expect(f.setAutoPlay(0)).rejects.toThrow('minutes must be a whole number')
  expect((await f.setAutoPlay(null)).autoPlay).toBeUndefined()
})

/** A task record as `running()` reads it: it decides by task kind and checkpoint phase only. */
const at = (kind: string, phase: string) => ({ kind, state: { checkpoint: { phase } } })

it('treats message deliveries and routes as passive waiters', () => {
  expect(passive(at('board.delivery', 'deliver'))).toBe(true)
  expect(passive(at('board.delivery', 'reply'))).toBe(true)
  expect(passive(at('ultimate.subagent-reporter', 'deliver'))).toBe(true)
  expect(passive(at('board.route', 'observe'))).toBe(true)
  expect(passive(at('conversations.summary', 'generate'))).toBe(false)
})

it('stays Pausing… while a background task executes, not for passive waiters', async () => {
  const f = await fixture()
  const { root, harness } = await f.open()
  await harness.commit(
    (tx) =>
      tx.createTask(f.stream, null, {
        conversationId: root.id,
        ownership: { kind: 'conversation' },
        background: true,
      }),
    context,
  )
  await until(async () =>
    (await harness.inspect(context)).tasks.some(
      ({ record, state }) => record.kind === 'pause-test.stream' && state.kind === 'running',
    ),
  )
  const pausing = await f.action('pause')
  expect(pausing.running.map((task) => task.what)).toEqual(['pause-test.stream'])
  f.background.resolve()
  await until(async () => (await f.action('state')).running.length === 0)
})

it('words how long a pause lasted', () => {
  expect(lasted(40_000)).toBe('40s')
  expect(lasted(5 * 60_000)).toBe('5m')
  expect(lasted((2 * 60 + 14) * 60_000)).toBe('2h 14m')
})
