import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Message } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate'
import { defineTask, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { afterAll, beforeAll, expect } from 'vitest'
import { context } from '../../../server/harness.ts'
import {
  branchProbe,
  fauxServer,
  post,
  seedTally,
  sourceCopy,
  temp,
} from '../../../test/helpers.ts'

// Shared by the lineage test files: importing this registers their source fixture and server cleanup.
let ultimateRoot: string
beforeAll(async () => {
  ultimateRoot = await sourceCopy(await temp())
  await branchProbe(ultimateRoot)
  await writeFile(
    join(ultimateRoot, '.ultimate/settings.json'),
    JSON.stringify({
      summaryModel: 'unavailable/test',
      extensions: { enable: ['plan', 'subagents'] },
    }),
  )
})

export type Server = Awaited<ReturnType<typeof fauxServer>>
export const servers: Server[] = []
// Each test owns its durable home; share only the read-only source fixture.
afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

export const textOf = (content: unknown) =>
  typeof content === 'string'
    ? content
    : ((content ?? []) as { type: string; text?: string }[])
        .flatMap((part) => (part.type === 'text' ? [part.text!] : []))
        .join('')

/** The installed `lineage` prompt section as it renders for `id`. */
export function section(server: Server, id: ConversationId) {
  const lineage = server.host.registry.snapshot().extension('lineage')!.sections![0]
  return lineage.render({ conversationId: id } as Parameters<typeof lineage.render>[0], context)
}

/**
 * A faux server whose provider answers lineage summaries with LINEAGE SUMMARY and everything else with the last user
 * text echoed; `requests` keeps every conversation request's messages.
 */
export async function fixture(reopen?: string) {
  const home = reopen ?? (await temp('ultimate-lineage-'))
  const server = await fauxServer({ ultimateRoot, home, userHome: home })
  servers.push(server)
  const requests: Message[][] = []
  const condensed: string[] = []
  /** While `condense` is set, compaction summaries wait for it. */
  const gate: { condense?: Promise<void> } = {}
  const route: FauxResponseFactory = async (transcript) => {
    server.host.faux!.appendResponses([route])
    const [system, first] = transcript.messages
    if (textOf(system.content).startsWith('You condense')) {
      condensed.push(textOf(first.content))
      await gate.condense
      return fauxAssistantMessage(`LINEAGE SUMMARY of ${textOf(first.content).slice(0, 40)}`)
    }
    requests.push([...transcript.messages])
    const final = transcript.messages.at(-1)!
    if (final.role === 'toolResult') return fauxAssistantMessage(`Tool: ${textOf(final.content)}`)
    const last = transcript.messages.findLast((message) => message.role === 'user')
    if (textOf(last?.content).startsWith('NOTIFY '))
      return fauxAssistantMessage(
        [fauxToolCall('notify', JSON.parse(textOf(last?.content).slice(7)))],
        { stopReason: 'toolUse' },
      )
    return fauxAssistantMessage(`echo ${textOf(last?.content)}`)
  }
  server.host.faux!.setResponses([route])
  return { server, home, requests, condensed, gate }
}

export const branchFrom = async (server: Server, args: Record<string, unknown>) => {
  // An empty first conversation is a root that read nothing yet; one with history stays an ordinary root.
  if (args.from === 1) await seedTally(server.harness)
  const { status, data } = await post(server, '/api/extensions/branch-probe/actions/branch', {
    args,
  })
  expect([status, data.error]).toEqual([200, undefined])
  return data.result.id as ConversationId
}

/** Wait until `id`'s prompt is delivered and answered. */
export const settled = async (server: Server, id: ConversationId) => {
  const conversation = (await server.harness.conversation(id, context))!
  await conversation.waitForIdle(context)
  return conversation
}

/** The model's view of a conversation as [role, text] pairs, system messages left out. */
export const said = (messages: readonly Message[]) =>
  messages
    .filter((message) => message.role !== 'system')
    .map((message) => [message.role, textOf(message.content)])

export const tallyTokens = async (server: Server, id: ConversationId) =>
  (await (await server.harness.conversation(id, context))!.context(context)).messages.reduce(
    (sum, message) => sum + estimateMessageTokens(message),
    0,
  )

export const image = { type: 'image', data: 'aW1n', mimeType: 'image/png' } as const

/**
 * A faux server where `NOTIFY {json}` calls the notify tool, `SEND {json}` the message tool, and `HOLD` answers only
 * once released.
 */
export async function notifyFixture(reopen?: string) {
  const home = reopen ?? (await temp('ultimate-lineage-'))
  const server = await fauxServer({ ultimateRoot, home, userHome: home })
  servers.push(server)
  const hold = Promise.withResolvers<void>()
  const route: FauxResponseFactory = async (transcript, options) => {
    server.host.faux!.appendResponses([route])
    // A system prompt that changed since the last run follows the history.
    const last = transcript.messages.findLast((message) => message.role !== 'system')!
    const text = textOf(last.content)
    if (last.role === 'toolResult') return fauxAssistantMessage(`Tool: ${text}`)
    if (text.startsWith('NOTIFY '))
      return fauxAssistantMessage([fauxToolCall('notify', JSON.parse(text.slice(7)))], {
        stopReason: 'toolUse',
      })
    if (text.startsWith('SEND '))
      return fauxAssistantMessage([fauxToolCall('message', JSON.parse(text.slice(5)))], {
        stopReason: 'toolUse',
      })
    if (text === 'HOLD')
      await Promise.race([
        hold.promise,
        new Promise((_, fail) =>
          options?.signal?.addEventListener('abort', () => fail(new Error('aborted'))),
        ),
      ])
    return fauxAssistantMessage(`echo ${text}`)
  }
  server.host.faux!.setResponses([route])
  return { server, home, release: () => hold.resolve() }
}

/** A second top-level conversation with the root's model. */
export async function second(server: Server) {
  const { model } = await server.root.agent(context)
  return server.harness.createConversation(
    { ownership: { kind: 'ownerless' }, agent: { model } },
    context,
  )
}

export const ask = async (server: Server, id: ConversationId, content: string) =>
  (
    await (await server.harness.conversation(id, context))!.submit(
      { type: 'input', content },
      context,
    )
  ).wait(context)

export const pendingNotifies = (server: Server) =>
  server.harness.commit(
    async (tx) =>
      (
        await tx.scanTasks({ conversationId: ROOT_CONVERSATION_ID, kind: 'lineage.notify' }, 50)
      ).items.filter((task) => task.state.status !== 'terminal'),
    context,
  )

export const kinds = async (server: Server, id: ConversationId) =>
  (await (await server.harness.conversation(id, context))!.context(context)).entries.map(
    (entry) => entry.kind,
  )

export const anchor = defineTask<null, { phase: 'done' }, null>({
  name: 'lineage-test.anchor',
  version: 1,
  initial: () => ({ phase: 'done' }),
  phases: {
    done: (_task, runtime, caller) =>
      runtime.commit(
        () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
        caller,
      ),
  },
  abort: (_task, runtime, caller) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), caller),
})
