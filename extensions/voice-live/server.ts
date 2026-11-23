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
import { arr, num, obj, opt, str } from '@earendil-works/pi-schema'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { defineEffect } from '../../lib/effect.ts'
import { openaiSecretOrNonOAuthKey, openaiTranscribe } from '../../lib/openai.ts'
import { offsetEntryId } from '../../lib/ids.ts'
import { safeToRerun } from '../../lib/replay.ts'
import { readSettings, userSettingsPath } from '../../lib/settings.ts'
import { imageMimeTypes, maxImageBytes, maxImages } from '../../shared/protocol.ts'
import { ConversationsApi, Trees } from '../conversations/api.ts'
import { Standing } from '../subagents/api.ts'
import { VoiceHandoffEntry, VoiceTurnEntry } from './entries.ts'
import {
  EndAction,
  RecordAction,
  ModelAction,
  OpenAction,
  StatusAction,
  StopAction,
  TurnAction,
} from './refs.ts'
import type { VoiceFork, VoiceHandoff, VoiceRoute, VoiceSession, VoiceTurn } from './refs.ts'
import { voicePrompt } from './prompt.ts'

const DEFAULT_MODEL = { provider: 'antigravity', modelId: 'gemini-4-neon-low' }
const MAX_AUDIO_BYTES = 8 * 1024 * 1024
const PLACEHOLDER = '(no transcript yet)'
const TRANSCRIBE_TIMEOUT_MS = 65_000
const READ_TOOLS = ['read', 'bash', 'memory', 'web_search', 'web_fetch', 'voice_handoff']

export const userActions = ['open', 'record', 'turn', 'model', 'stop', 'end']

export const Session = defineDoc<VoiceSession>({
  kind: 'voice.session',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

export const Fork = defineDoc<VoiceFork & { seen?: EntryId; introduced?: true; ended?: true }>({
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
  const picked = (await host.harness().snapshot(Session, ROOT_CONVERSATION_ID, context))?.model
  const settings = await readSettings(userSettingsPath(host.userHome))
  const configured = picked ?? (settings.voice as { model?: unknown } | undefined)?.model
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

const transcriptions = new WeakMap<ExtensionHost, ReturnType<typeof transcribeEffect>>()
const transcribe = (host: ExtensionHost) => {
  const known = transcriptions.get(host)
  if (known) return known
  const effect = transcribeEffect(host)
  transcriptions.set(host, effect)
  return effect
}

const transcribeEffect = (host: ExtensionHost) =>
  defineEffect<{ session: ConversationId; audio: string }, string>(
    'voice-live.transcribe',
    async ({ audio }, { signal }) => {
      const key = await openaiSecretOrNonOAuthKey(host, signal)
      if (!key) throw new Error('Transcription needs an OpenAI API key in ⌘K → Secrets')
      const { data, mimeType } = await readRecording(host, audio)
      const answer = await openaiTranscribe(
        key,
        new Blob([Buffer.from(data, 'base64')], { type: mimeType }),
        AbortSignal.any([signal, AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS)]),
      )
      if (answer.text === undefined)
        throw new Error(
          `Transcription failed (HTTP ${answer.status})${answer.detail ? `: ${answer.detail}` : ''}`,
        )
      return answer.text.trim()
    },
    async (tx, { session, audio }, outcome) => {
      const fork = await tx.doc(Fork, session)
      if (outcome.ok) fork.transcripts = { ...fork.transcripts, [audio]: outcome.value }
      else fork.failed = { ...fork.failed, [audio]: outcome.error }
    },
  )

async function checkBranch(
  host: ExtensionHost,
  id: ConversationId,
  screen: ConversationId | undefined,
) {
  if (id !== screen)
    throw new Error(
      `#${id} is not on Daniel's screen; send to the conversation he has open, or to @ultimate`,
    )
  await host.harness().commit(async (tx) => {
    const record = await tx.conversation(id)
    const conversations = host.need(ConversationsApi)
    if (!record) throw new Error(`#${id} does not exist`)
    if (record.owner) throw new Error(`#${id} is a subagent; send to its branch or to @ultimate`)
    if (await host.need(Trees).isRoot(tx, id))
      throw new Error(`#${id} is a root; send to @ultimate`)
    if ((await conversations.concludedIn(tx)).has(id)) throw new Error(`#${id} is concluded`)
    const standing = (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate
    if (standing === id) throw new Error('That is @ultimate itself: leave out `to`')
  }, context)
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

async function concludeHandedOff(host: ExtensionHost) {
  const id = (await host.harness().snapshot(Session, ROOT_CONVERSATION_ID, context))?.id
  if (id === undefined || !(await host.harness().snapshot(Fork, id, context))?.handedOff) return
  await host.harness().commit(async (tx) => {
    const session = await tx.doc(Session, ROOT_CONVERSATION_ID)
    if (session.id !== id) return
    ;(await tx.doc(Fork, id)).ended = true
    delete session.id
    await host.need(ConversationsApi).concludeIn(tx, [id], 'user')
  }, context)
}

async function openSession(host: ExtensionHost) {
  const main = (await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, context))?.ultimate
  if (main === undefined) throw new Error('@ultimate is not available')
  const answer = await lastSettledAnswer(host, main)
  const model = await voiceModel(host)
  await concludeHandedOff(host)
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
    const open = (await host.harness().snapshot(Session, ROOT_CONVERSATION_ID, context))?.id
    const model =
      (open === undefined
        ? undefined
        : (await host.harness().snapshot(AgentDoc, open, context))?.model) ??
      (await voiceModel(host))
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
    const session = await openSession(host)
    await host.harness().commit(async (tx) => {
      await tx.createTask(
        transcribe(host),
        { session, audio: id },
        { conversationId: session, ownership: { kind: 'conversation' }, background: true },
      )
    }, context)
    host.harness().resume()
    return { audio: id }
  }),
  open: implementAction(OpenAction, async (_args, { host }) => ({
    conversation: await openSession(host),
  })),
  turn: implementAction(TurnAction, async (args, { host }) => {
    const { key, text, audio, seconds, envelope, hint, screen, images } = unwrap<{
      key: unknown
      text: unknown
      audio: unknown
      seconds: unknown
      envelope: unknown
      hint: unknown
      screen: unknown
      images: unknown
    }>(args)
    if (typeof key !== 'string' || !key) throw new Error('Expected a turn key')
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
    const levels =
      Array.isArray(envelope) && envelope.every((level) => typeof level === 'number')
        ? envelope
            .slice(-400)
            .map((level) => Math.round(Math.min(1, Math.max(0, level)) * 100) / 100)
        : undefined
    const data: VoiceTurn = {
      key,
      text: text.trim(),
      route,
      ...(typeof audio === 'string' ? { audio } : {}),
      ...(typeof seconds === 'number' && Number.isFinite(seconds) ? { seconds } : {}),
      ...(levels?.length ? { envelope: levels } : {}),
      ...(typeof hint === 'string' && hint.trim() ? { hint: hint.trim() } : {}),
      ...(pictures.length ? { images: pictures.length } : {}),
    }
    const said = data.text || PLACEHOLDER
    const words =
      typeof audio === 'string'
        ? `Daniel, by voice${route === 'audio' ? ' (his recording follows)' : ' (transcribed)'}: ${said}`
        : `Daniel, typed: ${said}`
    const content = [
      ...(data.hint ? [{ type: 'text' as const, text: data.hint }] : []),
      { type: 'text' as const, text: words },
      ...pictures,
    ]
    await host.harness().commit(async (tx) => {
      const fork = await tx.doc(Fork, id)
      if (typeof screen === 'number') fork.screen = screen as ConversationId
      else delete fork.screen
    }, context)
    const conversation = (await host.harness().conversation(id, context))!
    await conversation.submit(
      {
        type: 'input',
        requestId: `voice:turn:${key}`,
        whenBusy: 'steer',
        entry: { kind: VoiceTurnEntry.kind, data },
        content,
      },
      context,
    )
    return { conversation: id, route }
  }),
  model: implementAction(ModelAction, async (args, { host }) => {
    const { model } = unwrap<{ model: unknown }>(args)
    if (typeof model !== 'string' || !/^[^/\s]+\/\S+$/.test(model))
      throw new Error('Expected { model: "provider/model" }')
    const [provider, ...rest] = model.split('/')
    const ref = { provider, modelId: rest.join('/') }
    if (!host.modelRuntime.getModel(ref.provider, ref.modelId))
      throw new Error(`Unknown model ${model}`)
    await host.harness().commit(async (tx) => {
      const session = await tx.doc(Session, ROOT_CONVERSATION_ID)
      session.model = model
      if (session.id !== undefined) (await tx.doc(AgentDoc, session.id)).model = ref
    }, context)
    return {}
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

async function voiceRequest(
  host: ExtensionHost,
  messages: readonly Message[],
  turns: { data: VoiceTurn; model?: readonly Message[] }[],
  transcripts: Record<string, string>,
) {
  let result = [...messages]
  let changed = false
  const newest = turns[0]
  for (const turn of turns) {
    const said = turn.model?.find((message) => message.role === 'user')
    const at = result.findLastIndex(
      (message) => message.role === 'user' && message.timestamp === said?.timestamp,
    )
    const message = result[at]
    if (message?.role !== 'user' || typeof message.content === 'string') continue
    const transcript = turn.data.audio ? transcripts[turn.data.audio] : undefined
    let content = transcript
      ? message.content.map((part) =>
          part.type === 'text' && part.text.endsWith(PLACEHOLDER)
            ? { ...part, text: part.text.slice(0, -PLACEHOLDER.length) + transcript }
            : part,
        )
      : message.content
    if (turn === newest && turn.data.route === 'audio' && turn.data.audio) {
      const { data, mimeType } = await readRecording(host, turn.data.audio)
      content = [...content, { type: 'image' as const, data, mimeType }]
    }
    if (content === message.content) continue
    result = result.with(at, { ...message, content })
    changed = true
  }
  return changed ? result : undefined
}

export default function voiceExtension(host: ExtensionHost) {
  host.need(ConversationsApi)
  return defineExtension({
    name: 'voice-live',
    tasks: [transcribe(host)],
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
          const page = await api.entries({ order: 'descending' }, 200, undefined, ctx)
          const turns = page.items.flatMap((entry) => (VoiceTurnEntry.is(entry) ? [entry] : []))
          if (!turns.length) return undefined
          const messages = await voiceRequest(host, request.messages, turns, fork.transcripts ?? {})
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
          "Hand the agreed outcome of this voice conversation to the main @ultimate as a message it acts on, or with `to` to the branch conversation on Daniel's screen (its coordinator). Write it the way you would brief yourself.",
        parameters: obj({
          to: opt(
            num({ description: "A branch conversation on Daniel's screen; omit for @ultimate" }),
          ),
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
          const { to, ...brief } = args
          const branch = to === undefined ? undefined : (to as ConversationId)
          const target = branch ?? fork.of
          if (branch !== undefined) await checkBranch(host, branch, fork.screen)
          const handoff: VoiceHandoff = { ...brief, from: api.conversationId }
          const lines = [
            `Handoff from voice mode (#${api.conversationId}, a fork of @ultimate where Daniel talked it through): ${args.title}`,
            `Outcome: ${args.outcome}`,
            ...(args.decided?.length ? ['Decided:', ...args.decided.map((d) => `- ${d}`)] : []),
            ...(args.open?.length ? ['Open:', ...args.open.map((o) => `- ${o}`)] : []),
            ...(args.attachments?.length
              ? ['Screenshots he shared:', ...args.attachments.map((a) => `- ${a}`)]
              : []),
            `Instruction: ${args.instruction}`,
          ]
          const receiver = (await host.harness().conversation(target, ctx))!
          await host.harness().commit(async (tx) => {
            ;(await tx.doc(Fork, api.conversationId)).handedOff = true
          }, ctx)
          await receiver.submit(
            {
              type: 'input',
              requestId: `voice:handoff:${api.taskId}`,
              whenBusy: 'followUp',
              entry: { kind: VoiceHandoffEntry.kind, data: handoff },
              content: lines.join('\n'),
            },
            ctx,
          )
          return {
            output: [
              { type: 'text', text: to === undefined ? 'Sent to @ultimate.' : `Sent to #${to}.` },
            ],
          }
        },
      }),
    ],
  })
}
