/**
 * MCP: connects the servers in `mcpServers` (user settings, and the project's once its setup is trusted) and offers
 * their tools through one `mcp` tool, so the prompt stays the same however many tools the servers have.
 */
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { map, obj, opt, str, unknown } from '@earendil-works/pi-schema'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import type { JsonObject } from '@earendil-works/pi-durable'
import {
  McpAbortError,
  McpClient,
  McpError,
  McpTimeoutError,
  StdioTransport,
  StreamableHttpTransport,
  toLlmContent,
} from '@earendil-works/pi-mcp'
import type { Tool } from '@earendil-works/pi-mcp'
import { implementAction } from '../../lib/actions.ts'
import { readSecret } from '../../lib/secrets.ts'
import { readSettings, userSettingsPath } from '../../lib/settings.ts'
import type { ExtensionAction } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Mcp } from './api.ts'
import { ReconnectAction, StatusAction } from './refs.ts'
import type { McpServerStatus } from './refs.ts'

export const reloadOnSettings = true
export const pollActions = ['status']

/** A tool call may run long; progress notifications from the server renew it. */
const CALL_TIMEOUT = 10 * 60_000
const FIRST_RETRY = 5_000
const LAST_RETRY = 5 * 60_000

/** One `mcpServers` entry, as Claude Desktop and Cursor write it. */
type Entry =
  | { command: string; args: string[]; env: Record<string, string>; cwd?: string }
  | { url: string; headers: Record<string, string> }

type Server = Omit<McpServerStatus, 'tools'> & {
  entry?: Entry
  client?: McpClient
  tools: Tool[]
  attempts: number
  timer?: ReturnType<typeof setTimeout>
  /** The connect or reconnect running now; the next one queues behind it. */
  connecting?: Promise<void>
  /** The secret values its config resolved, kept out of every error it shows. */
  secrets: string[]
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const strings = (value: unknown) =>
  Array.isArray(value) && value.every((v) => typeof v === 'string')
const record = (value: unknown) =>
  isObject(value) && Object.values(value).every((v) => typeof v === 'string')

/** The entry, or why it cannot be used. */
function entryOf(value: unknown): Entry | string {
  if (!isObject(value)) return 'must be an object'
  if (typeof value.url === 'string') {
    if (value.type === 'sse')
      return 'the legacy SSE transport is not supported; use Streamable HTTP'
    if (value.headers !== undefined && !record(value.headers))
      return 'headers must map names to strings'
    return { url: value.url, headers: (value.headers as Record<string, string>) ?? {} }
  }
  if (typeof value.command !== 'string') return 'needs a command or a url'
  if (value.args !== undefined && !strings(value.args)) return 'args must be a list of strings'
  if (value.env !== undefined && !record(value.env)) return 'env must map names to strings'
  return {
    command: value.command,
    args: (value.args as string[]) ?? [],
    env: (value.env as Record<string, string>) ?? {},
    ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
  }
}

const SECRET = /\$\{([A-Z][A-Z0-9_]*)\}/g

/** The secrets an entry names with `${NAME}`, in its url, headers, command args and env. */
const placeholders = (entry: Entry) =>
  ('url' in entry
    ? [entry.url, ...Object.values(entry.headers)]
    : [...entry.args, ...Object.values(entry.env)]
  ).flatMap((value) => [...value.matchAll(SECRET)].map(([, name]) => name))

class MissingSecret extends Error {
  secret: string
  constructor(secret: string) {
    super(`Missing secret ${secret}: add it in the Secrets panel (⌘K → Secrets)`)
    this.secret = secret
  }
}

/** `${NAME}` in a value becomes the secret `NAME` from the Secrets panel, taken literally; `found` collects them. */
async function expand(home: string, value: string, found: string[]) {
  const values = new Map<string, string>()
  for (const [, name] of value.matchAll(SECRET)) {
    const secret = await readSecret(home, name)
    if (secret === undefined) throw new MissingSecret(name)
    values.set(name, secret)
    found.push(secret)
  }
  return value.replace(SECRET, (_token, name: string) => values.get(name)!)
}
const expandAll = async (home: string, values: Record<string, string>, found: string[]) =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(values).map(async ([key, value]) => [key, await expand(home, value, found)]),
    ),
  ) as Record<string, string>

/** An error's message with the server's secrets masked: HTTP bodies and stderr may echo them. */
const redact = (server: Server, error: unknown) =>
  server.secrets.reduce(
    (text, secret) => text.replaceAll(secret, '***'),
    error instanceof Error ? error.message : String(error),
  )

/** User servers, then the project's (empty until its setup is trusted); a project entry replaces a user one by name. */
async function configured(host: ExtensionHost) {
  const layers: [McpServerStatus['source'], JsonObject][] = [
    ['user', await readSettings(userSettingsPath(host.userHome))],
    ['project', await host.projectSettings()],
  ]
  const servers = new Map<string, Server>()
  for (const [source, settings] of layers) {
    const entries = settings.mcpServers
    if (entries === undefined) continue
    if (!isObject(entries)) throw new Error(`mcpServers in ${source} settings must be an object`)
    for (const [name, value] of Object.entries(entries)) {
      servers.delete(name)
      if (isObject(value) && value.disabled === true) continue
      const entry = entryOf(value)
      servers.set(name, {
        name,
        source,
        transport: isObject(value) && typeof value.url === 'string' ? 'http' : 'stdio',
        ...(typeof entry === 'string'
          ? { state: 'failed', error: `Invalid entry: ${entry}` }
          : { state: 'connecting', entry }),
        tools: [],
        attempts: 0,
        secrets: [],
      })
    }
  }
  return servers
}

/** Every `${NAME}` in the configured servers, declared so the Secrets panel lists it with its Add button. */
export async function secrets(host: ExtensionHost) {
  const users = new Map<string, Set<string>>()
  for (const server of (await configured(host)).values())
    for (const name of server.entry ? placeholders(server.entry) : [])
      users.set(name, (users.get(name) ?? new Set()).add(server.name))
  return [...users].map(([name, servers]) => ({
    name,
    description: `Used by the MCP server${servers.size > 1 ? 's' : ''} ${[...servers].join(', ')}`,
  }))
}

const listing = (server: Server) =>
  [
    `${server.name}: ${server.tools.length} tools. Call one with mcp {server, tool, args}.`,
    ...server.tools.map(
      (tool) =>
        `\n${tool.name}: ${tool.description?.trim() ?? tool.title ?? ''}\n  input: ${JSON.stringify(tool.inputSchema)}`,
    ),
  ].join('\n')
const failure = (text: string) => ({ output: [{ type: 'text' as const, text }], isError: true })

const views = new WeakMap<
  ExtensionHost,
  { status(): McpServerStatus[]; reconnect(name: string): Promise<void> }
>()

export const actions: Record<string, ExtensionAction> = {
  status: implementAction(StatusAction, (_args, { host }) => views.get(host)?.status() ?? []),
  reconnect: implementAction(ReconnectAction, async (args, { host }) => {
    const view = views.get(host)
    const name = isObject(args) ? args.name : undefined
    if (!view || typeof name !== 'string') throw new Error('reconnect: name is required')
    await view.reconnect(name)
    return view.status()
  }),
}

export default async function mcp(host: ExtensionHost) {
  const servers = await configured(host)
  let closed = false

  function fail(server: Server, error: string) {
    server.client = undefined
    server.state = 'failed'
    server.error = error
    const delay = Math.min(FIRST_RETRY * 2 ** server.attempts++, LAST_RETRY)
    server.retryAt = Date.now() + delay
    server.timer = setTimeout(() => void begin(server), delay)
    server.timer.unref?.()
  }

  async function connect(server: Server) {
    clearTimeout(server.timer)
    delete server.retryAt
    delete server.error
    delete server.missing
    server.state = 'connecting'
    const entry = server.entry!
    const found: string[] = []
    server.secrets = found
    const client = new McpClient({
      name: 'ultimate',
      version: '1.0.0',
      roots: [{ uri: pathToFileURL(host.projectRoot).href, name: basename(host.projectRoot) }],
    })
    server.client = client
    // Once connected, a dropped connection fails the server and retries; closing it here does not.
    client.onClose(() => {
      if (!closed && server.client === client && server.state === 'connected')
        fail(server, 'Disconnected')
    })
    let stdio: StdioTransport | undefined
    try {
      const transport =
        'url' in entry
          ? new StreamableHttpTransport({
              url: await expand(host.userHome, entry.url, found),
              headers: await expandAll(host.userHome, entry.headers, found),
            })
          : (stdio = new StdioTransport({
              command: entry.command,
              args: await Promise.all(entry.args.map((arg) => expand(host.userHome, arg, found))),
              env: await expandAll(host.userHome, entry.env, found),
              cwd: entry.cwd ?? host.projectRoot,
            }))
      await client.connect(transport)
      client.onNotification('notifications/tools/list_changed', () => {
        client
          .listTools()
          .then((tools) => {
            if (server.client === client) server.tools = tools
          })
          // The list stays as it was; the next reconnect reads it again.
          .catch((error: unknown) =>
            console.warn(`MCP ${server.name}: tools/list: ${redact(server, error)}`),
          )
      })
      const tools = await client.listTools()
      if (closed || server.client !== client) return
      server.tools = tools
      server.state = 'connected'
      server.attempts = 0
    } catch (error) {
      if (closed || server.client !== client) return
      if (error instanceof MissingSecret) server.missing = error.secret
      const stderr = stdio?.stderr.trim().split('\n').at(-1)
      fail(
        server,
        [redact(server, error), stderr && redact(server, stderr)].filter(Boolean).join(': '),
      )
      await close(client)
    }
  }

  async function close(client: McpClient | undefined) {
    try {
      await client?.close()
    } catch (error) {
      // Closing is best effort: the transport is gone either way, and the server shows its own state.
      console.warn('MCP close', error instanceof Error ? error.message : error)
    }
  }

  /** Runs `work` after the server's current connect or reconnect, so only one client is ever being set up. */
  function queue(server: Server, work: () => Promise<void>) {
    const next = (server.connecting ?? Promise.resolve()).then(work)
    server.connecting = next
    // work never rejects (connect and close report into the server's state).
    // oxlint-disable-next-line typescript/no-floating-promises -- see above.
    void next.finally(() => {
      if (server.connecting === next) delete server.connecting
    })
    return next
  }

  function begin(server: Server) {
    if (closed || !server.entry) return Promise.resolve()
    return server.connecting ?? queue(server, () => connect(server))
  }

  /** Drops the server's client and connects again. */
  function restart(server: Server) {
    if (closed || !server.entry) return Promise.resolve()
    return queue(server, async () => {
      const previous = server.client
      server.client = undefined
      await close(previous)
      server.attempts = 0
      await connect(server)
    })
  }

  views.set(host, {
    status: () =>
      [...servers.values()].map((server) => ({
        name: server.name,
        source: server.source,
        transport: server.transport,
        state: server.state,
        ...(server.state === 'connected' ? { tools: server.tools.length } : {}),
        ...(server.error ? { error: server.error } : {}),
        ...(server.missing ? { missing: server.missing } : {}),
        ...(server.retryAt ? { retryAt: server.retryAt } : {}),
      })),
    async reconnect(name) {
      const server = servers.get(name)
      if (!server) throw new Error(`No MCP server named ${name}`)
      await restart(server)
    },
  })

  let started = false
  host.onOpen(async () => {
    if (started) return
    started = true
    // Each server reports its own failure in its state, and connect() never rejects; none waits for another.
    // oxlint-disable-next-line typescript/no-floating-promises -- see above.
    for (const server of servers.values()) void begin(server)
  })
  host.onClose(async () => {
    closed = true
    for (const server of servers.values()) clearTimeout(server.timer)
    await Promise.all([...servers.values()].map((server) => close(server.client)))
  })

  const names = [...servers.keys()]

  /** The server once its current connect settles; throws when it is unknown or not connected. */
  async function connected(name: string) {
    const server = servers.get(name)
    if (!server) throw new Error(`No MCP server named ${name}. Configured: ${names.join(', ')}`)
    await server.connecting
    if (server.state !== 'connected' || !server.client)
      throw new Error(`MCP server ${name} is ${server.state}: ${server.error ?? 'not connected'}`)
    return server
  }

  /** Calls one tool for the `mcp` tool and the Mcp service; throws when the call fails. */
  async function call(
    name: string,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ) {
    const server = await connected(name)
    const client = server.client!
    try {
      return await client.callTool(tool, args, {
        ...(signal ? { signal } : {}),
        timeoutMs: CALL_TIMEOUT,
        // Asking for progress lets each notification renew the timeout.
        onProgress: () => {},
      })
    } catch (error) {
      // A JSON-RPC error, a timeout or a cancel leaves the connection usable. Anything else (an HTTP
      // failure, an expired session, a closed transport) does not: connect again, never resend the call.
      const broken = !(
        error instanceof McpError ||
        error instanceof McpTimeoutError ||
        error instanceof McpAbortError
      )
      // restart never rejects; the server's state shows how it went.
      // oxlint-disable-next-line typescript/no-floating-promises -- see above.
      if (broken && server.client === client) void restart(server)
      throw new Error(`MCP ${name}/${tool} failed: ${redact(server, error)}`, { cause: error })
    }
  }

  host.implement(Mcp, {
    call: (server, tool, args, options) => call(server, tool, args ?? {}, options?.signal),
  })

  return defineExtension({
    name: 'mcp',
    tools: names.length
      ? [
          defineTool({
            name: 'mcp',
            description:
              `Use the tools of the configured MCP servers: ${names.join(', ')}. ` +
              "mcp {server} lists a server's tools with their input schemas; mcp {server, tool, args} calls one. " +
              'In codemode, tools.mcp(...) runs many calls and filters their results.',
            parameters: obj({
              server: str({ description: `One of: ${names.join(', ')}` }),
              tool: opt(str({ description: "The tool to call; omit to list the server's tools" })),
              args: opt(
                map(unknown(), {
                  description: "The tool's arguments, matching its input schema",
                }),
              ),
            }),
            async execute({ server: name, tool, args }, _api, context) {
              try {
                if (!tool)
                  return { output: [{ type: 'text', text: listing(await connected(name)) }] }
                const result = await call(name, tool, args ?? {}, context.abortSignal)
                return { output: toLlmContent(result), isError: result.isError === true }
              } catch (error) {
                return failure(error instanceof Error ? error.message : String(error))
              }
            },
          }),
        ]
      : [],
  })
}
