import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { clampThinkingLevel } from '@earendil-works/pi-ai'
import type { Message, ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { ConversationId, Cursor, EntryId, Tx } from '@earendil-works/pi-durable'
import {
  AgentDoc,
  defineDoc,
  defineExtension,
  defineSignal,
  defineTool,
  GenerationTask,
  hook,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  ToolTask,
} from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { arr, lit, num, obj, opt, str, union, unknown } from '@earendil-works/pi-schema'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { defineEffect } from '../../lib/effect.ts'
import { openaiSecretOrNonOAuthKey, openaiTranscribe } from '../../lib/openai.ts'
import { readSecret } from '../../lib/secrets.ts'
import { imagesOf, isInput } from '../../lib/entries.ts'
import { offsetEntryId } from '../../lib/ids.ts'
import { safeToRerun } from '../../lib/replay.ts'
import {
  answerIncludingClosingToolResults,
  lastSettledInputAnswer,
} from '../../lib/settled-answer.ts'
import { readSettings, userSettingsPath } from '../../lib/settings.ts'
import { imageMimeTypes, maxImageBytes, maxImages } from '../../shared/protocol.ts'
import { ClassifyApi } from '../classify/api.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { Branch } from '../lineage/api.ts'
import { Standing } from '../subagents/api.ts'
import { VoiceHandoffEntry, VoiceTurnEntry } from './entries.ts'
import {
  EndAction,
  RecordAction,
  OpenAction,
  StatusAction,
  StopAction,
  DiscardAction,
  IntentAction,
  SpeakAction,
  TurnAction,
  UiAnswerAction,
  UiClaimAction,
} from './refs.ts'
import type {
  OpenAiVoice,
  VoiceDelivery,
  VoiceFork,
  VoiceHandoff,
  VoiceRoute,
  VoiceSession,
  VoiceTurn,
  VoiceUi,
} from './refs.ts'
import { voicePrompt } from './prompt.ts'
import { createRealtimeVoice } from './openai-voice.ts'
import { MAX_SPOKEN, VOICES } from './voices.ts'

const DEFAULT_MODEL = { provider: 'claude-code', modelId: 'claude-opus-5-5' }
const MAX_AUDIO_BYTES = 8 * 1024 * 1024
const PLACEHOLDER = '(no transcript yet)'
const TRANSCRIBE_TIMEOUT_MS = 65_000
const MAX_WORDS = 6_000
const UNHEARD = '(still being transcribed)'
const VOICE_TOOLS = [
  'read',
  'memory',
  'web_search',
  'web_fetch',
  'video_ask',
  'codemode',
  'action',
  'ui',
  'voice_handoff',
]
const UI_TIMEOUT_MS = 15_000
const SPEAK_TIMEOUT_MS = 20_000

export const userActions = [
  'open',
  'record',
  'turn',
  'stop',
  'end',
  'ui-claim',
  'ui-answer',
  'discard',
  'intent',
  'speak',
]

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

export const Ui = defineDoc<VoiceUi>({
  kind: 'voice.ui',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ calls: [] }),
})

const UiAnswered = defineSignal({ name: 'voice-live.ui-answered', version: 1, schema: unknown() })

export const docs = [Session, Fork, Ui]

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

const recordings = (host: ExtensionHost, session: ConversationId) =>
  join(host.home, 'voice', String(session))
const recordingPath = (host: ExtensionHost, session: ConversationId, id: string) => {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Unknown recording')
  return join(recordings(host, session), `${id}.json`)
}

async function readRecording(host: ExtensionHost, session: ConversationId, id: string) {
  return JSON.parse(await readFile(recordingPath(host, session, id), 'utf8')) as {
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
    async ({ session, audio }, { signal }) => {
      const key = await openaiSecretOrNonOAuthKey(host, signal)
      if (!key) throw new Error('Transcription needs an OpenAI API key in ⌘K → Secrets')
      const { data, mimeType } = await readRecording(host, session, audio)
      const answer = await openaiTranscribe(
        key,
        new Blob([Buffer.from(data, 'base64')], { type: mimeType }),
        AbortSignal.any([signal, AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS)]),
      )
      if (answer.text === undefined)
        throw new Error(
          `Transcription failed (HTTP ${answer.status})${answer.detail ? `: ${answer.detail}` : ''}`,
        )
      const heard = answer.text.trim()
      if (!heard) await dropSilentTurn(host, session, audio)
      return heard
    },
    async (tx, { session, audio }, outcome) => {
      const fork = await tx.doc(Fork, session)
      if (outcome.ok) fork.transcripts = { ...fork.transcripts, [audio]: outcome.value }
      else fork.failed = { ...fork.failed, [audio]: outcome.error }
    },
  )

async function dropSilentTurn(host: ExtensionHost, session: ConversationId, empty: string) {
  const fork = await host.harness().snapshot(Fork, session, context)
  const heard = { ...fork?.transcripts, [empty]: '' }
  const silent = Object.entries(fork?.pending ?? {}).filter(
    ([, group]) => group.includes(empty) && group.every((clip) => heard[clip] === ''),
  )
  for (const [key] of silent) {
    const turn = await host
      .harness()
      .commit((tx) => tx.submissionByRequest(session, `voice:turn:${key}`), context)
    if (!turn) continue
    const outcome = await host.harness().abortSubmission(turn.id, context, session)
    const running = (await host.harness().snapshot(LiveDoc, session, context))?.run
    if (
      outcome === 'already_placed' &&
      running?.inputs.length === 1 &&
      running.inputs[0] === turn.id
    )
      await host.harness().abortTask(running.taskId, context)
  }
}

function levelsOf(envelope: unknown) {
  if (!Array.isArray(envelope) || !envelope.every((level) => typeof level === 'number'))
    return undefined
  const levels = envelope
    .slice(-400)
    .map((level) => Math.round(Math.min(1, Math.max(0, level)) * 100) / 100)
  return levels.length ? levels : undefined
}

async function checkBranch(
  host: ExtensionHost,
  tx: Tx,
  id: ConversationId,
  screen: ConversationId | undefined,
) {
  if (id !== screen)
    throw new Error(
      `#${id} is not on Daniel's screen; send to the conversation he has open, or to @ultimate`,
    )
  if (!(await tx.conversation(id))) throw new Error(`#${id} does not exist`)
  if (!(await tx.doc(Branch, id)).branch)
    throw new Error(`#${id} is not a branch; send to a branch's coordinator, or to @ultimate`)
  if ((await host.need(ConversationsApi).concludedIn(tx)).has(id))
    throw new Error(`#${id} is concluded`)
}

function keepModel(
  session: VoiceSession,
  agent: { model?: { provider: string; modelId: string }; thinkingLevel?: ModelThinkingLevel },
) {
  if (agent.model) session.model = `${agent.model.provider}/${agent.model.modelId}`
  if (agent.thinkingLevel) session.thinking = agent.thinkingLevel
}

function thinkingFor(
  host: ExtensionHost,
  ref: { provider: string; modelId: string },
  picked: ModelThinkingLevel = 'low',
) {
  const model = host.modelRuntime.getModel(ref.provider, ref.modelId)
  return model ? clampThinkingLevel(model, picked) : picked
}

const sessionArg = (value: unknown) => {
  if (value === undefined) return undefined
  if (typeof value !== 'number') throw new Error('Expected session as a conversation id')
  return value as ConversationId
}

async function openSession(host: ExtensionHost, expected?: ConversationId) {
  const main = (await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, context))?.ultimate
  if (main === undefined) throw new Error('@ultimate is not available')
  const answer = await lastSettledInputAnswer(host, main, context)
  const configured = await voiceModel(host)
  return host.harness().commit(async (tx) => {
    const session = await tx.doc(Session, ROOT_CONVERSATION_ID)
    const current = session.id === undefined ? undefined : await tx.doc(Fork, session.id)
    const open = current !== undefined && !current.ended
    if (expected !== undefined && (!open || session.id !== expected))
      throw new Error('This voice session ended; send again')
    let model = configured
    if (open && !current.handedOff) return session.id!
    const at = await answerIncludingClosingToolResults(tx, main, answer)
    if (open) {
      current.ended = true
      const handedOff = await tx.doc(AgentDoc, session.id!)
      keepModel(session, handedOff)
      model = handedOff.model ?? configured
      await host.need(ConversationsApi).concludeIn(tx, [session.id!], 'user')
    }
    const fork = await tx.forkConversation(main, at, { ownership: { kind: 'ownerless' } })
    Object.assign(await tx.doc(Fork, fork.id), { of: main, at, seen: at })
    const agent = await tx.doc(AgentDoc, fork.id)
    agent.model = model
    agent.thinkingLevel = thinkingFor(host, model, session.thinking)
    const own = ['ui', 'voice_handoff']
    const tools = agent.tools
    if (Array.isArray(tools))
      agent.tools = [...tools, ...own.filter((name) => !tools.includes(name))]
    const loaded = agent.modelTools
    agent.modelTools = Array.isArray(loaded)
      ? [...loaded, ...own]
      : { ...loaded, add: [...(loaded?.add ?? []), ...own] }
    Object.assign(await tx.doc(host.metadata, fork.id), { title: 'Voice', label: 'voice' })
    await host.need(ConversationsApi).setAutomaticSummaries(tx, fork.id, false)
    Object.assign(session, {
      id: fork.id,
      of: main,
      at,
      startedAt: Date.now(),
      forks: [...(session.forks ?? []), fork.id],
    })
    return fork.id
  }, context)
}

const ANSWER_QUESTION = {
  type: 'choice' as const,
  instructions:
    "The assistant's last reply may end with a question for the user, who answers by voice in one or more recordings. Read the latest recording after what was collected before it. Where does the user's answer stand?",
  criteria: {
    none: "The assistant's last reply asked the user no question, or the user talks about something else.",
    unfinished:
      'An answer is under way but not done: it breaks off mid-sentence, trails off, says more is coming, or keeps weighing options aloud.',
    complete:
      'A clean, finished answer to the question the assistant just asked: the user has said what they want and the thought is settled.',
  },
}
const ANSWER_THRESHOLD = 0.85

async function openQuestion(host: ExtensionHost, id: ConversationId, forkedAt: EntryId) {
  const conversation = (await host.harness().conversation(id, context))!
  let cursor: Cursor | undefined
  do {
    const page = await conversation.entries(
      { minEntryId: offsetEntryId(forkedAt, 1) },
      100,
      cursor,
      context,
    )
    for (const entry of page.items) {
      if (isInput(entry)) return undefined
      if (entry.kind !== 'pi.assistant') continue
      const text = (entry.model ?? [])
        .flatMap((message) =>
          message.role === 'assistant'
            ? message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
            : [],
        )
        .join(' ')
        .trim()
      if (!text) continue
      const ending = text.split(/\n\s*\n/).at(-1)!
      return ending.includes('?') ? ending : undefined
    }
    cursor = page.next
  } while (cursor)
  return undefined
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

function spoken(turn: VoiceTurn, fork: VoiceFork) {
  if (turn.route === 'text') return turn.text
  const clips = turn.clips ?? (turn.audio ? [turn.audio] : [])
  const heard = clips.map((clip) =>
    fork.failed?.[clip] !== undefined ? '' : (fork.transcripts?.[clip] ?? UNHEARD),
  )
  return [...heard, turn.text].filter(Boolean).join(' ')
}

async function wordsOf(tx: Tx, session: ConversationId, fork: VoiceFork) {
  const turns: string[] = []
  let cursor: Cursor | undefined
  do {
    const page = await tx.scanEntries(
      { conversationId: session, minEntryId: offsetEntryId(fork.at!, 1), order: 'ascending' },
      200,
      cursor,
    )
    for (const entry of page.items)
      if (VoiceTurnEntry.is(entry)) turns.push(spoken(entry.data, fork))
    cursor = page.next
  } while (cursor)
  const said = turns.map((turn) => turn.trim()).filter(Boolean)
  let kept = 0
  let size = 0
  while (kept < said.length && (kept === 0 || size + said.at(-1 - kept)!.length <= MAX_WORDS))
    size += said.at(-1 - kept++)!.length
  return { words: said.slice(said.length - kept), earlier: said.length - kept }
}

const voices = new WeakMap<ExtensionHost, ReturnType<typeof createRealtimeVoice>>()
const realtimeVoice = (host: ExtensionHost) => {
  const known = voices.get(host)
  if (known) return known
  const made = createRealtimeVoice()
  voices.set(host, made)
  host.onClose(async () => {
    voices.delete(host)
    made.close()
  })
  return made
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
    const name = `${model.provider}/${model.modelId}`
    const transcribes = !!(await openaiSecretOrNonOAuthKey(host))
    const classifies =
      !!host.want(ClassifyApi) && !!(await readSecret(host.userHome, 'TYPESAFE_API_KEY'))
    return {
      model: name,
      route: hearsAudio(model) ? ('audio' as const) : ('text' as const),
      transcribes,
      ...(available ? {} : { reason: `${name} has no login` }),
      setup: {
        model: available
          ? {
              ready: true,
              detail: hearsAudio(model)
                ? `${name}: hears your voice directly`
                : `${name}: reads the transcript`,
            }
          : {
              ready: false,
              detail: `${name} has no login`,
              fix: 'Log in to its provider, or type a first message to open a session and pick another model in its prompt box.',
            },
        transcription: transcribes
          ? {
              ready: true,
              detail: 'OpenAI transcription: your words show as text and reach any model',
            }
          : {
              ready: false,
              detail: 'OpenAI transcription is missing',
              fix: 'Required: add OPENAI_API_KEY in ⌘K → Secrets.',
            },
        handsFree: classifies
          ? { ready: true, detail: 'Jev: "send it" sends a collected message hands-free' }
          : {
              ready: false,
              detail: 'Hands-free send is off',
              fix: 'Optional: turn on classify and add TYPESAFE_API_KEY in ⌘K → Secrets, so "send it" sends a collected message. Enter works without it.',
            },
      },
    }
  }),
  record: implementAction(RecordAction, async (args, { host }) => {
    const {
      audio,
      mimeType,
      collect,
      session: expected,
    } = unwrap<{
      audio: unknown
      mimeType: unknown
      collect: unknown
      session: unknown
    }>(args)
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
    const session = await openSession(host, sessionArg(expected))
    await mkdir(recordings(host, session), { recursive: true })
    await writeFile(recordingPath(host, session, id), JSON.stringify({ data: audio, mimeType }), {
      mode: 0o600,
    })
    const clip = unwrap<{ seconds: unknown; envelope: unknown }>(collect)
    await host.harness().commit(async (tx) => {
      if ((await tx.doc(Fork, session)).ended)
        throw new Error('This voice session ended; record again')
      await tx.createTask(
        transcribe(host),
        { session, audio: id },
        { conversationId: session, ownership: { kind: 'conversation' }, background: true },
      )
      if (collect === undefined) return
      const fork = await tx.doc(Fork, session)
      fork.draft = [
        ...(fork.draft ?? []),
        {
          audio: id,
          seconds: typeof clip.seconds === 'number' ? clip.seconds : 0,
          ...(levelsOf(clip.envelope) ? { envelope: levelsOf(clip.envelope)! } : {}),
        },
      ]
    }, context)
    host.harness().resume()
    return { audio: id, session }
  }),
  open: implementAction(OpenAction, async (_args, { host }) => ({
    conversation: await openSession(host),
  })),
  turn: implementAction(TurnAction, async (args, { host }) => {
    const {
      key,
      text,
      audio,
      clips,
      delivery,
      answered,
      seconds,
      envelope,
      hint,
      screen,
      images,
      session: expected,
    } = unwrap<{
      session: unknown
      key: unknown
      text: unknown
      audio: unknown
      clips: unknown
      delivery: unknown
      answered: unknown
      seconds: unknown
      envelope: unknown
      hint: unknown
      screen: unknown
      images: unknown
    }>(args)
    if (typeof key !== 'string' || !key) throw new Error('Expected a turn key')
    if (typeof text !== 'string') throw new Error('Expected text')
    if (audio !== undefined && typeof audio !== 'string') throw new Error('Expected a recording id')
    const collected =
      Array.isArray(clips) && clips.every((clip) => typeof clip === 'string') && clips.length
        ? clips
        : undefined
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
    if (!text.trim() && typeof audio !== 'string' && !pictures.length)
      throw new Error('Expected text, a recording or an image')
    if (answered === true && !collected) throw new Error('An answer sends the collected clips')
    const id = await openSession(host, sessionArg(expected))
    for (const clip of collected ?? (typeof audio === 'string' ? [audio] : []))
      await readRecording(host, id, clip).catch(() => {
        throw new Error('That recording belongs to an ended session; record again')
      })
    const model = (await host.harness().snapshot(AgentDoc, id, context))?.model ?? DEFAULT_MODEL
    const route: VoiceRoute = typeof audio === 'string' && hearsAudio(model) ? 'audio' : 'text'
    const levels = levelsOf(envelope)
    const data: VoiceTurn = {
      key,
      text: text.trim(),
      route,
      ...(collected ? { audio: collected[0] } : typeof audio === 'string' ? { audio } : {}),
      ...(collected && collected.length > 1 ? { clips: collected } : {}),
      ...(delivery === 'followUp' ? { delivery: 'followUp' as const } : {}),
      ...(answered === true ? { answered: true as const } : {}),
      ...(typeof seconds === 'number' && Number.isFinite(seconds) ? { seconds } : {}),
      ...(levels?.length ? { envelope: levels } : {}),
      ...(typeof hint === 'string' && hint.trim() ? { hint: hint.trim() } : {}),
      ...(pictures.length ? { images: pictures.length } : {}),
    }
    const words =
      typeof audio === 'string'
        ? route === 'audio'
          ? `Daniel, by voice (his recording follows): ${PLACEHOLDER}${data.text ? `\n\nAnd typed: ${data.text}` : ''}`
          : `Daniel, by voice (transcribed): ${data.text || PLACEHOLDER}`
        : `Daniel, typed: ${data.text}`
    const content = [
      ...(data.hint ? [{ type: 'text' as const, text: data.hint }] : []),
      { type: 'text' as const, text: words },
      ...pictures,
    ]
    const conversation = (await host.harness().conversation(id, context))!
    const group = collected ?? (typeof audio === 'string' ? [audio] : [])
    const outcome = await host.harness().commit(async (tx) => {
      const fork = await tx.doc(Fork, id)
      if (fork.ended) throw new Error('This voice session ended; send again')
      if (collected) {
        const held = (fork.draft ?? []).map((clip) => clip.audio)
        const changed =
          answered === true
            ? held.join() !== collected.join()
            : !collected.every((clip) => held.includes(clip))
        if (changed) throw new Error('The collected recordings changed; send again')
      }
      const silent =
        group.length > 0 &&
        !data.text &&
        !pictures.length &&
        group.every((clip) => fork.transcripts?.[clip] === '')
      if (collected)
        fork.draft = (fork.draft ?? []).filter((clip) => !collected.includes(clip.audio))
      if (typeof screen === 'number') fork.screen = screen as ConversationId
      else delete fork.screen
      if (silent) return 'dropped' as const
      if (group.length && !data.text && !pictures.length)
        fork.pending = { ...fork.pending, [key]: group }
      await conversation.submit(tx, {
        type: 'input',
        requestId: `voice:turn:${key}`,
        whenBusy: data.delivery ?? 'steer',
        entry: { kind: VoiceTurnEntry.kind, data },
        content,
      })
      return 'sent' as const
    }, context)
    host.harness().resume()
    if (outcome === 'dropped') return { conversation: id, route, dropped: true as const }
    return { conversation: id, route }
  }),
  discard: implementAction(DiscardAction, async (_args, { host }) => {
    const id = (await host.harness().snapshot(Session, ROOT_CONVERSATION_ID, context))?.id
    if (id === undefined) return {}
    await host.harness().commit(async (tx) => {
      delete (await tx.doc(Fork, id)).draft
    }, context)
    return {}
  }),
  speak: implementAction(SpeakAction, async (args, { host, signal }) => {
    const { voice, text } = unwrap<{ voice: unknown; text: unknown }>(args)
    if (!VOICES.includes(voice as OpenAiVoice)) throw new Error(`Unknown voice: ${String(voice)}`)
    if (
      text !== undefined &&
      (typeof text !== 'string' || !text.trim() || text.length > MAX_SPOKEN)
    )
      throw new Error(`Expected text of at most ${MAX_SPOKEN} characters`)
    const key = await openaiSecretOrNonOAuthKey(host, signal)
    if (!key) throw new Error('OpenAI voice needs OPENAI_API_KEY in ⌘K → Secrets')
    const realtime = realtimeVoice(host)
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(SPEAK_TIMEOUT_MS)])
    if (text === undefined) return await realtime.connect(key, bounded).then(() => ({}))
    const wav = await realtime.speak(key, text, voice as OpenAiVoice, bounded)
    return { audio: wav.toString('base64') }
  }),
  intent: implementAction(IntentAction, async (args, { host, signal }) => {
    const { audio } = unwrap<{ audio: unknown }>(args)
    if (typeof audio !== 'string') throw new Error('Expected { audio }')
    const id = (await host.harness().snapshot(Session, ROOT_CONVERSATION_ID, context))?.id
    if (id === undefined) return {}
    const fork = await host.harness().snapshot(Fork, id, context)
    if (
      fork?.transcripts?.[audio] === undefined ||
      !fork.draft?.some((clip) => clip.audio === audio)
    )
      return {}
    const classify = host.want(ClassifyApi)
    if (!classify) return { unavailable: 'Spoken send needs the classify extension and its key' }
    const collected = fork.draft
    const heard = collected.map((clip) => fork.transcripts?.[clip.audio])
    const question =
      heard.every((text) => text !== undefined) && fork.at !== undefined
        ? await openQuestion(host, id, fork.at)
        : undefined
    const latest = question ? collected.at(-1)!.audio : audio
    const said = fork.transcripts[latest]
    const before = collected
      .filter((clip) => clip.audio !== latest)
      .map((clip) => fork.transcripts?.[clip.audio] ?? '')
      .join(' ')
    const asking = classify.ask(
      {
        state: { collectedSoFar: before, latestRecording: said },
        questions: {
          send: {
            type: 'choice',
            instructions:
              'The user is dictating a message to an assistant in several recordings and sends it by voice. Does the latest recording end the message by handing it over: a command to send it, or a turn to the assistant asking it to start working on what was said?',
            criteria: {
              hold: 'Not handed over yet: more of the message, a pause, thinking aloud to themselves, or describing what they will ask later.',
              steer:
                'It ends by handing over now: a send command ("send it", "go", "confirm", "let\'s go", "that\'s it", "steer"), or a turn to the assistant to act on it ("let\'s brainstorm this", "let\'s think it through", "what do you think?", "can you look into that", "help me with this").',
              followUp:
                'It ends with a command to send it as a follow-up ("send as follow-up", "follow up", "queue it").',
            },
          },
          only: {
            type: 'noul',
            instructions:
              'Is the latest recording nothing but a bare send command ("send it", "go", "follow up"), with no other content? A request to brainstorm or think something through is content, not a bare command.',
          },
        },
      },
      signal,
    )
    const answering = Promise.allSettled(
      question
        ? [
            classify.ask(
              {
                state: {
                  assistantLastReply: question,
                  collectedSoFar: before,
                  latestRecording: said,
                },
                questions: { answer: ANSWER_QUESTION },
              },
              signal,
            ),
          ]
        : [],
    )
    const { answers } = await asking
    const send = answers.send
    const commanded = send?.type === 'choice' && send.choice !== 'hold' && send.confidence >= 0.6
    if (!commanded) {
      const [replied] = await answering
      if (replied?.status === 'rejected') throw replied.reason
      const answer = replied?.value.answers.answer
      if (answer?.type !== 'choice' || (answer.probabilities.complete ?? 0) < ANSWER_THRESHOLD)
        return {}
      return {
        send: 'steer' as const,
        clips: collected.map((clip) => clip.audio),
        answered: true as const,
      }
    }
    const only = answers.only?.type === 'noul' && answers.only.noul > 0.5
    if (only)
      await host.harness().commit(async (tx) => {
        const draft = await tx.doc(Fork, id)
        if (draft.ended) return
        draft.draft = (draft.draft ?? []).filter((clip) => clip.audio !== latest)
      }, context)
    const clips = collected.map((clip) => clip.audio).filter((clip) => !(only && clip === latest))
    return {
      send: send.choice as VoiceDelivery,
      clips,
      ...(only ? { dropped: true as const } : {}),
    }
  }),
  'ui-claim': implementAction(UiClaimAction, async (args, { host }) => {
    const { id, page } = unwrap<{ id: unknown; page: unknown }>(args)
    if (typeof id !== 'string' || typeof page !== 'string' || !page)
      throw new Error('Expected { id, page }')
    const session = (await host.harness().snapshot(Session, ROOT_CONVERSATION_ID, context))?.id
    if (session === undefined) return { claimed: false }
    return host.harness().commit(async (tx) => {
      const ui = await tx.doc(Ui, session)
      const call = ui.calls.find((each) => each.id === id)
      if (!call || call.page || Date.now() - call.at > UI_TIMEOUT_MS) return { claimed: false }
      call.page = page
      return { claimed: true }
    }, context)
  }),
  'ui-answer': implementAction(UiAnswerAction, async (args, { host }) => {
    const { id, page, result } = unwrap<{ id: unknown; page: unknown; result: unknown }>(args)
    if (typeof id !== 'string' || typeof page !== 'string')
      throw new Error('Expected { id, page, result }')
    const session = (await host.harness().snapshot(Session, ROOT_CONVERSATION_ID, context))?.id
    if (session === undefined) return {}
    await host.harness().commit(async (tx) => {
      const ui = await tx.doc(Ui, session)
      const call = ui.calls.find((each) => each.id === id)
      if (!call || call.page !== page) return
      await tx.signal(call.task, UiAnswered, id, result ?? null)
    }, context)
    host.harness().resume()
    return {}
  }),
  stop: implementAction(StopAction, async (_args, { host }) => {
    const id = (await host.harness().snapshot(Session, ROOT_CONVERSATION_ID, context))?.id
    if (id !== undefined) await (await host.harness().conversation(id, context))?.abort(context)
    return {}
  }),
  end: implementAction(EndAction, async (_args, { host }) => {
    const id = await host.harness().commit(async (tx) => {
      const session = await tx.doc(Session, ROOT_CONVERSATION_ID)
      const ending = session.id
      if (ending === undefined) return undefined
      const fork = await tx.doc(Fork, ending)
      fork.ended = true
      delete fork.draft
      keepModel(session, await tx.doc(AgentDoc, ending))
      delete session.id
      delete session.of
      delete session.at
      delete session.startedAt
      await host.need(ConversationsApi).concludeIn(tx, [ending], 'user')
      return ending
    }, context)
    if (id === undefined) return {}
    await (await host.harness().conversation(id, context))?.abort(context, { background: true })
    await rm(recordings(host, id), { recursive: true, force: true })
    return {}
  }),
}

async function voiceRequest(
  host: ExtensionHost,
  session: ConversationId,
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
    const heardClips = turn.data.clips ?? (turn.data.audio ? [turn.data.audio] : [])
    const heard = heardClips.map((clip) => transcripts[clip])
    const transcript =
      heardClips.length && heard.every((text) => text !== undefined)
        ? heard.filter(Boolean).join(' ')
        : undefined
    let content = transcript
      ? message.content.map((part) =>
          part.type === 'text' && part.text.includes(PLACEHOLDER)
            ? { ...part, text: part.text.replace(PLACEHOLDER, transcript) }
            : part,
        )
      : message.content
    if (turn === newest && turn.data.route === 'audio')
      for (const clip of heardClips) {
        const { data, mimeType } = await readRecording(host, session, clip)
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
          const messages = await voiceRequest(
            host,
            api.conversationId,
            request.messages,
            turns,
            fork.transcripts ?? {},
          )
          return messages ? { messages } : undefined
        },
      }),
      hook(ToolTask, {
        beforeTool: async (call, api, ctx) => {
          const fork = await api.snapshot(Fork, api.conversationId, ctx)
          if (fork?.of === undefined) return undefined
          if (fork.ended) return { block: 'This voice session has ended' }
          if (VOICE_TOOLS.includes(call.name)) return undefined
          return {
            block: `Voice mode reads, drives the UI and hands off: ${call.name} is blocked. Use voice_handoff to ask @ultimate to do it.`,
          }
        },
      }),
    ],
    tools: [
      defineTool({
        name: 'ui',
        description:
          "Drive Daniel's own Ultimate page through its ui-sdk agent bridge: `snapshot` lists the controls on screen with their state, `query` finds controls by label or row text (`text`, optional `within` a list, `kind`), `act` runs steps in order as the agent ([{ref, action, args?}], ref is a label or a ref from query, like {ref: 'System', action: 'press'} to switch surface). Each change is recorded as made by an agent. Say in one short line what you are about to do before calling it.",
        parameters: union([
          obj({ op: lit('snapshot') }),
          obj({ op: lit('query'), text: opt(str()), within: opt(str()), kind: opt(str()) }),
          obj({
            op: lit('act'),
            steps: arr(
              obj({
                ref: str({ minLength: 1 }),
                action: str({ minLength: 1 }),
                args: opt(arr(unknown())),
              }),
            ),
          }),
        ]),
        ...safeToRerun(
          'The request is recorded once per tool call; a rerun finds it or its answer.',
        ),
        async execute(args, api, ctx) {
          const id = api.callId
          const answered = await api.readSignal(UiAnswered, id, ctx)
          if (answered && 'value' in answered) {
            await api.commit(async (tx) => {
              const ui = await tx.doc(Ui, api.conversationId)
              ui.calls = ui.calls.filter((call) => call.id !== id)
            }, ctx)
            return { output: [{ type: 'text', text: JSON.stringify(answered.value) }] }
          }
          if (answered || api.wake?.reason === 'time') {
            const claimed = await api.commit(async (tx) => {
              const ui = await tx.doc(Ui, api.conversationId)
              const call = ui.calls.find((each) => each.id === id)
              ui.calls = ui.calls.filter((each) => each.id !== id)
              return !!call?.page
            }, ctx)
            return {
              isError: true,
              output: [
                {
                  type: 'text',
                  text: claimed
                    ? "Daniel's page took the request but did not answer in time: it may or may not have run. Look before repeating it."
                    : "Daniel's page did not answer: the voice panel must be open in his browser.",
                },
              ],
            }
          }
          const { op, ...input } = args as { op: 'snapshot' | 'query' | 'act' }
          await api.commit(async (tx) => {
            const ui = await tx.doc(Ui, api.conversationId)
            if (!ui.calls.some((call) => call.id === id))
              ui.calls = [...ui.calls, { id, task: api.taskId, op, input, at: api.now() }]
          }, ctx)
          return {
            sleep: { until: api.now() + UI_TIMEOUT_MS, signals: [UiAnswered.key(id)] },
          }
        },
        async cancel(_args, api, ctx) {
          await api.commit(async (tx) => {
            const ui = await tx.doc(Ui, api.conversationId)
            ui.calls = ui.calls.filter((call) => call.id !== api.callId)
          }, ctx)
        },
      }),
      defineTool({
        name: 'voice_handoff',
        deferred: true,
        description:
          "Hand the agreed outcome of this voice conversation to the main @ultimate as a message it acts on, or with `to` to the branch conversation on Daniel's screen (its coordinator), which a busy coordinator reads after its current tool round. Write it the way you would brief yourself.",
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
          const quoted = (words: string[], earlier: number) => [
            '',
            `Daniel's words in voice mode, oldest first${earlier ? ` (${earlier} earlier turns left out)` : ''}:`,
            ...words.map((said) => `> ${said.replaceAll('\n', '\n> ')}`),
          ]
          const receiver = await host.harness().conversation(target, ctx)
          if (!receiver) throw new Error(`#${target} does not exist`)
          await host.harness().commit(async (tx) => {
            const requestId = `voice:handoff:${api.taskId}`
            if (await tx.submissionByRequest(target, requestId)) return
            if (branch !== undefined)
              await checkBranch(host, tx, branch, (await tx.doc(Fork, api.conversationId)).screen)
            const shared = args.attachments?.length
              ? (await tx.scanEntries({ conversationId: api.conversationId }, 200)).items
                  .filter((entry) => VoiceTurnEntry.is(entry))
                  .flatMap((entry) => imagesOf(entry).toReversed())
                  .slice(0, maxImages)
                  .toReversed()
              : []
            if (shared.length) handoff.images = shared.length
            const session = await tx.doc(Fork, api.conversationId)
            const { words, earlier } = await wordsOf(tx, api.conversationId, session)
            if (words.length) handoff.words = words
            if (earlier) handoff.earlier = earlier
            const text = [...lines, ...(words.length ? quoted(words, earlier) : [])].join('\n')
            await receiver.submit(tx, {
              type: 'input',
              requestId,
              whenBusy: branch === undefined ? 'followUp' : 'steer',
              entry: { kind: VoiceHandoffEntry.kind, data: handoff },
              content: [{ type: 'text', text }, ...shared],
            })
            session.handedOff = true
          }, ctx)
          host.harness().resume()
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
