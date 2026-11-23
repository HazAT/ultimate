import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  fauxAssistantMessage,
  fauxToolCall,
  fauxProvider,
} from '@earendil-works/pi-ai/providers/faux'
import { num, obj } from '@earendil-works/pi-schema'
import { defineExtension, defineTool, hook, ToolTask } from '@earendil-works/pi-durable'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import type { ConversationId } from '@earendil-works/pi-durable'
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
} from '../../../test/helpers.ts'
import { context } from '../../../server/harness.ts'
import { FIRST_CHAPTER, requestChapter } from '../../../lib/chapters.ts'
import { SummaryDoc, withDefaultTimeout } from '../server.ts'
import { CodemodeStoreDoc } from '@earendil-works/pi-durable/codemode'
import { Summarized } from '../refs.ts'
import planExtension from '../../plan/server.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { Metadata } from '../../../server/metadata.ts'
import type { CallTree } from '../../../server/trace.ts'

const servers: Awaited<ReturnType<typeof createServer>>[] = []
const directories: string[] = []
afterEach(async () => {
  // Take both lists before the first await: a hook still running past its timeout must not delete the next test's
  // directories (first seen in messages.test.ts).
  const closing = servers.splice(0)
  const taken = directories.splice(0)
  for (const server of closing) {
    await server.vite.watcher.close()
    await server.close()
  }
  for (const directory of taken) await removeTemp(directory)
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
  // Immutable after boot; do not restart Vite for a replay of the fixture's initial config write.
  await writeFile(
    join(ultimateRoot, 'vite.config.ts'),
    "import { fileURLToPath } from 'node:url'; import { defineConfig } from 'vite-plus'; export default defineConfig({ root: 'web', cacheDir: '.vite-cache', optimizeDeps: { noDiscovery: true }, server: { watch: { ignored: [(file) => file === fileURLToPath(import.meta.url)] } } })",
  )
  await writeFile(join(ultimateRoot, 'web/index.html'), '<html>Codemode</html>')
  // The copy reaches the definitions module in the checkout, as `ultimate.agents()` reads them through it.
  await writeFile(
    join(ultimateRoot, 'extensions/codemode/server.ts'),
    (await readFile(resolve('extensions/codemode/server.ts'), 'utf8'))
      .replace("'../../lib/agents.ts'", JSON.stringify(resolve('lib/agents.ts')))
      .replace("'../../lib/api-files.ts'", JSON.stringify(resolve('lib/api-files.ts'))),
  )
  for (const file of ['api.ts', 'chapters.ts', 'models.ts', 'projects.ts', 'refs.ts', 'summary.ts'])
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
    entries: await ultimate.entries(${server.root.id}, { chapter: '${FIRST_CHAPTER}', kinds: ['chapter.note'], full: true }),
    search: await ultimate.search('closed-chapter-needle', { chapter: '${FIRST_CHAPTER}', limit: 1, full: true }),
    conversations: await ultimate.conversations({ chapter: '${FIRST_CHAPTER}' })
  };`,
  )
  expect(result.data.isError).not.toBe(true)
  expect(result.value).toMatchObject({
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
  const { conversations } = result.value as {
    conversations: { id: number; title: string }[]
  }
  expect(conversations.find((item) => item.id === long)!.title.length).toBeLessThanOrEqual(60)
  const conflict = await run(
    next,
    `return await ultimate.entries(1, { project: 'anything', chapter: '${FIRST_CHAPTER}' });`,
  )
  expect(conflict.output).toContain('chapter and project cannot be used together')
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
  expect(text).toContain('act on them through tools.action({extension, action, args})')
  expect(text).toContain('at most 1000 models.classify/generateImages calls')
  expect(text).not.toContain('jev-1.14.0')
  expect(text).toContain('declare const ultimate')
  expect(text).toContain('entries(conversationId: number')
  expect(text).toContain('### `action`')
  expect(text).toContain('### `tell`')
  const withRestart = await section.render(
    {
      conversationId: server.root.id,
      agent: { ...agent, tools: [...agent.tools, { ...agent.tools[0], name: 'restart' }] },
    } as unknown as Parameters<typeof section.render>[0],
    context,
  )
  expect(withRestart).toContain('Call restart only at top level')
  expect(agent.tools.map((tool) => tool.name)).not.toContain('action')
  expect(agent.tools.map((tool) => tool.name)).not.toContain('tell')
  const tool = agent.tools.find((item) => item.name === 'codemode')!
  expect(tool.replay).toBe('safe')
  expect(tool.description).toContain('models.classify(')
  const replayOf = (name: string) =>
    server.host.registry
      .snapshot()
      .extension('codemode')!
      .tools!.find((item) => item.name === name)!.replay
  expect(replayOf('pi.codemode.models.classify')).toBe('safe')
  expect(replayOf('pi.codemode.models.generateImages')).not.toBe('safe')
  expect(replayOf('action')).toBe('unsafe')
})

it('keeps model-only tools callable directly but out of script bindings and guidance', async () => {
  const { server } = await fixture()
  let executions = 0
  server.host.registry.install(
    defineExtension({
      name: 'caller-test',
      tools: [
        defineTool({
          name: 'model_only_probe',
          description: 'A model-only test tool',
          parameters: obj({}),
          callers: ['model'],
          execute: async () => {
            executions++
            return { output: [{ type: 'text', text: 'Called directly' }] }
          },
        }),
      ],
    }),
  )
  server.host.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall('model_only_probe', {})], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Complete'),
  ])
  await server.root.submit({ type: 'input', content: 'Call the model-only tool' }, context)
  await server.harness.waitForIdle(context)
  expect(executions).toBe(1)
  const result = await run(server, 'return await tools.model_only_probe({})')
  expect(executions).toBe(1)
  expect(result.data.isError).toBe(true)
  expect(result.text).toContain('model_only_probe')
  const agent = await server.root.agent(context)
  const section = server.host.registry.snapshot().extension('codemode')!.sections![0]
  const guidance = await section.render(
    { conversationId: server.root.id, agent } as Parameters<typeof section.render>[0],
    context,
  )
  expect(guidance).not.toContain('model_only_probe')
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
  const state = await server.root.context(context)
  const entry = state.entries.findLast((item) => item.kind === 'pi.tool-result')!
  const message = entry.model![0] as unknown as {
    content: { type: string; text?: string }[]
    details: { calls: { name: string; status: string; args: string; error?: string }[] }
    isError: boolean
  }
  const output = message.content
    .slice(1)
    .flatMap((block) => (block.type === 'text' ? [block.text!] : []))
    .join('\n')
  return {
    text: JSON.stringify(message.content),
    output,
    value: parsed(output),
    data: message,
  }
}
const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
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
      import { obj } from '@earendil-works/pi-schema'
      ${token}
      export default (host) => {
        const echo = host.need(Echo)
        return { name: 'trace-probe', tools: [defineTool({
          name: 'probe',
          description: 'Echoes through a service',
          parameters: obj({}),
          execute: async () => ({ output: [{ type: 'text', text: echo.echo('probed') }] }),
        }), defineTool({
          name: 'outer',
          description: 'Runs probe as a Pi nested call',
          parameters: obj({}),
          execute: async (_args, api, ctx) => {
            const result = await api.executeTool('probe', {}, ctx)
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
  expect((await run(server, `return await tools.probe({});`)).value).toBe('probed')
  const echo = server.extensions.trace.query().find((row) => row.name === 'trace-echo.echo')!
  expect(shape(server.extensions.trace.tree(echo.trace))).toEqual([
    [
      'tool',
      'agent',
      'codemode',
      [['tool', 'codemode', 'probe', [['service', 'trace-probe', 'trace-echo.echo', []]]]],
    ],
  ])

  // A model call runs outer, which runs probe as a Pi nested task: one chain of immediate parents.
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
      [['tool', 'trace-probe', 'probe', [['service', 'trace-probe', 'trace-echo.echo', []]]]],
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
    `return await tools.action({extension: 'action-test', action: 'echo', args: { value: 42 }});`,
  )
  expect(result.value).toEqual({
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
    return { action, tool: [tool.kind, tool.name, tool.children.map((call) => [call.name, call.children.map((inner) => inner.name)])] };`,
  )
  expect(traced.value).toMatchObject({
    action: { kind: 'action', caller: 'agent', ok: true, args: '{"value":42}' },
    tool: ['tool', 'codemode', [['action', ['action-test/echo']]]],
  })
  const defaults = await run(
    server,
    `return await tools.action({extension: 'action-test', action: 'echo'});`,
  )
  expect(defaults.value).toMatchObject({ args: null })
  for (const [extension, action, error] of [
    ['missing', 'echo', 'Unknown extension action: missing/echo'],
    ['action-test', 'missing', 'Unknown extension action: action-test/missing'],
    ['action-test', 'toString', 'Unknown extension action: action-test/toString'],
    ['action-test', 'fail', 'Action failed'],
  ]) {
    const failed = await run(
      server,
      `return await tools.action({extension: '${extension}', action: '${action}'});`,
    )
    expect(failed.data.isError).toBe(true)
    expect(failed.text).toContain(error)
  }
  await mkdir(join(options.userHome, '.ultimate'), { recursive: true })
  await writeFile(
    join(options.userHome, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { disable: ['action-test'] } }),
  )
  await until(() => !server.extensions.action('action-test', 'echo'))
  const disabled = await run(
    server,
    `return await tools.action({extension: 'action-test', action: 'echo'});`,
  )
  expect(disabled.data.isError).toBe(true)
  expect(disabled.text).toContain('Unknown extension action: action-test/echo')
  for (const name of ['action', 'tell']) {
    server.host.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall(name, { extension: 'action-test', action: 'echo' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('Complete'),
    ])
    await server.root.submit({ type: 'input', content: `call ${name} directly` }, context)
    await server.harness.waitForIdle(context)
    const direct = (await server.root.context(context)).entries.findLast(
      (entry) => entry.kind === 'pi.tool-result',
    )!
    expect(JSON.stringify(direct.model)).toContain(`Tool ${name} is not available`)
  }
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
  const value = result.value as {
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
      `// contract-test/refs.ts: the browser contract: documents, actions (call them with tools.action) and events\n${refs}`,
  )
  expect(value.unknown).toMatch(
    /^No enabled extension "no-such-extension" with an api\.ts or refs\.ts; known: .*\bcontract-test\b/,
  )
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
    `const stored = async () => (await tools.action({extension: 'automations', action: 'list'})).filter((item) => item.name === 'Probe');
     await tools.automation({action:'create', name:'Probe', schedule:'every 1d'});
     const [{ id, subscribers: created }] = await stored();
     await tools.automation({action:'subscribe', id, to:'@ultimate'});
     await tools.automation({action:'unsubscribe', id, to:'#${server.root.id}'});
     const [{ schedule, enabled, subscribers }] = await stored();
     return { created, schedule, enabled, subscribers };`,
  )
  expect(result.value).toEqual({
    created: [server.root.id],
    schedule: { kind: 'every', ms: 86_400_000 },
    enabled: true,
    subscribers: ['@ultimate'],
  })
})

it('reserves trust and secret writes for the UI while allowing normal actions', async () => {
  const { server, options } = await fixture()
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
      `return await tools.action({extension: '${extension}', action: '${action}', args: ${JSON.stringify(args)}});`,
    )
    expect(denied.data.isError).toBe(true)
    expect(denied.text).toContain(`${extension}/${action} is a user-only action`)
    const response = await post(server, `/api/extensions/${extension}/actions/${action}`, { args })
    expect(response.status).toBe(200)
  }
  const normal = await run(
    server,
    `return await tools.action({extension: 'secrets', action: 'list'});`,
  )
  expect(normal.data.isError).not.toBe(true)
  expect(normal.value).toEqual([expect.objectContaining({ name: 'TEST_KEY', set: true })])
})

it('labels a one-call script by its ultimate helper and call id, with an event', async () => {
  const { server } = await fixture()
  await run(server, `return (await ultimate.conversations()).length`)
  const view = await server.root.context(context)
  const call = view.entries.findLast((entry) => entry.kind === 'pi.tool-result')!
  const callId = call.model?.[0]?.role === 'toolResult' ? call.model[0].toolCallId : ''
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
    `const source = await tools.read({path:${JSON.stringify(path)}}); const shell = await tools.bash({command:'echo nested-private'}); const failed = await tools.bash({command:'exit 3'}); return {source: source.trim(), length:shell.output.length, exitCode: failed.exitCode};`,
  )
  expect(result.text).toContain('Script completed')
  expect(result.text).not.toContain('nested-private')
  expect(result.data.details.calls.map((call) => [call.name, call.status])).toEqual([
    ['read', 'ok'],
    ['bash', 'ok'],
    ['bash', 'error'],
  ])
  // A schema tool resolves to its structured output, a nonzero exit included.
  expect(result.value).toEqual({ source: 'before', length: 15, exitCode: 3 })
  const view = await server.root.context(context)
  expect(view.entries.filter((entry) => entry.kind === 'pi.tool-result')).toHaveLength(1)
  server.host.registry.install(
    defineExtension({
      name: 'structured',
      tools: [
        defineTool({
          name: 'structured',
          description: 'Structured test',
          parameters: obj({ answer: num() }),
          structuredOutputSchema: { type: 'object' },
          execute: async ({ answer }) => ({
            structuredOutput: { answer },
            output: [{ type: 'text', text: 'private fallback' }],
          }),
        }),
      ],
    }),
  )
  server.host.registry.install(
    planExtension({
      react: () => {},
      implement: () => {},
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
  expect(extended.value).toMatchObject({
    description: 'draft\nmore',
    status: 'todo',
    child: 7,
    title: 'T',
  })
  server.host.registry.install(
    defineExtension({
      name: 'streams-then-throws',
      tools: [
        defineTool({
          name: 'flaky',
          description: 'Streams progress, then fails',
          parameters: obj({}),
          execute: async (_args, api) => {
            api.output('Starting…')
            throw new Error('disk full')
          },
        }),
      ],
    }),
  )
  const thrown = await run(
    server,
    `try { await tools.flaky({}); } catch (error) { return error.message; }`,
  )
  expect(thrown.value).toBe('Starting…')
  const structured = await run(server, `return await tools.structured({answer:42});`)
  expect(structured.value).toEqual({ answer: 42 })
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
          parameters: obj({}),
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
  expect(parallel.value).toEqual(['overlapped', 'overlapped'])
  const caught = await run(
    server,
    `try { await tools.read({path:'missing-file'}); } catch (error) { return error.message; }`,
  )
  expect(caught.data.details.calls[0].status).toBe('error')
  expect(String(caught.value)).toContain('missing-file')
  const failed = await run(server, `text('kept');\nawait tools.read({path:'missing-file'});`)
  expect(failed.text).toContain('Script failed')
  expect(failed.text).toContain('kept')
  expect(failed.output).toContain('missing-file')
  expect(failed.data.isError).toBe(true)
})

it('runs tool hooks on nested calls, so a beforeTool block stops a script call', async () => {
  const { server } = await fixture()
  let executions = 0
  const seen: string[] = []
  server.host.registry.install(
    defineExtension({
      name: 'guard',
      hooks: [
        hook(ToolTask, {
          beforeTool: async (call) => {
            seen.push(`before ${call.name}`)
            return call.name === 'guarded' ? { block: 'workspace failed' } : undefined
          },
          afterTool: async (call) => {
            seen.push(`after ${call.name}`)
            return undefined
          },
        }),
      ],
      tools: [
        defineTool({
          name: 'guarded',
          description: 'A tool the guard blocks',
          parameters: obj({}),
          execute: async () => {
            executions++
            return { output: [{ type: 'text', text: 'ran past the guard' }] }
          },
        }),
      ],
    }),
  )
  const result = await run(server, 'return await tools.guarded({})')
  expect(executions).toBe(0)
  expect(result.data.isError).toBe(true)
  expect(result.text).toContain('workspace failed')
  expect(seen).toEqual(['before codemode', 'before guarded', 'after guarded', 'after codemode'])
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
    const theirs = await ultimate.doc('pi.codemode.store', undefined, { project: 'poe2-rust' });
    return { found: found.length, tail: tail[0].kind, own: own.length, theirs: JSON.stringify(theirs) };`,
  )
  // Their conversation 1 ran a script but stored nothing.
  expect(asked.value).toEqual({
    found: 1,
    tail: 'pi.user',
    own: 0,
    theirs: '{"values":{}}',
  })
  // Naming this project reads here, defaulting to the calling conversation as without a project.
  await run(server, `store('here-key', 1); return 1`)
  const stored = await run(
    server,
    `const here = (await ultimate.projects()).find((p) => p.current).name;
    return await ultimate.doc('pi.codemode.store', undefined, { project: here });`,
  )
  expect(JSON.stringify(stored.value)).toContain('here-key')
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
  await post(server, '/api/ui', { ops: [{ key: 'ext.conversations.concluded', value: [done] }] })
  const result = await run(server, `return await ultimate.conversations()`)
  expect(result.data.isError).toBe(false)
  const listed = result.value as { id: number }[]
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
  const ids = await Promise.all(
    Array.from(
      { length: 40 },
      async () =>
        ((await post(server, '/api/conversations', { title: prompt })).data as { id: number }).id,
    ),
  )
  const result = await run(server, `return await ultimate.conversations()`)
  expect(result.data.isError).toBe(false)
  const listed = result.value as { id: number; title?: string }[]
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
    return result.value
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
    `const matches = await ultimate.search('history-needle'); const entries = await ultimate.entries(1, {kinds:['pi.user'], limit:1}); const old = await ultimate.entries(1, {before:entries[0].id}); return {matches:matches.length, old:old.length, doc:await ultimate.doc('pi.codemode.store')};`,
  )
  expect(result.data.isError).toBe(false)
  expect(result.value).toMatchObject({
    doc: { values: { saved: 7 } },
  })
  expect((result.value as { matches: number }).matches).toBeGreaterThan(0)
  expect((result.value as { old: number }).old).toBeGreaterThan(0)
})

it('searches compactly by default, filters kinds, and returns whole entries with full', async () => {
  const { server } = await fixture()
  await run(server, `return 1;`, `kinds-needle ${'padding '.repeat(500)}`)
  const { value } = (await run(
    server,
    `return {
        compact: await ultimate.search('kinds-needle', { kinds: ['pi.user'] }),
        none: await ultimate.search('kinds-needle', { kinds: ['board.message'] }),
        full: await ultimate.search('kinds-needle', { kinds: ['pi.user'], full: true }),
      };`,
  )) as {
    value: { compact: { excerpt: string }[]; none: unknown[]; full: { data: unknown }[] }
  }
  expect(value.compact).toEqual([
    {
      conversation: server.root.id,
      id: expect.any(Number),
      kind: 'pi.user',
      at: expect.any(String),
      excerpt: expect.stringContaining('kinds-needle'),
    },
  ])
  expect(value.compact[0].excerpt.length).toBeLessThan(250)
  expect(value.none).toEqual([])
  expect(value.full).toHaveLength(1)
  expect(JSON.stringify(value.full[0])).toContain('padding '.repeat(500))
})

it('persists store over two calls and harness close/reopen; discards failed writes', async () => {
  const { server, options } = await fixture()
  const values = async (harness = server.harness) =>
    (await harness.snapshot(CodemodeStoreDoc, server.root.id, context))?.values
  expect(
    (await run(server, `store('runs', (load('runs') ?? 0)+1); return load('runs');`)).value,
  ).toBe(1)
  expect((await run(server, `store('runs', load('runs')+1); return load('runs');`)).value).toBe(2)
  await run(server, `store('runs', 99); throw new Error('no commit');`)
  expect(await values()).toEqual({ runs: 2 })
  await server.close()
  servers.splice(servers.indexOf(server), 1)
  const reopened = await createServer(options)
  servers.push(reopened)
  expect(
    (await run(reopened, `const n = load('runs'); store('runs', undefined); return n;`)).value,
  ).toBe(2)
  expect(await values(reopened.harness)).toEqual({})
})

it('resumes an interrupted script from its journal without running finished calls again', async () => {
  const { server, options } = await fixture()
  const marker = join(server.host.home, 'ran.txt')
  server.host.faux!.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall('codemode', {
          code: `await tools.bash({command:'echo once >> ${marker}'}); const listed = await ultimate.conversations(); await tools.bash({command:'sleep 30'}); store('finished', listed.length); return 'resumed';`,
        }),
      ],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Complete'),
  ])
  await server.root.submit({ type: 'input', content: 'interrupt this' }, context)
  await until(async () => {
    const state = await server.root.watch(context)
    try {
      return JSON.stringify(state.value.docs['pi.live']).includes('sleep 30')
    } finally {
      await state.stop()
    }
  })
  await server.vite.watcher.close()
  await server.close()
  servers.splice(servers.indexOf(server), 1)
  const reopened = await createServer(options)
  servers.push(reopened)
  await reopened.harness.waitForIdle(context)
  expect(await readFile(marker, 'utf8')).toBe('once\n')
  const result = (await reopened.root.context(context)).entries.find(
    (entry) => entry.kind === 'pi.tool-result',
  )
  expect(JSON.stringify(result)).toContain('Script failed')
  expect(JSON.stringify(result)).toContain('bash (error)')
})

it('sends a failed script to the summary model as a fixed label, never its printed output', async () => {
  const { server } = await fixture()
  const path = join(server.host.home, 'scratch.txt')
  await run(
    server,
    `await tools.read({path:${JSON.stringify(path)}}); await tools.bash({command:'true'}); text('Script error:\\nsecret line'); throw new Error('Script error:\\nsecret line');`,
  )
  const inputs = await server.harness.commit(async (tx) => {
    const found: string[] = []
    let cursor
    do {
      const page = await tx.scanTasks({}, 256, cursor)
      for (const task of page.items)
        if (task.kind === 'codemode.summary') found.push(JSON.stringify(task.input))
      cursor = page.next
    } while (cursor)
    return found
  }, context)
  expect(inputs).toHaveLength(1)
  expect(inputs[0]).toContain('Script failed')
  expect(inputs[0]).not.toContain('secret line')
})

it('gives a script without timeout_ms a 60 s deadline, which stops a spinning script', async () => {
  const { server } = await fixture()
  const spun = await run(
    server,
    '// @options: {"timeout_ms":300}\nconst start = Date.now(); while (Date.now() < start + 1e9) {}',
  )
  expect(spun.data.isError).toBe(true)
  expect(spun.output).toContain('Script timed out')
  expect(withDefaultTimeout('return 1')).toBe('// @options: {"timeout_ms":60000}\nreturn 1')
  expect(withDefaultTimeout('// @options: {"max_output_tokens":10}\nreturn 1')).toBe(
    '// @options: {"max_output_tokens":10,"timeout_ms":60000}\nreturn 1',
  )
  const explicit = '// @options: {"timeout_ms":5}\nreturn 1'
  expect(withDefaultTimeout(explicit)).toBe(explicit)
})
