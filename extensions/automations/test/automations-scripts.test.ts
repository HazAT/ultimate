import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord/json'
import { doneText, fireText, trimLog } from '../types.ts'
import type { Automation } from '../types.ts'
import { Automations } from '../server.ts'
import { context } from '../../../server/harness.ts'
import { UiState } from '../../../shared/ui-state.ts'
import { fauxServer, held, removeTemp, temp, until } from '../../../test/helpers.ts'

const homes: string[] = []
const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
afterAll(async () => {
  // Capture both lists before close can yield to another test's setup.
  const closing = servers.splice(0)
  const taken = homes.splice(0)
  await Promise.all(closing.map((server) => server.close()))
  for (const home of taken) await removeTemp(home)
})

it('accepts loose FIRE text, including JSON and an empty payload, only on stdout', () => {
  expect(fireText('FIRE done', true)).toBe('done')
  expect(fireText('FIRE {"status":"ok"}', true)).toBe('{"status":"ok"}')
  expect(fireText('FIRE', true)).toBe('')
  expect(fireText('FIRE\tfinished', true)).toBe('finished')
  for (const text of ['progress', 'FIREWORKS', ' FIRE done', 'fire done'])
    expect(fireText(text, true)).toBeUndefined()
  expect(fireText('FIRE not a notification', false)).toBeUndefined()
})

it('reads DONE with optional text only on stdout', () => {
  expect(doneText('DONE', true)).toBe('')
  expect(doneText('DONE all merged', true)).toBe('all merged')
  for (const text of ['DONEZO', 'done', ' DONE']) expect(doneText(text, true)).toBeUndefined()
  expect(doneText('DONE', false)).toBeUndefined()
})

it('retains the newest output within both line and byte limits', () => {
  const text = Array.from({ length: 3000 }, (_, i) => `line ${i}\n`).join('')
  const trimmed = trimLog(text)
  expect(trimmed.split('\n')).toHaveLength(2001)
  expect(trimmed.startsWith('line 1000\n')).toBe(true)
  expect(trimmed.endsWith('line 2999\n')).toBe(true)
  const long = trimLog('x'.repeat(300 * 1024) + '\nend\n')
  expect(Buffer.byteLength(long)).toBeLessThanOrEqual(256 * 1024)
  expect(long.endsWith('\nend\n')).toBe(true)
  expect(trimLog('progress\n')).toBe('progress\n')
})

it('stops a paused or deleted automation’s watcher, which cannot resume it', async () => {
  // Regression: an owner deleted a script automation while its watcher was mid-turn; the watcher read "Unknown
  // automation", created it again with a new watcher, and that chain repeated five times. Watchers also resumed
  // automations their owner had just paused.
  const home = await temp('ultimate-automations-watcher-')
  homes.push(home)
  const definitions = join(home, '.ultimate/agents')
  await mkdir(definitions, { recursive: true })
  await mkdir(join(home, 'project'))
  await writeFile(
    join(definitions, 'watcher.md'),
    '---\nname: watcher\ndescription: Test\nmodel: faux/faux-1\ntools: [automation]\n---\nShort.\n',
  )
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: join(home, 'project'),
    userHome: home,
    home: join(home, 'state'),
  })
  servers.push(server)
  const watcherTurn: FauxResponseFactory = (transcript, options, state, model) => {
    server.host.faux!.appendResponses([watcherTurn])
    const last = transcript.messages.at(-1)!
    if (last.role === 'toolResult') return fauxAssistantMessage('Stopped.')
    const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
    const resume = /Resume (A\d+)/.exec(text)
    if (resume)
      return fauxAssistantMessage(
        [fauxToolCall('automation', { action: 'resume', id: resume[1] })],
        {
          stopReason: 'toolUse',
        },
      )
    return held(transcript, options, state, model)
  }
  server.host.faux!.setResponses([watcherTurn])
  const caller = await server.harness.createConversation(
    { ownership: { kind: 'ownerless' } },
    context,
  )
  const invoke = (action: string, args: JsonValue, from?: ConversationId) =>
    server.extensions.invoke('automations', action, args, new AbortController().signal, from)
  const create = async (name: string) =>
    (await invoke('create', { name, ask: 'Watch deploys' }, caller.id)) as Automation
  const busy = async (id: ConversationId) =>
    (await server.harness.snapshot(LiveDoc, id, context))?.run !== undefined
  const ledger = async () => (await server.harness.snapshot(Automations, context))!

  const deleted = await create('Deleted')
  const watcher = deleted.script!.conversationId
  await until(() => busy(watcher))
  await invoke('delete', { id: deleted.id })
  expect(await busy(watcher)).toBe(false)
  const ui = await server.harness.snapshot(UiState, ROOT_CONVERSATION_ID, context)
  expect(ui?.['ext.conversations.concluded']).toContain(watcher)
  expect(Object.values((await ledger()).automations).map((a) => a.name)).not.toContain('Deleted')

  const paused = await create('Paused')
  const pausedWatcher = paused.script!.conversationId
  await until(() => busy(pausedWatcher))
  await invoke('pause', { id: paused.id })
  expect(await busy(pausedWatcher)).toBe(false)
  const run = join(home, '.ultimate/automations/state', paused.id, 'run')
  await writeFile(run, '#!/bin/sh\nsleep 60\n', { mode: 0o700 })
  const conversation = (await server.harness.conversation(pausedWatcher, context))!
  await conversation.submit({ type: 'input', content: `Resume ${paused.id}` }, context)
  await until(async () =>
    (await conversation.context(context)).entries.some(
      (e) =>
        e.kind === 'pi.tool-result' &&
        JSON.stringify(e).includes('is stopped; only its owner resumes it'),
    ),
  )
  expect((await ledger()).automations[paused.id]).toMatchObject({
    enabled: false,
    script: { state: 'stopped' },
  })
})

it('aborts the watcher’s turn when an update changes the ask, and briefs it again without escalating', async () => {
  // Regression (PR #327): the watcher kept working on the old ask after an update.
  const home = await temp('ultimate-automations-reset-watcher-')
  homes.push(home)
  const definitions = join(home, '.ultimate/agents')
  await mkdir(definitions, { recursive: true })
  await mkdir(join(home, 'project'))
  await writeFile(
    join(definitions, 'watcher.md'),
    '---\nname: watcher\ndescription: Test\nmodel: faux/faux-1\ntools: [automation]\n---\nShort.\n',
  )
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: join(home, 'project'),
    userHome: home,
    home: join(home, 'state'),
  })
  servers.push(server)
  let firstBriefStarted = false
  let firstBriefAborted = false
  let secondBriefSeen = false
  const watcherTurn: FauxResponseFactory = (transcript, options, state, model) => {
    server.host.faux!.appendResponses([watcherTurn])
    const last = transcript.messages.at(-1)!
    const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
    if (text.includes('Watch target 2')) {
      secondBriefSeen = true
      return held(transcript, options, state, model)
    }
    firstBriefStarted = true
    return new Promise((_answer, fail) =>
      options?.signal?.addEventListener('abort', () => {
        firstBriefAborted = true
        fail(new Error('aborted'))
      }),
    )
  }
  server.host.faux!.setResponses([watcherTurn])
  const caller = await server.harness.createConversation(
    { ownership: { kind: 'ownerless' } },
    context,
  )
  const invoke = (action: string, args: JsonValue) =>
    server.extensions.invoke('automations', action, args, new AbortController().signal, caller.id)
  const created = (await invoke('create', { name: 'Watch', ask: 'Watch target 1' })) as Automation
  const watcher = created.script!.conversationId
  await until(() => firstBriefStarted)

  await invoke('update', { id: created.id, ask: 'Watch target 2' })
  await until(() => secondBriefSeen)
  expect(firstBriefAborted).toBe(true)
  expect(
    (await server.harness.snapshot(Automations, context))!.automations[created.id],
  ).toMatchObject({ enabled: true, script: { ask: 'Watch target 2', state: 'writing' } })
  const watcherEntries = (
    await (await server.harness.conversation(watcher, context))!.context(context)
  ).entries.filter((e) => e.conversationId === watcher)
  expect(watcherEntries.filter((e) => e.kind === 'automations.writing')).toHaveLength(2)
  expect(watcherEntries.filter((e) => e.kind === 'automations.escalated')).toHaveLength(0)
})

// A project extension outside the clone cannot import api.ts; the token is its name, which is all `want` needs.
const consumer = `
import { defineExtension } from '@earendil-works/pi-durable'
const Automations = { name: 'automations' }
export default () => defineExtension({ name: 'prs' })
export const actions = {
  call: async ({ method, id }, { host }) => {
    const automations = host.want(Automations)
    if (!automations) return 'missing'
    try { return await automations[method](id) } catch (error) { return String(error) }
  },
}`

it('lets a project extension read, pause and resume an automation through the service', async () => {
  const home = await temp('ultimate-automations-service-')
  homes.push(home)
  const projectRoot = join(home, 'project')
  const definitions = join(home, '.ultimate/agents')
  await mkdir(definitions, { recursive: true })
  await writeFile(
    join(definitions, 'watcher.md'),
    '---\nname: watcher\ndescription: Test\nmodel: faux/faux-1\ntools: []\n---\nShort.\n',
  )
  const folder = join(projectRoot, '.ultimate/extensions/prs')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'server.ts'), consumer)
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  servers.push(server)
  const caller = await server.harness.createConversation(
    { ownership: { kind: 'ownerless' } },
    context,
  )
  const sub = (await server.extensions.invoke(
    'automations',
    'create',
    { name: 'Watch', ask: 'Watch ship/* PRs', once: false },
    new AbortController().signal,
    caller.id,
  )) as Automation
  await until(() => !!server.extensions.action('prs', 'call'))
  const call = (method: string, id = sub.id) =>
    server.extensions.invoke('prs', 'call', { method, id }, new AbortController().signal)

  expect(await call('status')).toMatchObject({
    id: sub.id,
    alive: false,
    script: { state: 'writing' },
  })
  expect(await call('pause')).toMatchObject({
    id: sub.id,
    enabled: false,
    script: { state: 'stopped' },
  })
  // Resume checks the executable before it changes anything: the automation stays stopped.
  expect(await call('resume')).toContain('Missing or non-executable')
  expect(await call('status')).toMatchObject({ script: { state: 'stopped' } })
  expect(await call('status', 'A99')).toBe('Error: Unknown automation: A99')
  expect(await call('status', 'nope')).toBe('Error: Unknown automation: nope')
  expect(await call('status', 'Not/A slug')).toBe(
    'Error: id must be A<n> or a project automation slug',
  )
  expect(server.extensions.catalogue().apis.find((api) => api.name === 'automations')).toEqual({
    name: 'automations',
    provider: 'automations',
    needs: ['goal'],
    wants: ['prs'],
  })
})
