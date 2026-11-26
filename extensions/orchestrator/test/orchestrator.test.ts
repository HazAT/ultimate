import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId } from '@earendil-works/pi-durable'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { fauxServer, seedTally, temp, until } from '../../../test/helpers.ts'
import { context } from '../../../server/harness.ts'
import { createOrchestratorClient } from '../../../lib/orchestrator-client.ts'
import { handleMcpRequest } from '../../../scripts/mcp.ts'
import { Standing } from '../../subagents/api.ts'
import { Started } from '../../messages/addresses.ts'

type RunningServer = Awaited<ReturnType<typeof fauxServer>>
const servers: RunningServer[] = []

afterEach(async () => {
  const closing = servers.splice(0)
  for (const server of closing) await server.close()
})

async function boot() {
  const home = await temp('ultimate-orch-')
  const userHome = await temp('ultimate-orch-user-')
  await mkdir(join(userHome, '.ultimate'), { recursive: true })
  await writeFile(
    join(userHome, '.ultimate/settings.json'),
    JSON.stringify({ summaryModel: 'unavailable/test' }),
  )
  const faux = fauxProvider()
  const server = await fauxServer({
    home,
    userHome,
    ultimateRoot: resolve('.'),
    projectRoot: resolve('.'),
    faux,
  })
  servers.push(server)
  await seedTally(server.harness)
  const client = createOrchestratorClient(server.url, 'Antigravity')
  return { server, faux, client }
}

it('starts a coordinator branch owned by the passive orchestrator, delivers replies to inbox, and never wakes @ultimate', async () => {
  const { server, faux, client } = await boot()
  faux.setResponses([fauxAssistantMessage([fauxText('Branch work complete.')])])

  const started = await client.branch({
    prompt: 'Implement small fix',
    title: 'Small fix',
    isolated: false,
  })
  expect(started.id).toBeGreaterThan(1)
  expect(started.orchestratorId).toBeGreaterThan(1)

  const startedBy = await server.harness.snapshot(Started, started.id as ConversationId, context)
  expect(startedBy?.by).toBe(started.orchestratorId)

  const waited = await client.wait({ since: 0, timeoutMs: 5_000 })
  expect(waited.timedOut).toBe(false)
  expect(waited.items.some((item) => item.kind === 'board.reply' && item.from === started.id)).toBe(
    true,
  )
  const reply = waited.items.find((item) => item.kind === 'board.reply' && item.from === started.id)
  expect(reply?.text).toContain('Branch work complete.')

  const standing = await server.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context)
  expect(standing?.ultimate).toBeUndefined()
  expect(faux.state.callCount).toBe(1)

  const orchestrator = await server.harness.conversation(
    started.orchestratorId as ConversationId,
    context,
  )
  await expect(
    orchestrator!.submit({ type: 'input', content: 'Should never run' }, context),
  ).rejects.toThrow('External orchestrator conversations do not run a model turn')
})

it('routes a branch decision request to the orchestrator inbox and settles it when the orchestrator replies', async () => {
  const { faux, client } = await boot()
  const { id: orchestratorId } = await client.ensure()

  faux.setResponses([
    fauxAssistantMessage([fauxText('Assessment ready. Standing by.')]),
    fauxAssistantMessage(
      [
        fauxToolCall('message', {
          to: `#${orchestratorId}`,
          text: 'Decisions: 1a fast path or 1b full refactor?',
          reply: true,
        }),
      ],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage([fauxText('Waiting for orchestrator decision.')]),
    fauxAssistantMessage([fauxText('Applied 1a fast path.')]),
  ])

  const started = await client.branch({
    prompt: 'Assess approach',
    title: 'Assess approach',
    isolated: false,
  })

  const first = await client.wait({ since: 0, timeoutMs: 5_000 })
  expect(
    first.items.some(
      (item) => item.from === started.id && item.text?.includes('Assessment ready.'),
    ),
  ).toBe(true)

  await client.message({ to: `#${started.id}`, text: 'Proceed and ask if blocked.', reply: false })

  const decisionWait = await client.wait({ since: first.cursor, timeoutMs: 5_000 })
  expect(decisionWait.timedOut).toBe(false)
  const decisionMsg = decisionWait.items.find(
    (item) =>
      item.kind === 'board.message' &&
      item.from === started.id &&
      item.text?.includes('Decisions: 1a'),
  )
  expect(decisionMsg).toBeDefined()
  expect(decisionWait.branches.find((b) => b.id === started.id)?.waiting).toBe(true)

  await client.message({ to: `#${started.id}`, text: 'Decided: 1a.' })

  await until(async () => {
    const inbox = await client.inbox({ since: decisionWait.cursor })
    return inbox.items.some(
      (item) => item.from === started.id && item.text?.includes('Applied 1a fast path.'),
    )
  })
})

it('messages @ultimate directly as Antigravity and receives @ultimate reply back in the passive inbox', async () => {
  const { faux, client } = await boot()
  let seenPrompt = ''
  faux.setResponses([
    (req) => {
      const last = req.messages.at(-1)
      if (last?.role === 'user')
        seenPrompt =
          typeof last.content === 'string'
            ? last.content
            : last.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
      return fauxAssistantMessage([fauxText('Handed off to @ultimate.')])
    },
  ])

  const before = await client.inbox({ since: 0 })
  await client.message({ to: '@ultimate', text: 'Keep watching the build overnight.' })

  const waited = await client.wait({ since: before.cursor, timeoutMs: 5_000 })
  expect(waited.timedOut).toBe(false)
  const reply = waited.items.find((item) => item.kind === 'board.reply')
  expect(reply?.text).toBe('Handed off to @ultimate.')
  expect(seenPrompt).toContain('(Antigravity)')
  expect(seenPrompt).toContain('Keep watching the build overnight.')
})

it('manages project root memory and serves MCP initialize, tools/list, and tools/call', async () => {
  const { client } = await boot()
  const getClient = async () => client

  const init = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' }, getClient)
  expect(init?.result).toMatchObject({ serverInfo: { name: 'ultimate-orchestrator' } })

  const listed = await handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, getClient)
  expect(listed).toBeDefined()
  const tools = (listed!.result as { tools: { name: string }[] }).tools.map((t) => t.name)
  expect(tools).toEqual(
    expect.arrayContaining([
      'ultimate_projects',
      'ultimate_status',
      'ultimate_branch',
      'ultimate_message',
      'ultimate_inbox',
      'ultimate_wait',
      'ultimate_inspect',
      'ultimate_conclude',
      'ultimate_memory',
      'ultimate_todo',
      'ultimate_restart',
    ]),
  )

  const writeMemory = await handleMcpRequest(
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'ultimate_memory',
        arguments: {
          ops: [
            {
              op: 'add',
              slug: 'release-rule',
              kind: 'decision',
              line: 'Tag releases with semver',
              body: 'Always tag releases with vX.Y.Z.',
            },
          ],
        },
      },
    },
    getClient,
  )
  expect(writeMemory).toBeDefined()
  const writeResult = JSON.parse(
    (writeMemory!.result as { content: [{ text: string }] }).content[0].text,
  ) as { root: number; summary: string }
  expect(writeResult.root).toBe(1)

  const readMemory = await handleMcpRequest(
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'ultimate_memory', arguments: {} },
    },
    getClient,
  )
  expect(readMemory).toBeDefined()
  const readResult = JSON.parse(
    (readMemory!.result as { content: [{ text: string }] }).content[0].text,
  ) as { memories: Record<string, { line: string }> }
  expect(readResult.memories['release-rule']?.line).toBe('Tag releases with semver')

  const unknown = await handleMcpRequest(
    {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'nonexistent', arguments: {} },
    },
    getClient,
  )
  expect(unknown).toBeDefined()
  expect((unknown!.result as { isError?: boolean }).isError).toBe(true)
})
