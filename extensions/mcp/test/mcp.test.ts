import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import mcp, { actions, secrets } from '../server.ts'
import { actions as secretActions } from '../../secrets/server.ts'
import { writeSecret } from '../../secrets/store.ts'
import type { McpServerStatus } from '../refs.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { removeTemp, temp, until } from '../../../test/helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

/** A Streamable HTTP MCP server with one `echo` tool, answering only requests that carry the token. */
async function serve(token: string) {
  const server = createServer((request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end()
      return
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end('{"error":"unauthorized"}')
      return
    }
    let text = ''
    request.on('data', (chunk) => (text += chunk))
    request.on('end', () => {
      const message = JSON.parse(text)
      const params = message.params ?? {}
      const args = params.arguments ?? {}
      if (message.id === undefined) {
        response.writeHead(202).end()
        return
      }
      const results: Record<string, unknown> = {
        initialize: {
          protocolVersion: params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'echo', version: '1.0.0' },
        },
        'tools/list': {
          tools: [
            {
              name: 'echo',
              description: 'Says it back',
              inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
            },
          ],
        },
        'tools/call': {
          content: [{ type: 'text', text: `echo: ${args.text ?? ''}` }],
          isError: args.text === undefined,
        },
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({ jsonrpc: '2.0', id: message.id, result: results[message.method] }),
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`
}

it('connects configured servers, lists and calls their tools, and isolates a failing one', async () => {
  const root = await temp()
  cleanup.push(() => removeTemp(root))
  const url = await serve('s3cret')
  await writeSecret(root, 'ECHO_TOKEN', 's3cret')
  await mkdir(join(root, '.ultimate'), { recursive: true })
  await writeFile(
    join(root, '.ultimate/settings.json'),
    JSON.stringify({
      mcpServers: {
        echo: { type: 'http', url, headers: { Authorization: 'Bearer ${ECHO_TOKEN}' } },
        locked: { url },
        broken: { args: ['no command'] },
      },
    }),
  )
  const closers: (() => Promise<void>)[] = []
  const host = {
    userHome: root,
    projectRoot: root,
    projectSettings: async () => ({}),
    onOpen: (callback: () => Promise<void>) => void callback(),
    onClose: (callback: () => Promise<void>) => closers.push(callback),
  } as unknown as ExtensionHost
  const [tool] = (await mcp(host)).tools!
  cleanup.push(async () => {
    for (const close of closers) await close()
  })
  const status = () => actions.status(null, { host } as never) as unknown as McpServerStatus[]
  await until(() => status().every((server) => server.state !== 'connecting'))
  expect(status()).toMatchObject([
    { name: 'echo', state: 'connected', tools: 1 },
    { name: 'locked', state: 'failed' },
    { name: 'broken', state: 'failed', error: 'Invalid entry: needs a command or a url' },
  ])
  const run = (args: unknown) =>
    tool.execute(args as never, {} as never, { abortSignal: new AbortController().signal } as never)

  expect(JSON.stringify(await run({ server: 'echo' }))).toContain('echo: Says it back')
  expect(await run({ server: 'echo', tool: 'echo', args: { text: 'hi' } })).toEqual({
    output: [{ type: 'text', text: 'echo: hi' }],
    isError: false,
  })
  expect(await run({ server: 'echo', tool: 'echo', args: {} })).toMatchObject({ isError: true })
  expect(await run({ server: 'locked', tool: 'echo' })).toMatchObject({
    isError: true,
    output: [{ text: expect.stringContaining('MCP server locked is failed') }],
  })
})

it('declares each ${NAME} of the configured servers as a secret, missing until it is written', async () => {
  const root = await temp()
  cleanup.push(() => removeTemp(root))
  await mkdir(join(root, '.ultimate'), { recursive: true })
  await writeFile(
    join(root, '.ultimate/settings.json'),
    JSON.stringify({
      mcpServers: {
        executor: {
          url: 'https://example.com/mcp',
          headers: { 'CF-Access-Client-Id': '${CF_ACCESS_CLIENT_ID}' },
        },
      },
    }),
  )
  const closers: (() => Promise<void>)[] = []
  const host = {
    userHome: root,
    projectRoot: root,
    projectSettings: async () => ({
      mcpServers: { tool: { command: 'x', env: { KEY: '${CF_ACCESS_CLIENT_ID}' } } },
    }),
    onOpen: (callback: () => Promise<void>) => void callback(),
    onClose: (callback: () => Promise<void>) => closers.push(callback),
    modelRuntime: { getProviderAuthStatus: () => ({ configured: false }) },
  } as unknown as ExtensionHost
  await mcp(host)
  cleanup.push(async () => {
    for (const close of closers) await close()
  })
  const declared = await secrets(host)
  expect(declared).toEqual([
    { name: 'CF_ACCESS_CLIENT_ID', description: 'Used by the MCP servers executor, tool' },
  ])
  const extensions = () => [{ name: 'mcp', enabled: true, server: { secrets: declared } }]
  const list = () => secretActions.list(null, { host: { ...host, extensions } } as never)
  expect(await list()).toMatchObject([
    { name: 'CF_ACCESS_CLIENT_ID', declaredBy: ['mcp'], set: false },
  ])
  const status = () => actions.status(null, { host } as never) as unknown as McpServerStatus[]
  await until(() => status().every((server) => server.state !== 'connecting'))
  expect(status()[0]).toMatchObject({ name: 'executor', missing: 'CF_ACCESS_CLIENT_ID' })

  await writeSecret(root, 'CF_ACCESS_CLIENT_ID', 'id')
  expect(await list()).toMatchObject([{ name: 'CF_ACCESS_CLIENT_ID', set: true }])
})
