import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Message } from '@earendil-works/pi-ai'
import type { ConversationId, Cursor, EntryId, Tx } from '@earendil-works/pi-durable'
import {
  AgentDoc,
  defineDoc,
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  ROOT_CONVERSATION_ID,
  ToolTask,
} from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { arr, obj, opt, str } from '@earendil-works/pi-schema'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { offsetEntryId } from '../../lib/ids.ts'
import { safeToRerun } from '../../lib/replay.ts'
import { readSettings, userSettingsPath } from '../../lib/settings.ts'
import { imageMimeTypes, maxImageBytes, maxImages } from '../../shared/protocol.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { Standing } from '../subagents/api.ts'
import { VoiceHandoffEntry, VoiceTurnEntry } from './entries.ts'
import { EndAction, RecordAction, StatusAction, StopAction, TurnAction } from './refs.ts'
import type { VoiceHandoff, VoiceRoute, VoiceSession, VoiceTurn } from './refs.ts'
import { voicePrompt } from './prompt.ts'

const DEFAULT_MODEL = { provider: 'antigravity', modelId: 'gemini-4-neon-low' }
const MAX_AUDIO_BYTES = 8 * 1024 * 1024
const READ_TOOLS = ['read', 'bash', 'memory', 'web_search', 'web_fetch', 'voice_handoff']

export const userActions = ['record', 'turn', 'stop', 'end']

export const Session = defineDoc<VoiceSession>({
  kind: 'voice.session',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

const Fork = defineDoc<{
  of?: ConversationId
  at?: EntryId
  seen?: EntryId
  introduced?: true
  ended?: true
}>({
  kind: 'voice.fork',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

export const docs = [Session, Fork]

export const hearsAudio = (model: { provider: string; modelId: string }) =>
  /gemini/i.test(model.modelId)

async function voiceModel(host: ExtensionHost) {
  const settings = await readSettings(userSettingsPath(host.userHome))
  const configured = (settings.voice as { model?: unknown } | undefined)?.model
  if (typeof configured === 'string' && configured.includes('/')) {
    const [provider, ...rest] = configured.split('/')
    return { provider, modelId: rest.join('/') }
  }
  return DEFAULT_MODEL
}

const recordings = (host: ExtensionHost) => join(host.home, 'voice')
const recordingPath = (host: ExtensionHost, id: string) => {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Unknown recording')
  return join(recordings(host), `${id}.json`)
}

async function readRecording(host: ExtensionHost, id: string) {
  return JSON.parse(await readFile(recordingPath(host, id), 'utf8')) as {
    data: string
    mimeType: string
  }
}

async function lastSettledAnswer(host: ExtensionHost, main: ConversationId) {
  let cursor: Cursor | undefined
  let answer: EntryId | undefined
  do {
    const page = await host.scanSubmissions(
      { conversationId: main, status: 'done' },
      100,
      cursor,
      context,
    )
    for (const input of page.items)
      if (input.type === 'input' && input.status === 'done' && (answer ?? 0) < input.answer)
        answer = input.answer
    cursor = page.next
  } while (cursor)
  if (answer === undefined) throw new Error('@ultimate has no finished turn to fork from yet')
  return answer
}

async function withClosingToolResults(tx: Tx, main: ConversationId, answer: EntryId) {
  const entry = (await tx.entry(answer))!
  const pending = new Set(
    entry.model?.flatMap((message) =>
      message.role === 'assistant'
        ? message.content.flatMap((part) => (part.type === 'toolCall' ? [part.id] : []))
        : [],
    ) ?? [],
  )
  if (!pending.size) return answer
  let cursor: Cursor | undefined
  do {
    const page = await tx.scanEntries(
      { conversationId: main, minEntryId: answer, order: 'ascending' },
      100,
      cursor,
    )
    for (const result of page.items) {
      for (const message of result.model ?? [])
        if (message.role === 'toolResult') pending.delete(message.toolCallId)
      if (!pending.size) return result.id
    }
    cursor = page.next
  } while (cursor)
  throw new Error('@ultimate is finishing a tool round; try again in a moment')
}

async function openSession(host: ExtensionHost) {
  const main = (await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, context))?.ultimate
  if (main === undefined) throw new Error('@ultimate is not available')
  const answer = await lastSettledAnswer(host, main)
  const model = await voiceModel(host)
  return host.harness().commit(async (tx) => {
    const session = await tx.doc(Session, ROOT_CONVERSATION_ID)
    if (session.id !== undefined && !(await tx.doc(Fork, session.id)).ended) return session.id
    const at = await withClosingToolResults(tx, main, answer)
    const fork = await tx.forkConversation(main, at, { ownership: { kind: 'ownerless' } })
    Object.assign(await tx.doc(Fork, fork.id), { of: main, at, seen: at })
    const agent = await tx.doc(AgentDoc, fork.id)
    agent.model = model
    agent.thinkingLevel = 'low'
    if (Array.isArray(agent.tools) && !agent.tools.includes('voice_handoff'))
      agent.tools = [...agent.tools, 'voice_handoff']
    const loaded = agent.modelTools
    agent.modelTools = Array.isArray(loaded)
      ? [...loaded, 'voice_handoff']
      : { ...loaded, add: [...(loaded?.add ?? []), 'voice_handoff'] }
    Object.assign(await tx.doc(host.metadata, fork.id), { title: 'Voice', label: 'voice' })
    await host.need(ConversationsApi).setAutomaticSummaries(tx, fork.id, false)
    Object.assign(session, { id: fork.id, of: main, at, startedAt: Date.now() })
    return fork.id
  }, context)
}

async function sinceFork(tx: Tx, main: ConversationId, after: EntryId) {
  const lines: string[] = []
  let cursor: Cursor | undefined
  do {
    const page = await tx.scanEntries(
      { conversationId: main, minEntryId: offsetEntryId(after, 1), order: 'ascending' },
      100,
      cursor,
    )
    for (const entry of page.items)
      for (const message of entry.model ?? []) {
        const text =
          typeof message.content === 'string'
            ? message.content
            : message.role === 'toolResult'
              ? ''
              : message.content
                  .flatMap((part) => (part.type === 'text' ? [part.text] : []))
                  .join(' ')
        if (text.trim() && message.role !== 'toolResult')
          lines.push(
            `${message.role === 'user' ? 'In' : '@ultimate'}: ${text.trim().slice(0, 400)}`,
          )
      }
    cursor = page.next
  } while (cursor && lines.length < 40)
  return lines.slice(-12)
}

const unwrap = <T extends object>(args: unknown) =>
  (args && typeof args === 'object' && !Array.isArray(args) ? args : {}) as Partial<T>

export const actions = {
  status: implementAction(StatusAction, async (_args, { host }) => {
    const model = await voiceModel(host)
    const available = host.modelRuntime
      .getAvailableSnapshot()
      .some((listed) => listed.provider === model.provider && listed.id === model.modelId)
    return {
      model: `${model.provider}/${model.modelId}`,
      route: hearsAudio(model) ? ('audio' as const) : ('text' as const),
      transcribes: true,
      ...(available ? {} : { reason: `${model.provider}/${model.modelId} has no login` }),
    }
  }),
  record: implementAction(RecordAction, async (args, { host }) => {
    const { audio, mimeType } = unwrap<{ audio: unknown; mimeType: unknown }>(args)
    if (
      typeof audio !== 'string' ||
      !audio ||
      typeof mimeType !== 'string' ||
      !mimeType.startsWith('audio/')
    )
      throw new Error('Expected { audio: base64, mimeType: audio/* }')
    if (Buffer.byteLength(audio, 'base64') > MAX_AUDIO_BYTES)
      throw new Error('The recording is too large')
    const id = randomUUID()
    await mkdir(recordings(host), { recursive: true })
    await writeFile(recordingPath(host, id), JSON.stringify({ data: audio, mimeType }), {
      mode: 0o600,
    })
    return { audio: id }
  }),
  turn: implementAction(TurnAction, async (args, { host }) => {
    const { text, audio, seconds, hint, images } = unwrap<{
      text: unknown
      audio: unknown
      seconds: unknown
      hint: unknown
      images: unknown
    }>(args)
    if (typeof text !== 'string' || (!text.trim() && typeof audio !== 'string'))
      throw new Error('Expected text or a recording')
    if (audio !== undefined && typeof audio !== 'string') throw new Error('Expected a recording id')
    if (audio !== undefined) await readRecording(host, audio)
    const pictures = (Array.isArray(images) ? images : []).map((image: unknown) => {
      const { data, mimeType } = unwrap<{ data: unknown; mimeType: unknown }>(image)
      if (
        typeof data !== 'string' ||
        typeof mimeType !== 'string' ||
        !imageMimeTypes.includes(mimeType)
      )
        throw new Error(`Expected images as { data, mimeType: ${imageMimeTypes.join(' | ')} }`)
      if (Buffer.byteLength(data, 'base64') > maxImageBytes)
        throw new Error('An image exceeds 2 MiB')
      return { type: 'image' as const, data, mimeType }
    })
    if (pictures.length > maxImages) throw new Error(`At most ${maxImages} images`)
    const id = await openSession(host)
    const model = (await host.harness().snapshot(AgentDoc, id, context))?.model ?? DEFAULT_MODEL
    const route: VoiceRoute = typeof audio === 'string' && hearsAudio(model) ? 'audio' : 'text'
    const data: VoiceTurn = {
      text: text.trim(),
      route,
      ...(typeof audio === 'string' ? { audio } : {}),
      ...(typeof seconds === 'number' && Number.isFinite(seconds) ? { seconds } : {}),
      ...(typeof hint === 'string' && hint.trim() ? { hint: hint.trim() } : {}),
      ...(pictures.length ? { images: pictures.length } : {}),
    }
    const said = data.text || '(no transcript yet)'
    const words =
      typeof audio === 'string'
        ? `Daniel, by voice${route === 'audio' ? ' (his recording follows)' : ' (transcribed)'}: ${said}`
        : `Daniel, typed: ${said}`
    const content = [
      ...(data.hint ? [{ type: 'text' as const, text: data.hint }] : []),
      { type: 'text' as const, text: words },
      ...pictures,
    ]
    const conversation = (await host.harness().conversation(id, context))!
    await conversation.submit(
      {
        type: 'input',
        whenBusy: 'steer',
        entry: { kind: VoiceTurnEntry.kind, data },
        content,
      },
      context,
    )
    return { conversation: id, route }
  }),
  stop: implementAction(StopAction, async (_args, { host }) => {
    const id = (await host.harness().snapshot(Session, ROOT_CONVERSATION_ID, context))?.id
    if (id !== undefined) await (await host.harness().conversation(id, context))?.abort(context)
    return {}
  }),
  end: implementAction(EndAction, async (_args, { host }) => {
    const id = (await host.harness().snapshot(Session, ROOT_CONVERSATION_ID, context))?.id
    if (id === undefined) return {}
    await (await host.harness().conversation(id, context))?.abort(context)
    await host.harness().commit(async (tx) => {
      ;(await tx.doc(Fork, id)).ended = true
      const session = await tx.doc(Session, ROOT_CONVERSATION_ID)
      delete session.id
      delete session.of
      delete session.at
      delete session.startedAt
      await host.need(ConversationsApi).concludeIn(tx, [id], 'user')
    }, context)
    await rm(recordings(host), { recursive: true, force: true })
    return {}
  }),
}

async function withRecording(
  host: ExtensionHost,
  messages: readonly Message[],
  turn: { data: VoiceTurn; model?: readonly Message[] },
) {
  const said = turn.model?.find((message) => message.role === 'user')
  const at = messages.findLastIndex(
    (message) => message.role === 'user' && message.timestamp === said?.timestamp,
  )
  const message = messages[at]
  if (message?.role !== 'user' || typeof message.content === 'string') return undefined
  const { data, mimeType } = await readRecording(host, turn.data.audio!)
  return messages.with(at, {
    ...message,
    content: [...message.content, { type: 'image' as const, data, mimeType }],
  })
}

export default function voiceExtension(host: ExtensionHost) {
  host.need(ConversationsApi)
  return defineExtension({
    name: 'voice-live',
    hooks: [
      hook(GenerationTask, {
        beforeInput: async (_input, { tx, conversationId }) => {
          const fork = await tx.doc(Fork, conversationId)
          if (fork.of === undefined) return undefined
          if (fork.ended) throw new Error('This voice session has ended')
          const entries = []
          const seen = fork.seen ?? fork.at!
          if (!fork.introduced) {
            fork.introduced = true
            entries.push({
              kind: 'conversations.identity',
              model: [
                {
                  role: 'user' as const,
                  content: voicePrompt(conversationId, fork.of),
                  timestamp: Date.now(),
                },
              ],
            })
          } else {
            const latest = (await tx.scanEntries({ conversationId: fork.of }, 1)).items[0]?.id
            if (latest !== undefined && latest > seen) {
              const lines = await sinceFork(tx, fork.of, seen)
              fork.seen = latest
              if (lines.length)
                entries.push({
                  kind: 'conversations.identity',
                  model: [
                    {
                      role: 'user' as const,
                      content: `Meanwhile in @ultimate's main conversation (newest last):\n${lines.join('\n')}`,
                      timestamp: Date.now(),
                    },
                  ],
                })
            }
          }
          return entries.length ? { entries } : undefined
        },
        beforeRequest: async (request, api, ctx) => {
          const fork = await api.snapshot(Fork, api.conversationId, ctx)
          if (fork?.of === undefined) return undefined
          const page = await api.entries({ order: 'descending' }, 20, undefined, ctx)
          const turn = page.items.find((entry) => VoiceTurnEntry.is(entry))
          if (!turn || !VoiceTurnEntry.is(turn) || turn.data.route !== 'audio' || !turn.data.audio)
            return undefined
          const messages = await withRecording(host, request.messages, turn)
          return messages ? { messages } : undefined
        },
      }),
      hook(ToolTask, {
        beforeTool: async (call, api, ctx) => {
          const fork = await api.snapshot(Fork, api.conversationId, ctx)
          if (fork?.of === undefined) return undefined
          if (fork.ended) return { block: 'This voice session has ended' }
          if (READ_TOOLS.includes(call.name)) return undefined
          return {
            block: `Voice mode only reads and hands off: ${call.name} is blocked. Use voice_handoff to ask @ultimate to do it.`,
          }
        },
      }),
    ],
    tools: [
      defineTool({
        name: 'voice_handoff',
        deferred: true,
        description:
          'Hand the agreed outcome of this voice conversation to the main @ultimate as a message it acts on. Only after Daniel agreed. Write it the way you would brief yourself.',
        parameters: obj({
          title: str({ minLength: 1 }),
          outcome: str({ minLength: 1 }),
          decided: opt(arr(str())),
          open: opt(arr(str())),
          instruction: str({ minLength: 1 }),
          attachments: opt(arr(str())),
        }),
        ...safeToRerun('The handoff is submitted once per tool call through its request id.'),
        async execute(args, api, ctx) {
          const fork = await api.snapshot(Fork, api.conversationId, ctx)
          if (fork?.of === undefined) throw new Error('voice_handoff works only in a voice session')
          const handoff: VoiceHandoff = { ...args, from: api.conversationId }
          const lines = [
            `Handoff from voice mode (#${api.conversationId}, a fork of you where Daniel talked it through): ${args.title}`,
            `Outcome: ${args.outcome}`,
            ...(args.decided?.length ? ['Decided:', ...args.decided.map((d) => `- ${d}`)] : []),
            ...(args.open?.length ? ['Open:', ...args.open.map((o) => `- ${o}`)] : []),
            ...(args.attachments?.length
              ? ['Screenshots he shared:', ...args.attachments.map((a) => `- ${a}`)]
              : []),
            `Instruction: ${args.instruction}`,
          ]
          const main = (await host.harness().conversation(fork.of, ctx))!
          await main.submit(
            {
              type: 'input',
              requestId: `voice:handoff:${api.taskId}`,
              whenBusy: 'followUp',
              entry: { kind: VoiceHandoffEntry.kind, data: handoff },
              content: lines.join('\n'),
            },
            ctx,
          )
          return { output: [{ type: 'text', text: 'Sent to @ultimate.' }] }
        },
      }),
    ],
  })
}
