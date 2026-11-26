#!/usr/bin/env node
import { parseArgs } from 'node:util'
import type { JsonValue } from '@earendil-works/chord/json'
import {
  createOrchestratorClient,
  listRunningInstances,
  resolveInstanceUrl,
} from '../lib/orchestrator-client.ts'

const usage = `Usage: ultimate-orch <command> [args] [options]

Commands:
  projects                       List running Ultimate instances on this machine
  status                         Show instance status, branches and open questions
  ensure                         Ensure the passive orchestrator conversation exists
  branch <prompt>                Start a coordinator branch owned by this orchestrator
  message <to> <text>            Send a message to #<id> or @ultimate
  tell-ultimate <text>           Message @ultimate (add --wait to wait for its reply)
  note <id|root> <text>          Leave a non-waking note on #<id> or root
  inbox                          Read orchestrator inbox entries since --since
  watch                          Block until a new report, reply or landing arrives
  entries <id>                   Read compact entries of a conversation
  search <text>                  Search conversation entries
  conclude <id...>               Conclude one or more branch conversations
  resume <id...>                 Resume concluded conversations
  memory                         Read project root memories
  remember <json-ops>            Apply an atomic memory ops JSON array
  restart                        Trigger a live core swap

Options:
  --dir <path>                   Project directory (default: cwd)
  --url <url>                    Explicit Ultimate URL (default: from ultimate.lock)
  --name <label>                 Orchestrator display name (default: Antigravity)
  --title <text>                 Branch title (max 60 chars)
  --family <name>                Coordinator model family override
  --root <id>                    Explicit root conversation id
  --no-isolated                  Run branch without a git worktree
  --no-reply                     Send a one-way message
  --steer                        Steer recipient if busy
  --since <entryId>              Inbox cursor (entry id)
  --limit <n>                    Maximum entries to return
  --timeout <seconds>            Watch/wait timeout in seconds (default: 120)
  --wait                         For tell-ultimate: wait for @ultimate's reply
  --conversation <id>            Filter search to one conversation
  -h, --help                     Show this help`

const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)

const intArg = (raw: string | undefined, name: string) => {
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`)
  return value
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      dir: { type: 'string' },
      url: { type: 'string' },
      name: { type: 'string' },
      title: { type: 'string' },
      family: { type: 'string' },
      root: { type: 'string' },
      'no-isolated': { type: 'boolean' },
      'no-reply': { type: 'boolean' },
      steer: { type: 'boolean' },
      since: { type: 'string' },
      limit: { type: 'string' },
      timeout: { type: 'string' },
      wait: { type: 'boolean' },
      conversation: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  })
  const [command, ...rest] = positionals
  if (values.help || !command) {
    process.stdout.write(`${usage}\n`)
    return
  }
  if (command === 'projects') {
    print(await listRunningInstances())
    return
  }
  const url = await resolveInstanceUrl({ dir: values.dir, url: values.url })
  const client = createOrchestratorClient(url, values.name)
  switch (command) {
    case 'ensure':
      print(await client.ensure())
      return
    case 'status': {
      const [status, inbox] = await Promise.all([client.status(), client.inbox({ limit: 10 })])
      print({ url, status, orchestrator: inbox })
      return
    }
    case 'branch': {
      const prompt = rest.join(' ').trim()
      if (!prompt) throw new Error('Expected branch prompt')
      print(
        await client.branch({
          prompt,
          ...(values.title ? { title: values.title } : {}),
          ...(values.family ? { family: values.family } : {}),
          ...(values.root === undefined ? {} : { root: intArg(values.root, 'root') }),
          ...(values['no-isolated'] ? { isolated: false } : {}),
        }),
      )
      return
    }
    case 'message': {
      const [to, ...parts] = rest
      const text = parts.join(' ').trim()
      if (!to || !text) throw new Error('Expected: message <to> <text>')
      print(
        await client.message({
          to,
          text,
          ...(values['no-reply'] ? { reply: false } : {}),
          ...(values.steer ? { steer: true } : {}),
        }),
      )
      return
    }
    case 'tell-ultimate': {
      const text = rest.join(' ').trim()
      if (!text) throw new Error('Expected: tell-ultimate <text>')
      const before = values.wait ? (await client.inbox({ limit: 1 })).cursor : 0
      const sent = await client.message({
        to: '@ultimate',
        text,
        reply: !values['no-reply'],
        ...(values.steer ? { steer: true } : {}),
      })
      if (!values.wait) {
        print(sent)
        return
      }
      const reply = await client.waitUntil({
        since: before,
        timeoutSeconds: intArg(values.timeout, 'timeout') ?? 120,
      })
      print({ sent, inbox: reply })
      return
    }
    case 'note': {
      const [target, ...parts] = rest
      const text = parts.join(' ').trim()
      if (!target || !text) throw new Error('Expected: note <id|root> <text>')
      const to = target === 'root' ? 'root' : intArg(target.replace(/^#/, ''), 'to')!
      print(await client.note({ to, text }))
      return
    }
    case 'inbox':
      print(
        await client.inbox({
          ...(values.since === undefined ? {} : { since: intArg(values.since, 'since') }),
          ...(values.limit === undefined ? {} : { limit: intArg(values.limit, 'limit') }),
        }),
      )
      return
    case 'watch':
      print(
        await client.waitUntil({
          ...(values.since === undefined ? {} : { since: intArg(values.since, 'since') }),
          ...(values.limit === undefined ? {} : { limit: intArg(values.limit, 'limit') }),
          timeoutSeconds: intArg(values.timeout, 'timeout') ?? 120,
        }),
      )
      return
    case 'entries': {
      const id = intArg(rest[0]?.replace(/^#/, ''), 'id')
      if (id === undefined) throw new Error('Expected: entries <id>')
      const limit = intArg(values.limit, 'limit')
      print(await client.entries(id, limit === undefined ? {} : { limit }))
      return
    }
    case 'search': {
      const query = rest.join(' ').trim()
      if (!query) throw new Error('Expected: search <text>')
      const conversationId = intArg(values.conversation?.replace(/^#/, ''), 'conversation')
      const limit = intArg(values.limit, 'limit')
      print(
        await client.search(query, {
          ...(conversationId === undefined ? {} : { conversationId }),
          ...(limit === undefined ? {} : { limit }),
        }),
      )
      return
    }
    case 'conclude': {
      const ids = rest.map((raw) => intArg(raw.replace(/^#/, ''), 'id')!)
      if (!ids.length) throw new Error('Expected: conclude <id...>')
      print(await client.conclude(ids))
      return
    }
    case 'resume': {
      const ids = rest.map((raw) => intArg(raw.replace(/^#/, ''), 'id')!)
      if (!ids.length) throw new Error('Expected: resume <id...>')
      print(await client.resume(ids))
      return
    }
    case 'memory':
      print(await client.memory(intArg(values.root, 'root')))
      return
    case 'remember': {
      const raw = rest.join(' ').trim()
      if (!raw) throw new Error('Expected: remember <json-ops>')
      const ops = JSON.parse(raw) as JsonValue[]
      print(await client.remember(ops, intArg(values.root, 'root')))
      return
    }
    case 'restart':
      print(await client.restart())
      return
    default:
      throw new Error(`Unknown command: ${command}`)
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
