import { request } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve as resolvePath } from 'node:path'
import { applyImmutable } from '@earendil-works/chord/delta'
import type { Op } from '@earendil-works/chord/delta'
import type { ConversationId, ConversationView } from '@earendil-works/pi-durable'
import { InboxDoc, LiveDoc } from '@earendil-works/pi-durable'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { describe, expect, it, vi } from 'vitest'
import {
  fauxServer as createServer,
  prepareFauxServer as prepareServer,
  until,
  post,
  attach,
  held,
} from './helpers.ts'
import { context } from '../server/harness.ts'
import { UiState } from '../shared/ui-state.ts'
import { Metadata } from '../server/metadata.ts'
import type { ServerEvents } from '../shared/protocol.ts'
import { Logins } from '../extensions/models/server.ts'
import { fixture, orderedSource, servers } from './server-fixture.ts'
import { eventHost } from './helpers.ts'
import { writeSecret } from '../extensions/secrets/store.ts'
import { UserInputEvent } from '../shared/events.ts'

describe('server', () => {
  it('admits registered identities for API, SSE, actions and assets, then revokes on disposal and unload', async () => {
    const origin = 'https://rog.example.ts.net:5799'
    const { server, options } = await fixture(false, {
      access: `import { defineExtension } from '@earendil-works/pi-durable'

let remove
export default host => {
  remove = host.access.allow({ origin: '${origin}', verify: async ({ headers }) => headers['tailscale-user-login'] === 'owner' ? { login: 'owner' } : undefined })
  return defineExtension({ name: 'access' })
}
export const actions = { ping: async () => 'pong', revoke: async () => { remove(); return true } }`,
    })
    const wire = (
      path: string,
      login: string | null = 'owner',
      extra: Record<string, string> = {},
      method = 'GET',
    ) =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          server.url + path,
          {
            method,
            headers: {
              host: new URL(origin).host,
              origin,
              ...(login ? { 'tailscale-user-login': login } : {}),
              ...extra,
            },
          },
          (response) => {
            resolve(response.statusCode!)
            response.destroy()
          },
        )
        req.on('error', reject)
        req.end(method === 'POST' ? '{"args":null}' : undefined)
      })
    for (const path of ['/', '/api/models', '/api/events', '/api/extensions/access/actions/ping']) {
      const method = path.includes('actions') ? 'POST' : 'GET'
      expect(await wire(path, 'owner', {}, method)).toBe(200)
      expect(await wire(path, 'other', {}, method)).toBe(403)
      expect(await wire(path, null, {}, method)).toBe(403)
    }
    expect(await wire('/api/models', 'owner', { host: 'unknown.example:5799' })).toBe(403)
    expect(await wire('/api/models', 'owner', { origin: 'https://evil.example' })).toBe(403)
    expect((await fetch(server.url + '/api/models')).status).toBe(200)
    expect(
      await wire(
        '/api/extensions/access/actions/ping',
        'owner',
        { origin: '', 'sec-fetch-site': 'cross-site' },
        'POST',
      ),
    ).toBe(403)
    expect(
      await wire(
        '/api/extensions/access/actions/ping',
        'owner',
        { origin: '', 'sec-fetch-site': 'same-origin' },
        'POST',
      ),
    ).toBe(200)
    // An action call without `args` runs with empty args.
    expect(
      await (
        await fetch(server.url + '/api/extensions/access/actions/ping', {
          method: 'POST',
          headers: { origin: server.url },
          body: '{}',
        })
      ).json(),
    ).toEqual({ result: 'pong' })
    for (const forwarded of ['x-forwarded-for', 'x-forwarded-host', 'forwarded']) {
      for (const login of [null, 'other', 'owner']) {
        for (const originHeader of ['', server.url]) {
          const headers = { host: new URL(server.url).host, origin: originHeader, [forwarded]: '' }
          for (const path of ['/api/models', '/', '/api/extensions/access/actions/ping'])
            expect(
              await wire(path, login, headers, path.includes('actions') ? 'POST' : 'GET'),
            ).toBe(403)
        }
      }
    }
    for (const site of ['cross-site', 'same-site']) {
      const navigation = {
        origin: '',
        'sec-fetch-site': site,
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      }
      // A link may open only the UI root, with or without a query or exact Origin.
      expect(await wire('/', 'owner', navigation)).toBe(200)
      expect(await wire('/?conversation=1', 'owner', { ...navigation, origin })).toBe(200)
      expect(await wire('/', 'other', navigation)).toBe(403)
      expect(await wire('/', 'owner', { ...navigation, origin: 'https://evil.example' })).toBe(403)
      expect(await wire('/', 'owner', navigation, 'POST')).toBe(403)
      expect(await wire('/', 'owner', { ...navigation, 'sec-fetch-dest': 'iframe' })).toBe(403)
      expect(await wire('/', 'owner', { origin: '', 'sec-fetch-site': site })).toBe(403)
      // Navigation metadata cannot turn API, SSE, assets or other paths into documents.
      for (const path of ['/api/models', '/api/events', '/assets/index.js', '/other'])
        expect(await wire(path, 'owner', navigation)).toBe(403)
      expect(await wire('/api/extensions/access/actions/ping', 'owner', navigation, 'POST')).toBe(
        403,
      )
    }
    expect(await wire('/api/models', 'owner', { 'sec-fetch-site': 'none' })).toBe(200)
    await until(() => server.system.current().access.origins.includes(origin))
    expect(await wire('/api/extensions/access/actions/revoke', 'owner', {}, 'POST')).toBe(200)
    expect(await wire('/api/models')).toBe(403)
    for (const site of ['cross-site', 'same-site'])
      expect(
        await wire('/?conversation=1', 'owner', {
          'sec-fetch-site': site,
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
        }),
      ).toBe(403)
    // Reload the facet to create a new registration, then disable it.
    await writeFile(
      join(options.ultimateRoot, 'extensions/access/server.ts'),
      (await readFile(join(options.ultimateRoot, 'extensions/access/server.ts'), 'utf8')) + '\n',
    )
    await until(async () => (await wire('/api/models')) === 200)
    await writeFile(
      join(options.ultimateRoot, '.ultimate/settings.json'),
      '{"extensions":{"disable":["access"]}}',
    )
    await until(async () => (await wire('/api/models')) === 403)
  })
  it('revokes a deferred verifier in flight', async () => {
    const { server } = await fixture(false, {
      deferred: `import { defineExtension } from '@earendil-works/pi-durable'

let host, remove, resolve
export default h => { host=h; return defineExtension({ name: 'deferred' }) }
export const actions = {
arm: async () => { resolve=undefined; remove=host.access.allow({ origin:'https://remote.example:5799', verify: () => new Promise(r => { resolve=r }) }); return true },
waiting: async () => Boolean(resolve),
finish: async () => { remove(); resolve({login:'owner'}); return true }
}`,
    })
    await post(server, '/api/extensions/deferred/actions/arm', { args: null })
    const pending = new Promise<number>((resolve, reject) => {
      const req = request(
        server.url + '/api/models',
        { headers: { host: 'remote.example:5799' } },
        (res) => {
          resolve(res.statusCode!)
          res.destroy()
        },
      )
      req.on('error', reject)
      req.end()
    })
    await until(
      async () =>
        (await post(server, '/api/extensions/deferred/actions/waiting', { args: null })).data
          .result === true,
    )
    await post(server, '/api/extensions/deferred/actions/finish', { args: null })
    expect(await pending).toBe(403)
  })

  it('cleans up facet lifecycles on reload but retains reload-stable resource lifecycles until shutdown', async () => {
    const source = `import { defineExtension } from '@earendil-works/pi-durable'

import { writeFile } from 'node:fs/promises'
export let state
export default host => {
  state = host.resource('lifecycle.state', () => {
    const value = { opens: 0, closes: 0, facetsClosed: 0 }
    host.onOpen(async () => { value.opens++ })
    host.onClose(async () => { value.closes++; await writeFile(host.userHome + '/closed.json', JSON.stringify(value)) })
    return value
  })
  host.onClose(async () => { state.facetsClosed++ })
  return defineExtension({ name: 'lifecycle' })
}
export const actions = { state: async () => state }`
    const { server, options } = await fixture(false, { lifecycle: source })
    const path = join(options.ultimateRoot, 'extensions/lifecycle/server.ts')
    const initial = server.extensions.info().find((entry) => entry.name === 'lifecycle')!
      .server!.loadedAt
    await writeFile(path, source + '\n')
    await until(
      () =>
        server.extensions.info().find((entry) => entry.name === 'lifecycle')!.server!.loadedAt !==
        initial,
    )
    expect(
      (await post(server, '/api/extensions/lifecycle/actions/state', { args: null })).data.result,
    ).toEqual({ opens: 1, closes: 0, facetsClosed: 1 })
    servers.splice(servers.indexOf(server), 1)
    await server.close()
    expect(JSON.parse(await readFile(join(options.userHome, 'closed.json'), 'utf8'))).toEqual({
      opens: 1,
      closes: 1,
      facetsClosed: 2,
    })
  })

  it('ignores late notices from disposed facets without losing the replacement’s notices', async () => {
    const source = `import { defineExtension } from '@earendil-works/pi-durable'
export let raise
export default host => {
  raise = message => host.notice(message)
  return defineExtension({ name: 'late-notice' })
}`
    const { server, options } = await fixture(false, { 'late-notice': source })
    const path = join(options.ultimateRoot, 'extensions/late-notice/server.ts')
    const previous = (await server.vite.ssrLoadModule(path)).raise as (message: string) => void
    const initial = server.extensions.info().find((entry) => entry.name === 'late-notice')!
      .server!.loadedAt
    await writeFile(path, source + '\n')
    await until(
      () =>
        server.extensions.info().find((entry) => entry.name === 'late-notice')!.server!.loadedAt !==
        initial,
    )
    expect(() => previous('retired notice')).not.toThrow()
    const current = (await server.vite.ssrLoadModule(path)).raise as (message: string) => void
    current('current notice')
    expect(await server.extensions.info.diagnostics()).toContain('current notice')
    expect(await server.extensions.info.diagnostics()).not.toContain('retired notice')
    servers.splice(servers.indexOf(server), 1)
    await server.close()
    expect(() => current('shutdown notice')).not.toThrow()
  })

  it('clears a missing-secret notice from the diagnostics once the secret is saved', async () => {
    const { server, options } = await fixture(false, {
      'needs-key': `import { defineExtension } from '@earendil-works/pi-durable'
export default host => {
  host.notice('Missing MY_KEY', { untilSecretSet: 'MY_KEY' })
  return defineExtension({ name: 'needs-key' })
}`,
    })
    await until(() => server.system.current().extensionDiagnostics.includes('Missing MY_KEY'))
    expect(await server.extensions.info.diagnostics()).toContain('Missing MY_KEY')
    await writeSecret(options.userHome, 'MY_KEY', 'value')
    server.vite.watcher.emit('all', 'change', join(options.userHome, '.ultimate/secrets.json'))
    await until(() => !server.system.current().extensionDiagnostics.includes('Missing MY_KEY'))
    expect(await server.extensions.info.diagnostics()).not.toContain('Missing MY_KEY')
  })

  it('runs late facet openers immediately and continues after throwing cleanups', async () => {
    const { server } = await fixture(false, {
      cleanup: `import { defineExtension } from '@earendil-works/pi-durable'

import { writeFile } from 'node:fs/promises'
let host, opened=false
export default h => { host=h; h.onClose(async()=>{throw new Error('cleanup test failure')}); h.onClose(async()=>{await writeFile(h.userHome+'/cleanup-ok','yes')}); return defineExtension({name:'cleanup'}) }
export const actions={ late: async()=>{host.onOpen(async()=>{opened=true}); return true}, opened:async()=>opened }`,
    })
    const stream = await attach(server)
    await post(server, '/api/extensions/cleanup/actions/late', { args: null })
    await until(
      async () =>
        (await post(server, '/api/extensions/cleanup/actions/opened', { args: null })).data
          .result === true,
    )
    await server.extensions.close()
    expect(await readFile(join(server.host.userHome, 'cleanup-ok'), 'utf8')).toBe('yes')
    await until(() =>
      stream.events.some(
        (e) => e.name === 'notice' && JSON.stringify(e.data).includes('cleanup test failure'),
      ),
    )
    await stream.close()
  })

  it('commits release work, then closes the harness before extensions, so a task running at shutdown resumes instead of faulting', async () => {
    const { server, options } = await fixture(false, {
      teardown: `import { defineDoc, defineExtension, defineTask, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { awaitWithContext, BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { existsSync, writeFileSync } from 'node:fs'
import { defineApi } from '../../shared/extension-api.ts'
const Probe = defineApi()('probe')
let host, started = false
const gate = Promise.withResolvers()
const Task = defineTask({ name: 'teardown.task', version: 1, initial: () => ({ phase: 'run' }), phases: {
  run: async (_task, runtime, ctx) => {
    started = true
    if (!existsSync(host.userHome + '/closed')) await awaitWithContext(gate.promise, ctx)
    host.need(Probe).ping()
    await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), ctx)
  } },
  abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx) })
const Released = defineDoc({ kind: 'teardown.released', checkpointWhen: () => false, version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ at: 0 }) })
export const docs = [Released]
export default h => { host = h; h.implement(Probe, { ping: () => true }); h.onOpen(async (opened) => { opened.defer(() => h.harness().commit(async tx => { (await tx.doc(Released, ROOT_CONVERSATION_ID)).at = 1 }, BACKGROUND_CONTEXT)) }); h.onClose(async () => { writeFileSync(h.userHome + '/closed', ''); gate.resolve(); await new Promise(r => setImmediate(r)) }); return defineExtension({ name: 'teardown', tasks: [Task] }) }
export const actions = {
  start: async () => { await host.harness().commit(tx => tx.createTask(Task, null, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: 'conversation' }, background: true }), BACKGROUND_CONTEXT); return true },
  started: async () => started,
  released: async () => (await host.harness().snapshot(Released, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT))?.at }`,
    })
    await post(server, '/api/extensions/teardown/actions/start', { args: null })
    await until(
      async () =>
        (await post(server, '/api/extensions/teardown/actions/started', { args: null })).data
          .result === true,
    )
    servers.splice(servers.indexOf(server), 1)
    await server.close()
    const reopened = await createServer(options)
    servers.push(reopened)
    const task = async () =>
      (await reopened.harness.commit((tx) => tx.scanTasks({ kind: 'teardown.task' }, 10), context))
        .items[0]
    await until(async () => (await task()).state.status === 'terminal')
    expect((await task()).state).toMatchObject({ outcome: { status: 'completed' } })
    expect(
      (await post(reopened, '/api/extensions/teardown/actions/released', { args: null })).data
        .result,
    ).toBe(1)
  })

  it('settles failing process resource cleanups and still closes the server', async () => {
    const { server } = await fixture(false, {
      resourcecleanup: `import { defineExtension } from '@earendil-works/pi-durable'

import { writeFile } from 'node:fs/promises'
export default host => { host.resource('cleanup.process',()=>{
  host.onClose(()=>{throw new Error('sync process failure')})
  host.onClose(async()=>{throw new Error('async process failure')})
  host.onClose(async()=>{await writeFile(host.userHome+'/process-cleanup-ok','yes')})
  return {}
}); return defineExtension({name:'resourcecleanup'}) }`,
    })
    await expect(server.close()).resolves.toBeUndefined()
    servers.splice(servers.indexOf(server), 1)
    expect(server.http.listening).toBe(false)
    expect(await readFile(join(server.host.userHome, 'process-cleanup-ok'), 'utf8')).toBe('yes')
  })

  it('serves and completes a faux submit with an empty extensions directory', async () => {
    const { server } = await fixture(false, undefined, true)
    expect((await fetch(server.url)).status).toBe(200)
    expect(server.extensions.info()).toEqual([])
    server.host.faux!.setResponses([fauxAssistantMessage('Core-only response')])
    const submitted = await server.root.submit({ type: 'input', content: 'hello' }, context)
    await submitted.wait(context)
    await server.harness.waitForIdle(context)
    const view = await server.root.context(context)
    const messages = view.entries.flatMap((entry) => entry.model ?? [])
    expect(
      messages.some((message) => message.role === 'assistant' && message.stopReason === 'stop'),
    ).toBe(true)
    expect(messages.some((message) => message.role === 'toolResult')).toBe(false)
  })
  it('scans committed submissions newest first, filtered and paged', async () => {
    const { server } = await fixture(false, undefined, true)
    server.host.faux!.setResponses([fauxAssistantMessage('One'), fauxAssistantMessage('Two')])
    const ids = []
    for (const content of ['one', 'two']) {
      const submitted = await server.root.submit({ type: 'input', content }, context)
      await submitted.wait(context)
      ids.push(submitted.id)
    }
    const query = { conversationId: server.root.id, status: 'done', order: 'descending' } as const
    const first = await server.host.scanSubmissions(query, 1, undefined, context)
    expect(first.items.map((item) => item.id)).toEqual([ids[1]])
    const second = await server.host.scanSubmissions(query, 1, first.next, context)
    expect(second.items.map((item) => item.id)).toEqual([ids[0]])
    expect(second.next).toBeUndefined()
    expect(
      (await server.host.scanSubmissions({ ...query, status: 'queued' }, 10, undefined, context))
        .items,
    ).toEqual([])
    servers.splice(servers.indexOf(server), 1)
    await server.vite.watcher.close()
    await server.close()
    expect(() => server.host.scanSubmissions(query, 1, undefined, context)).toThrow(
      'Harness is not open',
    )
  })
  it('does not inherit the supervisor public URL in an embedded server', async () => {
    vi.stubEnv('ULTIMATE_PUBLIC_URL', 'http://127.0.0.1:1')
    try {
      const { server } = await fixture()
      expect(server.url).toBe(`http://127.0.0.1:${server.port}`)
      expect((await fetch(server.url)).status).toBe(200)
      expect(
        (await post(server, '/api/ui', { ops: [{ key: 'test.isolated', value: true }] })).status,
      ).toBe(200)
      expect(await server.host.uiState(context)).toEqual({ 'test.isolated': true, 'ui.rev': 1 })
      await (
        await server.root.submit({ type: 'input', content: 'self URL' }, context)
      ).wait(context)
      const view = await server.root.context(context)
      const system = view.entries.find((entry) => entry.kind === 'pi.system')?.model?.[0]
      expect(system?.role === 'system' ? system.sections?.environment : undefined).toContain(
        `UI: ${server.url}`,
      )
      await server.root.abort(context)
    } finally {
      vi.unstubAllEnvs()
    }
  })
  it('withdraws one queued input without aborting the current run or another conversation', async () => {
    const { server } = await fixture()
    server.host.faux!.setResponses([held, fauxAssistantMessage('Complete')])
    await post(server, '/api/conversations/1/submit', { text: 'start' })
    const run = (await server.harness.snapshot(LiveDoc, server.root.id, context))?.run?.taskId
    expect(run).toBeDefined()
    const queued = await post(server, '/api/conversations/1/submit', {
      text: 'queued input',
      whenBusy: 'followUp',
    })
    const submissionId = queued.data.submissionId
    if (typeof submissionId !== 'number') throw new Error('Expected submission id')
    const path = `/api/conversations/1/inbox/${submissionId}/cancel`
    expect((await post(server, `/api/conversations/999/inbox/${submissionId}/cancel`)).status).toBe(
      404,
    )
    expect((await post(server, path)).status).toBe(200)
    expect((await post(server, path)).status).toBe(200)
    expect((await server.harness.snapshot(InboxDoc, server.root.id, context))?.items).toEqual([])
    expect((await server.harness.snapshot(LiveDoc, server.root.id, context))?.run?.taskId).toBe(run)
    await server.root.abort(context)
    const completed = await server.root.submit({ type: 'input', content: 'complete' }, context)
    await completed.wait(context)
    expect((await post(server, `/api/conversations/1/inbox/${completed.id}/cancel`)).status).toBe(
      409,
    )
  })
  it('stops the run but keeps queued follow-ups, delivering them before the next input', async () => {
    const { server } = await fixture()
    server.host.faux!.setResponses([held, held])
    await post(server, '/api/conversations/1/submit', { text: 'start' })
    const run = (await server.harness.snapshot(LiveDoc, server.root.id, context))?.run?.taskId
    expect(run).toBeDefined()
    await post(server, '/api/conversations/1/submit', { text: 'queued', whenBusy: 'followUp' })
    expect((await post(server, '/api/conversations/1/abort')).status).toBe(200)
    expect((await server.harness.getTask(run!, context))?.state.status).toBe('terminal')
    expect((await server.harness.snapshot(LiveDoc, server.root.id, context))?.run).toBeUndefined()
    expect(
      (await server.harness.snapshot(InboxDoc, server.root.id, context))?.items.map(
        (item) => item.mode !== 'write' && item.content,
      ),
    ).toEqual(['queued'])
    await post(server, '/api/conversations/1/submit', { text: 'next' })
    expect((await server.harness.snapshot(InboxDoc, server.root.id, context))?.items).toEqual([])
    const view = await server.root.context(context)
    const users = view.entries.flatMap((entry) =>
      entry.model?.[0]?.role === 'user' ? [JSON.stringify(entry.model[0].content)] : [],
    )
    expect(users.slice(-3).map((text) => /start|queued|next/.exec(text)?.[0])).toEqual([
      'start',
      'queued',
      'next',
    ])
    await server.root.abort(context)
  })
  it('records each typed input as one user.input event with its device and never its text', async () => {
    const { server } = await fixture()
    server.host.faux!.setResponses([held])
    const submit = (text: string, whenBusy?: string) =>
      fetch(server.url + '/api/conversations/1/submit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: server.url,
          'User-Agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
        },
        body: JSON.stringify({ text, whenBusy }),
      }).then((response) => response.json() as Promise<{ submissionId: number }>)
    const first = await submit('a secret plan')
    const queued = await submit('later', 'followUp')
    const events = await eventHost(() => server.harness, 'test').eventLog.recent({
      events: [UserInputEvent],
      order: 'ascending',
    })
    const placed = (await server.harness.submission(first.submissionId as never, context))!
    expect(events.map((event) => event.data)).toEqual([
      {
        conversation: 1,
        kind: 'prompt',
        entry: (await placed.status(context)).entry,
        length: 13,
        device: 'phone safari',
      },
      {
        conversation: 1,
        kind: 'follow-up',
        submission: queued.submissionId,
        length: 5,
        device: 'phone safari',
      },
    ])
    expect(JSON.stringify(events)).not.toContain('secret')
    await server.root.abort(context)
  })
  it('orders live-added sections and tools deterministically across reopen', async () => {
    const { server, options } = await fixture(false, {
      a: orderedSource('a'),
      prompt: orderedSource('prompt', -100),
    })
    // This demo finishes without requiring the fixture to expose coding tools.
    await post(server, '/api/conversations/1/submit', { text: 'Return the word DONE.' })
    await server.harness.waitForIdle(context)
    const folder = join(options.ultimateRoot, 'extensions/0-new')
    await mkdir(folder)
    await writeFile(join(folder, 'server.ts'), orderedSource('0-new'))
    await until(() => !!server.extensions.info().find((item) => item.name === '0-new')?.server)
    expect(
      server.extensions.info().find((item) => item.name === '0-new')?.server?.error,
    ).toBeUndefined()
    await post(server, '/api/conversations/1/submit', { text: 'Return the word DONE.' })
    await server.harness.waitForIdle(context)
    const view = await server.root.context(context)
    const systems = view.entries.filter((entry) => entry.kind === 'pi.system')
    const message = systems.at(-1)!.model![0]
    expect(message.role).toBe('system')
    if (message.role !== 'system') throw new Error('Expected system message')
    expect(Object.keys(message.sections!)).toEqual(['prompt', 'new', 'a'])
    expect(message.toolsAdded!.map((tool) => tool.name)).toEqual(['prompt', 'new', 'a'])
    const lastId = systems.at(-1)!.id
    await server.vite.watcher.close()
    await server.close()
    servers.splice(servers.indexOf(server), 1)
    const reopened = await createServer(options)
    servers.push(reopened)
    await post(reopened, '/api/conversations/1/submit', { text: 'Return the word DONE.' })
    await reopened.harness.waitForIdle(context)
    const next = await reopened.root.context(context)
    expect(next.entries.filter((entry) => entry.kind === 'pi.system' && entry.id > lastId)).toEqual(
      [],
    )
  })

  it('shares root UI snapshots and set/delete deltas across conversations and reopen', async () => {
    const { server, options } = await fixture()
    const created = await post(server, '/api/conversations')
    const first = await attach(server)
    const second = await attach(server, { conversation: created.data.id as number })
    expect(
      await post(server, '/api/ui', {
        ops: [
          { key: 'shell.panel', value: 'tasks' },
          { key: 'app.count', value: 2 },
        ],
      }),
    ).toEqual({ status: 200, data: { ok: true, rev: 1 } })
    // The revision is the server's: a client cannot set or delete it.
    expect((await post(server, '/api/ui', { ops: [{ key: 'ui.rev', value: 9 }] })).status).toBe(400)
    expect((await post(server, '/api/ui', { ops: [{ key: 'ui.rev' }] })).status).toBe(400)
    await until(() => second.events.some((event) => event.name === 'uiOps'))
    let value = (second.events.find((event) => event.name === 'ui')!.data as ServerEvents['ui'])
      .value
    for (const event of second.events.filter((item) => item.name === 'uiOps'))
      value = applyImmutable(value, (event.data as ServerEvents['uiOps']).ops)
    expect(value).toEqual({ 'shell.panel': 'tasks', 'app.count': 2, 'ui.rev': 1 })
    const count = second.events.filter((event) => event.name === 'uiOps').length
    await post(server, '/api/ui', { ops: [{ key: 'app.count' }] })
    await until(() => second.events.filter((event) => event.name === 'uiOps').length > count)
    const deletion = second.events.filter((event) => event.name === 'uiOps').at(-1)!
    expect(applyImmutable(value, (deletion.data as ServerEvents['uiOps']).ops)).toEqual({
      'shell.panel': 'tasks',
      'ui.rev': 2,
    })
    await until(() => first.events.filter((event) => event.name === 'uiOps').length === 2)
    expect(await server.host.uiState(context)).toEqual({ 'shell.panel': 'tasks', 'ui.rev': 2 })
    const entry = await server.root.commit(
      async (tx) => tx.appendEntry(server.root.id, { kind: 'test.marker' }),
      context,
    )
    await post(server, '/api/ui', { ops: [{ key: 'shell.panel', value: 'settings' }] })
    const fork = await server.root.fork(entry.id, { ownership: { kind: 'ownerless' } }, context)
    expect(await server.harness.snapshot(UiState, fork.id, context)).toEqual({
      'shell.panel': 'tasks',
      'ui.rev': 2,
    })
    expect(await server.host.uiState(context)).toEqual({ 'shell.panel': 'settings', 'ui.rev': 3 })
    await post(server, '/api/ui', { ops: [{ key: 'shell.panel', value: 'tasks' }] })
    await first.close()
    await second.close()
    await server.vite.watcher.close()
    await server.close()
    servers.splice(servers.indexOf(server), 1)
    const reopened = await createServer(options)
    servers.push(reopened)
    const stream = await attach(reopened)
    expect(stream.events.find((event) => event.name === 'ui')!.data).toEqual({
      value: { 'shell.panel': 'tasks', 'ui.rev': 4 },
    })
    await stream.close()
  })

  it('validates UI keys and the merged document size atomically', async () => {
    const { server } = await fixture()
    for (const key of ['', 'bad key', 'x'.repeat(201)])
      expect((await post(server, '/api/ui', { ops: [{ key, value: true }] })).status).toBe(400)
    expect((await post(server, '/api/ui', { ops: [{ key: 4 }] })).status).toBe(400)
    expect((await post(server, '/api/ui', { ops: {} })).status).toBe(400)
    await post(server, '/api/ui', { ops: [{ key: 'large', value: 'x'.repeat(200000) }] })
    expect(
      (await post(server, '/api/ui', { ops: [{ key: 'extra', value: 'é'.repeat(40000) }] })).status,
    ).toBe(413)
    expect(await server.host.uiState(context)).toEqual({ large: 'x'.repeat(200000), 'ui.rev': 1 })
    await post(server, '/api/ui', {
      ops: [JSON.parse('{"key":"__proto__","value":{"safe":true}}'), { key: 'large' }],
    })
    expect(await server.host.uiState(context)).toEqual(
      JSON.parse('{"__proto__":{"safe":true},"ui.rev":2}'),
    )
  })

  it('prepares the core and listener without opening SQLite until go', async () => {
    const { options } = await fixture()
    const prepared = await prepareServer({ ...options, home: join(options.home, 'candidate') })
    try {
      expect((await fetch(prepared.url)).status).toBe(503)
      await expect(readFile(prepared.host.database)).rejects.toMatchObject({ code: 'ENOENT' })
      const opened = await prepared.go()
      expect(opened.root.id).toBe(1)
      expect((await readFile(prepared.host.database)).length).toBeGreaterThan(0)
    } finally {
      await prepared.close()
    }
  })
  it('streams a SQLite tool turn as ops that exactly replicate the committed view', async () => {
    const { server } = await fixture()
    const stream = await attach(server)
    expect(stream.events.slice(0, 6).map((event) => event.name)).toEqual([
      'stream',
      'system',
      'conversations',
      'ui',
      'tasks',
      'view',
    ])
    expect(await (await fetch(server.url)).text()).toContain('Ultimate server is running')
    const file = join(server.host.home, 'scratch.txt')
    server.host.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: `printf 'before\\n' > '${file}'` })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage(
        [fauxToolCall('edit', { path: file, edits: [{ oldText: 'before', newText: 'after' }] })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('## Complete'),
    ])
    const result = await post(server, '/api/conversations/1/submit', { text: 'edit the file' })
    expect(result.status).toBe(202)
    await server.harness.waitForIdle(context)
    const state = await server.root.watch(context)
    let replica!: ConversationView
    await until(() => {
      replica = stream.events.find((event) => event.name === 'view')!.data as ConversationView
      for (const event of stream.events)
        if (event.name === 'ops') replica = applyImmutable(replica, event.data as Op[])
      return JSON.stringify(replica) === JSON.stringify(state.value)
    })
    expect(replica).toEqual(state.value)
    await state.stop()
    expect(replica.entries.filter((entry) => entry.kind === 'pi.tool-result')).toHaveLength(2)
    expect(await readFile(file, 'utf8')).toBe('after\n')
    await stream.close()
  })
  it('persists image-only and mixed inputs and validates image requests', async () => {
    const { server, options } = await fixture()
    const image = { data: 'aGVsbG8=', mimeType: 'image/png' }
    server.host.faux!.setResponses([fauxAssistantMessage('Seen.')])
    expect(
      (await post(server, '/api/conversations/1/submit', { text: '', images: [image] })).status,
    ).toBe(202)
    await server.harness.waitForIdle(context)
    const entries = (await server.root.entries({}, 100, undefined, context)).items
    expect(entries.find((entry) => entry.kind === 'pi.user')?.model?.[0]).toMatchObject({
      content: [{ type: 'image', ...image }],
    })
    for (const images of [
      null,
      {},
      [{ ...image, mimeType: 'image/svg+xml' }],
      [{ ...image, data: 'not base64' }],
    ]) {
      expect((await post(server, '/api/conversations/1/submit', { text: '', images })).status).toBe(
        400,
      )
    }
    expect(
      (
        await post(server, '/api/conversations/1/submit', {
          text: '',
          images: Array.from({ length: 5 }, () => ({ ...image })),
        })
      ).status,
    ).toBe(413)
    expect(
      (
        await post(server, '/api/conversations/1/submit', {
          text: '',
          images: [{ ...image, data: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64') }],
        })
      ).status,
    ).toBe(413)
    expect(
      (await post(server, '/api/conversations/1/submit', { text: '', images: [] })).status,
    ).toBe(400)
    server.host.faux!.setResponses([fauxAssistantMessage('Seen again.')])
    expect(
      (await post(server, '/api/conversations/1/submit', { text: 'Look', images: [image] })).status,
    ).toBe(202)
    await server.harness.waitForIdle(context)
    expect(
      (await server.root.entries({}, 100, undefined, context)).items
        .filter((entry) => entry.kind === 'pi.user')
        .at(0)?.model?.[0],
    ).toMatchObject({
      content: [
        { type: 'text', text: 'Look' },
        { type: 'image', ...image },
      ],
    })
    await server.close()
    servers.splice(servers.indexOf(server), 1)
    const reopened = await createServer(options)
    servers.push(reopened)
    expect(
      (await reopened.root.entries({}, 100, undefined, context)).items.filter(
        (entry) => entry.kind === 'pi.user',
      ),
    ).toHaveLength(2)
    expect(
      (await reopened.root.entries({}, 100, undefined, context)).items.find(
        (entry) => entry.kind === 'pi.user',
      )?.model?.[0],
    ).toMatchObject({
      content: [
        { type: 'text', text: 'Look' },
        { type: 'image', ...image },
      ],
    })
  })
  it('queues images as steer and follow-up content while busy', async () => {
    const { server } = await fixture()
    const image = { data: 'aGVsbG8=', mimeType: 'image/png' }
    server.host.faux!.setResponses([held])
    await post(server, '/api/conversations/1/submit', { text: 'start' })
    expect((await server.harness.snapshot(LiveDoc, server.root.id, context))?.run).toBeDefined()
    for (const whenBusy of ['steer', 'followUp']) {
      expect(
        (
          await post(server, '/api/conversations/1/submit', {
            text: 'Look',
            images: [image],
            whenBusy,
          })
        ).status,
      ).toBe(202)
      const items = (await server.harness.snapshot(InboxDoc, server.root.id, context))?.items ?? []
      expect(items).toContainEqual(
        expect.objectContaining({
          mode: whenBusy,
          content: [
            { type: 'text', text: 'Look' },
            { type: 'image', ...image },
          ],
        }),
      )
    }
    await server.root.abort(context)
  })
  it('accepts configure, submit, steering, follow-up and abort; validates errors and creates conversations', async () => {
    const { server } = await fixture()
    // Pi's levels for this model: off, low, high.
    Object.assign(server.host.faux!.models[0], {
      reasoning: true,
      thinkingLevelMap: { minimal: null, medium: null },
    })
    const configure = async (data: Record<string, unknown>) => {
      const { status } = await post(server, '/api/conversations/1/configure', data)
      return { status, thinkingLevel: (await server.root.agent(context)).thinkingLevel }
    }
    expect(
      await configure({ model: { provider: 'faux', modelId: 'faux-1' }, thinkingLevel: 'high' }),
    ).toEqual({ status: 200, thinkingLevel: 'high' })
    for (const thinkingLevel of ['medium', 'max', 'bogus', 7])
      expect(await configure({ thinkingLevel })).toEqual({ status: 400, thinkingLevel: 'high' })
    // A new model keeps a supported level and clamps another as Pi does: medium becomes high, not low.
    await server.root.configure({ thinkingLevel: 'medium' }, context)
    expect(await configure({ model: { provider: 'faux', modelId: 'faux-1' } })).toEqual({
      status: 200,
      thinkingLevel: 'high',
    })
    expect(await configure({ thinkingLevel: 'low' })).toEqual({ status: 200, thinkingLevel: 'low' })
    expect((await post(server, '/api/conversations/1/submit', { text: 'start' })).status).toBe(202)
    expect(
      (await post(server, '/api/conversations/1/submit', { text: 'steer', whenBusy: 'steer' }))
        .status,
    ).toBe(202)
    expect(
      (
        await post(server, '/api/conversations/1/submit', {
          text: 'follow up',
          whenBusy: 'followUp',
        })
      ).status,
    ).toBe(202)
    expect((await post(server, '/api/conversations/1/abort')).status).toBe(200)
    await server.harness.waitForIdle(context)
    expect((await post(server, '/api/conversations/1/submit', { text: 7 })).status).toBe(400)
    expect((await post(server, '/api/conversations/999/abort')).status).toBe(404)
    const created = await post(server, '/api/conversations', {
      title: 'Another',
      cwd: server.host.projectRoot,
    })
    expect(created.status).toBe(201)
    const stream = await attach(server, { conversation: created.data.id as number })
    const summaries = stream.events.find((event) => event.name === 'conversations')!.data
    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: created.data.id, title: 'Another', busy: false }),
      ]),
    )
    await stream.close()
  })
  it('sends conversations and tasks once whole, then as ops that rebuild what a fresh stream gets', async () => {
    const { server } = await fixture()
    const stream = await attach(server)
    const created = (await post(server, '/api/conversations', { title: 'Another' })).data
      .id as ConversationId
    server.host.faux!.setResponses([held])
    await post(server, `/api/conversations/${created}/submit`, { text: 'work' })
    const busy = () => stream.conversations().find((item) => item.id === created)?.busy
    const running = () =>
      Object.values(stream.tasks().tasks).some((task) => task.conversationId === created)
    const sameAsFresh = async () => {
      const fresh = await attach(server)
      try {
        await until(
          () =>
            JSON.stringify(stream.conversations()) === JSON.stringify(fresh.conversations()) &&
            JSON.stringify(stream.tasks()) === JSON.stringify(fresh.tasks()),
        )
      } finally {
        await fresh.close()
      }
    }
    // While the turn runs: the task and the busy flag arrived as ops on the first stream.
    await until(() => busy() === true && running())
    await sameAsFresh()
    await post(server, `/api/conversations/${created}/abort`)
    await server.harness.waitForIdle(context)
    await until(() => busy() === false && !running())
    await sameAsFresh()
    const sent = (name: string) => stream.events.filter((event) => event.name === name).length
    expect([sent('conversations'), sent('tasks')]).toEqual([1, 1])
    expect(sent('conversationsOps')).toBeGreaterThan(0)
    expect(sent('tasksOps')).toBeGreaterThan(0)
    expect(stream.conversations()).toEqual(server.api.conversations())
    await stream.close()
  })
  it('refuses only the subscription whose document fails to open, and opens its siblings', async () => {
    const { server } = await fixture(true)
    const stream = await attach(server, { view: false })
    const { id } = stream.events.find((event) => event.name === 'stream')!.data as { id: string }
    const doc = server.extensions.doc.bind(server.extensions)
    vi.spyOn(server.extensions, 'doc').mockImplementation((kind) => {
      if (kind === 'test.counter') throw new Error('broken')
      return doc(kind)
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await fetch(`${server.url}/api/events/${id}`, {
      method: 'POST',
      headers: { Origin: server.url },
      body: JSON.stringify({
        subscribe: [
          { sub: 5, docs: ['test.counter'], view: false },
          { sub: 6, docs: [], view: true },
        ],
        unsubscribe: [],
      }),
    })
    expect({ status: response.status, data: await response.json() }).toEqual({
      status: 200,
      data: { ok: true, refused: { 5: 500 } },
    })
    await until(() => stream.events.some((event) => event.name === 'view' && event.sub === 6))

    // An invalid conversation or document list refuses only its own open.
    const mixed = await fetch(`${server.url}/api/events/${id}`, {
      method: 'POST',
      headers: { Origin: server.url },
      body: JSON.stringify({
        subscribe: [
          { sub: 10, conversation: 0, docs: [], view: true },
          { sub: 11, docs: [42], view: false },
          { sub: 12, docs: [], view: true },
        ],
        unsubscribe: [],
      }),
    })
    expect(await mixed.json()).toEqual({ ok: true, refused: { 10: 400, 11: 400 } })
    await until(() => stream.events.some((event) => event.name === 'view' && event.sub === 12))

    // A watch that fails to start is refused and stopped, so the same id can open later.
    const harness = server.harness
    const watchDoc = harness.watchDoc.bind(harness)
    const stopped = vi.fn<() => void>()
    const spy = vi.spyOn(harness, 'watchDoc').mockImplementationOnce(async (...args) => {
      const watch = (await watchDoc(...args))!
      const stop = watch.stop.bind(watch)
      return Object.assign(watch, {
        start: () => {
          throw new Error('cannot start')
        },
        stop: () => {
          stopped()
          return stop()
        },
      })
    })
    const open = () =>
      fetch(`${server.url}/api/events/${id}`, {
        method: 'POST',
        headers: { Origin: server.url },
        body: JSON.stringify({
          subscribe: [{ sub: 7, docs: ['pi.live'], view: false }],
          unsubscribe: [],
        }),
      }).then((answer) => answer.json())
    expect(await open()).toEqual({ ok: true, refused: { 7: 500 } })
    expect(stopped).toHaveBeenCalledOnce()
    spy.mockRestore()
    expect(await open()).toEqual({ ok: true, refused: {} })
    await until(() => stream.events.some((event) => event.name === 'doc' && event.sub === 7))
    await stream.close()
  })
  it('runs a subscribed read once for every page, pushes only changed answers, and stops with its last page', async () => {
    const { server } = await fixture(false, {
      probe: `import { defineExtension } from '@earendil-works/pi-durable'

let runs = 0
let ticks = 0
let value = 'one'
export default defineExtension({ name: 'probe' })
export const actions = {
  value: async (args) => {
    if (args?.fail) throw new Error('probe failed')
    runs++
    return value
  },
  tick: async () => ++ticks,
  set: async (args) => { value = args.value; return value },
  runs: async () => runs,
}`,
    })
    const first = await attach(server, { view: false })
    const second = await attach(server, { view: false })
    const streamId = (stream: typeof first) =>
      (stream.events.find((event) => event.name === 'stream')!.data as { id: string }).id
    await until(() => first.events.some((e) => e.name === 'stream'))
    await until(() => second.events.some((e) => e.name === 'stream'))
    const subscribe = (
      stream: typeof first,
      body: object,
      headers: object = { Origin: server.url },
    ) =>
      fetch(`${server.url}/api/events/${streamId(stream)}`, {
        method: 'POST',
        headers: headers as Record<string, string>,
        body: JSON.stringify({ subscribe: [], unsubscribe: [], ...body }),
      }).then((answer) => answer.json())
    const read = { extension: 'probe', action: 'value', args: null }
    const answers = (stream: typeof first, sub: number) =>
      stream.events.filter((event) => event.name === 'read' && event.sub === sub).map((e) => e.data)
    const runs = async () =>
      (await post(server, '/api/extensions/probe/actions/runs', { args: null })).data
        .result as number

    expect(await subscribe(first, { subscribe: [{ sub: 1, read, every: 250 }] })).toEqual({
      ok: true,
      refused: {},
    })
    await until(() => answers(first, 1).length === 1)
    expect(await subscribe(second, { subscribe: [{ sub: 1, read, every: 250 }] })).toEqual({
      ok: true,
      refused: {},
    })
    await until(() => answers(second, 1).length === 1)
    expect(server.api.reads()).toBe(1)
    expect([answers(first, 1), answers(second, 1)]).toEqual([
      [{ result: 'one' }],
      [{ result: 'one' }],
    ])

    await post(server, '/api/extensions/probe/actions/set', { args: { value: 'two' } })
    await until(() => answers(first, 1).length === 2 && answers(second, 1).length === 2)
    expect(answers(first, 1).at(-1)).toEqual({ result: 'two' })

    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(
      await subscribe(first, {
        subscribe: [
          { sub: 2, read: { ...read, args: { fail: true } } },
          { sub: 3, read: { extension: 'probe', action: 'missing', args: null } },
        ],
      }),
    ).toEqual({ ok: true, refused: {} })
    await until(() => answers(first, 2).length === 1 && answers(first, 3).length === 1)
    expect(answers(first, 2)).toEqual([{ error: 'probe failed', status: 500 }])
    expect(answers(first, 3)).toEqual([{ error: 'Unknown extension action', status: 404 }])

    expect(await subscribe(second, { subscribe: [{ sub: 5, read }] }, {})).toEqual({
      ok: true,
      refused: {},
    })
    await until(() => answers(second, 5).length === 1)
    expect(answers(second, 5)).toEqual([
      { error: 'Extension actions require a browser request', status: 403 },
    ])

    expect(server.api.reads()).toBe(3)
    await subscribe(first, { unsubscribe: [2, 3] })
    expect(server.api.reads()).toBe(1)
    await subscribe(second, { unsubscribe: [1, 5] })
    await second.close()
    expect(server.api.reads()).toBe(1)
    await first.close()
    await until(() => server.api.reads() === 0)
    const stopped = await runs()
    const third = await attach(server, { view: false })
    await until(() => third.events.some((e) => e.name === 'stream'))
    const tick = { extension: 'probe', action: 'tick', args: null }
    await subscribe(third, { subscribe: [{ sub: 6, read: tick, every: 250 }] })
    await until(() => answers(third, 6).length >= 3)
    expect(await runs()).toBe(stopped)
    await third.close()
  })
  it('serves published titles and activity to clients and server facets without deriving entries', async () => {
    const { server } = await fixture(false, {
      summaries: `import { defineExtension } from '@earendil-works/pi-durable'

export default defineExtension({ name: 'summaries' })
export const actions = { list: async (_args, ctx) => ctx.host.conversations() }`,
    })
    const created = (await post(server, '/api/conversations')).data.id as ConversationId
    const summary = () => server.api.conversations().find((item) => item.id === created)
    const stream = await attach(server)
    await post(server, `/api/conversations/${created}/submit`, { text: 'Not a core-derived title' })
    await server.harness.waitForIdle(context)
    expect(summary()).not.toHaveProperty('inputAt')
    expect(summary()).not.toHaveProperty('answerAt')
    expect(summary()).not.toHaveProperty('title')
    await server.harness.commit(async (tx) => {
      Object.assign(await tx.doc(Metadata, created), {
        inputTitle: 'Published input title',
        inputAt: 1000,
        answerAt: 2000,
      })
    }, context)
    await until(() => summary()?.answerAt === 2000)
    expect(summary()).toMatchObject({
      title: 'Published input title',
      inputAt: 1000,
      answerAt: 2000,
    })
    await until(() =>
      stream.conversations().some((item) => item.id === created && item.answerAt === 2000),
    )
    expect(
      (await post(server, '/api/extensions/summaries/actions/list', { args: null })).data.result,
    ).toEqual(server.api.conversations())
    await server.harness.commit(async (tx) => {
      ;(await tx.doc(Metadata, created)).title = 'Explicit title'
    }, context)
    await until(() => summary()?.title === 'Explicit title')
    const conversation = (await server.harness.conversation(created, context))!
    await conversation.reset(undefined, context)
    await server.harness.waitForIdle(context)
    expect(summary()).toMatchObject({ title: 'Explicit title', inputAt: 1000, answerAt: 2000 })
    await stream.close()
  })
  it('streams extension document snapshots and deltas, with a notice for unknown kinds', async () => {
    const { server } = await fixture(true)
    const stream = await attach(server, { docs: ['test.counter', 'missing'] })
    await until(() => stream.events.some((event) => event.name === 'doc'))
    expect(stream.events.find((event) => event.name === 'doc')!.data).toEqual({
      kind: 'test.counter',
      value: { count: 0 },
    })
    expect(stream.events.find((event) => event.name === 'notice')!.data).toEqual(
      expect.objectContaining({ message: 'Unknown extension document: missing' }),
    )
    server.host.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall('increment', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Incremented'),
    ])
    await post(server, '/api/conversations/1/submit', { text: 'increment' })
    await server.harness.waitForIdle(context)
    await until(() => stream.events.some((event) => event.name === 'docOps'))
    let value = { count: 0 }
    for (const event of stream.events)
      if (event.name === 'docOps') value = applyImmutable(value, (event.data as { ops: Op[] }).ops)
    expect(value).toEqual({ count: 1 })
    await stream.close()
  })
  it("streams a conversation's pi.live alone, without its view", async () => {
    const { server } = await fixture(true)
    const stream = await attach(server, { docs: ['pi.live'], view: false })
    await until(() => stream.events.some((event) => event.name === 'doc'))
    expect(stream.events.some((event) => event.name === 'view')).toBe(false)
    expect(stream.events.some((event) => event.name === 'notice')).toBe(false)
    server.host.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall('increment', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Incremented'),
    ])
    await post(server, '/api/conversations/1/submit', { text: 'increment' })
    await server.harness.waitForIdle(context)
    // The run started and ended in pi.live.
    await until(() => stream.events.filter((event) => event.name === 'docOps').length > 1)
    expect(stream.events.some((event) => event.name === 'view')).toBe(false)
    await stream.close()
  })
  it('carries subscriptions opened and closed on one stream in batches, each event tagged with its id', async () => {
    const { server } = await fixture(true)
    const stream = await attach(server, { docs: ['test.counter'] })
    const { id } = stream.events.find((event) => event.name === 'stream')!.data as { id: string }
    const batch = (
      subscribe: { sub: number; conversation?: number; docs?: string[]; view?: boolean }[],
      unsubscribe: number[] = [],
      streamId = id,
    ) =>
      fetch(`${server.url}/api/events/${streamId}`, {
        method: 'POST',
        headers: { Origin: server.url },
        body: JSON.stringify({ subscribe, unsubscribe }),
      }).then(async (response) => ({ status: response.status, data: await response.json() }))
    const docs = { docs: ['test.counter'], view: false }
    // One request opens several; a refused one fails alone.
    expect(
      await batch([
        { sub: 5, ...docs },
        { sub: 6, ...docs },
        { sub: 8, conversation: 999 },
      ]),
    ).toEqual({ status: 200, data: { ok: true, refused: { 8: 404 } } })
    expect((await batch([], [6])).status).toBe(200)
    // A close that overtakes its open wins, once: the open consumes it, and a resent close of a closed one is harmless.
    expect((await batch([], [7])).status).toBe(200)
    expect((await batch([{ sub: 7, ...docs }])).status).toBe(200)
    expect((await batch([], [6])).status).toBe(200)
    expect((await batch([{ sub: 9, ...docs }], [9])).status).toBe(200)
    const invalid = await fetch(`${server.url}/api/events/${id}`, {
      method: 'POST',
      headers: { Origin: server.url },
      body: JSON.stringify({ subscribe: [null], unsubscribe: [] }),
    })
    expect(invalid.status).toBe(400)
    expect((await batch([], [1], crypto.randomUUID())).status).toBe(410)
    const of = (name: string) =>
      stream.events.filter((event) => event.name === name).map((event) => event.sub)
    await until(() => of('doc').length === 3)
    expect(of('doc')).toEqual([0, 5, 6])
    expect(of('view')).toEqual([0])
    server.host.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall('increment', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Incremented'),
    ])
    await post(server, '/api/conversations/1/submit', { text: 'increment' })
    await server.harness.waitForIdle(context)
    await until(() => of('docOps').length === 2)
    expect(of('docOps')).toEqual([0, 5])
    // Closing the stream ends it with all its subscriptions.
    await stream.close()
    await until(async () => (await batch([], [5])).status === 410)
  })
  it('ends a stream whose closes of never-opened subscriptions pile up, so it starts over clean', async () => {
    const { server } = await fixture(true)
    const stream = await attach(server, { view: false })
    const { id } = stream.events.find((event) => event.name === 'stream')!.data as { id: string }
    const close = (subs: number[]) =>
      fetch(`${server.url}/api/events/${id}`, {
        method: 'POST',
        headers: { Origin: server.url },
        body: JSON.stringify({ subscribe: [], unsubscribe: subs }),
      }).then((response) => response.status)
    const range = (from: number) => Array.from({ length: 500 }, (_, index) => from + index)
    expect(await close(range(100))).toBe(200)
    expect(await close(range(600))).toBe(200)
    expect(await close(range(1100))).toBe(410)
    await until(() => stream.connections() > 1)
    await stream.close()
  })
  it('runs logins in the models extension: prompt, answer, cancel, no credential leak, dead flows cancelled', async () => {
    const { server, options } = await fixture(false, {
      models: `export { default, actions, docs, userActions } from ${JSON.stringify(resolvePath('extensions/models/server.ts'))}`,
    })
    vi.spyOn(server.host.modelRuntime, 'getProvider').mockReturnValue({
      id: 'stub',
      auth: {
        apiKey: { name: 'Stub', login: async () => ({ key: '' }), resolve: async () => undefined },
      },
    } as unknown as ReturnType<typeof server.host.modelRuntime.getProvider>)
    let answered = ''
    vi.spyOn(server.host.modelRuntime, 'login').mockImplementation(
      async (_provider, _type, interaction) => {
        interaction.notify({ type: 'info', message: 'Stub login' })
        answered = await interaction.prompt({ type: 'secret', message: 'Enter key' })
        return { type: 'api_key', key: answered }
      },
    )
    const stream = await attach(server, { docs: ['models.login'] })
    const action = (name: string, args: unknown, conversationId = 1) =>
      post(server, `/api/extensions/models/actions/${name}`, { args, conversationId })
    const flows = async () =>
      (await server.harness.snapshot(Logins, 1 as ConversationId, context))?.flows ?? {}
    const login = async (conversationId = 1) => {
      const response = await action('login', { provider: 'stub', type: 'api_key' }, conversationId)
      expect(response.status).toBe(200)
      const flowId = String(response.data.result.flowId)
      await until(async () => (await flows())[flowId]?.prompt?.type === 'secret')
      return flowId
    }
    const first = await login()
    expect((await action('answer', { flowId: first, value: 'not-a-real-credential' })).status).toBe(
      200,
    )
    await until(async () => (await flows())[first].status === 'complete')
    expect(answered).toBe('not-a-real-credential')
    expect((await flows())[first]).toEqual({
      provider: 'stub',
      type: 'api_key',
      status: 'complete',
      events: [{ type: 'info', message: 'Stub login' }],
    })
    const blank = await login()
    expect((await action('answer', { flowId: blank, value: '' })).status).toBe(200)
    await until(async () => (await flows())[blank].status === 'complete')
    expect(answered).toBe('')
    // Logins are machine-wide: a flow started from any conversation lives on the root.
    const other = Number((await post(server, '/api/conversations', {})).data.id)
    const second = await login(other)
    expect((await action('cancel', { flowId: second })).status).toBe(200)
    await until(async () => (await flows())[second].status === 'cancel')
    expect((await flows())[second].prompt).toBeUndefined()
    expect((await action('answer', { flowId: second, value: 'late-credential' })).data).toEqual({
      error: 'Unknown login flow',
    })
    // The call trace records answers, accepted or rejected, without their credentials.
    const answers = server.extensions.trace
      .query({ limit: 1000 })
      .filter((row) => row.name === 'models/answer')
    expect(answers.map(({ ok, args, result, error }) => ({ ok, args, result, error }))).toEqual([
      { ok: true, args: undefined, result: undefined, error: undefined },
      { ok: true, args: undefined, result: undefined, error: undefined },
      { ok: false, args: undefined, result: undefined, error: 'Error' },
    ])
    const trace = JSON.stringify(server.extensions.trace.query({ limit: 1000 }))
    expect(trace).not.toContain('not-a-real-credential')
    expect(trace).not.toContain('late-credential')
    expect(
      stream.events.some(
        (event) =>
          event.name === 'docOps' && (event.data as ServerEvents['docOps']).kind === 'models.login',
      ),
    ).toBe(true)
    expect(JSON.stringify(stream.events)).not.toContain('not-a-real-credential')
    expect(JSON.stringify(await flows())).not.toContain('not-a-real-credential')
    await stream.close()
    // A flow that dies with its process reads cancelled on the next start.
    await server.harness.commit(async (tx) => {
      ;(await tx.doc(Logins, 1 as ConversationId)).flows.dead = {
        provider: 'stub',
        type: 'api_key',
        status: 'running',
        prompt: { type: 'secret', message: 'Enter key' },
        events: [],
      }
    }, context)
    await server.vite.watcher.close()
    await server.close()
    servers.splice(servers.indexOf(server), 1)
    const reopened = await createServer(options)
    servers.push(reopened)
    expect(
      (await reopened.harness.snapshot(Logins, 1 as ConversationId, context))?.flows.dead,
    ).toEqual({ provider: 'stub', type: 'api_key', status: 'cancel', events: [] })
  })
})
