import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  fauxAssistantMessage,
  fauxToolCall,
  fauxProvider,
} from '@earendil-works/pi-ai/providers/faux'
import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import type { ConversationId, ToolExecutionResult } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import {
  copyApis,
  eventHost,
  fauxServer as createServer,
  until,
  temp,
  removeTemp,
  linkDependencies,
  post,
} from './helpers.ts'
import { context } from '../server/harness.ts'
import { FIRST_CHAPTER, requestChapter } from '../lib/chapters.ts'
import { Store, SummaryDoc } from '../extensions/codemode/server.ts'
import { Summarized } from '../extensions/codemode/refs.ts'
import planExtension from '../extensions/plan/server.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { Metadata } from '../server/metadata.ts'
import type { CallTree } from '../server/trace.ts'

const servers: Awaited<ReturnType<typeof createServer>>[] = []
const directories: string[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.vite.watcher.close()
    await server.close()
  }
  for (const directory of directories.splice(0)) await removeTemp(directory)
})
async function fixture() {
  const directory = await temp('ultimate-codemode-')
  directories.push(directory)
  const ultimateRoot = join(directory, 'repo')
  await mkdir(join(ultimateRoot, 'extensions/codemode'), { recursive: true })
  await cp(resolve('extensions/coding-tools'), join(ultimateRoot, 'extensions/coding-tools'), {
    recursive: true,
  })
  await copyApis(ultimateRoot)
  await mkdir(join(ultimateRoot, 'web'), { recursive: true })
  await linkDependencies(ultimateRoot)
  await writeFile(
    join(ultimateRoot, 'vite.config.ts'),
    "import { defineConfig } from 'vite-plus'; export default defineConfig({ root: 'web', cacheDir: '.vite-cache', optimizeDeps: { noDiscovery: true } })",
  )
  await writeFile(join(ultimateRoot, 'web/index.html'), '<html>Codemode</html>')
  // The copy reaches the definitions module in the checkout, as `ultimate.agents()` reads them through it.
  await writeFile(
    join(ultimateRoot, 'extensions/codemode/server.ts'),
    (await readFile(resolve('extensions/codemode/server.ts'), 'utf8'))
      .replace("'../../lib/agents.ts'", JSON.stringify(resolve('lib/agents.ts')))
      .replace("'../../lib/api-files.ts'", JSON.stringify(resolve('lib/api-files.ts'))),
  )
  for (const file of ['api.ts', 'chapters.ts', 'projects.ts', 'refs.ts', 'summary.ts'])
    await cp(resolve('extensions/codemode', file), join(ultimateRoot, 'extensions/codemode', file))
  const options = {
    ultimateRoot,
    projectRoot: ultimateRoot,
    userHome: directory,
    home: join(directory, 'home'),
    faux: fauxProvider(),
    port: 0,
  }
  const server = await createServer(options)
  servers.push(server)
  expect(
    server.extensions.info().find((extension) => extension.name === 'codemode')?.server?.error,
  ).toBeUndefined()
  // A file for scripts to read.
  await writeFile(join(server.host.home, 'scratch.txt'), 'before\n')
  return { server, options }
}
it('reads an inactive chapter through the sandbox and rejects project with chapter', async () => {
  const { server, options } = await fixture()
  await server.harness.commit(async (tx) => {
    await tx.appendEntry(server.root.id, {
      kind: 'chapter.note',
      data: { text: 'closed-chapter-needle' },
    })
  }, context)
  const long = (
    (
      await post(server, '/api/conversations', {
        title: `Closed chapter work ${'with a long prompt '.repeat(400)}`,
      })
    ).data as { id: number }
  ).id
  const live = (await server.root.entries({}, 100, undefined, context)).items.filter(
    (entry) => entry.kind === 'chapter.note',
  )
  await server.vite.watcher.close()
  await server.close()
  servers.splice(servers.indexOf(server), 1)
  await requestChapter(options.home, 'next')
  const next = await createServer(options)
  servers.push(next)
  const result = await run(
    next,
    `return {
    entries: await ultimate.entries(${server.root.id}, { chapter: '${FIRST_CHAPTER}', kinds: ['chapter.note'] }),
    search: await ultimate.search('closed-chapter-needle', { chapter: '${FIRST_CHAPTER}', limit: 1 }),
    conversations: await ultimate.conversations({ chapter: '${FIRST_CHAPTER}' })
  };`,
  )
  expect(result.data.isError).not.toBe(true)
  expect(result.data.details.value).toMatchObject({
    entries: live,
    search: live,
    conversations: expect.arrayContaining([
      expect.objectContaining({ id: server.root.id }),
      expect.objectContaining({
        id: long,
        title: expect.stringMatching(/^Closed chapter work with a long prompt .*…$/),
      }),
    ]),
  })
  const { conversations } = result.data.details.value as {
    conversations: { id: number; title: string }[]
  }
  expect(conversations.find((item) => item.id === long)!.title.length).toBeLessThanOrEqual(60)
  const conflict = await run(
    next,
    `return await ultimate.entries(1, { project: 'anything', chapter: '${FIRST_CHAPTER}' });`,
  )
  expect(conflict.data.details.error).toContain('chapter and project cannot be used together')
})

it('keeps codemode guidance without repeating top-level tool schemas', async () => {
  const { server } = await fixture()
  const agent = await server.root.agent(context)
  const extension = server.host.registry.snapshot().extension('codemode')!
  const section = extension.sections![0]
  const text = await section.render(
    { conversationId: server.root.id, agent } as Parameters<typeof section.render>[0],
    context,
  )
  expect(text).toContain('Use edit/write outside codemode')
  expect(text).toContain('filter to concise findings')
  expect(text).toContain('top-level tool schemas and rules')
  expect(text).toContain(
    'Discover extension contracts with ultimate.apis() and read one with ultimate.api(name); act on them through ultimate.action.',
  )
  expect(text).toContain('Available: read, write, edit, bash')
  expect(text).not.toContain('declare const tools')
  const withRestart = await section.render(
    {
      conversationId: server.root.id,
      agent: { ...agent, tools: [...agent.tools, { ...agent.tools[0], name: 'restart' }] },
    } as unknown as Parameters<typeof section.render>[0],
    context,
  )
  expect(withRestart).toContain('Call restart only at top level')
  expect(withRestart?.split('Available: ')[1].split(', ')).not.toContain('restart')
  const tool = agent.tools.find((item) => item.name === 'codemode')!
  expect(tool.description).toContain('store(key,value)/load(key)')
  expect(tool.description).toContain('yielded wait discards them')
  expect(tool.description).toContain('already in scope (never redeclare them)')
  expect(tool.description).toContain('setTimeout and setInterval are undefined')
  expect(tool.description).toContain('declare const ultimate')
})

async function run(
  server: Awaited<ReturnType<typeof createServer>>,
  code: string,
  prompt = 'run codemode',
) {
  server.host.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall('codemode', { code })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Complete'),
  ])
  await server.root.submit({ type: 'input', content: prompt }, context)
  await server.harness.waitForIdle(context)
  const state = await server.root.viewState(context)
  try {
    const entry = state.value.entries.findLast((item) => item.kind === 'pi.tool-result')!
    return {
      text: JSON.stringify(entry.model?.[0]?.role === 'toolResult' ? entry.model[0].content : []),
      data: entry.model![0] as unknown as {
        details: {
          calls: { name: string; status: string; ms: number }[]
          value?: unknown
          error?: string
          yielded?: boolean
          pendingSubagents?: { conversationId: number; background?: boolean }[]
          subagentAnswers?: number[]
        }
        isError: boolean
      },
    }
  } finally {
    state.dispose()
  }
}

/** Kind, caller and name of each call in a trace tree, nested like it. */
const shape = (calls: CallTree[]): unknown[] =>
  calls.map((call) => [call.kind, call.caller, call.name, shape(call.children)])

it('traces a tool a codemode script calls, and its service call, inside the codemode call', async () => {
  const { server, options } = await fixture()
  const token = `import { defineApi } from ${JSON.stringify(resolve('shared/extension-api.ts'))}
    const Echo = defineApi()('trace-echo')`
  for (const [name, source] of [
    [
      'trace-echo',
      `${token}
      export default (host) => {
        host.implement(Echo, { echo: (text) => text })
        return { name: 'trace-echo' }
      }`,
    ],
    [
      'trace-probe',
      `import { defineTool } from '@earendil-works/pi-durable'
      import { Type } from '@earendil-works/pi-ai'
      ${token}
      export default (host) => {
        const echo = host.need(Echo)
        return { name: 'trace-probe', tools: [defineTool({
          name: 'probe',
          description: 'Echoes through a service',
          parameters: Type.Object({}),
          execute: async () => ({ output: [{ type: 'text', text: echo.echo('probed') }] }),
        }), defineTool({
          name: 'outer',
          description: 'Runs a codemode script as a Pi nested call',
          parameters: Type.Object({}),
          execute: async (_args, api, ctx) => {
            const result = await api.executeTool('codemode', { code: 'return await tools.probe({})' }, ctx)
            return { output: [{ type: 'text', text: JSON.stringify(result.details?.value ?? result) }] }
          },
        })] }
      }`,
    ],
  ]) {
    await mkdir(join(options.ultimateRoot, 'extensions', name))
    await writeFile(join(options.ultimateRoot, 'extensions', name, 'server.ts'), source)
  }
  await until(async () =>
    (await server.root.agent(context)).tools.some((tool) => tool.name === 'probe'),
  )
  expect((await run(server, `return await tools.probe({});`)).data.details.value).toBe('probed')
  const echo = server.extensions.trace.query().find((row) => row.name === 'trace-echo.echo')!
  expect(shape(server.extensions.trace.tree(echo.trace))).toEqual([
    [
      'tool',
      'agent',
      'codemode',
      [['tool', 'codemode', 'probe', [['service', 'trace-probe', 'trace-echo.echo', []]]]],
    ],
  ])

  // A model call runs codemode as a Pi nested task, which calls probe in-process: one chain of immediate parents.
  server.host.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall('outer', {})], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Complete'),
  ])
  await server.root.submit({ type: 'input', content: 'run outer' }, context)
  await server.harness.waitForIdle(context)
  const outer = server.extensions.trace.query().find((row) => row.name === 'outer')!
  expect(shape(server.extensions.trace.tree(outer.trace))).toEqual([
    [
      'tool',
      'agent',
      'outer',
      [
        [
          'tool',
          'trace-probe',
          'codemode',
          [['tool', 'codemode', 'probe', [['service', 'trace-probe', 'trace-echo.echo', []]]]],
        ],
      ],
    ],
  ])
})

it('calls extension actions with caller context and rejects missing or disabled actions', async () => {
  const { server, options } = await fixture()
  const path = join(options.ultimateRoot, 'extensions/action-test')
  await mkdir(path)
  await writeFile(
    join(path, 'server.ts'),
    `import { defineExtension } from '@earendil-works/pi-durable';
    export default defineExtension({ name: 'action-test' });
    export const actions = {
      echo: async (args, ctx) => ({ args, conversationId: ctx.conversationId, signal: ctx.signal instanceof AbortSignal }),
      fail: async () => { throw new Error('Action failed'); },
    };`,
  )
  await until(() => !!server.extensions.action('action-test', 'echo'))
  const result = await run(
    server,
    `return await ultimate.action('action-test', 'echo', { value: 42 });`,
  )
  expect(result.data.details.value).toEqual({
    args: { value: 42 },
    conversationId: server.root.id,
    signal: true,
  })
  // The call trace shows the action as the agent's, inside the codemode tool call that made it.
  const traced = await run(
    server,
    `const calls = await ultimate.trace({ conversation: ${server.root.id} });
    const action = calls.findLast((call) => call.name === 'action-test/echo');
    const [tool] = await ultimate.traceTree(action.trace);
    return { action, tool: [tool.kind, tool.name, tool.children.map((call) => call.name)] };`,
  )
  expect(traced.data.details.value).toMatchObject({
    action: { kind: 'action', caller: 'agent', ok: true, args: '{"value":42}' },
    tool: ['tool', 'codemode', ['action-test/echo']],
  })
  const defaults = await run(server, `return await ultimate.action('action-test', 'echo');`)
  expect(defaults.data.details.value).toMatchObject({ args: null })
  for (const [extension, action, error] of [
    ['missing', 'echo', 'Unknown extension action: missing/echo'],
    ['action-test', 'missing', 'Unknown extension action: action-test/missing'],
    ['action-test', 'toString', 'Unknown extension action: action-test/toString'],
    ['action-test', 'fail', 'Action failed'],
  ]) {
    const failed = await run(server, `return await ultimate.action('${extension}', '${action}');`)
    expect(failed.data.isError).toBe(true)
    expect(failed.text).toContain(error)
  }
  await mkdir(join(options.userHome, '.ultimate'), { recursive: true })
  await writeFile(
    join(options.userHome, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { disable: ['action-test'] } }),
  )
  await until(() => !server.extensions.action('action-test', 'echo'))
  const disabled = await run(server, `return await ultimate.action('action-test', 'echo');`)
  expect(disabled.data.isError).toBe(true)
  expect(disabled.text).toContain('Unknown extension action: action-test/echo')
})

it('discovers extension contracts: summaries first, then one api.ts and refs.ts by name', async () => {
  const { server, options } = await fixture()
  const folder = join(options.projectRoot, '.ultimate/extensions/contract-test')
  const browserOnly = join(options.projectRoot, '.ultimate/extensions/refs-only')
  await mkdir(folder, { recursive: true })
  await mkdir(browserOnly, { recursive: true })
  const source =
    '/**\n * Contract test: a fixture with a documented contract. It offers nothing else.\n */\nexport type Service = { /** Says hi. */ hi(): string }\n'
  const refs = '/** Contract test in the browser: one constant. */\nexport const Hi = 1\n'
  await writeFile(join(folder, 'api.ts'), source)
  await writeFile(join(folder, 'refs.ts'), refs)
  await writeFile(join(browserOnly, 'refs.ts'), '/** Refs only: a browser contract. */\n')
  for (const [path, name] of [
    [folder, 'contract-test'],
    [browserOnly, 'refs-only'],
  ])
    await writeFile(
      join(path, 'server.ts'),
      `import { defineExtension } from '@earendil-works/pi-durable'; export default defineExtension({ name: '${name}' })`,
    )
  server.vite.watcher.emit('add', join(folder, 'server.ts'))
  server.vite.watcher.emit('add', join(browserOnly, 'server.ts'))
  await until(() =>
    ['contract-test', 'refs-only'].every((name) =>
      server.extensions.info().some((entry) => entry.name === name && entry.enabled),
    ),
  )
  const result = await run(
    server,
    `const apis = await ultimate.apis();
    let unknown;
    try { await ultimate.api('no-such-extension') } catch (error) { unknown = error.message }
    return { apis, source: await ultimate.api('contract-test'), unknown };`,
  )
  const value = result.data.details.value as {
    apis: { name: string; summary: string }[]
    source: string
    unknown: string
  }
  // The fixture's built-ins bring their own contracts; each has a summary.
  expect(value.apis).toContainEqual({
    name: 'contract-test',
    summary: 'Contract test: a fixture with a documented contract.',
  })
  // An extension with only a browser contract is listed by it.
  expect(value.apis).toContainEqual({
    name: 'refs-only',
    summary: 'Refs only: a browser contract.',
  })
  for (const api of value.apis) expect(api.summary).not.toBe('')
  expect(value.source).toBe(
    `// contract-test/api.ts: the server contract: services, extension points, documents\n${source}\n` +
      `// contract-test/refs.ts: the browser contract: documents, actions (call them with ultimate.action) and events\n${refs}`,
  )
  expect(value.unknown).toMatch(
    /^No enabled extension "no-such-extension" with an api\.ts or refs\.ts; known: .*\bcontract-test\b/,
  )
})

it("returns workspaces' refs.ts with its api.ts, so agents see its actions and events", async () => {
  const home = await temp('ultimate-codemode-workspaces-')
  directories.push(home)
  await mkdir(join(home, 'project'))
  const server = await createServer({
    ultimateRoot: resolve('.'),
    projectRoot: join(home, 'project'),
    userHome: home,
    home: join(home, 'state'),
  })
  servers.push(server)
  const result = await run(server, `return await ultimate.api('workspaces')`)
  const source = result.data.details.value as string
  expect(source).toContain(
    `// workspaces/api.ts: the server contract: services, extension points, documents\n${await readFile(resolve('extensions/workspaces/api.ts'), 'utf8')}`,
  )
  expect(source).toContain('// workspaces/refs.ts: the browser contract')
  expect(source).toContain(
    "export const SubmissionLanded = defineEvent<LandedData>('workspaces.landed')",
  )
  expect(source).toContain("actionRef<{ id: number }, WorkspaceInfo | null>('workspaces', 'info')")
})

// Three projects saw a script's later automation calls get the first call's receipt: nested calls share one task.
it('applies each automation call in one script to its own arguments', async () => {
  const home = await temp('ultimate-codemode-automation-')
  directories.push(home)
  await mkdir(join(home, 'project'))
  const server = await createServer({
    ultimateRoot: resolve('.'),
    projectRoot: join(home, 'project'),
    userHome: home,
    home: join(home, 'state'),
  })
  servers.push(server)
  const result = await run(
    server,
    `const created = await tools.automation({action:'create', name:'Probe', schedule:'every 1d'});
     const id = created.split(' ')[0];
     await tools.automation({action:'subscribe', id, to:'@ultimate'});
     await tools.automation({action:'unsubscribe', id, to:'#${server.root.id}'});
     const [stored] = await ultimate.action('automations', 'list');
     return { line: await tools.automation({action:'list'}), subscribers: stored.subscribers };`,
  )
  expect(result.data.details.value).toEqual({
    line: 'A1 Probe — Every 1 day — enabled → @ultimate',
    subscribers: ['@ultimate'],
  })
})

it('reserves trust and secret writes for the UI while allowing normal actions', async () => {
  const { server, options } = await fixture()
  await mkdir(join(options.ultimateRoot, 'server'), { recursive: true })
  await cp(resolve('server/lock.ts'), join(options.ultimateRoot, 'server/lock.ts'))
  // Onboarding and secrets use the shared helpers in lib/.
  await cp(resolve('lib'), join(options.ultimateRoot, 'lib'), { recursive: true })
  const probes = { onboarding: 'decide', secrets: 'set' } as const
  for (const [name, probe] of Object.entries(probes)) {
    await cp(resolve(`extensions/${name}`), join(options.ultimateRoot, `extensions/${name}`), {
      recursive: true,
    })
    await until(() => !!server.extensions.action(name, probe))
  }
  for (const [extension, action, args] of [
    ['onboarding', 'decide', { local: true }],
    ['secrets', 'set', { name: 'TEST_KEY', value: 'test-value' }],
  ] as const) {
    const denied = await run(
      server,
      `return await ultimate.action('${extension}', '${action}', ${JSON.stringify(args)});`,
    )
    expect(denied.data.isError).toBe(true)
    expect(denied.text).toContain(`${extension}/${action} is a user-only action`)
    const response = await post(server, `/api/extensions/${extension}/actions/${action}`, { args })
    expect(response.status).toBe(200)
  }
  const normal = await run(server, `return await ultimate.action('secrets', 'list');`)
  expect(normal.data.isError).not.toBe(true)
  expect(normal.data.details.value).toEqual([
    expect.objectContaining({ name: 'TEST_KEY', set: true }),
  ])
})

it('logs ultimate helper calls and labels a one-call script by its call id, with an event', async () => {
  const { server } = await fixture()
  const result = await run(server, `return (await ultimate.conversations()).length`)
  expect(result.data.details.calls.map((call) => [call.name, call.status])).toEqual([
    ['ultimate.conversations', 'ok'],
  ])
  const view = await server.root.viewState(context)
  const call = view.value.entries.findLast((entry) => entry.kind === 'pi.tool-result')!
  const callId = call.model?.[0]?.role === 'toolResult' ? call.model[0].toolCallId : ''
  view.dispose()
  expect(await server.harness.snapshot(SummaryDoc, server.root.id, context)).toEqual({
    calls: { [callId]: { line: 'Listed the conversations' } },
  })
  const events = await eventHost(() => server.harness, 'test').eventLog.recent({
    events: [Summarized],
  })
  expect(events.map((event) => event.data)).toEqual([
    {
      conversation: server.root.id,
      call: callId,
      line: 'Listed the conversations',
      effect: false,
    },
  ])
})

it('composes read and bash with private nested results and final JSON details', async () => {
  const { server } = await fixture()
  const path = join(server.host.home, 'scratch.txt')
  const result = await run(
    server,
    `const source = await tools.read({path:${JSON.stringify(path)}}); const shell = await tools.bash({command:'echo nested-private'}); text(source.trim()); return {length:shell.length};`,
  )
  expect(result.text).toContain('Script completed')
  expect(result.text).toContain('before')
  expect(result.text).not.toContain('nested-private')
  expect(result.data.details.calls.map((call) => [call.name, call.status])).toEqual([
    ['read', 'ok'],
    ['bash', 'ok'],
  ])
  expect(result.data.details.value).toEqual({ length: 15 })
  const view = await server.root.viewState(context)
  expect(view.value.entries.filter((entry) => entry.kind === 'pi.tool-result')).toHaveLength(1)
  view.dispose()
  server.host.registry.install(
    defineExtension({
      name: 'structured',
      tools: [
        {
          ...defineTool({
            name: 'structured',
            description: 'Structured test',
            parameters: Type.Object({ answer: Type.Number() }),
            execute: async ({ answer }) => ({
              structuredContent: { answer },
              output: [{ type: 'text', text: 'private fallback' }],
            }),
          }),
          outputSchema: { type: 'object' },
        },
      ],
    }),
  )
  server.host.registry.install(
    planExtension({
      metadata: Metadata,
      onOpen: () => {},
    } as unknown as ExtensionHost),
  )
  // #159728 extended task descriptions from a script; a text result made `shown.description` undefined and wiped them.
  const extended = await run(
    server,
    `const epic = await tools.plan({action:'create', title:'E', body:'b'});
     const task = await tools.plan({action:'add', epic: epic.key, title:'T', role:'worker', description:'draft'});
     const shown = await tools.plan({action:'show', key: task.key});
     await tools.plan({action:'update', key: task.key, description: shown.description + '\\nmore'});
     await tools.plan({action:'update', key: task.key, status:'todo', child: 7});
     return await tools.plan({action:'show', key: task.key});`,
  )
  expect(extended.data.details.value).toMatchObject({
    description: 'draft\nmore',
    status: 'todo',
    child: 7,
    title: 'T',
  })
  const structured = await run(server, `return await tools.structured({answer:42});`)
  expect(structured.data.details.value).toEqual({ answer: 42 })
  const invalid = await run(server, `await tools.structured({answer:'wrong'});`)
  expect(invalid.data.isError).toBe(true)
  expect(invalid.data.details.calls[0].status).toBe('error')
  let entered = 0
  let release!: () => void
  const barrier = new Promise<void>((done) => {
    release = done
  })
  server.host.registry.install(
    defineExtension({
      name: 'parallel',
      tools: [
        defineTool({
          name: 'rendezvous',
          description: 'Wait for both calls',
          parameters: Type.Object({}),
          execute: async () => {
            if (++entered === 2) release()
            await barrier
            return { output: [{ type: 'text', text: 'overlapped' }] }
          },
        }),
      ],
    }),
  )
  const parallel = await run(
    server,
    `return await Promise.all([tools.rendezvous({}), tools.rendezvous({})]);`,
  )
  expect(parallel.data.details.value).toEqual(['overlapped', 'overlapped'])
  const caught = await run(
    server,
    `try { await tools.read({path:'missing-file'}); } catch (error) { return error.message; }`,
  )
  expect(caught.data.details.calls[0].status).toBe('error')
  expect(String(caught.data.details.value)).toContain('missing-file')
  const failed = await run(server, `text('kept');\nawait tools.read({path:'missing-file'});`)
  expect(failed.text).toContain('Script failed')
  expect(failed.text).toContain('kept')
  expect(failed.data.details.error).toContain('missing-file')
  expect(failed.data.isError).toBe(true)
})

it("reads another running project's history through its API, and names a project that isn't running", async () => {
  const { server, options } = await fixture()
  const projects = join(options.userHome, '.ultimate/projects')
  const otherRoot = join(options.userHome, 'poe2-rust')
  await mkdir(otherRoot, { recursive: true })
  const other = await createServer({
    ...options,
    projectRoot: otherRoot,
    home: join(projects, 'poe2-rust-1'),
  })
  servers.push(other)
  // The supervisor writes this lock; `ultimate.projects()` finds a running instance's URL in it.
  await writeFile(
    join(projects, 'poe2-rust-1/ultimate.lock'),
    JSON.stringify({ pid: process.pid, port: Number(new URL(other.url).port) }),
  )
  await run(other, 'return 1', 'remote-needle-poe2')
  const asked = await run(
    server,
    `const list = await ultimate.conversations({ project: 'poe2-rust' });
    const needle = ['remote-needle', 'poe2'].join('-');
    const found = await ultimate.search(needle, { project: 'poe2-rust', limit: 1 });
    const tail = await ultimate.entries(list[0].id, { project: 'POE2-RUST', kinds: ['pi.user'], limit: 1 });
    const own = await ultimate.search(needle);
    const theirs = await ultimate.doc('codemode.store', undefined, { project: 'poe2-rust' });
    return { found: found.length, tail: tail[0].kind, own: own.length, theirs: JSON.stringify(theirs) };`,
  )
  // Their conversation 1 ran a script but stored nothing.
  expect(asked.data.details.value).toEqual({
    found: 1,
    tail: 'pi.user',
    own: 0,
    theirs: '{}',
  })
  // Naming this project reads here, defaulting to the calling conversation as without a project.
  await run(server, `store('here-key', 1); return 1`)
  const stored = await run(
    server,
    `const here = (await ultimate.projects()).find((p) => p.current).name;
    return await ultimate.doc('codemode.store', undefined, { project: here });`,
  )
  expect(JSON.stringify(stored.data.details.value)).toContain('here-key')
  await other.close()
  servers.splice(servers.indexOf(other), 1)
  await rm(join(projects, 'poe2-rust-1/ultimate.lock'))
  const stopped = await run(server, `return await ultimate.entries(1, { project: 'poe2-rust' })`)
  expect(stopped.data.isError).toBe(true)
  expect(stopped.text).toContain('poe2-rust is not running on this machine; start it to query it')
  const unknown = await run(server, `return await ultimate.entries(1, { project: 'nope' })`)
  expect(unknown.text).toContain('Unknown project nope')
  expect(unknown.text).toContain('poe2-rust')
})

it('lists conversations with their title and cwd', async () => {
  const { server } = await fixture()
  const create = async (title: string) =>
    ((await post(server, '/api/conversations', { title })).data as { id: number }).id
  const open = await create('Parser work')
  const done = await create('Old work')
  // The conversations extension owns concluding; this fixture loads only codemode, so write its UI state directly.
  await post(server, '/api/ui', { set: { 'ext.conversations.concluded': [done] } })
  const result = await run(server, `return await ultimate.conversations()`)
  expect(result.data.isError).toBe(false)
  const listed = result.data.details.value as { id: number }[]
  expect(listed.find((item) => item.id === open)).toMatchObject({
    title: 'Parser work',
    cwd: expect.any(String),
    busy: false,
  })
  expect(listed.find((item) => item.id === open)).not.toHaveProperty('concluded')
  expect(listed.find((item) => item.id === done)).toMatchObject({
    title: 'Old work',
    concluded: true,
  })
})

it('lists conversations whose titles are whole prompts with short titles, far below the read limit', async () => {
  const { server } = await fixture()
  const prompt = `Rewrite the parser ${'and keep every token '.repeat(300)}`
  expect(prompt.length).toBeGreaterThan(6000)
  const ids = await Promise.all(
    Array.from(
      { length: 40 },
      async () =>
        ((await post(server, '/api/conversations', { title: prompt })).data as { id: number }).id,
    ),
  )
  const result = await run(server, `return await ultimate.conversations()`)
  expect(result.data.isError).toBe(false)
  const listed = result.data.details.value as { id: number; title?: string }[]
  for (const item of listed.filter((entry) => ids.includes(entry.id))) {
    expect(item.title).toMatch(/^Rewrite the parser and keep every token .*…$/)
    expect(item.title!.length).toBeLessThanOrEqual(60)
  }
  // Full titles would make this listing 40 × 6,000 characters; short ones keep it to a few kilobytes.
  expect(JSON.stringify(listed).length).toBeLessThan(20_000)
  // The stored title is untouched.
  const stored = await server.harness.snapshot(Metadata, ids[0] as ConversationId, context)
  expect(stored?.title).toBe(prompt)
})

it("lists project agents once the project's setup is trusted, and says when it is not", async () => {
  const { server, options } = await fixture()
  await mkdir(join(options.projectRoot, '.ultimate/agents'), { recursive: true })
  await writeFile(
    join(options.projectRoot, '.ultimate/agents/writer.md'),
    '---\nname: writer\ndescription: Polishes posts\n---\n\nPolish.\n',
  )
  const agents = async () => {
    const result = await run(
      server,
      `const a = await ultimate.agents(); return { setup: a.projectSetup, project: a.definitions.filter((d) => d.source === 'project').map((d) => d.name) }`,
    )
    expect(result.data.isError).toBe(false)
    return result.data.details.value
  }
  // The faux fixture trusts its project; declining it hides the project's definitions and says why.
  const trust = new ProjectTrustStore(join(options.userHome, '.ultimate'))
  expect(await agents()).toEqual({ setup: 'trusted', project: ['writer'] })
  trust.set(options.projectRoot, false)
  expect(await agents()).toEqual({ setup: 'declined', project: [] })
})

it('reads stored history and documents from before a reset', async () => {
  const { server } = await fixture()
  await run(server, `store('saved', 7); return 1;`, 'history-needle')
  await server.root.reset(undefined, context)
  const result = await run(
    server,
    `const matches = await ultimate.search('history-needle'); const entries = await ultimate.entries(1, {kinds:['pi.user'], limit:1}); const old = await ultimate.entries(1, {before:entries[0].id}); return {matches:matches.length, old:old.length, doc:await ultimate.doc('codemode.store')};`,
  )
  expect(result.data.isError).toBe(false)
  expect(result.data.details.value).toMatchObject({
    doc: { saved: 7 },
  })
  expect((result.data.details.value as { matches: number }).matches).toBeGreaterThan(0)
  expect((result.data.details.value as { old: number }).old).toBeGreaterThan(0)
})

it('persists store over two calls and harness close/reopen; discards failed writes', async () => {
  const { server, options } = await fixture()
  expect(
    (await run(server, `store('runs', (load('runs') ?? 0)+1); return load('runs');`)).data.details
      .value,
  ).toBe(1)
  expect(
    (await run(server, `store('runs', load('runs')+1); return load('runs');`)).data.details.value,
  ).toBe(2)
  await run(server, `store('runs', 99); throw new Error('no commit');`)
  expect(await server.harness.snapshot(Store, server.root.id, context)).toEqual({ runs: 2 })
  await server.close()
  servers.splice(servers.indexOf(server), 1)
  const reopened = await createServer(options)
  servers.push(reopened)
  expect(
    (await run(reopened, `const n = load('runs'); store('runs', undefined); return n;`)).data
      .details.value,
  ).toBe(2)
  expect(await reopened.harness.snapshot(Store, reopened.root.id, context)).toEqual({})
  const truncated = await run(
    reopened,
    `// @options: {"max_output_tokens":20}\ntext('x'.repeat(1000));`,
  )
  expect(truncated.text).toContain('Output truncated')
})

it('aborts nested work without committing store writes', async () => {
  const { server } = await fixture()
  server.host.faux!.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall('codemode', {
          code: `await tools.read({path:${JSON.stringify(join(server.host.home, 'scratch.txt'))}}); await tools.bash({command:'sleep 30'}); store('aborted', true);`,
        }),
      ],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Complete'),
  ])
  await server.root.submit({ type: 'input', content: 'abort this' }, context)
  await until(async () => {
    const state = await server.root.viewState(context)
    try {
      return JSON.stringify(state.value.docs['pi.live']).includes('✓ tools.read')
    } finally {
      state.dispose()
    }
  })
  await server.root.abort(context)
  await server.harness.waitForIdle(context)
  expect(await server.harness.snapshot(Store, server.root.id, context)).toBeUndefined()
  const view = await server.root.viewState(context)
  expect(
    JSON.stringify(view.value.entries.findLast((entry) => entry.kind === 'pi.tool-result')),
  ).toMatch(/aborted|interrupted/)
  view.dispose()
})

it.each([
  ['sequential', `await tools.subagent({action:'wait', id:41});`],
  ['foreground start', `await tools.subagent({action:'start'});`],
  [
    'catch',
    `try { await tools.subagent({action:'wait', id:41}); } catch { text('caught'); await tools.effect({}); }`,
  ],
  [
    'finally',
    `try { await tools.subagent({action:'wait', id:41}); } finally { text('finalized'); await tools.effect({}); }`,
  ],
])('yields %s without executing the remainder or committing store writes', async (_name, wait) => {
  const { server } = await fixture()
  let effects = 0
  server.host.registry.install(
    defineExtension({
      name: 'yield-test',
      tools: [
        defineTool({
          name: 'subagent',
          description: 'Fake child wait',
          parameters: Type.Object({ action: Type.String(), id: Type.Optional(Type.Number()) }),
          execute: async ({ id }): Promise<ToolExecutionResult> =>
            id === 1
              ? {
                  output: [{ type: 'text', text: 'earlier-private-answer' }],
                  details: { conversationId: 1, answerId: 101 },
                }
              : {
                  output: [{ type: 'text', text: 'Unfinished; yielded to steering' }],
                  details: { yielded: true, conversationId: id ?? 41, background: true },
                },
        }),
        defineTool({
          name: 'effect',
          description: 'Record a side effect',
          parameters: Type.Object({}),
          execute: async () => {
            effects++
            return { output: [{ type: 'text', text: 'effect' }] }
          },
        }),
      ],
    }),
  )
  await run(server, `store('saved', 7); store('deleted', true);`)
  const result = await run(
    server,
    `await tools.subagent({action:'wait', id:1}); await tools.effect({}); text('prior-output'); store('saved', 99); store('deleted', undefined); store('new', true); ${wait} text('continued'); await tools.effect({}); return 'finished';`,
  )
  expect(result.data.isError).toBe(false)
  expect(result.data.details).toMatchObject({
    yielded: true,
    pendingSubagents: [{ conversationId: 41, background: true }],
    calls: [
      { name: 'subagent', status: 'ok' },
      { name: 'effect', status: 'ok' },
      { name: 'subagent', status: 'yielded' },
    ],
  })
  expect(result.data.details).not.toHaveProperty('subagentAnswers')
  expect(result.data.details.value).toBeUndefined()
  expect(result.data.details.error).toBeUndefined()
  expect(result.text).toContain(
    'Script yielded to steering; subagents still running; remaining script not executed; prior side effects may have happened',
  )
  expect(result.text).toContain('41')
  expect(result.text).toContain('prior-output')
  expect(result.text).not.toMatch(
    /Script completed|Script failed|continued|caught|finalized|finished|earlier-private-answer/,
  )
  expect(effects).toBe(1)
  expect(await server.harness.snapshot(Store, server.root.id, context)).toEqual({
    saved: 7,
    deleted: true,
  })
  // A sandbox-local yield does not cancel the parent's invocation or its next tool round.
  expect((await run(server, `return await tools.effect({});`)).data.details.value).toBe('effect')
  expect(effects).toBe(2)
})

it('yields Promise.all, cancels pending host work, and preserves other waiting child IDs', async () => {
  const { server } = await fixture()
  let entered = 0
  let release!: () => void
  const barrier = new Promise<void>((done) => {
    release = done
  })
  let cancelled = 0
  let effects = 0
  const rendezvous = () => {
    if (++entered === 3) release()
  }
  server.host.registry.install(
    defineExtension({
      name: 'parallel-yield-test',
      tools: [
        defineTool({
          name: 'subagent',
          description: 'Fake parallel wait',
          parameters: Type.Object({ action: Type.String(), id: Type.Number() }),
          execute: async ({ id }, _api, nestedContext) => {
            rendezvous()
            if (id === 41) {
              await barrier
              return {
                output: [{ type: 'text', text: 'Still running' }],
                details: { yielded: true, conversationId: id },
              }
            }
            await new Promise<void>((_resolve, reject) => {
              nestedContext.abortSignal!.addEventListener(
                'abort',
                () => {
                  cancelled++
                  reject(new Error('Wait cancelled'))
                },
                { once: true },
              )
            })
            throw new Error('Unreachable')
          },
        }),
        defineTool({
          name: 'effect',
          description: 'Normal cancellable tool',
          parameters: Type.Object({}),
          execute: async (_args, _api, nestedContext) => {
            rendezvous()
            await new Promise<void>((_resolve, reject) => {
              nestedContext.abortSignal!.addEventListener(
                'abort',
                () => {
                  cancelled++
                  reject(new Error('Work cancelled'))
                },
                { once: true },
              )
            })
            effects++
            return { output: [{ type: 'text', text: 'effect' }] }
          },
        }),
      ],
    }),
  )
  const result = await run(
    server,
    `store('parallel', true); try { await Promise.all([tools.subagent({action:'wait', id:41}), tools.subagent({action:'wait', id:42}), tools.effect({})]); } catch { text('caught'); } finally { text('finalized'); } text('continued'); return 'finished';`,
  )
  expect(result.data.isError).toBe(false)
  expect(result.data.details.yielded).toBe(true)
  expect(result.data.details).not.toHaveProperty('subagentAnswers')
  expect(result.data.details.pendingSubagents).toEqual([
    { conversationId: 41 },
    { conversationId: 42 },
  ])
  expect(result.data.details.calls.map((call) => [call.name, call.status])).toEqual([
    ['subagent', 'yielded'],
    ['subagent', 'cancelled'],
    ['effect', 'cancelled'],
  ])
  expect(cancelled).toBe(2)
  expect(effects).toBe(0)
  expect(result.text).not.toMatch(/caught|finalized|continued|finished|Script failed/)
  expect(await server.harness.snapshot(Store, server.root.id, context)).toBeUndefined()
})

it('recovers an unsafe interrupted script with its committed nested-call log', async () => {
  const { server, options } = await fixture()
  server.host.faux!.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall('codemode', {
          code: `await tools.read({path:${JSON.stringify(join(server.host.home, 'scratch.txt'))}}); await tools.bash({command:'sleep 30'}); store('finished', true);`,
        }),
      ],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Complete'),
  ])
  await server.root.submit({ type: 'input', content: 'interrupt this' }, context)
  await until(async () => {
    const state = await server.root.viewState(context)
    try {
      return JSON.stringify(state.value.docs['pi.live']).includes('✓ tools.read')
    } finally {
      state.dispose()
    }
  })
  await server.vite.watcher.close()
  await server.close()
  servers.splice(servers.indexOf(server), 1)
  const reopened = await createServer(options)
  servers.push(reopened)
  await reopened.harness.waitForIdle(context)
  const state = await reopened.root.viewState(context)
  try {
    const result = state.value.entries.find((entry) => entry.kind === 'pi.tool-result')
    expect(JSON.stringify(result)).toContain('interrupted')
    expect(JSON.stringify(result)).toContain('✓ tools.read')
    expect(await reopened.harness.snapshot(Store, reopened.root.id, context)).toBeUndefined()
  } finally {
    state.dispose()
  }
})
