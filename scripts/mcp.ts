#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import type { JsonValue } from '@earendil-works/chord/json'
import { inProcess } from '../lib/errors.ts'
import {
  createOrchestratorClient,
  listRunningInstances,
  resolveInstanceUrl,
} from '../lib/orchestrator-client.ts'
import type { OrchestratorClient } from '../lib/orchestrator-client.ts'

export type RpcRequest = {
  jsonrpc: '2.0'
  id?: number | string | null
  method?: string
  params?: Record<string, unknown>
}

export type RpcResponse = {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: { code: number; message: string }
}

const PROTOCOL_VERSION = '2024-11-05'

export const MCP_TOOLS = [
  {
    name: 'ultimate_projects',
    description:
      'List all running Ultimate project instances on this machine with their URLs and ports.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ultimate_status',
    description:
      'Get Ultimate instance health, busy count, failures, open user questions, extensions, and orchestrated branches.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Optional project directory override.' },
        url: { type: 'string', description: 'Optional Ultimate instance URL override.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ultimate_branch',
    description:
      'Start an Ultimate coordinator branch in an isolated git worktree, owned by the external orchestrator so reports and landings come back to your inbox without waking internal @ultimate.',
    inputSchema: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'Self-contained branch task prompt.' },
        title: { type: 'string', description: 'Short one-line title (max 60 chars).' },
        family: { type: 'string', description: 'Optional model family override.' },
        root: { type: 'integer', description: 'Optional explicit root conversation id.' },
        isolated: { type: 'boolean', description: 'Create an isolated worktree (default true).' },
        dir: { type: 'string' },
        url: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ultimate_message',
    description:
      'Send a message from the external orchestrator to a branch (#<id>) to steer/weigh in on decisions, or to @ultimate to delegate or hand off work.',
    inputSchema: {
      type: 'object',
      required: ['to', 'text'],
      properties: {
        to: { type: 'string', description: 'Recipient address: #<conversationId> or @ultimate.' },
        text: { type: 'string', description: 'Message body.' },
        reply: { type: 'boolean', description: 'Expect a reply back in inbox (default true).' },
        steer: { type: 'boolean', description: 'Steer immediately if recipient is busy.' },
        dir: { type: 'string' },
        url: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ultimate_inbox',
    description:
      'Read new branch reports, @ultimate replies, decision requests, and landing cards delivered to the external orchestrator after entry id `since`.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'integer', description: 'Return entries with id greater than since.' },
        limit: { type: 'integer', description: 'Maximum entries (default 50, max 200).' },
        dir: { type: 'string' },
        url: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ultimate_wait',
    description:
      'Wait reactively (event-driven, no polling) for a new branch report, @ultimate reply, or landing card after entry id `since`.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'integer', description: 'Wait for entries with id greater than since.' },
        timeoutSeconds: {
          type: 'integer',
          description: 'Maximum seconds to wait (default 60, max 300).',
        },
        limit: { type: 'integer' },
        dir: { type: 'string' },
        url: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ultimate_inspect',
    description:
      'Inspect a conversation transcript (entries), list conversations, or search across entries.',
    inputSchema: {
      type: 'object',
      required: ['mode'],
      properties: {
        mode: { type: 'string', enum: ['entries', 'search', 'conversations', 'addresses'] },
        conversationId: { type: 'integer', description: 'Conversation id for entries/search.' },
        query: { type: 'string', description: 'Search text when mode is search.' },
        limit: { type: 'integer' },
        dir: { type: 'string' },
        url: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ultimate_conclude',
    description: 'Conclude finished or tabled branch conversations by id.',
    inputSchema: {
      type: 'object',
      required: ['ids'],
      properties: {
        ids: { type: 'array', items: { type: 'integer' } },
        dir: { type: 'string' },
        url: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ultimate_memory',
    description: 'Read project root memories, or apply an atomic batch of remember ops.',
    inputSchema: {
      type: 'object',
      properties: {
        ops: {
          type: 'array',
          description: 'When provided, applies these remember ops; otherwise reads memories.',
          items: { type: 'object' },
        },
        root: { type: 'integer' },
        dir: { type: 'string' },
        url: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ultimate_todo',
    description: 'Add a project to-do or mark one done.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['add', 'done'] },
        text: { type: 'string' },
        owner: { type: 'string', enum: ['ultimate', 'user'] },
        id: { type: 'integer' },
        dir: { type: 'string' },
        url: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ultimate_restart',
    description: 'Trigger a live core swap on Ultimate (use after a landing that needs restart).',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string' },
        url: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
] as const

export type ClientFactory = (options: { dir?: string; url?: string }) => Promise<OrchestratorClient>

const str = (value: unknown) => (typeof value === 'string' ? value : undefined)
const reqStr = (value: unknown, name: string) => {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${name} must be a nonempty string`)
  return value
}
const num = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined

async function runTool(
  name: string,
  args: Record<string, unknown>,
  getClient: ClientFactory,
): Promise<unknown> {
  if (name === 'ultimate_projects') return listRunningInstances()
  const client = await getClient({ dir: str(args.dir), url: str(args.url) })
  switch (name) {
    case 'ultimate_status': {
      const [status, inbox] = await Promise.all([client.status(), client.inbox({ limit: 10 })])
      return { url: client.baseUrl, status, orchestrator: inbox }
    }
    case 'ultimate_branch':
      return client.branch({
        prompt: reqStr(args.prompt, 'prompt'),
        ...(str(args.title) ? { title: str(args.title) } : {}),
        ...(str(args.family) ? { family: str(args.family) } : {}),
        ...(num(args.root) === undefined ? {} : { root: num(args.root) }),
        ...(typeof args.isolated === 'boolean' ? { isolated: args.isolated } : {}),
      })
    case 'ultimate_message':
      return client.message({
        to: reqStr(args.to, 'to'),
        text: reqStr(args.text, 'text'),
        ...(typeof args.reply === 'boolean' ? { reply: args.reply } : {}),
        ...(typeof args.steer === 'boolean' ? { steer: args.steer } : {}),
      })
    case 'ultimate_inbox':
      return client.inbox({
        ...(num(args.since) === undefined ? {} : { since: num(args.since) }),
        ...(num(args.limit) === undefined ? {} : { limit: num(args.limit) }),
      })
    case 'ultimate_wait': {
      const timeoutSeconds = Math.min(Math.max(num(args.timeoutSeconds) ?? 60, 1), 300)
      return client.waitUntil({
        ...(num(args.since) === undefined ? {} : { since: num(args.since) }),
        ...(num(args.limit) === undefined ? {} : { limit: num(args.limit) }),
        timeoutSeconds,
      })
    }
    case 'ultimate_inspect': {
      const mode = str(args.mode)
      const limit = num(args.limit)
      if (mode === 'conversations') return client.conversations()
      if (mode === 'addresses') return client.addresses()
      if (mode === 'entries') {
        const id = num(args.conversationId)
        if (id === undefined) throw new Error('conversationId is required for mode=entries')
        return client.entries(id, limit === undefined ? {} : { limit })
      }
      if (mode === 'search') {
        const query = str(args.query)
        if (!query) throw new Error('query is required for mode=search')
        const conversationId = num(args.conversationId)
        return client.search(query, {
          ...(conversationId === undefined ? {} : { conversationId }),
          ...(limit === undefined ? {} : { limit }),
        })
      }
      throw new Error(`Unknown inspect mode: ${String(mode)}`)
    }
    case 'ultimate_conclude': {
      const ids = Array.isArray(args.ids) ? args.ids.filter((id) => typeof id === 'number') : []
      if (!ids.length) throw new Error('ids must be a nonempty array of conversation ids')
      return client.conclude(ids)
    }
    case 'ultimate_memory':
      if (Array.isArray(args.ops)) return client.remember(args.ops as JsonValue[], num(args.root))
      return client.memory(num(args.root))
    case 'ultimate_todo':
      if (args.action === 'add')
        return client.todoAdd(
          reqStr(args.text, 'text'),
          args.owner === 'user' ? 'user' : 'ultimate',
        )
      if (args.action === 'done') {
        const id = num(args.id)
        if (id === undefined) throw new Error('id is required for todo done')
        return client.todoDone(id)
      }
      throw new Error(`Unknown todo action: ${String(args.action)}`)
    case 'ultimate_restart':
      return client.restart()
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

export async function handleMcpRequest(
  request: RpcRequest,
  getClient: ClientFactory,
): Promise<RpcResponse | undefined> {
  if (request.id === undefined) return undefined
  const id = request.id
  try {
    switch (request.method ?? '') {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'ultimate-orchestrator', version: '1.0.0' },
          },
        }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} }
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } }
      case 'tools/call': {
        const params = request.params ?? {}
        const name = str(params.name)
        if (!name) throw new Error('Missing tool name')
        const rawArgs =
          params.arguments &&
          typeof params.arguments === 'object' &&
          !Array.isArray(params.arguments)
            ? (params.arguments as Record<string, unknown>)
            : {}
        try {
          const result = await runTool(name, rawArgs, getClient)
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            },
          }
        } catch (error) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: error instanceof Error ? error.message : String(error),
                },
              ],
            },
          }
        }
      }
      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${String(request.method)}` },
        }
    }
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

async function runStdio() {
  const { values } = parseArgs({
    options: {
      dir: { type: 'string' },
      url: { type: 'string' },
      name: { type: 'string' },
    },
    allowPositionals: true,
  })
  const getClient: ClientFactory = async (override) => {
    const resolved = await resolveInstanceUrl({
      dir: override.dir ?? values.dir,
      url: override.url ?? values.url,
    })
    return createOrchestratorClient(resolved, values.name)
  }
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      let message: RpcRequest
      try {
        message = JSON.parse(line) as RpcRequest
      } catch (error) {
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32700,
              message: error instanceof Error ? error.message : 'Parse error',
            },
          })}\n`,
        )
        continue
      }
      inProcess(
        'stdio MCP request belongs to this CLI process',
        handleMcpRequest(message, getClient).then(
          (response) => {
            if (response) process.stdout.write(`${JSON.stringify(response)}\n`)
          },
          (error: unknown) => {
            if (message.id !== undefined)
              process.stdout.write(
                `${JSON.stringify({
                  jsonrpc: '2.0',
                  id: message.id,
                  error: {
                    code: -32603,
                    message: error instanceof Error ? error.message : String(error),
                  },
                })}\n`,
              )
          },
        ),
      )
    }
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await runStdio()
