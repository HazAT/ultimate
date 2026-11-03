import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { Conversation, ConversationId } from '@earendil-works/pi-durable'
import { afterAll, expect, it } from 'vitest'
import { onCommit } from '../lib/commits.ts'
import { attach, fauxServer, held, post, prepareFauxServer, temp, until } from './helpers.ts'
import type { ConversationSummary } from '../shared/protocol.ts'
import { context } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import {
  actions as conversationActions,
  concludedIn,
  setStanding,
} from '../extensions/conversations/server.ts'
import { UiState } from '../server/ui-state.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { actionExec } from '../server/actions.ts'
import { currentAnswer, exchangeUser } from '../extensions/conversations/summary.ts'
import { Overview } from '../extensions/conversations/overview.ts'
import { Branch } from '../extensions/lineage/api.ts'

type Server = Awaited<ReturnType<typeof fauxServer>>
const servers: Server[] = []
// Tests run concurrently, each on its own server; close them all once the file is done.
afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

/** A faux server whose project also enables subagents (for an owned child). */
async function launch() {
  const home = await temp('ultimate-conversations-')
  const projectRoot = join(home, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  await writeFile(
    join(projectRoot, '.ultimate/settings.json'),
    JSON.stringify({
      summaryModel: 'unavailable/test',
      extensions: { enable: ['subagents'] },
    }),
  )
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  servers.push(server)
  const summary = (id: number) => server.api.conversations().find((item) => item.id === id)
  return {
    server,
    home,
    summary,
    /** The root starts a worker that answers DONE; resolves once everything is idle. */
    delegate: async () => {
      server.host.faux!.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall('subagent', {
              action: 'start',
              agent: 'worker',
              isolate: 'none',
              task: 'Return the word DONE.',
            }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('DONE'),
        fauxAssistantMessage('Delegated.'),
      ])
      await post(server, '/api/conversations/1/submit', { text: 'delegate to worker' })
      await server.harness.waitForIdle(context)
    },
    /** A new top-level conversation, as the sidebar creates one. */
    create: async (data: { cwd?: string; title?: string } = {}) =>
      (await post(server, '/api/conversations', data)).data.id as ConversationId,
    /** A user message at `timestamp`, without a run; resolves once the summary shows it. */
    message: async (id: ConversationId, text: string, timestamp: number) => {
      await server.harness.commit(
        (tx) =>
          tx.appendEntry(id, {
            kind: 'pi.user',
            model: [{ role: 'user', content: text, timestamp }],
          }),
        context,
      )
      await until(() => summary(id)?.inputAt === timestamp)
    },
    /** A section of `extension` as conversation `id` would see it now. */
    render: async (extension: string, id: ConversationId) => {
      const section = server.host.registry.snapshot().extension(extension)!.sections![0]
      const agent = await (await server.harness.conversation(id, context))!.agent(context)
      return section.render(
        { conversationId: id, agent } as unknown as Parameters<typeof section.render>[0],
        context,
      )
    },
    action: (name: string, args: unknown) =>
      post(server, `/api/extensions/conversations/actions/${name}`, { args }),
  }
}
it.concurrent('reads concluded IDs from the current transaction without exposing mutable document state', async () => {
  const { server, create } = await launch()
  const id = await create()
  await server.harness.commit(async (tx) => {
    expect(await concludedIn(tx)).toEqual(new Set())
    const ui = await tx.doc(UiState, ROOT_CONVERSATION_ID)
    ui['ext.conversations.concluded'] = [id]
    const ids = await concludedIn(tx)
    expect(ids).toEqual(new Set([id]))
    ids.clear()
    expect(await concludedIn(tx)).toEqual(new Set([id]))
    ui['ext.conversations.concluded'] = 'invalid'
    expect(await concludedIn(tx)).toEqual(new Set())
    ui['ext.conversations.concluded'] = []
  }, context)
})

it.concurrent('tells each top-level conversation about the others in a fixed text', async () => {
  const { server, home, summary, create, message, render, delegate } = await launch()
  const root = ROOT_CONVERSATION_ID
  const fixed = await render('conversations', root)
  expect(fixed).toMatch(/^Other conversations in this project/)
  expect(fixed).toContain('`ultimate.conversations()`')

  // An owned child (a subagent) gets no section.
  await delegate()
  const child = server.api.conversations().find((item) => item.label === 'worker')!
  expect(child.inputAt).toEqual(expect.any(Number))
  expect(child.parentConversationId).toBe(root)
  expect(child.branchOf).toBeUndefined()
  expect(await render('conversations', child.id as ConversationId)).toBeUndefined()
  const childContext = await (await server.harness.conversation(
    child.id as ConversationId,
    context,
  ))!.context(context)
  const childNotes = childContext.entries.filter((entry) => entry.kind === 'conversations.identity')
  expect(childNotes).toHaveLength(1)
  expect(childNotes[0].model?.[0]).toMatchObject({ content: `You are conversation #${child.id}.` })

  // Other conversations starting, working elsewhere or concluding never change the text.
  const other = await create()
  await message(other, 'Fix the parser', 2000)
  const elsewhere = await create({ cwd: home })
  await message(elsewhere, 'Elsewhere', 3000)
  await post(server, '/api/extensions/conversations/actions/conclude', {
    args: { ids: [other] },
  })
  expect(await render('conversations', root)).toBe(fixed)
  expect(await render('conversations', elsewhere)).toBe(fixed)

  // An ownerless fork is top-level, but its inherited history is tracked separately.
  const view = await server.root.context(context)
  const entry = view.entries.find((item) => item.kind === 'pi.user')!
  const fork = await server.root.fork(entry.id, { ownership: { kind: 'ownerless' } }, context)
  await until(() => summary(fork.id)?.inputAt !== undefined)
  expect(summary(fork.id)!.inputAt).toEqual(expect.any(Number))
  expect(summary(fork.id)).toMatchObject({ branchOf: { conversationId: root, at: entry.id } })
  expect(summary(fork.id)).not.toHaveProperty('parentConversationId')
  const stream = await attach(server)
  try {
    const wire = stream.events.find((event) => event.name === 'conversations')!
    const conversations = wire.data as ConversationSummary[]
    expect(conversations.find((item) => item.id === fork.id)).toMatchObject({
      branchOf: { conversationId: root, at: entry.id },
    })
    expect(conversations.find((item) => item.id === fork.id)).not.toHaveProperty(
      'parentConversationId',
    )
    expect(conversations.find((item) => item.id === child.id)?.parentConversationId).toBe(root)
  } finally {
    await stream.close()
  }
  expect(await render('conversations', fork.id)).toBe(fixed)
  await until(async () => {
    try {
      const manifest = JSON.parse(
        await readFile(join(server.host.home, 'conversations.json'), 'utf8'),
      )
      return manifest.some((item: { id: number }) => item.id === fork.id)
    } catch {
      return false
    }
  })
  const manifest = JSON.parse(await readFile(join(server.host.home, 'conversations.json'), 'utf8'))
  expect(manifest.some((item: { id: number }) => item.id === child.id)).toBe(false)
})

it.concurrent('renders identical system prompt sections and tools for a conversation and its fork', async () => {
  const { server, create } = await launch()
  const id = await create({ title: 'Parent title' })
  const at = await server.harness.commit(
    (tx) =>
      tx.appendEntry(id, {
        kind: 'pi.user',
        model: [{ role: 'user', content: 'Work', timestamp: 1 }],
      }),
    context,
  )
  const fork = await server.harness.commit(
    (tx) => tx.forkConversation(id, at.id, { ownership: { kind: 'ownerless' } }),
    context,
  )
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Metadata, fork.id)).title = 'Different fork title'
  }, context)
  const render = async (conversationId: ConversationId) => {
    const conversation = (await server.harness.conversation(conversationId, context))!
    const agent = await conversation.agent(context)
    const sections: Record<string, string> = {}
    for (const section of agent.sections) {
      const value = await section.render(
        { conversationId, agent, env: undefined, shown: {}, read: server.harness },
        context,
      )
      if (value !== undefined) sections[section.key] = value
    }
    return {
      sections,
      // Include the schemas and descriptions too: they are part of the provider's cached prefix.
      tools: agent.tools.map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      })),
    }
  }
  const parent = await render(id)
  expect(parent.sections.conversations).toBeDefined()
  expect(parent.sections.identity).toBeDefined()
  expect(parent.tools.length).toBeGreaterThan(0)
  expect(JSON.stringify(await render(fork.id))).toBe(JSON.stringify(parent))

  // Audit the existing document exception: lineage.branch resets on raw forks.
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Branch, id)).branch = { from: 1, at: at.id, intent: 'Branch work' }
  }, context)
  const branchFork = await server.harness.commit(
    (tx) => tx.forkConversation(id, at.id, { ownership: { kind: 'ownerless' } }),
    context,
  )
  const branchParent = await render(id)
  const forked = await render(branchFork.id)
  expect(
    Object.keys(branchParent.sections).filter(
      (key) => branchParent.sections[key] !== forked.sections[key],
    ),
  ).toEqual(['lineage'])
  expect(branchParent.sections.lineage).toContain('Branched from #1')
  expect(forked.sections.lineage).not.toContain('Branched from')
  // When the fork has the same branch facts, its entire prefix is identical too.
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Branch, branchFork.id)).branch = { from: 1, at: at.id, intent: 'Branch work' }
  }, context)
  expect(JSON.stringify(await render(branchFork.id))).toBe(JSON.stringify(branchParent))
})

const submit = async (target: Conversation, text: string) =>
  (await target.submit({ type: 'input', content: text }, context)).wait(context)
const notes = async (target: Conversation) =>
  (await target.context(context)).entries.filter((entry) => entry.kind === 'conversations.identity')

it.concurrent('identifies first inputs and inputs after compaction, not other turns, durably across forks and reopening', async () => {
  const { server, create } = await launch()
  const id = await create()
  const conversation = (await server.harness.conversation(id, context))!
  server.host.faux!.setResponses(Array.from({ length: 12 }, () => fauxAssistantMessage('Answer')))
  await submit(conversation, 'First')
  const first = await notes(conversation)
  expect(first).toHaveLength(1)
  expect(first[0].model?.[0]).toMatchObject({
    role: 'user',
    content: `You are conversation #${id}.`,
  })
  const entries = (await conversation.context(context)).entries
  const noteIndex = entries.findIndex((entry) => entry.id === first[0].id)
  expect(noteIndex).toBeGreaterThanOrEqual(0)
  expect(noteIndex).toBeLessThan(entries.findIndex((entry) => entry.input))
  await submit(conversation, 'Second')
  expect(await notes(conversation)).toHaveLength(1)

  const at = (await conversation.context(context)).entries.at(-1)!.id
  const fork = await conversation.fork(at, { ownership: { kind: 'ownerless' } }, context)
  await submit(fork, 'Fork first')
  expect((await notes(fork)).at(-1)?.model?.[0]).toMatchObject({
    content: `You are conversation #${fork.id}.`,
  })
  await submit(fork, 'Fork second')
  expect(await notes(fork)).toHaveLength(2) // one inherited, one own

  // Enough history for Pi to summarize rather than skip a short context.
  await server.harness.commit(async (tx) => {
    for (let n = 0; n < 8; n++)
      await tx.appendEntry(id, {
        kind: 'pi.user',
        model: [{ role: 'user', content: `Part ${n} ${'word '.repeat(4000)}`, timestamp: n }],
      })
  }, context)
  await server.harness.waitForTask(await conversation.compact(undefined, context), context)
  const marker = await server.harness.commit((tx) => tx.latestHeadMarker(id), context)
  expect(marker?.kind).toBe('pi.compaction')
  await submit(conversation, 'After compaction')
  expect((await notes(conversation)).at(-1)!.id).toBeGreaterThan(marker!.id)
  const count = (await notes(conversation)).length
  await submit(conversation, 'After compaction second')
  expect(await notes(conversation)).toHaveLength(count)

  const options = {
    ultimateRoot: server.host.ultimateRoot,
    projectRoot: server.host.projectRoot,
    userHome: server.host.userHome,
    home: server.host.home,
  }
  await server.close()
  servers.splice(servers.indexOf(server), 1)
  const reopened = await fauxServer(options)
  servers.push(reopened)
  reopened.host.faux!.setResponses([fauxAssistantMessage('Reopened answer')])
  const continued = (await reopened.harness.conversation(id, context))!
  await submit(continued, 'After reopening')
  expect(await notes(continued)).toHaveLength(count)
  // A reset loses context too, and the same durable marker mechanism refreshes the identity once.
  await continued.reset(undefined, context)
  reopened.host.faux!.setResponses([
    fauxAssistantMessage('Reset answer'),
    fauxAssistantMessage('Next'),
  ])
  await submit(continued, 'After reset')
  expect(await notes(continued)).toHaveLength(1)
  await submit(continued, 'After reset second')
  expect(await notes(continued)).toHaveLength(1)
})

it.each(['compaction', 'reset'] as const)(
  'identifies the first request after a %s queued while busy',
  async (kind) => {
    const { server, create } = await launch()
    const id = await create()
    const conversation = (await server.harness.conversation(id, context))!
    await submit(conversation, 'First')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    server.host.faux!.setResponses([
      async () => {
        entered.resolve()
        await release.promise
        return fauxAssistantMessage('Busy answer')
      },
      (request) => {
        expect(JSON.stringify(request.messages)).toContain(`You are conversation #${id}.`)
        return fauxAssistantMessage('After boundary')
      },
    ])
    const busy = await conversation.submit({ type: 'input', content: 'Busy' }, context)
    await entered.promise
    const write = await conversation.submit(
      {
        type: 'write',
        entry: {
          kind: kind === 'compaction' ? 'pi.compaction' : 'pi.reset',
          head: 'self',
          model: [{ role: 'user', content: 'New context without identity', timestamp: Date.now() }],
        },
      },
      context,
    )
    const next = await conversation.submit({ type: 'input', content: 'Next' }, context)
    release.resolve()
    expect((await busy.wait(context)).status).toBe('done')
    expect((await write.wait(context)).status).toBe('done')
    expect((await next.wait(context)).status).toBe('done')
    expect(await notes(conversation)).toHaveLength(0) // the request guard does not write history
  },
)

it.concurrent('identifies the next model request after automatic overflow compaction mid-run', async () => {
  const { server, create } = await launch()
  const id = await create()
  const conversation = (await server.harness.conversation(id, context))!
  await submit(conversation, 'First')
  await server.harness.commit(async (tx) => {
    for (let n = 0; n < 8; n++)
      await tx.appendEntry(id, {
        kind: 'pi.user',
        model: [{ role: 'user', content: `Part ${n} ${'word '.repeat(4000)}`, timestamp: n }],
      })
  }, context)
  let resumed = false
  server.host.faux!.setResponses([
    fauxAssistantMessage('Too long', {
      stopReason: 'error',
      errorMessage: 'maximum context length exceeded',
    }),
    fauxAssistantMessage('Summary without identity'),
    (request) => {
      resumed = true
      expect(JSON.stringify(request.messages)).toContain('Summary without identity')
      expect(JSON.stringify(request.messages)).toContain(`You are conversation #${id}.`)
      return fauxAssistantMessage('Resumed')
    },
  ])
  expect((await submit(conversation, 'Continue')).status).toBe('done')
  expect(resumed).toBe(true)
  const marker = await server.harness.commit((tx) => tx.latestHeadMarker(id), context)
  expect(marker?.kind).toBe('pi.compaction')
  expect(marker?.data).toMatchObject({ reason: 'overflow' })
  expect(await notes(conversation)).toHaveLength(0) // the request guard does not write history
})

it.concurrent('renames top-level conversations', async () => {
  const { server, summary, create, message, action, delegate } = await launch()
  const id = await create()
  await message(id, 'Fix the parser', 2000)
  const title = async () => (await server.harness.snapshot(Metadata, id, context))?.title

  expect(await action('rename', { id, title: '  Parser work  ' })).toEqual({
    status: 200,
    data: { result: { ok: true } },
  })
  await until(() => summary(id)?.title === 'Parser work')
  await action('rename', { id, title: ' Parser\n\twork\r\n  again ' })
  await until(() => summary(id)?.title === 'Parser work again')
  await action('rename', { id, title: 'x'.repeat(200) })
  await until(() => summary(id)?.title === 'x'.repeat(160))
  await action('rename', { id, title: '   ' })
  await until(() => summary(id)?.title === 'Fix the parser')
  expect(await title()).toBeUndefined()

  // Bad args and conversations that are not top-level are refused.
  const root = server.root
  await message(root.id, 'Root work', 1000)
  const entry = (await root.context(context)).entries.find((item) => item.kind === 'pi.user')!
  const fork = await root.fork(entry.id, { ownership: { kind: 'ownerless' } }, context)
  expect(await action('rename', { id: fork.id, title: 'Branch work' })).toEqual({
    status: 200,
    data: { result: { ok: true } },
  })
  await delegate()
  const child = server.api.conversations().find((item) => item.label === 'worker')!
  const owned = `Conversation ${child.id} is owned, not a top-level conversation`
  for (const [name, args, error] of [
    ['rename', null, 'Expected a conversation id'],
    ['rename', { id: 'one', title: 'x' }, 'Expected a conversation id'],
    ['rename', { id }, 'Expected a title'],
    ['rename', { id: 999999, title: 'x' }, 'Unknown conversation 999999'],
    ['rename', { id: child.id, title: 'x' }, owned],
    ['conclude', { ids: [child.id] }, owned],
  ] as const)
    expect(await action(name, args)).toEqual({ status: 500, data: { error } })
})

it.concurrent('projects arbitrary typed inputs, ignores user-role writes, and preserves activity across heads and reopen', async () => {
  const { server, summary, create, action } = await launch()
  const id = await create()
  const conversation = (await server.harness.conversation(id, context))!
  await conversation.submit(
    {
      type: 'write',
      entry: {
        kind: 'lineage.note',
        model: [{ role: 'user', content: 'A note, not an input', timestamp: 1000 }],
      },
    },
    context,
  )
  server.harness.resume()
  await server.harness.waitForIdle(context)
  await until(() => summary(id) !== undefined)
  expect(summary(id)).not.toHaveProperty('inputAt')
  expect(summary(id)).not.toHaveProperty('title')

  await conversation.submit(
    { type: 'input', content: '  Typed\n request  ', entry: { kind: 'test.request' } },
    context,
  )
  server.harness.resume()
  await server.harness.waitForIdle(context)
  await until(() => summary(id)?.answerAt !== undefined)
  expect(summary(id)?.title).toBe(' Typed request ')
  const view = await conversation.context(context)
  const input = view.entries.find((entry) => entry.kind === 'test.request')!
  expect(input.input).toBe(true)
  await until(
    async () =>
      (await server.harness.snapshot(Overview, ROOT_CONVERSATION_ID, context))?.conversations[id]
        ?.internalInput === true,
  )
  const answer = view.entries.findLast((entry) => entry.model?.[0]?.role === 'assistant')!
  const inputAt = input.model![0].timestamp
  const answerAt = answer.model![0].timestamp
  await until(() => summary(id)?.inputAt === inputAt && summary(id)?.answerAt === answerAt)

  // A user-role write after the answer must not invalidate the current exchange or change recency.
  await conversation.submit(
    {
      type: 'write',
      entry: {
        kind: 'lineage.note',
        model: [{ role: 'user', content: 'Later note', timestamp: inputAt + 10000 }],
      },
    },
    context,
  )
  server.harness.resume()
  await server.harness.waitForIdle(context)
  const activity = { inputAt, answerAt }
  expect(summary(id)).toMatchObject(activity)
  await server.harness.commit(async (tx) => {
    expect((await exchangeUser(tx, id))?.id).toBe(input.id)
    expect(await currentAnswer(tx, id, answer.id)).toBe(true)
  }, context)
  await server.harness.commit(
    (tx) => tx.appendEntry(id, { kind: 'pi.compaction', head: 'self' }),
    context,
  )
  await until(() => summary(id)?.title === undefined)
  expect(summary(id)).toMatchObject(activity)

  await action('rename', { id, title: 'Kept title' })
  await until(() => summary(id)?.title === 'Kept title')
  await conversation.reset(undefined, context)
  expect(summary(id)).toMatchObject({ title: 'Kept title', ...activity })
  const options = {
    ultimateRoot: server.host.ultimateRoot,
    projectRoot: server.host.projectRoot,
    userHome: server.host.userHome,
    home: server.host.home,
  }
  await server.close()
  servers.splice(servers.indexOf(server), 1)
  const reopened = await fauxServer(options)
  servers.push(reopened)
  expect(reopened.api.conversations().find((item) => item.id === id)).toMatchObject({
    title: 'Kept title',
    ...activity,
  })
})

it.concurrent('keeps unmarked Pi input history and makes no metadata writes on an unchanged reopen', async () => {
  const { server, create, message, summary } = await launch()
  const id = await create()
  await message(id, 'Existing parser work', 1000)
  await server.harness.commit(
    (tx) =>
      tx.appendEntry(id, {
        kind: 'pi.assistant',
        model: [{ ...fauxAssistantMessage('Existing answer'), timestamp: 2000 }],
      }),
    context,
  )
  await until(() => summary(id)?.answerAt === 2000)
  expect(summary(id)).toMatchObject({
    title: 'Existing parser work',
    inputAt: 1000,
    answerAt: 2000,
  })
  const options = {
    ultimateRoot: server.host.ultimateRoot,
    projectRoot: server.host.projectRoot,
    userHome: server.host.userHome,
    home: server.host.home,
  }
  await server.close()
  servers.splice(servers.indexOf(server), 1)
  const prepared = await prepareFauxServer(options)
  const metadataWrites: number[] = []
  const open = prepared.host.open.bind(prepared.host)
  let stop: (() => void) | undefined
  prepared.host.open = async (...args) => {
    const opened = await open(...args)
    // Subscribe before extension onOpen callbacks reconcile the stored conversations.
    stop = onCommit(opened.harness, (publication) => {
      for (const change of publication.changes)
        if (change.type === 'document' && change.record.kind === Metadata.definition.kind)
          metadataWrites.push(change.conversationId!)
    })
    return opened
  }
  const reopened = { ...prepared, ...(await prepared.go()) }
  servers.push(reopened)
  expect(reopened.api.conversations().find((item) => item.id === id)).toMatchObject({
    title: 'Existing parser work',
    inputAt: 1000,
    answerAt: 2000,
  })
  expect(metadataWrites).toEqual([])
  stop?.()
})

it.concurrent('conclude merges concurrent additions, deduplicates ids and returns kept checkouts', async () => {
  const { server, create, action } = await launch()
  const first = await create()
  const second = await create()
  const kept = [{ id: first, uncommitted: 2, unlanded: 1 }]
  const released: number[][] = []
  const host = {
    harness: () => server.harness,
    doc: () => undefined,
    metadata: Metadata,
    want: () => ({
      release: async (ids: number[]) => {
        released.push(ids)
        return kept
      },
      stop: async () => [],
    }),
  } as unknown as ExtensionHost
  const ctx = {
    host,
    signal: new AbortController().signal,
    exec: actionExec('.', new AbortController().signal),
  }
  const results = await Promise.all([
    conversationActions.conclude({ ids: [first, first] }, ctx),
    conversationActions.conclude({ ids: [second] }, ctx),
  ])
  expect(results[0]).toEqual({ concluded: [first], stopped: [], previews: [], kept })
  expect(released).toEqual(expect.arrayContaining([[first], [second]]))
  expect((await server.host.uiState(context))['ext.conversations.concluded']).toEqual([
    first,
    second,
  ])
  const rejected = await create()
  expect(await action('conclude', { ids: [rejected, 999999] })).toEqual({
    status: 500,
    data: { error: 'Unknown conversation 999999' },
  })
  expect((await server.host.uiState(context))['ext.conversations.concluded']).toEqual([
    first,
    second,
  ])
  expect(await action('conclude', { ids: ['bad'] })).toEqual({
    status: 500,
    data: { error: 'Expected conversation ids' },
  })
})

it.concurrent('concluding a busy conversation stops it and the subagents it runs', async () => {
  const { server, create, action } = await launch()
  const id = await create()
  // The conversation starts a background worker, then both wait on answers that never come.
  server.host.faux!.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall('subagent', {
          action: 'start',
          agent: 'worker',
          isolate: 'none',
          background: true,
          task: 'Keep working.',
        }),
      ],
      { stopReason: 'toolUse' },
    ),
    held,
    held,
  ])
  await post(server, `/api/conversations/${id}/submit`, { text: 'start a worker' })
  const running = async (conversation: number) =>
    (await server.harness.snapshot(LiveDoc, conversation as ConversationId, context))?.run
  const child = () =>
    server.api.conversations().find((item) => item.parentConversationId === id)?.id ?? 0
  await until(async () => Boolean(child() && (await running(child())) && (await running(id))))

  const result = await action('conclude', { ids: [id] })
  expect(result).toMatchObject({
    status: 200,
    data: { result: { concluded: [id], stopped: [id, child()], previews: [] } },
  })
  expect(await running(id)).toBeUndefined()
  expect(await running(child())).toBeUndefined()
  const live = (await server.harness.inspect(context)).tasks.filter(({ record }) =>
    [id, child()].includes(record.conversationId as number),
  )
  expect(live).toEqual([])
})

it.concurrent('refuses to conclude a root or a standing agent', async () => {
  const { server, create, action } = await launch()
  const ultimate = (
    await post(server, '/api/extensions/subagents/actions/standing', { args: { name: 'ultimate' } })
  ).data.result as number
  // The lander is marked standing by workspaces; its label is not read, so relabelling it changes nothing.
  const lander = await create()
  await server.harness.commit(async (tx) => {
    await setStanding(tx, lander, true)
    ;(await tx.doc(Metadata, lander)).label = 'renamed'
  }, context)
  const labelled = await create()
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Metadata, labelled)).label = 'lander'
  }, context)
  const branch = await create()
  for (const [id, kind] of [
    [1, 'a root; roots'],
    [ultimate, 'a standing agent; standing agents'],
    [lander, 'a standing agent; standing agents'],
  ] as const) {
    expect(await action('conclude', { ids: [branch, id] })).toEqual({
      status: 500,
      data: { error: `#${id} is ${kind} cannot be concluded` },
    })
  }
  // The refusal is the whole call's: the ordinary conversation named with it was not concluded either.
  expect((await server.host.uiState(context))['ext.conversations.concluded']).toBeUndefined()
  expect(await action('conclude', { ids: [branch] })).toMatchObject({ status: 200 })
  // A conversation merely labelled `lander` is an ordinary one.
  expect(await action('conclude', { ids: [labelled] })).toMatchObject({ status: 200 })
})

it.concurrent('concludes a retired standing agent once its definition is gone', async () => {
  const { server, home, action } = await launch()
  const file = join(home, 'project/.ultimate/agents/x.md')
  await mkdir(join(home, 'project/.ultimate/agents'))
  await writeFile(file, '---\nname: x\ndescription: Test\nresident: true\n---\nX')
  const standing = (args: unknown) =>
    post(server, '/api/extensions/subagents/actions/standing', { args })
  const id = (await standing({ name: 'x' })).data.result as number
  expect(await action('conclude', { ids: [id] })).toMatchObject({ status: 500 })
  await rm(file)
  // Asking for the retired name prunes it, as the next open would.
  expect(await standing({ name: 'x' })).toMatchObject({ status: 500 })
  expect(await action('conclude', { ids: [id] })).toMatchObject({ status: 200 })
  expect((await server.host.uiState(context))['ext.conversations.concluded']).toEqual([id])
})

it.concurrent('resume removes concluded ancestors and leaves unrelated ids alone', async () => {
  const { server, create, action } = await launch()
  const parent = await create()
  const unrelated = await create()
  const at = await server.harness.commit(
    async (tx) => (await tx.appendEntry(parent, { kind: 'test.branch', data: {} })).id,
    context,
  )
  const child = await (await server.harness.conversation(parent, context))!.fork(
    at,
    { ownership: { kind: 'ownerless' } },
    context,
  )
  await action('conclude', { ids: [parent, child.id, unrelated] })
  expect(await action('resume', { ids: [child.id] })).toEqual({
    status: 200,
    data: { result: { resumed: [parent, child.id] } },
  })
  expect((await server.host.uiState(context))['ext.conversations.concluded']).toEqual([unrelated])
})
