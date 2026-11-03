import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  isModelType,
} from '@earendil-works/pi-ai/models'
import { fauxServer, temp, until, attach, post, sourceCopy } from '../helpers.ts'
import { createServer } from '../../server/main.ts'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { context } from '../../server/harness.ts'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'

it('loads pinned TypeScript upstream through Vite, tracks external auth, and cleans up reload/disable', async () => {
  const home = await temp()
  const cli = join(home, 'claude')
  const payload = join(home, 'status.json')
  await writeFile(
    cli,
    `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
if (process.argv.includes('status')) {
  process.stdout.write(readFileSync(${JSON.stringify(payload)}, 'utf8'))
} else {
  writeFileSync(${JSON.stringify(payload + '.discovery')}, 'catalog-only')
  for await (const line of createInterface({ input: process.stdin })) {
    const frame = JSON.parse(line)
    if (frame.type === 'control_request') console.log(JSON.stringify({
      type: 'control_response', response: { request_id: frame.request_id, subtype: 'success', response: {
        models: [{ value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet discovered', description: 'Sonnet', supportsAdaptiveThinking: true, supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] }]
      } }
    }))
  }
}
`,
  )
  await chmod(cli, 0o755)
  await writeFile(payload, JSON.stringify({ loggedIn: false }))
  vi.stubEnv('PI_CLAUDE_CODE_COMMAND', cli)
  const projectRoot = join(home, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  const settings = join(projectRoot, '.ultimate/settings.json')
  await writeFile(settings, '{}')
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    home: join(home, 'state'),
    userHome: home,
  })
  const runtime = server.host.modelRuntime
  const status = () =>
    server.extensions.invoke('claude-code', 'status', null, new AbortController().signal)
  try {
    const anthropic = runtime.getProvider('anthropic')
    const provider = runtime.getProvider('claude-code')!
    expect(provider).toBeDefined()
    expect(Object.hasOwn(provider.auth.oauth!, 'login')).toBe(false)
    expect(provider.auth.oauth?.isSubscription).toBe(true)
    expect(typeof provider.streamSimple).toBe('function')
    const staticModels = provider.getModels()
    const sonnet = staticModels.find((model) => model.id === 'claude-sonnet-5')!
    expect(sonnet.thinkingLevelMap?.off).toBeNull()
    expect(getSupportedThinkingLevels(sonnet)).not.toContain('off')
    expect(clampThinkingLevel(sonnet, 'off')).not.toBe('off')
    expect(clampThinkingLevel(sonnet, 'low')).toBe('low')
    const upstream = await server.vite.ssrLoadModule(
      resolve('node_modules/@earendil-works/pi-claude-code/src/provider.ts'),
    )
    expect(staticModels.filter((model) => model.id !== sonnet.id)).toEqual(
      upstream
        .createClaudeCodeProvider()
        .getModels()
        .filter((model: { id: string }) => model.id !== sonnet.id),
    )
    expect(provider.getAllModels!().find((model) => model.id === sonnet.id)).toEqual(sonnet)
    const discovery = await runtime.refresh({ allowNetwork: true, providers: ['claude-code'] })
    expect(discovery.errors.size).toBe(0)
    expect(await readFile(payload + '.discovery', 'utf8')).toBe('catalog-only')
    const discovered = runtime
      .getAllModels()
      .find((model) => model.provider === 'claude-code' && model.id === 'claude-sonnet-5')!
    if (!isModelType(discovered, 'chat')) throw new Error('Expected discovered chat model')
    expect(discovered.name).toMatch(/Sonnet/)
    expect(discovered.thinkingLevelMap?.off).toBeNull()
    expect(getSupportedThinkingLevels(discovered)).not.toContain('off')
    expect(clampThinkingLevel(discovered, 'off')).not.toBe('off')
    expect(await status()).toEqual({
      available: true,
      loggedIn: false,
      subscription: false,
      plan: null,
    })
    expect((await runtime.getAvailable()).some((m) => m.provider === 'claude-code')).toBe(false)

    await writeFile(
      payload,
      JSON.stringify({ loggedIn: true, subscriptionType: 'max', email: 'private@example.test' }),
    )
    expect(await status()).toEqual({
      available: true,
      loggedIn: true,
      subscription: true,
      plan: 'max',
    })
    expect(runtime.isUsingSubscription('claude-code')).toBe(true)
    expect((await runtime.getAvailable()).some((m) => m.provider === 'claude-code')).toBe(true)

    const file = join(server.host.ultimateRoot, 'extensions/claude-code/server.ts')
    const source = await readFile(file, 'utf8')
    // Hook both registration boundaries deterministically as well as polling:
    // even an unregister/re-register gap shorter than the timer must fail.
    const samples: boolean[] = []
    const sample = () => samples.push(!!runtime.getModel('claude-code', 'claude-sonnet-5'))
    const register = runtime.registerNativeProvider.bind(runtime)
    const unregister = runtime.unregisterProvider.bind(runtime)
    const registration = vi.spyOn(runtime, 'registerNativeProvider').mockImplementation((next) => {
      sample()
      register(next)
      sample()
    })
    const removal = vi.spyOn(runtime, 'unregisterProvider').mockImplementation((id) => {
      unregister(id)
      sample()
    })
    const polling = setInterval(sample, 2)
    try {
      // ultimateRoot is an isolated source copy; never mutate the working checkout here.
      await writeFile(file, source + '\n')
      server.vite.watcher.emit('change', file)
      await until(
        () =>
          runtime.getProvider('claude-code') !== provider && !!runtime.getProvider('claude-code'),
      )
      expect(registration).toHaveBeenCalled()
      expect(removal).not.toHaveBeenCalledWith('claude-code')
      expect(samples.length).toBeGreaterThan(1)
      expect(samples.every(Boolean)).toBe(true)
    } finally {
      clearInterval(polling)
      registration.mockRestore()
      removal.mockRestore()
    }
    await status()
    expect(runtime.isUsingSubscription('claude-code')).toBe(true)
    expect(runtime.getProvider('anthropic')).toBe(anthropic)

    await writeFile(payload, '{invalid json')
    expect(await status()).toEqual({
      available: true,
      loggedIn: false,
      subscription: false,
      plan: null,
    })
    // An unreadable probe is unknown, not a logout: retain the last confirmed login.
    expect((await runtime.getAvailable()).some((m) => m.provider === 'claude-code')).toBe(true)
    await writeFile(payload, JSON.stringify({ loggedIn: false }))
    expect(await status()).toMatchObject({ available: true, loggedIn: false })
    expect((await runtime.getAvailable()).some((m) => m.provider === 'claude-code')).toBe(false)
    vi.stubEnv('PI_CLAUDE_CODE_COMMAND', join(home, 'missing'))
    expect(await status()).toEqual({
      available: false,
      loggedIn: false,
      subscription: false,
      plan: null,
    })
    const aborted = new AbortController()
    aborted.abort()
    await expect(
      server.extensions.invoke('claude-code', 'status', null, aborted.signal),
    ).rejects.toThrow(/abort/i)

    await writeFile(settings, JSON.stringify({ extensions: { disable: ['claude-code'] } }))
    await until(() => !runtime.getProvider('claude-code'))
    expect(runtime.getAllModels().some((m) => m.provider === 'claude-code')).toBe(false)
    expect(runtime.getProvider('anthropic')).toBe(anthropic)
  } finally {
    await server.close()
  }
}, 60000)

// The model sometimes names a tool without its MCP prefix (#371663 failed four times on a bare `bash`); the turn
// resolves it to Pi's name instead of ending.
it('continues a Claude Code turn whose model names a tool without its MCP prefix', async () => {
  const home = await temp()
  const cli = join(home, 'claude')
  await writeFile(
    cli,
    `#!${process.execPath}
import { createInterface } from 'node:readline'
if (process.argv.includes('status')) {
  console.log(JSON.stringify({ loggedIn: true, subscriptionType: 'max' }))
} else {
  const emit = (event) => console.log(JSON.stringify(event))
  for await (const line of createInterface({ input: process.stdin })) {
    const frame = JSON.parse(line)
    if (frame.type !== 'user') continue
    if (frame.shouldQuery === false) {
      emit({ type: 'result', subtype: 'success', num_turns: 0 })
      continue
    }
    const block = { type: 'tool_use', id: 'toolu_1', name: 'bash', input: {} }
    emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: block } })
    emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } } })
    emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
    const message = { id: 'msg_bare', role: 'assistant', content: [{ ...block, input: { command: 'ls' } }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } }
    emit({ type: 'assistant', message })
    emit({ type: 'stream_event', event: { type: 'message_stop' } })
    emit({ type: 'result', subtype: 'error_max_turns', is_error: true, usage: message.usage })
  }
}
`,
  )
  await chmod(cli, 0o755)
  const { createClaudeCodeProvider, streamClaudeCode } =
    await import('@earendil-works/pi-claude-code/src/index.ts')
  const model = createClaudeCodeProvider()
    .getModels()
    .find((candidate: { id: string }) => candidate.id === 'claude-sonnet-5')!
  const bash = {
    name: 'bash',
    description: 'Run a command',
    parameters: { type: 'object', properties: {} },
  }
  const stream = streamClaudeCode(
    model,
    normalizeContext({
      messages: [
        { role: 'system', content: 'You help.', toolsAdded: [bash], timestamp: 0 },
        { role: 'user', content: 'List the files.', timestamp: 0 },
      ],
    }),
    { env: { PI_CLAUDE_CODE_COMMAND: cli }, cacheRetention: 'none' },
  )
  const ended = []
  for await (const event of stream)
    if (event.type === 'toolcall_end') ended.push(event.toolCall.name)
  const message = await stream.result()
  expect(message.errorMessage).toBeUndefined()
  expect(message.stopReason).toBe('toolUse')
  expect(ended).toEqual(['bash'])
  expect(message.content).toEqual([
    { type: 'toolCall', id: 'toolu_1', name: 'bash', arguments: { command: 'ls' } },
  ])
  // The replay carrier offers the call back under the name the request offered.
  const carrier = message.diagnostics?.find(
    (diagnostic) => diagnostic.type === 'claude-code.native-assistant.v1',
  )
  expect(JSON.stringify(carrier)).toContain('"name":"mcp__pi__bash"')
}, 60000)

it("passes a ClaudeCodeEnv provider's per-conversation environment to the CLI", async () => {
  const home = await temp()
  const cli = join(home, 'claude')
  const requests = join(home, 'requests')
  await writeFile(
    cli,
    `#!${process.execPath}
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
if (process.argv.includes('status')) {
  console.log(JSON.stringify({ loggedIn: true, subscriptionType: 'max' }))
} else {
  const emit = (event) => console.log(JSON.stringify(event))
  for await (const line of createInterface({ input: process.stdin })) {
    const frame = JSON.parse(line)
    if (frame.type !== 'user') continue
    if (frame.shouldQuery === false) {
      emit({ type: 'result', subtype: 'success', num_turns: 0 })
      continue
    }
    appendFileSync(${JSON.stringify(requests)}, process.pid + ' ' + (process.env.CLAUDE_CONFIG_DIR || '-') + ' ' + process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY + '\\n')
    const message = { id: 'msg_env', role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
    emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ok' } } })
    emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
    emit({ type: 'assistant', message })
    emit({ type: 'stream_event', event: { type: 'message_stop' } })
    emit({ type: 'result', subtype: 'success', usage: message.usage })
  }
}
`,
  )
  await chmod(cli, 0o755)
  vi.stubEnv('PI_CLAUDE_CODE_COMMAND', cli)
  vi.stubEnv('PI_CLAUDE_CODE_CONFIG_DIR', '')
  vi.stubEnv('CLAUDE_CONFIG_DIR', '')
  vi.stubEnv('CLAUDE_CODE_DISABLE_AUTO_MEMORY', undefined)
  const projectRoot = join(home, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  await writeFile(
    join(projectRoot, '.ultimate/settings.json'),
    JSON.stringify({ summaryModel: 'unavailable/test', extensions: { disable: ['tailscale'] } }),
  )
  new ProjectTrustStore(join(home, '.ultimate')).set(projectRoot, true)
  const server = await createServer({
    ultimateRoot: await sourceCopy(home),
    projectRoot,
    home: join(home, 'state'),
    userHome: home,
    port: 0,
  })
  const lines = async () =>
    (await readFile(requests, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
  try {
    const model = { provider: 'claude-code', modelId: 'claude-sonnet-5' }
    await server.host.modelRuntime.refresh({ allowNetwork: false })
    const conversation = async () => {
      const created = await server.harness.createConversation(
        { ownership: { kind: 'ownerless' }, agent: { model } },
        context,
      )
      const ask = async () =>
        (await created.submit({ type: 'input', content: 'Hi.' }, context)).wait(context)
      return Object.assign(ask, { id: created.id })
    }
    const [a, b] = [await conversation(), await conversation()]

    // Without a provider the request uses ambient config, with auto-memory off by default.
    await a()
    expect((await lines()).map((line) => line.split(' ').slice(1))).toEqual([['-', '1']])

    vi.stubEnv('CLAUDE_CODE_DISABLE_AUTO_MEMORY', '0')
    await a()
    expect((await lines()).at(-1)?.split(' ').slice(1)).toEqual(['-', '0'])
    vi.stubEnv('CLAUDE_CODE_DISABLE_AUTO_MEMORY', undefined)

    const folder = join(projectRoot, '.ultimate/extensions/claude-env')
    await mkdir(folder, { recursive: true })
    await writeFile(
      join(folder, 'server.ts'),
      `import { defineExtension } from '@earendil-works/pi-durable'
export default function (host) {
  host.implement({ name: 'claude-code.env' }, {
    env: (conversationId) => ({ PI_CLAUDE_CODE_CONFIG_DIR: '/config/' + conversationId, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' }),
  })
  return defineExtension({ name: 'claude-env' })
}
`,
    )
    server.vite.watcher.emit('change', join(folder, 'server.ts'))
    await until(() =>
      server.extensions
        .catalogue()
        .apis.some((api) => api.name === 'claude-code.env' && !!api.provider),
    )
    await a()
    await b()
    await a()
    const [, , first, second, third] = (await lines()).map((line) => line.split(' '))
    expect([first[1], second[1], third[1]]).toEqual([
      `/config/${a.id}`,
      `/config/${b.id}`,
      `/config/${a.id}`,
    ])
    expect([first[2], second[2], third[2]]).toEqual(['0', '0', '0'])
    // A distinct environment gets its own warm process; the same one reuses it.
    expect(second[0]).not.toBe(first[0])
    expect(third[0]).toBe(first[0])
  } finally {
    await server.close()
  }
}, 60000)

for (const lifecycle of ['reload', 'reopen', 'swap', 'cancel', 'permanent'] as const) {
  it(`preserves Claude Code requests across ${lifecycle}`, async () => {
    const home = await temp()
    const cli = join(home, 'claude')
    const started = join(home, 'started')
    const release = join(home, 'release')
    const workers = join(home, 'workers')
    await writeFile(
      cli,
      `#!${process.execPath}
import { existsSync, appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
if (process.argv.includes('status')) {
  console.log(JSON.stringify({ loggedIn: true, subscriptionType: 'max' }))
} else {
  appendFileSync(${JSON.stringify(workers)}, process.pid + '\\n')
  const emit = (event) => console.log(JSON.stringify(event))
  for await (const line of createInterface({ input: process.stdin })) {
    const frame = JSON.parse(line)
    if (frame.type !== 'user') continue
    if (frame.shouldQuery === false) {
      emit({ type: 'result', subtype: 'success', num_turns: 0 })
      continue
    }
    emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Recovered.' } } })
    emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
    appendFileSync(${JSON.stringify(started)}, 'request\\n')
    while (!existsSync(${JSON.stringify(release)})) await new Promise(r => setTimeout(r, 20))
    const message = { id: 'msg_test', role: 'assistant', content: [{ type: 'text', text: 'Recovered.' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
    emit({ type: 'assistant', message })
    emit({ type: 'stream_event', event: { type: 'message_stop' } })
    emit({ type: 'result', subtype: ${JSON.stringify(lifecycle)} === 'permanent' ? 'invalid_request' : 'success', is_error: ${JSON.stringify(lifecycle)} === 'permanent', usage: message.usage })
  }
}
`,
    )
    await chmod(cli, 0o755)
    vi.stubEnv('PI_CLAUDE_CODE_COMMAND', cli)
    const projectRoot = join(home, 'project')
    await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
    await writeFile(
      join(projectRoot, '.ultimate/settings.json'),
      // A real (not faux) server: keep it off this machine's tailnet. Count only lifecycle requests, not summaries
      // falling back to the mocked Claude Code provider; an explicit unavailable summary model never falls back.
      JSON.stringify({ summaryModel: 'unavailable/test', extensions: { disable: ['tailscale'] } }),
    )
    new ProjectTrustStore(join(home, '.ultimate')).set(projectRoot, true)
    const root = await sourceCopy(home)
    const facetFile = join(root, 'extensions/claude-code/server.ts')
    const facetSource = await readFile(facetFile, 'utf8')
    // Expose the retained resource, so the reload case can give it the shape an older load built.
    if (lifecycle === 'reload')
      await writeFile(
        facetFile,
        facetSource.replace(
          '  const upstream = shared.provider\n',
          '  Object.assign(globalThis, { claudeCodeShared: shared })\n  const upstream = shared.provider\n',
        ),
      )
    const options = {
      ultimateRoot: root,
      projectRoot,
      home: join(home, 'state'),
      userHome: home,
      port: 0,
    }
    let server = await createServer(options)
    const messages = async () =>
      (await server.root.entries({}, 100, undefined, context)).items.flatMap(
        (entry) => entry.model ?? [],
      )
    const model = server.host.modelRuntime.getModel('claude-code', 'claude-sonnet-5')!
    if (!isModelType(model, 'chat')) throw new Error('Expected chat model')
    try {
      await server.root.configure(
        { model: { provider: 'claude-code', modelId: 'claude-sonnet-5' } },
        context,
      )
      await server.host.modelRuntime.refresh({ allowNetwork: false })
      expect(server.host.modelRuntime.getModel('claude-code', 'claude-sonnet-5')).toBeDefined()
      const submitted = await server.root.submit(
        { type: 'input', content: 'Wait for release.' },
        context,
      )
      await until(async () => {
        const terminal = (await messages()).find(
          (message) => message.role === 'assistant' && message.stopReason !== 'pending',
        )
        if (terminal) throw new Error(JSON.stringify(terminal))
        return !!(await readFile(started, 'utf8').catch(() => ''))
      })
      // A browser refresh disconnects its event subscription, not the durable run.
      const browser = await attach(server)
      // The CLI writing its marker does not mean the host has consumed its partial yet.
      await until(() => JSON.stringify(browser.view().docs['pi.live'] ?? {}).includes('Recovered.'))
      await browser.close()
      const reconnected = await attach(server)
      await reconnected.close()
      expect(
        (await post(server, '/api/extensions/claude-code/actions/status', { args: null })).status,
      ).toBe(200)
      expect((await messages()).filter((message) => message.role === 'assistant')).toHaveLength(0)
      let reloadedServes = true
      let cancelStatus: number | undefined
      let cancelOutcome: unknown
      if (lifecycle === 'reload') {
        // Regressions: new code whose request path needs what the first load never had must load, serve the next
        // request and let the in-flight one finish. #409484 called `shared.setEnv`, then #409868 read
        // `shared.active` and `shared.facets` from a resource an older load had built without them.
        const retained = Reflect.get(globalThis, 'claudeCodeShared') as object
        Reflect.deleteProperty(retained, 'active')
        Reflect.deleteProperty(retained, 'facets')
        const provider = server.host.modelRuntime.getProvider('claude-code')
        const reloaded = facetSource
          .replace(
            'export default function claudeCode(',
            'const markReloaded = () => Object.assign(globalThis, { claudeCodeReloaded: true })\nexport default function claudeCode(',
          )
          .replace(
            'return track(upstream.streamSimple(',
            'markReloaded()\n      return track(upstream.streamSimple(',
          )
        await writeFile(facetFile, reloaded)
        server.vite.watcher.emit('change', facetFile)
        await until(() => server.host.modelRuntime.getProvider('claude-code') !== provider)
        await writeFile(release, 'ready')
        await server.harness.waitForIdle(context)
        // The in-flight request finished on the old code; only the new request runs the reloaded facet.
        reloadedServes = !('claudeCodeReloaded' in globalThis)
        await server.root.submit({ type: 'input', content: 'After reload.' }, context)
        await server.harness.waitForIdle(context)
        reloadedServes &&= 'claudeCodeReloaded' in globalThis
        Reflect.deleteProperty(globalThis, 'claudeCodeReloaded')
        Reflect.deleteProperty(globalThis, 'claudeCodeShared')
      } else if (lifecycle === 'reopen' || lifecycle === 'swap') {
        // Supervised swaps release the harness before extension cleanup; ordinary
        // close does the reverse. Exercise both orders against the same durable home.
        if (lifecycle === 'swap') await server.release()
        await server.close()
        server = await createServer(options)
        await until(async () => (await readFile(started, 'utf8')).trim().split('\n').length === 2)
      } else if (lifecycle === 'cancel') {
        cancelStatus = (await post(server, '/api/conversations/1/abort')).status
        const outcome = await submitted.wait(context)
        cancelOutcome = {
          status: outcome.status,
          reason: 'reason' in outcome ? outcome.reason : undefined,
        }
      }
      await writeFile(release, 'ready')
      await server.harness.waitForIdle(context)
      const assistants = (await messages()).filter((message) => message.role === 'assistant')
      expect(reloadedServes).toBe(true)
      expect(cancelStatus).toBe(lifecycle === 'cancel' ? 200 : undefined)
      expect(cancelOutcome).toEqual(
        lifecycle === 'cancel' ? { status: 'unanswered', reason: 'aborted' } : undefined,
      )
      expect(assistants.at(0)).toMatchObject({
        stopReason:
          lifecycle === 'cancel' ? 'aborted' : lifecycle === 'permanent' ? 'error' : 'stop',
        content: [{ type: 'text', text: 'Recovered.' }],
        ...(lifecycle === 'permanent'
          ? { errorMessage: 'Claude Code request failed: invalid_request' }
          : {}),
      })
      // The reload case's in-flight request and the one after the reload both answer.
      expect(
        lifecycle === 'reload' ? assistants.map((message) => message.stopReason) : undefined,
      ).toEqual(lifecycle === 'reload' ? ['stop', 'stop'] : undefined)
      if (lifecycle === 'cancel' || lifecycle === 'permanent') {
        await server.close()
        server = await createServer(options)
        await server.harness.waitForIdle(context)
      }
      expect((await readFile(started, 'utf8')).trim().split('\n')).toHaveLength(
        lifecycle === 'cancel' || lifecycle === 'permanent' ? 1 : 2,
      )
    } finally {
      const captured = server.host.modelRuntime.getProvider('claude-code')!
      await server.close()
      // Captured registrations must not start workers after resource cleanup began.
      expect(() => captured.streamSimple(model, normalizeContext({ messages: [] }))).toThrow(
        'provider is closing',
      )
      expect(() => captured.stream(model, normalizeContext({ messages: [] }))).toThrow(
        'provider is closing',
      )
      await until(async () =>
        (await readFile(workers, 'utf8'))
          .trim()
          .split('\n')
          .every((pid) => {
            try {
              process.kill(Number(pid), 0)
              return false
            } catch {
              return true
            }
          }),
      )
    }
  }, 60000)
}
