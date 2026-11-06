import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { awaitWithContext } from '@earendil-works/chord/context'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId } from '@earendil-works/pi-durable'
import {
  AgentDoc,
  defineDoc,
  defineExtension,
  defineTask,
  hook,
  ROOT_CONVERSATION_ID,
  ToolTask,
} from '@earendil-works/pi-durable'
import { context } from '../server/harness.ts'
import { Messages } from '../extensions/messages/api.ts'
import { branchOf, rootOf } from '../extensions/lineage/server.ts'
import { Branch } from '../extensions/lineage/api.ts'
import { Automations } from '../extensions/automations/server.ts'
import { Index, Side, tracksEffect } from '../extensions/side-chat/server.ts'
import type { endTask } from '../extensions/side-chat/server.ts'
import { fauxServer, post, sourceCopy, temp, until } from './helpers.ts'

let ultimateRoot: string
const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
beforeAll(async () => {
  ultimateRoot = await sourceCopy(await temp())
  // A watcher that inherits faux and only answers: creation must not launch a real script.
  await writeFile(
    join(ultimateRoot, 'agents/watcher.md'),
    '---\nname: watcher\ndescription: Test automation writer\ntools: [read]\n---\nAnswer without writing or starting any script.\n',
  )
  await writeFile(
    join(ultimateRoot, '.ultimate/settings.json'),
    JSON.stringify({ summaryModel: 'unavailable/test' }),
  )
})
// Each test's servers close when it ends: closing every test's servers at once overruns the hook timeout under load.
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})
const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content) && content[0]?.type === 'text'
      ? content[0].text
      : JSON.stringify(content)

async function fixture() {
  const home = await temp('ultimate-sidechat-')
  const server = await fauxServer({ ultimateRoot, home, userHome: home })
  servers.push(server)
  const standing = await post(server, '/api/extensions/subagents/actions/standing', {
    args: { name: 'ultimate' },
  })
  expect(standing.status).toBe(200)
  const main = standing.data.result as ConversationId
  // Dream makes both built-ins once @ultimate exists; they join its prompt, so wait before the first turn.
  await until(async () =>
    (
      await post(server, '/api/extensions/automations/actions/list', { args: null })
    ).data.result.some(({ name }: { name: string }) => name === 'Dream after a pause'),
  )
  const hold = Promise.withResolvers<void>()
  const gate = { afterTool: false, entered: false, summaryFailure: undefined as string | undefined }
  const requests: { system: string; text: string; messages: string }[] = []
  const summaries: string[] = []
  const route: FauxResponseFactory = async (transcript, options) => {
    server.host.faux!.appendResponses([route])
    const system = transcript.messages
      .filter((message) => message.role === 'system')
      .map((message) =>
        JSON.stringify({
          content: message.content,
          sections: message.sections,
          toolsAdded: message.toolsAdded,
          toolsRemoved: message.toolsRemoved,
        }),
      )
      .join('\n')
    const last = transcript.messages.findLast((message) => message.role !== 'system')!
    const text = textOf(last.content)
    requests.push({ system, text, messages: JSON.stringify(transcript.messages) })
    if (system.includes('Summarize this temporary side chat')) {
      summaries.push(text)
      if (gate.summaryFailure)
        return fauxAssistantMessage(gate.summaryFailure, {
          stopReason: 'error',
          errorMessage: gate.summaryFailure,
        })
      return fauxAssistantMessage('Decision: keep the finding. Open question: next step?')
    }
    if (last.role === 'toolResult') {
      if (gate.afterTool) {
        gate.entered = true
        await hold.promise
      }
      return fauxAssistantMessage(`Tool result: ${text}`)
    }
    if (text === 'HOLD')
      await Promise.race([
        hold.promise,
        new Promise((_, reject) =>
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
      ])
    if (text.startsWith('CALL ')) {
      const { name, args } = JSON.parse(text.slice(5))
      return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' })
    }
    return fauxAssistantMessage(`echo ${text}`)
  }
  server.host.faux!.setResponses([route])
  const ask = async (id: number, text: string) =>
    (
      await (await server.harness.conversation(id as ConversationId, context))!.submit(
        { type: 'input', content: text },
        context,
      )
    ).wait(context)
  await ask(main, 'MAIN HISTORY')
  const action = (name: string, args: unknown, conversationId = main) =>
    post(server, `/api/extensions/side-chat/actions/${name}`, { args, conversationId })
  const open = async (text = 'TANGENT') => {
    const result = await action('open', { text })
    expect([result.status, result.data.error]).toEqual([200, undefined])
    const id = result.data.result.id as ConversationId
    await (await server.harness.conversation(id, context))!.waitForIdle(context)
    return id
  }
  const call = (id: number, name: string, args: unknown) =>
    ask(id, `CALL ${JSON.stringify({ name, args })}`)
  return { server, main, home, hold, gate, requests, summaries, ask, action, open, call }
}

async function entries(server: Awaited<ReturnType<typeof fauxServer>>, id: number) {
  return server.harness.commit(
    async (tx) =>
      (await tx.scanEntries({ conversationId: id as ConversationId, order: 'ascending' }, 1000))
        .items,
    context,
  )
}

describe('side chats', () => {
  it('forks the last completed run while main is busy, preserves the entire prompt including codemode and all tools, and stays outside lineage', async () => {
    const f = await fixture()
    const mainBefore = f.requests.at(-1)!
    const finished = (await entries(f.server, f.main)).at(-1)!.id
    let entered = false
    const messages = f.server.host.registry.snapshot().extension('messages')!
    f.server.host.registry.install(
      defineExtension({
        ...messages,
        hooks: [
          ...(messages.hooks ?? []),
          hook(ToolTask, {
            beforeTool: async (call) => {
              if (call.name === 'message') {
                entered = true
                await f.hold.promise
              }
              return undefined
            },
          }),
        ],
      }),
    )
    const running = await (await f.server.harness.conversation(f.main, context))!.submit(
      {
        type: 'input',
        content: `CALL ${JSON.stringify({ name: 'message', args: { to: 'user', text: 'holding main' } })}`,
      },
      context,
    )
    await until(() => entered)
    const unfinished = (await entries(f.server, f.main)).at(-1)!
    expect(unfinished.kind).toBe('pi.assistant')
    expect(unfinished.model?.[0].content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'toolCall', name: 'message' })]),
    )
    const side = await f.open()
    const doc = await f.server.harness.snapshot(Side, side, context)
    expect(doc).toEqual({ of: f.main, at: finished, effects: false })
    const fork = (await f.server.harness.conversation(side, context))!
    const sideEntries = await entries(f.server, side)
    expect(sideEntries.some((entry) => entry.id === unfinished.id)).toBe(false)
    const own = sideEntries.filter((entry) => entry.conversationId === side)
    const reminder = own.findIndex(
      (entry) =>
        entry.kind === 'conversations.identity' &&
        JSON.stringify(entry.model).includes(`You are in a side chat (#${side})`),
    )
    expect(reminder).toBeGreaterThanOrEqual(0)
    // The reminder is read before the user's first words.
    expect(own.findIndex((entry) => entry.kind === 'pi.user')).toBeGreaterThan(reminder)
    expect(f.requests.at(-1)!.system).toBe(mainBefore.system)
    expect(mainBefore.system).toContain('codemode')
    expect(await f.server.harness.snapshot(AgentDoc, side, context)).toEqual(
      await f.server.harness.snapshot(AgentDoc, f.main, context),
    )
    expect((await fork.agent(context)).tools.map((tool) => tool.name)).toEqual(
      (await (await f.server.harness.conversation(f.main, context))!.agent(context)).tools.map(
        (tool) => tool.name,
      ),
    )
    expect((await f.server.harness.snapshot(AgentDoc, side, context))!.tools).toContain('compact')
    const host = { harness: () => f.server.harness }
    expect(await branchOf(host, side, context)).toBeUndefined()
    expect(await rootOf(host, side, context)).toBeUndefined()
    expect((await f.server.harness.snapshot(Branch, side, context))?.branch).toBeUndefined()
    await until(
      () =>
        f.server.api.conversations().find((conversation) => conversation.id === side)?.label ===
        'side-chat',
    )
    const listed = f.server.api.conversations().find((conversation) => conversation.id === side)!
    expect(listed.label).toBe('side-chat')
    expect(listed.branchOf).toEqual({ conversationId: f.main, at: finished })
    const index = await f.server.harness.snapshot(Index, f.main, context)
    expect(index!.sides).toEqual([{ id: side, at: finished, openedAt: expect.any(Number) }])
    expect((await f.action('open', { text: 'nested' }, side)).data.error).toMatch(
      /cannot open another/,
    )
    expect((await f.action('open', { text: 'wrong' }, ROOT_CONVERSATION_ID)).data.error).toMatch(
      /Only @ultimate/,
    )
    const second = await f.open('ANOTHER')
    expect(second).not.toBe(side)
    f.hold.resolve()
    await running.wait(context)
  })

  it('schedules no automatic summary task for a side chat, so its title stays Side chat', async () => {
    const f = await fixture()
    const side = await f.open()
    await f.ask(side, 'A question answered in the side chat.')
    const tasks = await f.server.harness.commit(
      (tx) => tx.scanTasks({ conversationId: side, kind: 'conversations.summary' }, 100),
      context,
    )
    expect(tasks.items).toEqual([])
    // No intent or reply summary entry: only the hidden identity reminders are the conversations extension's.
    expect(
      (await entries(f.server, side)).filter(
        (entry) =>
          entry.conversationId === side &&
          entry.kind.startsWith('conversations.') &&
          entry.kind !== 'conversations.identity',
      ),
    ).toEqual([])
    expect(
      f.server.api.conversations().find((conversation) => conversation.id === side),
    ).toMatchObject({ title: 'Side chat' })
  })

  it('includes terminal tool results and ignores completed generations inside an unfinished run', async () => {
    const f = await fixture()
    await f.call(f.main, 'message', { to: 'user', text: 'finished tool-terminated turn' })
    const closing = (await entries(f.server, f.main)).at(-1)!
    expect(closing.model?.[0].role).toBe('toolResult')
    const first = await f.open()
    expect((await f.server.harness.snapshot(Side, first, context))!.at).toBe(closing.id)
    f.gate.afterTool = true
    const running = f.call(f.main, 'note', { to: ROOT_CONVERSATION_ID, text: 'still working' })
    await until(() => f.gate.entered)
    // This tool round's generation is completed, but no input submission is answered yet.
    const side = await f.open()
    expect((await f.server.harness.snapshot(Side, side, context))!.at).toBe(closing.id)
    f.hold.resolve()
    await running
  })

  it('refuses side-chat lifecycle actions invoked by an agent', async () => {
    const f = await fixture()
    await f.call(f.main, 'codemode', {
      code: "return await ultimate.action('side-chat', 'open', {text: 'agent must not open'})",
    })
    expect(JSON.stringify(await entries(f.server, f.main))).toContain(
      'side-chat/open is a user-only action',
    )
    expect((await f.server.harness.snapshot(Index, f.main, context))?.sides ?? []).toEqual([])
  })

  it('tracks only the specified tool/actions before execution, including failures, and persists effects across reopen', async () => {
    for (const name of [
      'branch',
      'message',
      'note',
      'notify',
      'remember',
      'setup',
      'restart',
      'edit',
      'write',
    ])
      expect(tracksEffect(name, {})).toBe(true)
    for (const name of ['bash', 'codemode', 'read', 'memory'])
      expect(tracksEffect(name, {})).toBe(false)
    for (const action of ['add', 'done']) expect(tracksEffect('todo', { action })).toBe(true)
    expect(tracksEffect('todo', { action: 'list' })).toBe(false)
    for (const action of ['list', 'runs', 'log'])
      expect(tracksEffect('automation', { action })).toBe(false)
    for (const action of [
      'create',
      'subscribe',
      'unsubscribe',
      'update',
      'pause',
      'resume',
      'run',
      'abort',
      'delete',
      'escalate',
    ])
      expect(tracksEffect('automation', { action })).toBe(true)
    const f = await fixture()
    const side = await f.open()
    await f.call(side, 'todo', { action: 'list' })
    expect((await f.server.harness.snapshot(Side, side, context))!.effects).toBe(false)
    // A side chat keeps @ultimate's to-dos as main.
    await f.call(side, 'todo', { action: 'add', text: 'from the side', owner: 'user' })
    expect(JSON.stringify(await entries(f.server, side))).toContain(
      'Added 1 for user: from the side',
    )
    await f.call(side, 'message', { to: 'user', text: 'must fail' })
    expect((await f.server.harness.snapshot(Side, side, context))!.effects).toBe(true)
    expect(JSON.stringify(await entries(f.server, side))).toContain(
      'Only @ultimate and branches message the user',
    )
    expect((await f.action('discard', { id: side })).data.error).toMatch(/has effects/)
    servers.splice(servers.indexOf(f.server), 1)
    await f.server.close()
    const reopened = await fauxServer({ ultimateRoot, home: f.home, userHome: f.home })
    servers.push(reopened)
    expect((await reopened.harness.snapshot(Side, side, context))!.effects).toBe(true)
    const refused = await post(reopened, '/api/extensions/side-chat/actions/discard', {
      args: { id: side },
      conversationId: f.main,
    })
    expect(refused.data.error).toMatch(/has effects/)
  })

  it('attributes messages and notes to main, returns replies there, refuses messaging self/user, and leaves one provenance note', async () => {
    const f = await fixture()
    const target = await f.server.harness.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: { model: (await f.server.root.agent(context)).model },
      },
      context,
    )
    const side = await f.open()
    await f.call(side, 'note', { to: target.id, text: 'a note' })
    expect((await f.server.harness.snapshot(Side, side, context))!.effects).toBe(true)
    const note = (await entries(f.server, target.id)).find(
      (entry) => entry.kind === 'lineage.note',
    )!
    expect(note.data).toMatchObject({ from: f.main, text: 'a note' })
    await f.call(side, 'message', { to: `#${target.id}`, text: 'one question', reply: true })
    await until(async () => {
      const board = (await f.server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))!
      return board.messages.some((message) => message.from === target.id && message.to === f.main)
    })
    const board = (await f.server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))!
    expect(board.messages.find((message) => message.text === 'one question')).toMatchObject({
      from: f.main,
      to: target.id,
      reply: true,
    })
    expect(board.messages.filter((message) => message.to === side)).toEqual([])
    const provenance = (await entries(f.server, f.main)).filter(
      (entry) =>
        entry.kind === 'lineage.note' &&
        JSON.stringify(entry.data).includes(`Side chat #${side} messaged`),
    )
    expect(provenance).toHaveLength(1)
    await f.call(side, 'message', { to: '@ultimate', text: 'self' })
    expect(JSON.stringify(await entries(f.server, side))).toContain('You cannot message yourself')
    await f.call(side, 'message', { to: 'user', text: 'user' })
    expect(JSON.stringify(await entries(f.server, side))).toContain(
      'Only @ultimate and branches message the user',
    )
  })

  it.each([
    ['message', 'latest'],
    ['message', 'entry'],
    ['branch', 'latest'],
    ['branch', 'entry'],
  ] as const)(
    'forwards the side chat image for %s with %s, not main’s image',
    async (tool, ref) => {
      const f = await fixture()
      const side = await f.open()
      const image = {
        type: 'image' as const,
        data: Buffer.from('side').toString('base64'),
        mimeType: 'image/png',
      }
      const appendImage = (id: ConversationId, data: string) =>
        f.server.harness.commit(
          (tx) =>
            tx.appendEntry(id, {
              kind: 'pi.tool-result',
              model: [
                {
                  role: 'toolResult',
                  toolCallId: 'screenshot',
                  toolName: 'screenshot',
                  isError: false,
                  content: [{ ...image, data }],
                  timestamp: Date.now(),
                },
              ],
            }),
          context,
        )
      await appendImage(f.main, Buffer.from('main').toString('base64'))
      const target = await f.server.harness.createConversation(
        { ownership: { kind: 'ownerless' } },
        context,
      )
      const text = `image ${tool} ${ref}`
      const args =
        tool === 'branch'
          ? { prompt: text, root: ROOT_CONVERSATION_ID, isolated: false }
          : { to: `#${target.id}`, text, reply: false }
      let screenshot: { id: number }
      if (ref === 'latest') {
        // "latest" forwards this turn's images: the side chat's own input carries the screenshot.
        const submission = await (await f.server.harness.conversation(side, context))!.submit(
          {
            type: 'input',
            content: [
              {
                type: 'text',
                text: `CALL ${JSON.stringify({ name: tool, args: { ...args, images: ref } })}`,
              },
              image,
            ],
          },
          context,
        )
        await submission.wait(context)
        screenshot = { id: (await submission.status(context)).entry! }
      } else {
        screenshot = await appendImage(side, image.data)
        await f.call(side, tool, { ...args, images: screenshot.id })
      }
      await until(async () =>
        (await f.server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))!.messages.some(
          (message) => message.text === text && message.entry !== undefined,
        ),
      )
      const sent = (await f.server.harness.snapshot(
        Messages,
        ROOT_CONVERSATION_ID,
        context,
      ))!.messages.find((message) => message.text === text)!
      expect(sent).toMatchObject({ from: f.main, images: { entry: screenshot.id, count: 1 } })
      const delivered = (await entries(f.server, sent.to as number)).find(
        (entry) => entry.id === sent.entry,
      )!
      expect(
        delivered.model!.flatMap((message) =>
          typeof message.content === 'string'
            ? []
            : message.content.filter((block) => block.type === 'image'),
        ),
      ).toEqual([image])
    },
  )

  it('owns branches and notify tasks in main and leaves one non-waking note for each', async () => {
    const f = await fixture()
    const side = await f.open()
    await f.call(side, 'branch', {
      prompt: 'bounded work',
      root: ROOT_CONVERSATION_ID,
      isolated: false,
    })
    await until(async () =>
      (await f.server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))!.messages.some(
        (message) => message.text === 'bounded work',
      ),
    )
    const board = (await f.server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))!
    const message = board.messages.find((sent) => sent.text === 'bounded work')!
    expect(message.from).toBe(f.main)
    const started = defineDoc<{ by?: number }>({
      kind: 'board.started',
      version: 1,
      scope: 'conversation',
      checkpointWhen: () => false,
      history: 'latest',
      fork: 'initial',
      initial: () => ({}),
    })
    expect(
      (await f.server.harness.snapshot(started, message.to as ConversationId, context))!.by,
    ).toBe(f.main)
    await f.call(side, 'notify', { id: message.to, wake: false })
    await until(async () =>
      (await entries(f.server, f.main)).some(
        (entry) =>
          entry.kind === 'lineage.note' &&
          (entry.data as { source?: string })?.source === 'finished',
      ),
    )
    const tasks = await f.server.harness.commit(
      async (tx) =>
        (await tx.scanTasks({ conversationId: f.main, kind: 'lineage.notify' }, 100)).items,
      context,
    )
    expect(tasks).toHaveLength(1)
    const notes = (await entries(f.server, f.main))
      .filter((entry) => entry.kind === 'lineage.note')
      .map((entry) => JSON.stringify(entry.data))
    expect(notes.filter((text) => text.includes(`Side chat #${side} started branch`))).toHaveLength(
      1,
    )
    expect(
      notes.filter((text) => text.includes(`Side chat #${side} requested notification`)),
    ).toHaveLength(1)
  })

  it.each([false, true])(
    'recovers notify provenance exactly once after a crash (after note: %s)',
    async (afterNote) => {
      const f = await fixture()
      const side = await f.open()
      const target = await f.server.harness.createConversation(
        { ownership: { kind: 'ownerless' } },
        context,
      )
      const reached = Promise.withResolvers<void>()
      const forever = Promise.withResolvers<void>()
      const extension = f.server.host.registry.snapshot().extension('lineage')!
      f.server.host.registry.install(
        defineExtension({
          ...extension,
          tools: extension.tools!.map((tool) =>
            tool.name !== 'notify'
              ? tool
              : {
                  ...tool,
                  execute: (input, api, ctx) =>
                    tool
                      .execute(
                        input,
                        {
                          ...api,
                          commit: async (change, caller) => {
                            const result = await api.commit(change, caller)
                            if (!afterNote) {
                              reached.resolve()
                              await awaitWithContext(forever.promise, caller)
                            }
                            return result
                          },
                        },
                        ctx,
                      )
                      .then(async (result) => {
                        if (afterNote) {
                          reached.resolve()
                          await awaitWithContext(forever.promise, ctx)
                        }
                        return result
                      }),
                },
          ),
        }),
      )
      const pending = f
        .call(side, 'notify', { id: target.id, wake: false })
        .catch((error: unknown) => error)
      await reached.promise
      const provenance = async (server: typeof f.server) =>
        (await entries(server, f.main)).filter(
          (entry) =>
            entry.kind === 'lineage.note' &&
            JSON.stringify(entry.data).includes(`Side chat #${side} requested notification`),
        )
      expect(await provenance(f.server)).toHaveLength(afterNote ? 1 : 0)
      servers.splice(servers.indexOf(f.server), 1)
      await f.server.close()
      await pending
      const reopened = await fauxServer({ ultimateRoot, home: f.home, userHome: f.home })
      servers.push(reopened)
      reopened.host.faux!.setResponses([fauxAssistantMessage('Recovered')])
      reopened.harness.resume()
      await (await reopened.harness.conversation(side, context))!.waitForIdle(context)
      expect(await provenance(reopened)).toHaveLength(1)
      const tasks = await reopened.harness.commit(
        async (tx) =>
          (await tx.scanTasks({ conversationId: f.main, kind: 'lineage.notify' }, 100)).items,
        context,
      )
      expect(tasks).toHaveLength(1)
    },
  )

  it('subscribes main by default and records the provenance without spawning a script', async () => {
    const f = await fixture()
    const side = await f.open()
    // Subscribe to an existing stopped record: no script or subprocess is needed to test ownership.
    await f.server.harness.commit(async (tx) => {
      const state = await tx.doc(Automations)
      state.next = 2
      state.automations.A1 = {
        id: 'A1',
        name: 'test',
        script: { ask: 'test', once: true, secrets: [], conversationId: f.main, state: 'stopped' },
        subscribers: [],
        runs: [],
        fires: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        enabled: false,
      }
    }, context)
    await f.call(side, 'automation', { action: 'subscribe', id: 'A1' })
    const automations = await f.server.harness.snapshot(Automations, context)
    expect(automations!.automations.A1.subscribers).toEqual([f.main])
    await f.call(side, 'automation', { action: 'create', name: 'Test', ask: 'test creation only' })
    // The dummy watcher only answers, so it now escalates rather than leaving a script stuck in writing.
    await until(
      async () =>
        (await f.server.harness.snapshot(Automations, context))!.automations.A2.script!.state ===
        'failed',
    )
    const created = (await f.server.harness.snapshot(Automations, context))!.automations.A2
    expect(created.subscribers).toEqual([f.main])
    expect(created.script!.error).toContain('The watcher stopped while the script was writing')
    expect(created.script!.pid).toBeUndefined()
    expect(
      (await entries(f.server, f.main)).filter(
        (entry) =>
          entry.kind === 'lineage.note' &&
          JSON.stringify(entry.data).includes(`Side chat #${side} created automation A2`),
      ),
    ).toHaveLength(1)
    expect(
      (await entries(f.server, f.main)).filter(
        (entry) =>
          entry.kind === 'lineage.note' &&
          JSON.stringify(entry.data).includes(`Side chat #${side} subscribed`),
      ),
    ).toHaveLength(1)
  })

  it('discards without writing main, concludes, refuses repeated end and later input, and refuses inject without summaryModel', async () => {
    const f = await fixture()
    const side = await f.open()
    expect((await f.action('inject', { id: side })).data.error).toContain('summaryModel')
    const before = await entries(f.server, f.main)
    expect((await f.action('discard', { id: side })).status).toBe(200)
    expect(await entries(f.server, f.main)).toEqual(before)
    expect((await f.server.harness.snapshot(Side, side, context))!.ended).toBe('discarded')
    expect((await f.server.host.uiState(context))['ext.conversations.concluded']).toContain(side)
    expect((await f.action('discard', { id: side })).data.error).toMatch(/already ended/)
    await expect(f.ask(side, 'revive')).rejects.toThrow(/has ended/)
    expect((await f.server.host.uiState(context))['ext.conversations.concluded']).toContain(side)
  })

  it('reopens after a summary-model failure, reports its error, and admits exactly one summary on retry', async () => {
    const f = await fixture()
    const side = await f.open('FAILED SUMMARY FINDING')
    await writeFile(join(ultimateRoot, '.ultimate/settings.json'), JSON.stringify({}))
    try {
      f.gate.summaryFailure = 'provider rate limit'
      const failed = await f.action('inject', { id: side })
      expect(failed.status).toBe(500)
      expect(failed.data.error).toContain('provider rate limit')
      expect(
        (await entries(f.server, f.main)).filter((entry) => entry.kind === 'sidechat.summary'),
      ).toHaveLength(0)
      expect(await f.server.harness.snapshot(Side, side, context)).toMatchObject({ effects: false })
      expect((await f.server.harness.snapshot(Side, side, context))!.ended).toBeUndefined()
      await f.ask(side, 'continue after failed inject')
      f.gate.summaryFailure = undefined
      expect((await f.action('inject', { id: side })).status).toBe(200)
      expect(
        (await entries(f.server, f.main)).filter((entry) => entry.kind === 'sidechat.summary'),
      ).toHaveLength(1)
      expect((await f.server.harness.snapshot(Side, side, context))!.ended).toBe('injected')
      // A failed attempt with no effects also leaves Discard usable.
      const discardable = await f.open()
      f.gate.summaryFailure = 'another model failure'
      expect((await f.action('inject', { id: discardable })).status).toBe(500)
      expect((await f.action('discard', { id: discardable })).status).toBe(200)
    } finally {
      await writeFile(
        join(ultimateRoot, '.ultimate/settings.json'),
        JSON.stringify({ summaryModel: 'unavailable/test' }),
      )
    }
  })

  it('lets a side chat whose ending task faulted be injected or discarded again', async () => {
    const f = await fixture()
    const side = await f.open('FAULTED ENDING FINDING')
    await writeFile(join(ultimateRoot, '.ultimate/settings.json'), JSON.stringify({}))
    // The task throws after the summary, where a failure of main's admission faults it (not a model failure).
    const harness = f.server.harness
    const conversation = harness.conversation.bind(harness)
    let fault = false
    harness.conversation = async (id, ctx) => {
      if (fault && id === f.main) throw new RangeError('stdout maxBuffer length exceeded')
      return conversation(id, ctx)
    }
    try {
      fault = true
      const failed = await f.action('inject', { id: side })
      expect(failed.status).toBe(500)
      expect(failed.data.error).toContain(`Could not end side chat #${side}`)
      expect(failed.data.error).toContain('maxBuffer')
      fault = false
      expect((await f.action('inject', { id: side })).status).toBe(200)
      expect(
        (await entries(f.server, f.main)).filter((entry) => entry.kind === 'sidechat.summary'),
      ).toHaveLength(1)
      expect((await f.server.harness.snapshot(Side, side, context))!.ended).toBe('injected')
      const discardable = await f.open()
      fault = true
      expect((await f.action('inject', { id: discardable })).status).toBe(500)
      fault = false
      expect((await f.action('discard', { id: discardable })).status).toBe(200)
      expect((await f.server.harness.snapshot(Side, discardable, context))!.ended).toBe('discarded')
    } finally {
      harness.conversation = conversation
      await writeFile(
        join(ultimateRoot, '.ultimate/settings.json'),
        JSON.stringify({ summaryModel: 'unavailable/test' }),
      )
    }
  })

  it('queues the passive summary in a busy main without starting a run, then reads it with the next input', async () => {
    const f = await fixture()
    const side = await f.open('BUSY MAIN FINDING')
    const running = await (await f.server.harness.conversation(f.main, context))!.submit(
      { type: 'input', content: 'HOLD' },
      context,
    )
    await until(() => f.requests.some((request) => request.text === 'HOLD'))
    await writeFile(join(ultimateRoot, '.ultimate/settings.json'), JSON.stringify({}))
    try {
      const before = f.requests.length
      expect((await f.action('inject', { id: side })).status).toBe(200)
      expect(
        (await entries(f.server, f.main)).filter((entry) => entry.kind === 'sidechat.summary'),
      ).toHaveLength(0)
      // Only the summary model ran; main is still working on the same HOLD input.
      expect(f.requests).toHaveLength(before + 1)
      f.hold.resolve()
      await running.wait(context)
      expect(
        (await entries(f.server, f.main)).filter((entry) => entry.kind === 'sidechat.summary'),
      ).toHaveLength(1)
      await f.ask(f.main, 'FOLLOW UP')
      expect(f.requests.findLast((request) => request.text === 'FOLLOW UP')!.messages).toContain(
        `Side chat #${side} (forked at`,
      )
    } finally {
      f.hold.resolve()
      await writeFile(
        join(ultimateRoot, '.ultimate/settings.json'),
        JSON.stringify({ summaryModel: 'unavailable/test' }),
      )
    }
  })

  it('replays after write admission and before conclusion without asking the model or writing a second summary', async () => {
    const f = await fixture()
    const side = await f.open('CRASH FINDING')
    await writeFile(join(ultimateRoot, '.ultimate/settings.json'), JSON.stringify({}))
    try {
      const reached = Promise.withResolvers<void>()
      const extension = f.server.host.registry.snapshot().extension('side-chat')!
      const original = extension.tasks!.find(
        (task) => task.definition.name === 'side-chat.end',
      )! as ReturnType<typeof endTask>
      const definition = original.definition
      const interrupted = defineTask({
        ...definition,
        phases: {
          ...definition.phases,
          summarize: (task, runtime, ctx) =>
            definition.phases.summarize(
              task,
              {
                ...runtime,
                commit: async () => {
                  // The write has been admitted; die before the concluding commit, leaving summarize replayable.
                  reached.resolve()
                  await new Promise<void>((_resolve, reject) =>
                    runtime.signal.addEventListener('abort', () =>
                      reject(new Error('simulated crash')),
                    ),
                  )
                },
              },
              ctx,
            ),
        },
      })
      f.server.host.registry.install(
        defineExtension({
          ...extension,
          tasks: extension.tasks!.map((task) => (task === original ? interrupted : task)),
        }),
      )
      const pending = f.action('inject', { id: side }).catch((error: unknown) => error)
      await reached.promise
      expect(
        (await entries(f.server, f.main)).filter((entry) => entry.kind === 'sidechat.summary'),
      ).toHaveLength(1)
      expect((await f.server.harness.snapshot(Side, side, context))!.ended).toBeUndefined()
      expect(f.summaries).toHaveLength(1)
      servers.splice(servers.indexOf(f.server), 1)
      await f.server.close()
      await pending
      const reopened = await fauxServer({ ultimateRoot, home: f.home, userHome: f.home })
      servers.push(reopened)
      let asked = 0
      reopened.host.faux!.setResponses([
        () => {
          asked++
          return fauxAssistantMessage('must not ask again')
        },
      ])
      const result = await post(reopened, '/api/extensions/side-chat/actions/inject', {
        args: { id: side },
        conversationId: f.main,
      })
      expect([result.status, result.data.error]).toEqual([200, undefined])
      expect(asked).toBe(0)
      expect(
        (await entries(reopened, f.main)).filter((entry) => entry.kind === 'sidechat.summary'),
      ).toHaveLength(1)
      expect((await reopened.harness.snapshot(Side, side, context))!.ended).toBe('injected')
      expect((await reopened.host.uiState(context))['ext.conversations.concluded']).toContain(side)
    } finally {
      await writeFile(
        join(ultimateRoot, '.ultimate/settings.json'),
        JSON.stringify({ summaryModel: 'unavailable/test' }),
      )
    }
  })

  it('aborts a running copy, memoizes only its new entries, and injects exactly one passive summary even when requested twice', async () => {
    const f = await fixture()
    const side = await f.open('SIDE FINDING')
    // Project settings are read afresh when the summary is requested.
    await writeFile(join(ultimateRoot, '.ultimate/settings.json'), JSON.stringify({}))
    try {
      const mainBefore = f.requests.filter((request) => request.text === 'MAIN HISTORY').length
      const copy = (await f.server.harness.conversation(side, context))!
      await copy.submit({ type: 'input', content: 'HOLD' }, context)
      await until(() => f.requests.some((request) => request.text === 'HOLD'))
      const [a, b] = await Promise.all([
        f.action('inject', { id: side }),
        f.action('inject', { id: side }),
      ])
      expect([a.status, b.status, a.data.error, b.data.error]).toEqual([
        200,
        200,
        undefined,
        undefined,
      ])
      const summaries = (await entries(f.server, f.main)).filter(
        (entry) => entry.kind === 'sidechat.summary',
      )
      expect(summaries).toHaveLength(1)
      expect(summaries[0].data).toMatchObject({
        side,
        from: side,
        to: f.main,
        text: expect.stringContaining('Decision:'),
      })
      expect(f.summaries).toHaveLength(1)
      expect(f.summaries[0]).toContain('SIDE FINDING')
      expect(f.summaries[0]).not.toContain('MAIN HISTORY')
      expect((await f.server.harness.snapshot(Side, side, context))!.ended).toBe('injected')
      expect((await f.server.host.uiState(context))['ext.conversations.concluded']).toContain(side)
      expect((await f.server.harness.snapshot(Index, f.main, context))!.sides[0].ended).toBe(
        'injected',
      )
      expect(f.requests.filter((request) => request.text === 'MAIN HISTORY')).toHaveLength(
        mainBefore,
      )
      const live = await f.server.harness.inspect(context)
      expect(
        live.tasks.filter(
          (task) => task.record.conversationId === f.main && !task.record.background,
        ),
      ).toHaveLength(0)
      await expect(f.ask(side, 'revive')).rejects.toThrow(/has ended/)
      expect((await f.action('inject', { id: side })).status).toBe(200)
      expect(
        (await entries(f.server, f.main)).filter((entry) => entry.kind === 'sidechat.summary'),
      ).toHaveLength(1)
    } finally {
      await writeFile(
        join(ultimateRoot, '.ultimate/settings.json'),
        JSON.stringify({ summaryModel: 'unavailable/test' }),
      )
    }
  })
})
