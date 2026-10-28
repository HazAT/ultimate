import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { eventHost, temp, removeTemp, until, fauxServer, linkDependencies } from './helpers.ts'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { awaitWithContext } from '@earendil-works/chord/context'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { Type } from '@earendil-works/pi-ai'
import {
  configure,
  defineExtension,
  defineTask,
  defineTool,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, Task, TaskId } from '@earendil-works/pi-durable'
import type { Context, JsonValue } from '@earendil-works/chord'
import { afterEach, expect, it } from 'vitest'
import { context, prepareHarness } from '../server/harness.ts'
import type { OpenHost } from '../server/harness.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import type { ActionContext } from '../server/actions.ts'
import { Metadata } from '../server/metadata.ts'
import { emit } from '../server/events.ts'
import messagesExtension, { actions } from '../extensions/messages/server.ts'
import pauseExtension, { actions as pauseActions } from '../extensions/pause/server.ts'
import { Messages, MessageSent } from '../extensions/messages/api.ts'
import { UserInputEvent } from '../shared/events.ts'
import type { MessagesService } from '../extensions/messages/api.ts'
import { BranchReceipts, Tally, rootOf, startBranch } from '../extensions/lineage/server.ts'
import type { BranchInput } from '../extensions/lineage/server.ts'
import { Branch, Roots } from '../extensions/lineage/api.ts'
import { Standing, Subagents } from '../extensions/subagents/api.ts'
import { Workspaces } from '../extensions/workspaces/workspaces.ts'
import { concludedIn } from '../extensions/conversations/server.ts'
import { UiState } from '../server/ui-state.ts'

const homes: string[] = []
const hosts: OpenHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  for (const home of homes.splice(0)) await removeTemp(home)
})
/** Stands in for a subagent's report on its way to the branch: live until the test releases it. */
const pendingReport = Promise.withResolvers<void>()
const reporter = defineTask<{ delivered: boolean }, { phase: 'deliver' }, null>({
  name: 'ultimate.subagent-reporter',
  version: 1,
  initial: () => ({ phase: 'deliver' }),
  phases: {
    deliver: async (task, runtime, caller) => {
      if (!task.input.delivered) await awaitWithContext(pendingReport.promise, caller)
      await runtime.commit(
        () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
        caller,
      )
    },
  },
  abort: (_task, runtime, caller) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), caller),
})
const anchor = defineTask<null, { phase: 'done' }, null>({
  name: 'messages-test.anchor',
  version: 1,
  initial: () => ({ phase: 'done' }),
  phases: {
    done: (_task, runtime, caller) =>
      runtime.commit(
        () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
        caller,
      ),
  },
  abort: (_task, runtime, caller) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), caller),
})
function gate() {
  let release!: () => void
  return {
    promise: new Promise<void>((done) => {
      release = done
    }),
    release: () => release(),
  }
}
async function fixture(
  replyGate?: ReturnType<typeof gate>,
  sendGate?: {
    gate: ReturnType<typeof gate>
    afterMemo: boolean
    entered: boolean
    taskId?: TaskId
    /** Only this conversation's calls wait at the gate. */
    conversation?: () => number
  },
) {
  /** Services other extensions implement here, by API name, such as pause's `messages.gate`. */
  const provided = new Map<string, unknown>()
  const home = await temp('ultimate-messages-')
  homes.push(home)
  await mkdir(join(home, 'agents'), { recursive: true })
  await writeFile(
    join(home, 'agents/coordinator.md'),
    await readFile(resolve('agents/coordinator.md'), 'utf8'),
  )
  const prepared = await prepareHarness({
    home,
    ultimateRoot: home,
    userHome: home,
    faux: fauxProvider(),
  })
  let opened: OpenHost
  let service!: MessagesService
  const hold = gate()
  let holding = false
  const openers: (() => Promise<void>)[] = []
  const closers: (() => Promise<void>)[] = []
  const provider = ({ name }: { name: string }) =>
    provided.has(name)
      ? provided.get(name)
      : name === 'subagents'
        ? {
            residents: async () => [{ name: 'scout', description: 'Search' }],
            // Like the real service: only resident names resolve.
            standing: async (agent: string) => {
              if (agent !== 'scout') throw new Error(`Unknown standing agent @${agent}`)
              return recipient.id
            },
          }
        : name === 'workspaces'
          ? { doc: Workspaces, git: async () => '' }
          : name === 'conversations'
            ? { concludedIn }
            : name === 'lineage'
              ? {
                  rootOf: (id: number, ctx: Context) => rootOf(host, id, ctx),
                  branch: (input: BranchInput, ctx: Context) => startBranch(host, input, ctx),
                }
              : undefined
  const host = {
    ...prepared,
    metadata: Metadata,
    emit,
    harness: () => opened.harness,
    // Messages also implements workspaces' branches point; the tests call its own service.
    implement: (api: { name: string }, value: MessagesService) => {
      if (api.name === 'messages') service = value
    },
    want: provider,
    need: provider,
    onOpen: (callback: () => Promise<void>) => openers.push(callback),
    onClose: (cleanup: () => Promise<void>) => closers.push(cleanup),
    notice: (message: string) => {
      throw new Error(message)
    },
    conversations: () => [],
    doc: (kind: string) =>
      kind === 'lineage.roots' ? Roots : kind === 'lineage.tally' ? Tally : undefined,
  } as unknown as ExtensionHost
  let backend = messagesExtension(host)
  if (sendGate)
    backend = {
      ...backend,
      tools: backend.tools!.map((tool) => ({
        ...tool,
        execute: (...[input, api, ctx]: Parameters<typeof tool.execute>) =>
          tool.execute(
            input,
            {
              ...api,
              memo: async (name: string, value: JsonValue | Context, memoContext?: Context) => {
                if (memoContext === undefined) return api.memo(name, value as Context)
                if (sendGate.conversation && sendGate.conversation() !== api.conversationId)
                  return api.memo(name, value as JsonValue, memoContext)
                sendGate.taskId = api.taskId
                if (!sendGate.afterMemo) {
                  sendGate.entered = true
                  await awaitWithContext(sendGate.gate.promise, memoContext)
                }
                const result = await api.memo(name, value as JsonValue, memoContext)
                if (sendGate.afterMemo) {
                  sendGate.entered = true
                  await awaitWithContext(sendGate.gate.promise, memoContext)
                }
                return result
              },
            },
            ctx,
          ),
      })),
    }
  prepared.registry.install(
    replyGate
      ? {
          ...backend,
          tasks: backend.tasks!.map((t) => {
            const task = t as unknown as Task<JsonValue, { phase: string }, JsonValue, object>
            return {
              definition: {
                ...task.definition,
                phases: {
                  ...task.definition.phases,
                  reply: async (...args: Parameters<typeof task.definition.phases.reply>) => {
                    await awaitWithContext(replyGate.promise, args[2])
                    await task.definition.phases.reply(...args)
                  },
                },
              },
            }
          }),
        }
      : backend,
  )
  prepared.registry.install(
    defineExtension({
      name: 'test-hold',
      tasks: [anchor, reporter],
      tools: [
        defineTool({
          name: 'hold',
          description: 'Hold the current run',
          parameters: Type.Object({}),
          // Waiting has no side effects; replay simply waits on the same test gate.
          replay: 'safe',
          async execute(_input, _api, ctx) {
            holding = true
            await awaitWithContext(hold.promise, ctx)
            return { output: [{ type: 'text', text: 'released' }] }
          },
        }),
      ],
    }),
  )
  const observed: string[] = []
  const transcripts: string[] = []
  const route: FauxResponseFactory = (transcript) => {
    prepared.faux!.appendResponses([route])
    transcripts.push(JSON.stringify(transcript.messages))
    const last = transcript.messages.findLast((m) => m.role !== 'system')!
    const text =
      typeof last.content === 'string'
        ? last.content
        : last.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('')
    observed.push(text)
    if (last.role === 'user' && text.startsWith('BRANCH '))
      return fauxAssistantMessage([fauxToolCall('branch', JSON.parse(text.slice(7)))], {
        stopReason: 'toolUse',
      })
    const command = text.startsWith('Message from') ? text.split('\n')[1] : text
    if (last.role === 'user' && command.startsWith('SEND '))
      return fauxAssistantMessage([fauxToolCall('message', JSON.parse(command.slice(5)))], {
        stopReason: 'toolUse',
      })
    if (last.role === 'user' && (text === 'HOLD' || text.includes('\nHOLD')))
      return fauxAssistantMessage([fauxToolCall('hold', {})], { stopReason: 'toolUse' })
    if (last.role === 'user' && text.startsWith('Message from') && text.includes('NOANSWER'))
      return fauxAssistantMessage([])
    if (last.role === 'user' && text.startsWith('Message from') && text.includes('\nASK'))
      return fauxAssistantMessage([fauxText('Scope changed. Proceed?\n1. Yes\n2. No')])
    return fauxAssistantMessage([fauxText(last.role === 'toolResult' ? 'Done' : `Answer: ${text}`)])
  }
  prepared.faux!.setResponses([route])
  const open = async () => {
    opened = await prepared.open()
    const current = opened
    const close = current.close.bind(current)
    current.close = async () => {
      hosts.splice(hosts.indexOf(current), 1)
      for (const cleanup of closers) await cleanup()
      await close()
    }
    hosts.push(opened)
    for (const opener of openers) await opener()
    return opened
  }
  await open()
  const recipient = await opened!.harness.createConversation(
    { ownership: { kind: 'ownerless' } },
    context,
  )
  const agent = await opened!.root.agent(context)
  await opened!.harness.commit(
    (tx) => configure(tx, recipient.id, { model: agent.model, tools: agent.tools }),
    context,
  )
  await opened!.harness.commit(async (tx) => {
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = ROOT_CONVERSATION_ID
  }, context)
  const log = () => opened.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context)
  const action = () => ({ host, signal: new AbortController().signal }) as ActionContext
  const send = async (to: string, text = 'Hello', extra = {}) => {
    await (
      await opened.root.submit(
        { type: 'input', content: `SEND ${JSON.stringify({ to, text, ...extra })}` },
        context,
      )
    ).wait(context)
  }
  return {
    host,
    provided,
    get opened() {
      return opened
    },
    recipient,
    send,
    log,
    action,
    service: () => service,
    open,
    hold,
    holding: () => holding,
    observed,
    transcripts,
  }
}
async function replies(f: Awaited<ReturnType<typeof fixture>>) {
  const view = await f.opened.root.viewState(context)
  const entries = view.value.entries.filter((e) => e.kind === 'board.reply')
  view.dispose()
  return entries
}
it('wakes an idle recipient and returns one typed reply; one-way messages return nothing', async () => {
  const f = await fixture()
  await f.send(`#${f.recipient.id}`)
  await until(async () => (await replies(f)).length === 1)
  expect((await f.log())!.messages.map((m) => [m.from, m.to, m.state])).toEqual([
    [1, f.recipient.id, 'answered'],
    [f.recipient.id, 1, 'delivered'],
  ])
  await f.send(String(f.recipient.id), 'One way', { reply: false })
  await until(async () => (await f.log())!.messages.at(-1)?.state === 'delivered')
  await f.recipient.waitForIdle(context)
  expect(await replies(f)).toHaveLength(1)
  expect(f.observed.some((t) => t.includes('One way'))).toBe(true)
  // Each post is one event, without its text; the reply is no post. #1 is @ultimate, which steers by default.
  const sent = await eventHost(() => f.opened.harness, 'test').eventLog.recent({
    events: [MessageSent],
  })
  const [first, , oneWay] = (await f.log())!.messages
  expect(sent.map((event) => event.data)).toEqual([
    { message: oneWay.id, from: 1, to: f.recipient.id, reply: false, steer: true },
    { message: first.id, from: 1, to: f.recipient.id, reply: true, steer: true },
  ])
  expect(JSON.stringify(sent)).not.toContain('One way')
})
it('records a one-way input answer without returning it to the sender', async () => {
  const f = await fixture()
  await f.send(String(f.recipient.id), 'One-way update', { reply: false })
  await until(async () => (await f.log())!.messages[0]?.state === 'delivered')
  await f.recipient.waitForIdle(context)
  expect(f.observed).toContain(
    'Message from #1 (@ultimate):\nOne-way update\nOne-way message: #1 (@ultimate) expects no answer, and your answer here is not sent to it. If it needs to hear from you, message it.',
  )
  await until(async () => (await f.log())!.messages[0]?.answer !== undefined)
  const log = (await f.log())!
  expect(log.messages).toHaveLength(1)
  expect(log.messages[0]).toMatchObject({ state: 'delivered', reply: false })
  const view = await f.recipient.viewState(context)
  expect(view.value.entries.find((e) => e.id === log.messages[0].answer)?.kind).toBe('pi.assistant')
  view.dispose()
  expect(await replies(f)).toHaveLength(0)
})
async function worker(f: Awaited<ReturnType<typeof fixture>>) {
  const agent = await f.opened.root.agent(context)
  const childId = await f.opened.harness.commit(async (tx) => {
    const owner = await tx.createTask(anchor, null, {
      ownership: { kind: 'conversation' },
      conversationId: ROOT_CONVERSATION_ID,
      background: true,
    })
    const { id } = await tx.createConversation({ ownership: { kind: 'task', taskId: owner } })
    await configure(tx, id, { model: agent.model, tools: agent.tools })
    ;(await tx.doc(Subagents, ROOT_CONVERSATION_ID)).agents[String(id)] = {
      conversationId: id,
      agent: 'worker',
      background: true,
      reported: [],
    }
    return id
  }, context)
  return (await f.opened.harness.conversation(childId, context))!
}
it('places an idle parent update as a note without starting a run', async () => {
  const f = await fixture()
  const child = await worker(f)
  await (
    await child.submit(
      { type: 'input', content: 'SEND {"to":"#1","text":"Progress","reply":false}' },
      context,
    )
  ).wait(context)
  await until(async () => (await f.log())!.messages[0]?.state === 'delivered')
  const view = await f.opened.root.viewState(context)
  const note = view.value.entries.find((e) => e.kind === 'board.message')!
  expect(note.data).toMatchObject({ from: child.id, reply: false, delivery: 'note' })
  expect(note.input).not.toBe(true)
  expect(
    view.value.entries.filter((e) => e.id > note.id && e.kind === 'pi.assistant'),
  ).toHaveLength(0)
  view.dispose()
  const page = await f.host.scanSubmissions(
    { conversationId: ROOT_CONVERSATION_ID },
    100,
    undefined,
    context,
  )
  expect(page.items.find((s) => s.requestId === 'board:1')).toMatchObject({ type: 'write' })
  expect((await f.log())!.messages[0].answer).toBeUndefined()
})
it('places a busy parent note at its next boundary for the model to read', async () => {
  const f = await fixture()
  const child = await worker(f)
  await f.opened.root.submit({ type: 'input', content: 'HOLD' }, context)
  await until(f.holding)
  await (
    await child.submit(
      { type: 'input', content: 'SEND {"to":"#1","text":"Busy progress","reply":false}' },
      context,
    )
  ).wait(context)
  await until(async () => (await f.log())!.messages.length === 1)
  const page = await f.host.scanSubmissions(
    { conversationId: ROOT_CONVERSATION_ID },
    100,
    undefined,
    context,
  )
  expect(page.items.find((s) => s.requestId === 'board:1')).toMatchObject({
    type: 'write',
    status: 'queued',
  })
  f.hold.release()
  await f.opened.root.waitForIdle(context)
  await until(async () => (await f.log())!.messages[0]?.state === 'delivered')
  expect(
    f.transcripts.some((t) =>
      t.includes(`Note from #${child.id} (one-way update, no answer goes back):\\nBusy progress`),
    ),
  ).toBe(true)
})
it('still wakes a parent for a worker question and returns its typed reply', async () => {
  const f = await fixture()
  const child = await worker(f)
  await (
    await child.submit(
      { type: 'input', content: 'SEND {"to":"#1","text":"Question?","reply":true}' },
      context,
    )
  ).wait(context)
  await until(async () => (await f.log())!.messages[0]?.state === 'answered')
  await child.waitForIdle(context)
  const parentView = await f.opened.root.viewState(context)
  expect(parentView.value.entries.find((e) => e.kind === 'board.message')?.data).toMatchObject({
    reply: true,
    delivery: 'followUp',
  })
  parentView.dispose()
  await until(async () => {
    const current = await child.viewState(context)
    const replied = current.value.entries.some((e) => e.kind === 'board.reply')
    current.dispose()
    return replied
  })
  const view = await child.viewState(context)
  expect(view.value.entries.find((e) => e.kind === 'board.reply')?.data).toMatchObject({
    from: 1,
    re: 1,
  })
  view.dispose()
})
/** The recipient's tool results, as text. */
async function toolResults(f: Awaited<ReturnType<typeof fixture>>) {
  const view = await f.recipient.viewState(context)
  const results = view.value.entries
    .filter((e) => e.kind === 'pi.tool-result')
    .map((e) => JSON.stringify(e.model))
  view.dispose()
  return results
}
it('turns a message to a sender it owes an answer into that answer, once, with images', async () => {
  const f = await fixture()
  const command = 'SEND ' + JSON.stringify({ to: '#1', text: 'Ready', images: 'latest' })
  await submitWithImages(
    f,
    'SEND ' + JSON.stringify({ to: '@scout', text: command, images: 'latest' }),
    2,
  )
  await until(async () => (await replies(f)).length === 1)
  await f.recipient.waitForIdle(context)
  await f.opened.root.waitForIdle(context)
  const [asked, answer] = (await f.log())!.messages
  expect((await f.log())!.messages).toHaveLength(2)
  expect(asked).toMatchObject({ from: 1, to: f.recipient.id, state: 'answered' })
  expect(answer).toMatchObject({
    from: f.recipient.id,
    to: 1,
    text: 'Ready',
    re: asked.id,
    reply: false,
    state: 'delivered',
    images: { count: 2 },
  })
  const [reply] = await replies(f)
  expect(reply.data).toMatchObject({ id: answer.id, re: asked.id, text: 'Ready', images: 2 })
  expect(imagesIn(reply)).toEqual([png(0), png(1)])
  // The tool result ends the run: no final answer restates it, and delivery sends nothing more.
  expect((await toolResults(f)).at(-1)).toContain(`Sent as your answer to message ${asked.id}.`)
  const view = await f.recipient.viewState(context)
  expect(view.value.entries.at(-1)?.kind).toBe('pi.tool-result')
  view.dispose()
  expect(f.observed.filter((t) => t.startsWith('Reply from'))).toHaveLength(1)
})
/**
 * Two messages from #1 that steer the recipient's held run at two tool rounds (the first holds once more), so the
 * run's one final answer settles both.
 */
async function twoOpen(f: Awaited<ReturnType<typeof fixture>>, second: string) {
  await f.recipient.submit({ type: 'input', content: 'HOLD' }, context)
  await until(f.holding)
  await f.send(`#${f.recipient.id}`, 'HOLD')
  await f.send(`#${f.recipient.id}`, second)
  f.hold.release()
  await f.recipient.waitForIdle(context)
  await f.opened.harness.waitForIdle(context)
  await until(async () =>
    (await f.opened.harness.inspect(context)).tasks.every(
      (t) => t.record.kind !== 'board.delivery',
    ),
  )
  return (await f.log())!.messages
}
it('sends one reply naming every open message a run answered', async () => {
  // #14820 answered three messages from @ultimate in one run, and its answer arrived three times.
  const f = await fixture()
  const [first, second, reply, ...rest] = await twoOpen(f, 'Second')
  expect(rest).toEqual([])
  expect([first.state, second.state]).toEqual(['answered', 'answered'])
  expect(reply).toMatchObject({ from: f.recipient.id, to: 1, re: first.id, also: [second.id] })
  expect(await replies(f)).toHaveLength(1)
  expect(f.observed.filter((t) => t.startsWith('Reply from'))).toEqual([
    expect.stringMatching(
      new RegExp(`^Reply from #${f.recipient.id} to your messages ${first.id} and ${second.id}:`),
    ),
  ])
})
it('answers every owed message with one message, failing none', async () => {
  // #10238 answered with a message; it settled one of three owed messages, and the other two came back "failed".
  const f = await fixture()
  const [first, second, reply, ...rest] = await twoOpen(
    f,
    'SEND ' + JSON.stringify({ to: '#1', text: 'Both done' }),
  )
  expect(rest).toEqual([])
  expect([first.state, second.state]).toEqual(['answered', 'answered'])
  expect(reply).toMatchObject({ text: 'Both done', re: first.id, also: [second.id] })
  expect((await toolResults(f)).at(-1)).toContain(
    `Sent as your answer to messages ${first.id} and ${second.id}.`,
  )
})
it("turns @ultimate's message to the user it owes an answer into that answer and ends the run", async () => {
  const f = await fixture()
  const owe = (text: string) =>
    f.opened.harness.commit(async (tx) => {
      const log = await tx.doc(Messages, ROOT_CONVERSATION_ID)
      log.messages.push({
        id: log.next++,
        from: 'user',
        to: 1,
        text,
        at: 0,
        reply: true,
        state: 'delivered',
      })
    }, context)
  await owe('Q')
  await f.send('user', 'Report')
  const [first, report] = (await f.log())!.messages
  expect(first.state).toBe('answered')
  expect(report).toMatchObject({ to: 'user', re: first.id, text: 'Report', state: 'delivered' })
  const ended = await f.opened.root.viewState(context)
  expect(ended.value.entries.at(-1)?.kind).toBe('pi.tool-result')
  ended.dispose()
  // With questions it is the answer too, and stays open itself.
  await owe('Q2')
  await f.send('user', 'Next', { questions: [{ text: 'Ready?', kind: 'confirm' }] })
  const [, , second, next] = (await f.log())!.messages
  expect(second.state).toBe('answered')
  expect(next).toMatchObject({ to: 'user', re: second.id, reply: true, state: 'delivered' })
  expect(next.questions).toHaveLength(1)
  // Its card reads the result as a sent message, so the answer card shows under it.
  const view = await f.opened.root.viewState(context)
  const results = view.value.entries.filter((e) => e.kind === 'pi.tool-result')
  expect(view.value.entries.at(-1)?.kind).toBe('pi.tool-result')
  view.dispose()
  expect(JSON.stringify(results.at(-1)?.model)).toContain(`Message ${next.id} sent.`)
})
// omarchy-config #42: the user's card reply was still queued behind the run, and the questions were refused.
it("never lets the user's queued reply block @ultimate's message to them", async () => {
  const f = await fixture()
  await f.opened.harness.commit(async (tx) => {
    const log = await tx.doc(Messages, ROOT_CONVERSATION_ID)
    log.messages.push({
      id: log.next++,
      from: 'user',
      to: 1,
      text: '1a',
      at: 0,
      reply: true,
      state: 'sent',
    })
  }, context)
  await f.send('user', 'Assessment', { questions: [{ text: 'Go?', kind: 'confirm' }] })
  const [queued, assessment] = (await f.log())!.messages
  expect(queued.state).toBe('sent')
  expect(assessment).toMatchObject({ to: 'user', reply: true, state: 'delivered' })
  expect(assessment.re).toBeUndefined()
  expect(assessment.questions).toHaveLength(1)
})
it.each([false, true])('replays a converted answer once (afterMemo: %s)', async (afterMemo) => {
  const sendGate = { gate: gate(), afterMemo, entered: false, conversation: () => 0 }
  const f = await fixture(undefined, sendGate)
  sendGate.conversation = () => f.recipient.id
  await f.opened.root.submit(
    {
      type: 'input',
      content: 'SEND ' + JSON.stringify({ to: '@scout', text: 'SEND {"to":"#1","text":"Ready"}' }),
    },
    context,
  )
  await until(() => sendGate.entered)
  await f.opened.close()
  await f.open()
  sendGate.gate.release()
  await until(async () => (await replies(f)).length === 1)
  await (await f.opened.harness.conversation(f.recipient.id, context))!.waitForIdle(context)
  await f.opened.root.waitForIdle(context)
  expect((await f.log())!.messages).toMatchObject([
    { id: 1, state: 'answered' },
    { id: 2, re: 1, text: 'Ready', state: 'delivered' },
  ])
  expect((await f.log())!.next).toBe(3)
  expect(await replies(f)).toHaveLength(1)
})
it('lets an agent ask the sender again once its answer went back', async () => {
  const f = await fixture()
  await f.send('@scout')
  await until(async () => (await replies(f)).length === 1)
  await (
    await f.recipient.submit(
      { type: 'input', content: 'SEND ' + JSON.stringify({ to: '#1', text: 'After answer' }) },
      context,
    )
  ).wait(context)
  await until(async () => (await f.log())!.messages.length === 4)
  expect((await f.log())!.messages[2]).toMatchObject({
    from: f.recipient.id,
    to: 1,
    text: 'After answer',
    state: 'answered',
  })
})
it('allows one-way updates to the sender while answering', async () => {
  const f = await fixture()
  await f.send('@scout', 'SEND ' + JSON.stringify({ to: '#1', text: 'Progress', reply: false }))
  await until(async () => (await replies(f)).length === 1)
  expect((await f.log())!.messages).toMatchObject([
    { from: 1, to: f.recipient.id, state: 'answered' },
    { from: f.recipient.id, to: 1, text: 'Progress', reply: false, state: 'delivered' },
    { from: f.recipient.id, to: 1, re: 1 },
  ])
})
it('refuses messages to the user from anyone but @ultimate', async () => {
  const f = await fixture()
  await f.send('@scout', 'SEND ' + JSON.stringify({ to: 'user', text: 'Update' }))
  await until(async () => (await replies(f)).length === 1)
  expect((await f.log())!.messages).toHaveLength(2)
  expect(f.observed.join('\n')).toContain(
    'Only @ultimate messages the user; send this to @ultimate (reply: false) and it relays it.',
  )
  await f.send('user', 'Relayed update')
  expect((await f.log())!.messages.at(-1)).toMatchObject({
    from: 1,
    to: 'user',
    text: 'Relayed update',
  })
})
it('resolves a standing address and returns unanswered inputs as failure replies', async () => {
  const f = await fixture()
  await f.send('@scout', 'NOANSWER')
  await until(async () => (await replies(f)).length === 1)
  expect((await f.log())!.messages).toMatchObject([
    { to: f.recipient.id, state: 'failed', error: expect.stringContaining('without an answer') },
    { from: f.recipient.id, to: 1, re: 1, state: 'failed' },
  ])
  expect((await replies(f))[0].data).toMatchObject({ failed: true })
  await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).scout = f.recipient.id
  }, context)
  expect(await actions.addresses({}, f.action())).toMatchObject({
    agents: [{ name: 'scout', description: 'Search', id: f.recipient.id }],
  })
})
it('tells the sender a Stop as stopped, not failed', async () => {
  const f = await fixture()
  await f.send(`#${f.recipient.id}`, 'HOLD')
  await until(f.holding)
  // The person presses Stop in the recipient: its run is aborted before it answers.
  const run = (await f.opened.harness.snapshot(LiveDoc, f.recipient.id, context))!.run!.taskId
  await f.opened.harness.abortTask(run, context)
  await until(async () => (await replies(f)).length === 1)
  expect((await f.log())!.messages).toMatchObject([
    { to: f.recipient.id, state: 'stopped', error: 'was stopped by the user before it answered' },
    { from: f.recipient.id, to: 1, re: 1, state: 'stopped' },
  ])
  expect((await replies(f))[0].data).toMatchObject({ failed: true, stopped: true })
  expect(f.observed).toContainEqual(
    expect.stringContaining(`to your message 1 (stopped):\nwas stopped by the user`),
  )
})
it('delivers to a retired standing agent by id without refreshing it', async () => {
  const f = await fixture()
  await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).retired = f.recipient.id
  }, context)
  await f.send(`#${f.recipient.id}`, 'Still there?', { reply: false })
  await until(async () => (await f.log())!.messages.at(-1)?.state !== 'sent')
  expect((await f.log())!.messages.at(-1)).toMatchObject({
    to: f.recipient.id,
    state: 'delivered',
  })
})
it('answers questions to the user through answer cards or input in the sender conversation', async () => {
  const f = await fixture()
  await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = f.recipient.id
  }, context)
  const ask = async (text: string, reply = true) => {
    await (
      await f.recipient.submit(
        { type: 'input', content: 'SEND ' + JSON.stringify({ to: 'user', text, reply }) },
        context,
      )
    ).wait(context)
    return (await f.log())!.messages.at(-1)!
  }
  const state = async (id: number) => (await f.log())!.messages.find((m) => m.id === id)?.state

  // Asking typed into the recipient leaves that question open: only later input answers it.
  const replied = await ask('Which option?')
  expect(replied).toMatchObject({ to: 'user', reply: true, state: 'delivered' })
  await f.service().answer(replied.id, 'Option 1', context)
  await f.opened.harness.waitForIdle(context)
  expect(await state(replied.id)).toBe('answered')

  const report = await ask('Landed', false)
  expect(await state(report.id)).toBe('delivered')

  // Two open questions: answering one leaves the other open, and typing anywhere answers neither.
  const first = await ask('Which command?')
  const second = await ask('Approve the preview?')
  await f.service().answer(first.id, 'Q: Which command?\nA: Both', context, {
    device: 'phone safari',
  })
  await f.opened.harness.waitForIdle(context)
  expect(await state(first.id)).toBe('answered')
  expect(await state(second.id)).toBe('delivered')
  // Each answer is the user's input to the asker, recorded once with its reply's message and never its text.
  const inputs = await eventHost(() => f.opened.harness, 'test').eventLog.recent({
    events: [UserInputEvent],
  })
  const answer = (await f.log())!.messages.find((m) => m.from === 'user' && m.re === first.id)!
  expect(inputs.map((event) => event.data)).toEqual([
    {
      conversation: f.recipient.id,
      kind: 'answer',
      message: answer.id,
      length: 'Q: Which command?\nA: Both'.length,
      device: 'phone safari',
    },
    {
      conversation: f.recipient.id,
      kind: 'answer',
      message: expect.any(Number),
      length: 'Option 1'.length,
    },
  ])
  expect(JSON.stringify(inputs)).not.toContain('Which command')
  await (await f.recipient.submit({ type: 'input', content: 'Yes' }, context)).wait(context)
  await (await f.opened.root.submit({ type: 'input', content: 'Elsewhere' }, context)).wait(context)
  await f.opened.close()
  await f.open()
  expect(await state(second.id)).toBe('delivered')
})
it("ends @ultimate's run with its message to the user, unless it still owes a reply", async () => {
  const f = await fixture()
  await f.send('user', 'Landed')
  const root = await f.opened.root.viewState(context)
  // No final answer restates the message.
  expect(root.value.entries.at(-1)?.kind).toBe('pi.tool-result')
  root.dispose()
  expect(f.observed).not.toContain('Message 1 sent.')

  // A message to @ultimate that expects a reply still gets its answer after the message to the user.
  await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = f.recipient.id
  }, context)
  await f.send(`#${f.recipient.id}`, 'SEND ' + JSON.stringify({ to: 'user', text: 'Relayed' }))
  await until(async () => (await replies(f)).length === 1)
  expect((await f.log())!.messages.map((m) => [m.from, m.to, m.text])).toEqual([
    [1, 'user', 'Landed'],
    [1, f.recipient.id, expect.stringContaining('Relayed')],
    [f.recipient.id, 'user', 'Relayed'],
    [f.recipient.id, 1, 'Done'],
  ])
})
it('atomically admits only one answer-card reply through the Messages service', async () => {
  const f = await fixture()
  await f.send('user', 'Keep it running?')
  const id = (await f.log())!.messages.at(-1)!.id
  const results = await Promise.allSettled([
    f.service().answer(id, 'Q: Keep it running?\nA: Yes', context),
    f.service().answer(id, 'Q: Keep it running?\nA: No', context),
  ])
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(
    String(
      (results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason,
    ),
  ).toContain('These questions are no longer open')
  expect(
    (await f.log())!.messages.filter((message) => message.re === id && message.from === 'user'),
  ).toHaveLength(1)
  expect((await f.log())!.messages.find((message) => message.id === id)?.state).toBe('answered')
})

it('lets a subagent message only the conversation that started it', async () => {
  const f = await fixture()
  const agent = await f.opened.root.agent(context)
  const child = (subagent: boolean) =>
    f.opened.harness.commit(async (tx) => {
      const owner = await tx.createTask(anchor, null, {
        ownership: { kind: 'conversation' },
        conversationId: ROOT_CONVERSATION_ID,
        background: true,
      })
      const { id } = await tx.createConversation({ ownership: { kind: 'task', taskId: owner } })
      await configure(tx, id, { model: agent.model, tools: agent.tools })
      if (subagent)
        (await tx.doc(Subagents, ROOT_CONVERSATION_ID)).agents[String(id)] = {
          conversationId: id,
          agent: 'worker',
          background: true,
          reported: [],
        }
      return id
    }, context)
  const send = async (from: ConversationId, to: string) => {
    const conversation = await f.opened.harness.conversation(from, context)
    await (
      await conversation!.submit(
        {
          type: 'input',
          content: 'SEND ' + JSON.stringify({ to, text: `To ${to}`, reply: false }),
        },
        context,
      )
    ).wait(context)
  }

  const workerId = await child(true)
  await send(workerId, 'user')
  await send(workerId, `#${f.recipient.id}`)
  await send(workerId, '#1')
  expect(f.observed.filter((text) => text.includes('message only #1'))).toHaveLength(1)
  expect((await f.log())!.messages.map((m) => [m.from, m.to])).toEqual([[workerId, 1]])
  const view = await (await f.opened.harness.conversation(workerId, context))!.viewState(context)
  expect(JSON.stringify(view.value.entries)).toContain('Use message only to update #1')
  view.dispose()

  // An owned conversation that is no subagent cannot bypass @ultimate either.
  const run = await child(false)
  await send(run, 'user')
  expect((await f.log())!.messages).toHaveLength(1)
  expect(f.observed.join('\n')).toContain('Only @ultimate messages the user')
})
it('refuses self, unknown ids, tally roots and unknown names with valid names', async () => {
  const f = await fixture()
  await f.send('999')
  await f.send('@missing')
  expect(f.observed.join('\n')).toContain('Unknown conversation')
  expect(f.observed.join('\n')).toContain('@scout')
  await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots.push(f.recipient.id)
    ;(await tx.doc(Tally, f.recipient.id)).since = 2
  }, context)
  await f.send(String(f.recipient.id))
  expect(f.observed.join('\n')).toContain('use note')
  await f.send('#1')
  const view = await f.opened.root.viewState(context)
  expect(JSON.stringify(view.value.entries)).toContain('cannot message yourself')
  view.dispose()
})
it('loads existing version-1 logs with the unused read mark', async () => {
  const f = await fixture()
  await f.opened.harness.commit(async (tx) => {
    Object.assign(await tx.doc(Messages, ROOT_CONVERSATION_ID), { readUpTo: 7 })
  }, context)
  await f.opened.close()
  await f.open()
  await f.send('user', 'Still loadable')
  expect((await f.log())!.messages).toMatchObject([{ text: 'Still loadable' }])
})
it('bounds the log and exposes no user posting action', async () => {
  const f = await fixture()
  await f.opened.harness.commit(async (tx) => {
    const log = await tx.doc(Messages, ROOT_CONVERSATION_ID)
    for (let id = 1; id <= 300; id++)
      log.messages.push({
        id,
        from: 1,
        to: 2,
        text: String(id),
        at: id,
        reply: false,
        state: 'delivered',
      })
    log.next = 301
  }, context)
  await f.send('user', 'The newest')
  expect((await f.log())!.messages).toHaveLength(300)
  expect((await f.log())!.messages[0].id).toBe(2)
  expect((await f.log())!.messages.at(-1)).toMatchObject({ id: 301, text: 'The newest' })
  expect(actions).not.toHaveProperty('post')
  expect(actions).not.toHaveProperty('read')
})
it('queues a busy recipient as follow-up, or steers its current run; @ultimate steers by default', async () => {
  // The fixture's sender, #1, is @ultimate unless the case hands that role to another conversation.
  const cases = [
    { extra: { steer: false }, ultimate: true, steer: false },
    { extra: { steer: true }, ultimate: false, steer: true },
    { extra: {}, ultimate: true, steer: true },
    { extra: {}, ultimate: false, steer: false },
  ]
  for (const { extra, ultimate, steer } of cases) {
    const f = await fixture()
    if (!ultimate)
      await f.opened.harness.commit(async (tx) => {
        ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = 999 as ConversationId
      }, context)
    await f.recipient.submit({ type: 'input', content: 'HOLD' }, context)
    await until(f.holding)
    await f.send(String(f.recipient.id), 'Busy message', extra)
    const page = await f.host.scanSubmissions(
      { conversationId: f.recipient.id },
      100,
      undefined,
      context,
    )
    expect(page.items.find((s) => s.requestId === 'board:1')).toMatchObject({ status: 'queued' })
    expect(f.observed.some((t) => t.startsWith('Message from') && t.includes('Busy message'))).toBe(
      false,
    )
    f.hold.release()
    await until(async () => (await replies(f)).length === 1)
    expect(f.observed.some((t) => t.startsWith('Message from') && t.includes('Busy message'))).toBe(
      true,
    )
    const view = await f.recipient.viewState(context)
    expect(view.value.entries.find((e) => e.kind === 'board.message')?.data).toMatchObject({
      delivery: steer ? 'steer' : 'followUp',
    })
    view.dispose()
    const delivered = f.observed.findIndex(
      (t) => t.startsWith('Message from') && t.includes('Busy message'),
    )
    const released = f.observed.indexOf('released')
    expect(steer ? released === -1 : released < delivered).toBe(true)
  }
})
async function codemodeFixture() {
  const home = await temp('ultimate-messages-actions-')
  homes.push(home)
  await mkdir(join(home, 'extensions/messages'), { recursive: true })
  await mkdir(join(home, 'extensions/codemode'), { recursive: true })
  await mkdir(join(home, 'web'))
  await linkDependencies(home)
  await writeFile(
    join(home, 'extensions/messages/server.ts'),
    `export { default, actions, docs } from ${JSON.stringify(resolve('extensions/messages/server.ts'))}`,
  )
  await writeFile(
    join(home, 'extensions/codemode/server.ts'),
    `export { default, docs } from ${JSON.stringify(resolve('extensions/codemode/server.ts'))}`,
  )
  // Messages needs the core's subagents and workspaces; stand-ins with no standing agents and no worktrees.
  await mkdir(join(home, 'extensions/core-stand-ins'), { recursive: true })
  await writeFile(
    join(home, 'extensions/core-stand-ins/server.ts'),
    `import { SubagentsApi } from ${JSON.stringify(resolve('extensions/subagents/api.ts'))}
import { WorkspacesApi } from ${JSON.stringify(resolve('extensions/workspaces/api.ts'))}
import { Workspaces } from ${JSON.stringify(resolve('extensions/workspaces/workspaces.ts'))}
export default (host) => {
  host.implement(SubagentsApi, { residents: async () => [] })
  host.implement(WorkspacesApi, { doc: Workspaces })
  return { name: 'core-stand-ins' }
}
`,
  )
  await writeFile(
    join(home, 'vite.config.ts'),
    "import { defineConfig } from 'vite-plus'; export default defineConfig({ root: 'web', optimizeDeps: { noDiscovery: true } })",
  )
  await writeFile(join(home, 'web/index.html'), '<html>Messages actions</html>')
  return fauxServer({
    home: join(home, 'state'),
    ultimateRoot: home,
    projectRoot: home,
    userHome: home,
    faux: fauxProvider(),
    port: 0,
  })
}
it('has no posting action at the installed codemode boundary', async () => {
  const server = await codemodeFixture()
  try {
    for (const action of ['post']) {
      server.host.faux!.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall('codemode', {
              code: `return await ultimate.action('messages', '${action}', {to:'user',text:'fake'});`,
            }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('Complete'),
      ])
      await (
        await server.root.submit({ type: 'input', content: 'Try action' }, context)
      ).wait(context)
      const view = await server.root.viewState(context)
      try {
        const result = view.value.entries.findLast((e) => e.kind === 'pi.tool-result')!
        expect(JSON.stringify(result)).toContain(`Unknown extension action: messages/${action}`)
      } finally {
        view.dispose()
      }
    }
  } finally {
    await server.vite.watcher.close()
    await server.close()
  }
})
it('keeps sequential and parallel message calls distinct within one codemode script', async () => {
  const server = await codemodeFixture()
  try {
    await server.harness.commit(async (tx) => {
      ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = server.root.id
    }, context)
    server.host.faux!.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            'codemode',
            {
              code: `
          await tools.message({to: 'user', text: 'Sequential 1'});
          await tools.message({to: 'user', text: 'Sequential 2'});
          await Promise.all([
            tools.message({to: 'user', text: 'Parallel 1'}),
            tools.message({to: 'user', text: 'Parallel 2'})
          ]);
        `,
            },
            { id: 'script' },
          ),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxToolCall('message', { to: 'user', text: 'Direct' }, { id: 'm' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('Complete'),
    ])
    await (
      await server.root.submit({ type: 'input', content: 'Send four messages' }, context)
    ).wait(context)
    const log = await server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context)
    expect(log?.messages.map((m) => m.text).toSorted()).toEqual([
      'Direct',
      'Parallel 1',
      'Parallel 2',
      'Sequential 1',
      'Sequential 2',
    ])
    expect(new Set(log?.messages.map((m) => m.id)).size).toBe(5)
    // Each message records the call that sent it: the script's nested call, or the direct call's own id.
    expect(log?.messages.slice(0, 2).map((m) => [m.text, m.call])).toEqual([
      ['Sequential 1', 'script/1'],
      ['Sequential 2', 'script/2'],
    ])
    expect(
      log?.messages
        .slice(2, 4)
        .map((m) => m.call)
        .toSorted(),
    ).toEqual(['script/3', 'script/4'])
    expect(log?.messages.at(-1)).toMatchObject({ text: 'Direct', call: 'm' })
    // The script's nested messages could not end the run; the direct message did, before 'Complete'.
    const view = await server.root.viewState(context)
    expect(view.value.entries.at(-1)?.kind).toBe('pi.tool-result')
    view.dispose()
  } finally {
    await server.vite.watcher.close()
    await server.close()
  }
})
it('replays interrupted sends once, both before and after memoizing the message id', async () => {
  for (const afterMemo of [false, true]) {
    const sendGate = { gate: gate(), afterMemo, entered: false }
    const f = await fixture(undefined, sendGate)
    await f.opened.root.submit(
      { type: 'input', content: 'SEND {"to":"user","text":"One item"}' },
      context,
    )
    await until(() => sendGate.entered)
    expect((await f.log())!.messages).toHaveLength(1)
    await f.opened.close()
    await f.open()
    sendGate.gate.release()
    await f.opened.root.waitForIdle(context)
    expect((await f.log())!.messages).toMatchObject([{ id: 1, to: 'user', text: 'One item' }])
    expect((await f.log())!.next).toBe(2)
    const view = await f.opened.root.viewState(context)
    try {
      const result = view.value.entries.findLast((e) => e.kind === 'pi.tool-result')!
      expect(JSON.stringify(result)).toContain('Message 1 sent.')
    } finally {
      view.dispose()
    }
  }
})
it.each([false, true])(
  'replays a branch interrupted around memoization (afterMemo: %s)',
  async (afterMemo) => {
    const pause = {
      gate: gate(),
      afterMemo,
      entered: false,
      taskId: undefined as TaskId | undefined,
    }
    const f = await fixture(undefined, pause)
    const tool = (await f.opened.root.agent(context)).deferred.find(
      (candidate) => candidate.name === 'branch',
    )!
    await f.opened.harness.commit(async (tx) => {
      ;(await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots = [1]
      await configure(tx, f.opened.root.id, { modelTools: { add: [tool] } })
    }, context)
    await f.opened.root.submit(
      {
        type: 'input',
        content: 'BRANCH ' + JSON.stringify({ prompt: 'Explore durably', isolated: false }),
      },
      context,
    )
    await until(() => pause.entered || f.observed.length > 1)
    expect(f.observed).toEqual([expect.stringContaining('BRANCH ')])
    expect(pause.entered).toBe(true)
    const branches = async () => {
      const conversations = await f.opened.harness.commit(
        (tx) => tx.scanConversations({}, 100),
        context,
      )
      const ids = []
      for (const conversation of conversations.items) {
        if (
          (await f.opened.harness.snapshot(Branch, conversation.id, context))?.branch?.intent ===
          'Explore durably'
        )
          ids.push(conversation.id)
      }
      return ids
    }
    const created = await branches()
    expect(created).toHaveLength(1)
    expect(pause.taskId).toBeDefined()
    const receipt = await f.opened.harness.snapshot(BranchReceipts, pause.taskId!, context)
    expect(Object.values(receipt!.branches)).toEqual(created)
    expect((await f.log())?.messages ?? []).toHaveLength(0)
    await f.opened.close()
    await f.open()
    pause.gate.release()
    await until(async () => (await replies(f)).length === 1)
    expect(await branches()).toEqual(created)
    await f.opened.root.waitForIdle(context)
    expect(await f.opened.harness.snapshot(BranchReceipts, pause.taskId!, context)).toBeUndefined()
    expect((await f.log())!.messages.filter((message) => message.to === created[0])).toMatchObject([
      { from: 1, text: 'Explore durably' },
    ])
    expect(
      (await f.log())!.messages.filter(
        (message) => message.from === created[0] && message.re !== undefined,
      ),
    ).toHaveLength(1)
  },
)
const png = (n: number) => ({
  type: 'image' as const,
  mimeType: 'image/png',
  data: `iVBORw0KGgo${n}AAAA`,
})
async function submitWithImages(
  f: Awaited<ReturnType<typeof fixture>>,
  text: string,
  count: number,
) {
  const submission = await f.opened.root.submit(
    {
      type: 'input',
      content: [{ type: 'text', text }, ...Array.from({ length: count }, (_, i) => png(i))],
    },
    context,
  )
  await submission.wait(context)
  return (await submission.status(context)).entry!
}
async function placed(f: Awaited<ReturnType<typeof fixture>>, id: number, message: number) {
  const view = await (await f.opened.harness.conversation(
    id as ConversationId,
    context,
  ))!.viewState(context)
  const entry = view.value.entries.find(
    (e) => e.kind === 'board.message' && (e.data as { id: number }).id === message,
  )
  view.dispose()
  return entry
}
const imagesIn = (entry: { model?: readonly { content: unknown }[] } | undefined) => {
  const content = entry?.model?.[0]?.content
  return Array.isArray(content) ? content.filter((p) => p.type === 'image') : []
}
it('forwards images from the sender to a message recipient, by latest or entry id', async () => {
  const f = await fixture()
  const to = `#${f.recipient.id}`
  await submitWithImages(f, `SEND ${JSON.stringify({ to, text: 'See this', images: 'latest' })}`, 2)
  await until(async () => (await f.log())!.messages[0]?.state === 'answered')
  const first = (await f.log())!.messages[0]
  expect(first.images).toMatchObject({ count: 2 })
  const entry = await placed(f, f.recipient.id, first.id)
  expect(entry?.data).toMatchObject({ images: 2 })
  expect(imagesIn(entry)).toEqual([png(0), png(1)])
  // A later input without images: `latest` still finds the one that has them, and an id names it exactly.
  await f.send(to, 'Again', { images: 'latest' })
  await f.send(to, 'By id', { images: first.images!.entry })
  await until(async () => (await f.log())!.messages.filter((m) => m.images).length === 3)
  for (const sent of (await f.log())!.messages.filter((m) => m.images && m.id !== first.id)) {
    await until(async () => (await placed(f, f.recipient.id, sent.id)) !== undefined)
    expect(imagesIn(await placed(f, f.recipient.id, sent.id))).toEqual([png(0), png(1)])
  }
})
it('refuses image references that do not resolve or exceed the limits', async () => {
  const f = await fixture()
  const to = `#${f.recipient.id}`
  await f.send(to, 'None yet', { images: 'latest' })
  expect(f.observed.join('\n')).toContain('found no entry with images')
  await f.send(to, 'Missing', { images: 99999 })
  expect(f.observed.join('\n')).toContain('entry 99999 is not in this conversation')
  const plain = await submitWithImages(f, 'plain', 0)
  await f.send(to, 'Plain', { images: plain })
  expect(f.observed.join('\n')).toContain(`entry ${plain} has no images`)
  await submitWithImages(f, `SEND ${JSON.stringify({ to, text: 'Too many', images: 'latest' })}`, 5)
  expect(f.observed.join('\n')).toContain('has 5 images; at most 4 go along')
  expect((await f.log())?.messages ?? []).toHaveLength(0)
})
it("lets @ultimate's message to the user carry its images", async () => {
  const f = await fixture()
  const shot = await submitWithImages(
    f,
    `SEND ${JSON.stringify({ to: 'user', text: 'Look', images: 'latest' })}`,
    1,
  )
  expect((await f.log())!.messages).toMatchObject([
    { from: 1, to: 'user', text: 'Look', images: { entry: shot, count: 1 } },
  ])
})
const result = (images: object[]) => [
  {
    role: 'toolResult',
    toolCallId: 'shot',
    toolName: 'screenshot',
    content: [{ type: 'text', text: 'PNG' }, ...images],
    isError: false,
    timestamp: Date.now(),
  },
]
it('forwards tool-result images, finds latest past a page, and checks every image', async () => {
  const f = await fixture()
  const to = `#${f.recipient.id}`
  const write = (model: object[]) =>
    f.opened.harness.commit(
      async (tx) =>
        (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: 'test.entry', model } as never)).id,
      context,
    )
  const shot = await write(result([png(7)]))
  // More plain entries than one scan page: latest still reaches the screenshot.
  await f.opened.harness.commit(async (tx) => {
    for (let i = 0; i < 250; i++)
      await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: 'test.filler' })
  }, context)
  await f.send(to, 'Screenshot', { images: 'latest' })
  // The reply reaches the sender before the next send, so it does not steer into that send's run.
  await until(async () => (await f.log())?.messages[1]?.state === 'delivered')
  const message = (await f.log())!.messages[0]
  expect(message.images).toEqual({ entry: shot, count: 1 })
  expect(imagesIn(await placed(f, f.recipient.id, message.id))).toEqual([png(7)])
  const big = 'A'.repeat(Math.ceil(((2 * 1024 * 1024 + 3) / 3) * 4))
  const oversized = await write(result([{ type: 'image', mimeType: 'image/png', data: big }]))
  await f.send(to, 'Big', { images: oversized })
  const svg = await write(result([{ type: 'image', mimeType: 'image/svg+xml', data: 'AAAA' }]))
  await f.send(to, 'Svg', { images: svg })
  expect(f.observed.join('\n')).toContain(
    `entry ${oversized} has an unsupported image or one over 2 MiB`,
  )
  expect(f.observed.join('\n')).toContain(`entry ${svg} has an unsupported image or one over 2 MiB`)
  // Another conversation's entry is not this sender's to forward.
  const elsewhere = await f.opened.harness.commit(
    async (tx) =>
      (
        await tx.appendEntry(f.recipient.id, {
          kind: 'test.entry',
          model: result([png(1)]),
        } as never)
      ).id,
    context,
  )
  await f.send(to, 'Elsewhere', { images: elsewhere })
  expect(f.observed.join('\n')).toContain(`entry ${elsewhere} is not in this conversation`)
  expect((await f.log())!.messages.filter((m) => m.from === 1)).toHaveLength(1)
})
async function branched(f: Awaited<ReturnType<typeof fixture>>) {
  const tool = (await f.opened.root.agent(context)).deferred.find(
    (candidate) => candidate.name === 'branch',
  )!
  await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots = [1]
    await configure(tx, f.opened.root.id, { modelTools: { add: [tool] } })
  }, context)
  await f.opened.root.submit(
    { type: 'input', content: 'BRANCH ' + JSON.stringify({ prompt: 'Explore', isolated: false }) },
    context,
  )
  await until(async () => (await replies(f)).length === 1)
  await f.opened.root.waitForIdle(context)
  const id = (await f.log())!.messages[0].to as number
  const branch = (await f.opened.harness.conversation(id as ConversationId, context))!
  await branch.waitForIdle(context)
  const from = async () => (await f.log())!.messages.filter((m) => m.from === id)
  // Routing runs in background tasks, which idle waits skip: absence holds only once they settled.
  const settled = async () => {
    await f.opened.harness.waitForIdle(context)
    await until(async () =>
      (await f.opened.harness.inspect(context)).tasks.every(
        (t) => t.record.kind !== 'board.route' && t.record.kind !== 'board.delivery',
      ),
    )
  }
  const later = async (content: string) => {
    await (await branch.submit({ type: 'input', content }, context)).wait(context)
    await settled()
  }
  await settled()
  return { id, branch, from, later, settled }
}
it('forwards images into a new branch with its prompt', async () => {
  const f = await fixture()
  const tool = (await f.opened.root.agent(context)).deferred.find((t) => t.name === 'branch')!
  await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots = [1]
    await configure(tx, f.opened.root.id, { modelTools: { add: [tool] } })
  }, context)
  await submitWithImages(
    f,
    'BRANCH ' + JSON.stringify({ prompt: 'Fix this card', isolated: false, images: 'latest' }),
    1,
  )
  await until(async () => (await replies(f)).length === 1)
  const message = (await f.log())!.messages[0]
  expect(message.images?.count).toBe(1)
  const entry = await placed(f, message.to as number, message.id)
  expect(imagesIn(entry)).toEqual([png(0)])
})
it("routes a branch's later final answer to its starter once, waking it when the branch stopped idle", async () => {
  const f = await fixture()
  const b = await branched(f)
  await b.later('Landed abc123')
  await until(async () => (await b.from()).length === 2)
  await until(async () => (await f.log())!.messages.at(-1)?.answer !== undefined)
  await f.opened.root.waitForIdle(context)
  const [, routed] = await b.from()
  expect(routed).toMatchObject({ to: 1, text: 'Answer: Landed abc123', reply: false, report: true })
  const view = await f.opened.root.viewState(context)
  const input = view.value.entries.find(
    (e) => e.kind === 'board.message' && (e.data as { id?: number })?.id === routed.id,
  )
  expect([input?.data, input?.input]).toEqual([
    expect.objectContaining({ delivery: 'followUp' }),
    true,
  ])
  view.dispose()
  expect(f.observed).toContain(
    `Message from #${b.id}:\nAnswer: Landed abc123\nOne-way message: #${b.id} expects no answer, and your answer here is not sent to it. If it needs to hear from you, message it.`,
  )
  // A reopen replays nothing: the answer was routed exactly once.
  await f.opened.close()
  await f.open()
  await b.settled()
  expect(await b.from()).toHaveLength(2)
})
it("leaves a branch's final answer as a note while its work is under way", async () => {
  const f = await fixture()
  const b = await branched(f)
  // The branch has a submission in the lander's queue: its answer is an update, not a report.
  await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).queue.push({
      conversationId: b.id,
    } as never)
  }, context)
  await b.later('Submitted; waiting on the lander')
  await until(async () => (await b.from()).length === 2)
  const [, routed] = await b.from()
  expect(routed).toMatchObject({ reply: false })
  expect(routed.report).toBeUndefined()
  const view = await f.opened.root.viewState(context)
  const note = view.value.entries.find(
    (e) => e.kind === 'board.message' && (e.data as { id?: number })?.id === routed.id,
  )
  expect([note?.data, note?.input]).toEqual([
    expect.objectContaining({ delivery: 'note' }),
    undefined,
  ])
  expect(
    view.value.entries.filter((e) => e.id > note!.id && e.kind === 'pi.assistant'),
  ).toHaveLength(0)
  view.dispose()
})
it('leaves the final answer of a branch its landing concluded as a note, since the landing woke the starter', async () => {
  const f = await fixture()
  const b = await branched(f)
  await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(UiState, ROOT_CONVERSATION_ID))['ext.conversations.concluded'] = [b.id]
  }, context)
  // Its answer is routed after the lander concluded it: the starter already woke with the landing card.
  await b.later('Done')
  await until(async () => (await b.from()).length === 2)
  const [, routed] = await b.from()
  expect(routed).toMatchObject({ reply: false })
  expect(routed.report).toBeUndefined()
})
it("leaves a branch's answer as a note while a subagent's report is still on its way", async () => {
  const f = await fixture()
  const b = await branched(f)
  // The child answered, but its report is not yet an input of the branch (#431701's gap), and it is older than
  // 120 reports that finished since (#433005).
  await f.opened.harness.commit(
    (tx) =>
      tx.createTask(
        reporter,
        { delivered: false },
        {
          conversationId: b.id as ConversationId,
          ownership: { kind: 'conversation' },
          background: true,
        },
      ),
    context,
  )
  await f.opened.harness.commit(async (tx) => {
    for (let i = 0; i < 120; i++)
      await tx.createTask(
        reporter,
        { delivered: true },
        {
          conversationId: b.id as ConversationId,
          ownership: { kind: 'conversation' },
          background: true,
        },
      )
  }, context)
  // Only the undelivered report stays live.
  await until(
    async () =>
      (await f.opened.harness.inspect(context)).tasks.filter(
        ({ record }) => record.kind === reporter.definition.name,
      ).length === 1,
  )
  await (
    await b.branch.submit({ type: 'input', content: 'Waiting on the scout' }, context)
  ).wait(context)
  await until(async () => (await b.from()).length === 2)
  expect((await b.from())[1].report).toBeUndefined()
  pendingReport.resolve()
})
it("places a branch's one-way message to its starter as a note", async () => {
  const f = await fixture()
  const b = await branched(f)
  await b.later(
    'SEND ' + JSON.stringify({ to: '#1', text: 'Progress: scouts running', reply: false }),
  )
  const sent = (await b.from()).find((m) => m.text === 'Progress: scouts running')!
  const view = await f.opened.root.viewState(context)
  const note = view.value.entries.find(
    (e) => e.kind === 'board.message' && (e.data as { id?: number })?.id === sent.id,
  )
  expect(note?.data).toMatchObject({ delivery: 'note' })
  expect(note?.input).toBeUndefined()
  view.dispose()
})
it("does not route an answer to the starter's reply-enabled message", async () => {
  const f = await fixture()
  const b = await branched(f)
  expect(await b.from()).toMatchObject([{ re: 1 }])
  await f.send(`#${b.id}`, 'Status?')
  await until(async () => (await replies(f)).length === 2)
  await b.settled()
  expect((await b.from()).map((m) => m.re)).toEqual([1, 3])
})
it("routes an answer to the starter's one-way message, waking it for a decision without a loop", async () => {
  const f = await fixture()
  const b = await branched(f)
  await f.send(`#${b.id}`, 'New scope\nASK', { reply: false })
  await until(async () => (await b.from()).length === 2)
  await b.settled()
  await f.opened.root.waitForIdle(context)
  await b.settled()
  const routed = (await b.from())[1]
  expect(routed).toMatchObject({
    to: 1,
    reply: false,
    text: 'Scope changed. Proceed?\n1. Yes\n2. No',
  })
  expect(routed.re).toBeUndefined()
  // @ultimate woke and answered; that answer is to a one-way message, so nothing goes back to the branch.
  const root = await f.opened.root.viewState(context)
  const input = root.value.entries.find((e) => e.kind === 'board.message' && e.input === true)
  expect(input?.data).toMatchObject({ id: routed.id, delivery: 'followUp' })
  expect(root.value.entries.at(-1)?.kind).toBe('pi.assistant')
  root.dispose()
  expect((await f.log())!.messages.filter((m) => m.to === b.id)).toHaveLength(2)
  expect(await b.from()).toHaveLength(2)
})
it("routes a branch's answer to its starter's reply, so the starter hears how it went on", async () => {
  const f = await fixture()
  const b = await branched(f)
  await b.later('SEND ' + JSON.stringify({ to: '#1', text: 'Approve?' }))
  // The asking run's own final answer is a note: it still waits on the reply. @ultimate answers, the reply wakes the
  // branch, and the branch's answer to it, with nothing left under way, is its report.
  await until(async () => (await b.from()).length === 4)
  await b.settled()
  expect((await b.from()).map((m) => [m.text, m.report])).toEqual([
    [expect.stringContaining('Explore'), undefined],
    ['Approve?', undefined],
    ['Done', undefined],
    [expect.stringContaining('Reply from'), true],
  ])
})
it('recovers once after input placement, before the recipient settles', async () => {
  const f = await fixture()
  await f.send(String(f.recipient.id), 'HOLD')
  await until(f.holding)
  await f.opened.close()
  await f.open()
  f.hold.release()
  await until(async () => (await replies(f)).length === 1)
  expect((await f.log())!.messages.filter((m) => m.re === 1)).toHaveLength(1)
})
it('recovers once after the answer is recorded but before reply submission', async () => {
  const g = gate()
  const f = await fixture(g)
  await f.send(String(f.recipient.id))
  await until(async () => (await f.log())!.messages.length === 2)
  expect(await replies(f)).toHaveLength(0)
  await f.opened.close()
  await f.open()
  g.release()
  await until(async () => (await replies(f)).length === 1)
  expect((await f.log())!.messages.filter((m) => m.re === 1)).toHaveLength(1)
})

/** The pause extension's actions over the fixture's harness. */
function pauser(f: Awaited<ReturnType<typeof fixture>>) {
  const resources = new Map<string, unknown>()
  const host = {
    harness: () => f.opened.harness,
    resource: <T>(key: string, create: () => T) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key) as T
    },
    onOpen: () => {},
    onClose: () => {},
    onRelease: () => {},
    implement: () => {},
    conversations: () => [],
  } as unknown as ExtensionHost
  pauseExtension(host)
  return (name: keyof typeof pauseActions) =>
    pauseActions[name](null, { host } as unknown as ActionContext)
}
it('reaches Paused · safe while a delivery waits for its held recipient to answer', async () => {
  const f = await fixture()
  const pause = pauser(f)
  // A one-way message whose recipient runs two steps: a held tool call, then its answer.
  await f.send(`#${f.recipient.id}`, 'HOLD', { reply: false })
  await until(f.holding)
  const pausing = await pause('pause')
  expect(pausing.running.map((task) => task.what)).toEqual(['hold'])
  f.hold.release()
  // The tool ends; the recipient's next step is held, so its delivery waits on a receipt that settles on Play.
  await until(async () => (await pause('state')).running.length === 0)
  const delivery = (await f.opened.harness.inspect(context)).tasks.find(
    ({ record }) => record.kind === 'board.delivery',
  )
  expect(delivery?.state.kind).toBe('running')
  expect((await f.log())!.messages[0].state).toBe('delivered')
  await pause('play')
  await f.recipient.waitForIdle(context)
  await until(async () =>
    (await f.opened.harness.inspect(context)).tasks.every(
      ({ record }) => record.kind !== 'board.delivery',
    ),
  )
})
/** Another Ultimate on this machine, as an HTTP server that records the actions posted to it and answers `answer`. */
async function otherUltimate(answer: (path: string, body: JsonValue) => [number, unknown]) {
  const posted: { path: string; body: JsonValue }[] = []
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += String(chunk)
    const body = (JSON.parse(raw) as { args: JsonValue }).args
    posted.push({ path: request.url ?? '', body })
    const [status, json] = answer(request.url ?? '', body)
    response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(json))
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  servers.push(server)
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, posted }
}
const servers: Server[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})
/** A fixture whose @ultimate is conversation 1 and whose machine also runs `poe2-rust` at `url`. */
async function remoteFixture(url?: string) {
  const f = await fixture()
  f.provided.set('subagents', {
    residents: async () => [{ name: 'ultimate', description: 'Ultimate' }],
    standing: async () => ROOT_CONVERSATION_ID,
  })
  Object.assign(f.host, {
    projects: async () => [
      { name: 'ultimate', current: true },
      { name: 'poe2-rust', current: false, ...(url ? { running: { url } } : {}) },
    ],
  })
  return f
}
// The sender runs on this machine, so its answer routes back to the local poe2-rust instance.
const from = { project: 'poe2-rust', machine: hostname() }
it("delivers another Ultimate's message to @ultimate only, labelled as it, once per key", async () => {
  const other = await otherUltimate(() => [200, { result: 7 }])
  const f = await remoteFixture(other.url)
  const post = { key: 'k1', text: 'Start a branch that adds X', reply: true, from }
  const id = await actions.remote(post, f.action())
  // A repeated post (a retry, a replay) returns the first delivery and delivers nothing new.
  expect(await actions.remote(post, f.action())).toBe(id)
  await until(async () => (await f.log())!.messages.some((m) => m.to === 'remote'))
  const messages = (await f.log())!.messages
  expect(messages.filter((m) => m.from === 'remote')).toMatchObject([
    { id, to: ROOT_CONVERSATION_ID, reply: true, remote: { ...from, key: 'k1' } },
  ])
  // Only @ultimate's own conversation got it, and it reads who sent it, never the user.
  expect(f.observed.filter((text) => text.includes('Start a branch that adds X'))).toHaveLength(1)
  const delivered = f.observed.find((text) => text.includes('Start a branch'))!
  expect(delivered).toContain(
    `Message from @ultimate@poe2-rust on ${hostname()} (another project's Ultimate, not the user):`,
  )
  expect(f.observed.some((text) => text.includes('Start a branch') && text !== delivered)).toBe(
    false,
  )
  // Its answer goes back over the same route, as a reply to that key.
  await until(() => other.posted.length === 1)
  expect(other.posted[0]).toMatchObject({
    path: '/api/extensions/messages/actions/remoteReply',
    body: { key: 'k1', failed: false },
  })
  expect((other.posted[0].body as { text: string }).text).toContain('Start a branch that adds X')
  await until(async () =>
    (await f.log())!.messages.some((m) => m.to === 'remote' && m.state === 'delivered'),
  )
  expect((await f.log())!.messages.find((m) => m.from === 'remote')!.state).toBe('answered')
})
it("returns another Ultimate's answer as a reply once, and refuses a reply to a reply", async () => {
  const other = await otherUltimate((path) =>
    path.endsWith('/remote') ? [200, { result: 41 }] : [500, { error: 'unexpected' }],
  )
  const f = await remoteFixture(other.url)
  const told = await f
    .service()
    .tell(ROOT_CONVERSATION_ID, { project: 'poe2-rust', text: 'Did the landing work?' }, context)
  expect(told.delivered).toBe(41)
  const key = (other.posted[0].body as { key: string }).key
  expect(other.posted[0].body).toMatchObject({
    text: 'Did the landing work?',
    reply: true,
    from: { project: 'ultimate' },
  })
  const answer = { key, text: 'Yes, landed abc.', failed: false }
  const reply = await actions.remoteReply(answer, f.action())
  // A replayed answer delivers once.
  expect(await actions.remoteReply(answer, f.action())).toBe(reply)
  await until(async () => (await replies(f)).length === 1)
  await f.opened.root.waitForIdle(context)
  expect(await replies(f)).toHaveLength(1)
  const messages = (await f.log())!.messages
  expect(messages.find((m) => m.id === told.message)).toMatchObject({
    to: 'remote',
    state: 'answered',
    remote: { project: 'poe2-rust', id: 41, key },
  })
  // The reply expects none: @ultimate's answer to it goes nowhere, so two Ultimates cannot loop.
  expect(messages.find((m) => m.id === reply)).toMatchObject({ from: 'remote', reply: false })
  expect(other.posted).toHaveLength(1)
  for (const unknown of ['unknown', 'constructor'])
    await expect(
      actions.remoteReply({ key: unknown, text: 'Hi', failed: false }, f.action()),
    ).rejects.toThrow('No message from this Ultimate that expects a reply has that key')
  // A one-way tell takes no answer.
  await f
    .service()
    .tell(ROOT_CONVERSATION_ID, { project: 'poe2-rust', text: 'FYI', reply: false }, context)
  const oneWay = (other.posted[1].body as { key: string }).key
  await expect(
    actions.remoteReply({ key: oneWay, text: 'Thanks', failed: false }, f.action()),
  ).rejects.toThrow('No message from this Ultimate that expects a reply has that key')
})
it('takes a late answer after the log dropped its message, and keys named like object properties', async () => {
  const other = await otherUltimate(() => [200, { result: 3 }])
  const f = await remoteFixture(other.url)
  const told = await f
    .service()
    .tell(ROOT_CONVERSATION_ID, { project: 'poe2-rust', text: 'Ping' }, context)
  // Later traffic pushed the message out of the bounded log.
  await f.opened.harness.commit(async (tx) => {
    const log = await tx.doc(Messages, ROOT_CONVERSATION_ID)
    log.messages = log.messages.filter((m) => m.id !== told.message)
  }, context)
  const key = (other.posted[0].body as { key: string }).key
  const reply = await actions.remoteReply({ key, text: 'Pong', failed: false }, f.action())
  await until(async () => (await replies(f)).length === 1)
  expect((await f.log())!.messages.find((m) => m.id === reply)).toMatchObject({
    from: 'remote',
    re: told.message,
  })
  // A key such as `constructor` is a new message, not an inherited entry.
  const id = await actions.remote(
    { key: 'constructor', text: 'Hello', reply: false, from },
    f.action(),
  )
  expect(typeof id).toBe('number')
  expect((await f.log())!.messages.find((m) => m.id === id)).toMatchObject({ from: 'remote' })
})
it('refuses telling back an Ultimate whose question is open, and only @ultimate tells', async () => {
  const other = await otherUltimate(() => [200, { result: 1 }])
  const f = await remoteFixture(other.url)
  // @ultimate is busy, so the question stays open while it is told back.
  await f.opened.root.submit({ type: 'input', content: 'HOLD' }, context)
  await until(() => f.holding())
  await actions.remote({ key: 'q', text: 'Proceed?', reply: true, from }, f.action())
  await expect(
    f.service().tell(ROOT_CONVERSATION_ID, { project: 'poe2-rust', text: 'Yes' }, context),
  ).rejects.toThrow('is sent back automatically')
  f.hold.release()
  await expect(
    f.service().tell(f.recipient.id, { project: 'poe2-rust', text: 'Hi' }, context),
  ).rejects.toThrow("Only @ultimate tells another project's Ultimate")
})
it('names the project when another Ultimate cannot be reached, and marks the message failed', async () => {
  const closed = await otherUltimate(() => [200, {}])
  servers.pop()!.close()
  const f = await remoteFixture(closed.url)
  await expect(
    f.service().tell(ROOT_CONVERSATION_ID, { project: 'poe2-rust', text: 'Hi' }, context),
  ).rejects.toThrow(`poe2-rust on this machine did not answer at ${closed.url}`)
  expect((await f.log())!.messages.at(-1)).toMatchObject({ to: 'remote', state: 'failed' })
  const stopped = await remoteFixture()
  await expect(
    stopped.service().tell(ROOT_CONVERSATION_ID, { project: 'poe2-rust', text: 'Hi' }, context),
  ).rejects.toThrow('poe2-rust is not running on this machine')
})
