import { BACKGROUND_CONTEXT as context, awaitWithContext } from '@earendil-works/chord/context'
import {
  AssistantEntry,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  GenerationTask,
  hook,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type {
  ConversationId,
  Cursor,
  ToolExecutionApi,
  ToolTaskInput,
  Tx,
} from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord/context'
import { bool, int, obj, opt, str } from '@earendil-works/pi-schema'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { openaiError } from '../../lib/openai.ts'
import type { OpenAiError } from '../../lib/openai.ts'
import { readSecret } from '../../lib/secrets.ts'
import { formatAgo } from '../../lib/ago.ts'
import { openQuestion } from '../../lib/message-state.ts'
import { Messages, MessagesApi } from '../messages/api.ts'
import type { Message, Question } from '../messages/api.ts'
import { Standing, SubagentsApi } from '../subagents/api.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { LineageApi } from '../lineage/api.ts'
import {
  AskedAction,
  EndAction,
  HeardAction,
  LogAction,
  StartAction,
  StatusAction,
} from './refs.ts'
import type {
  VoiceAnswer,
  VoiceContext,
  VoiceGo,
  VoiceLine,
  VoiceQuestion,
  VoiceSession,
} from './refs.ts'
import { voiceBrief } from './brief.ts'

const SECRET = 'OPENAI_API_KEY'
const NO_KEY = `Live voice needs an OpenAI API key: add ${SECRET} in ⌘K → Secrets`
export const secrets = [
  {
    name: SECRET,
    description: 'OpenAI API key for live voice',
    url: 'https://platform.openai.com/api-keys',
  },
]

/** Composer voice takes the ChatGPT login too; live voice stays API-key-only, since OpenAI refuses live sessions to it. */
async function apiKey(host: ExtensionHost, signal: AbortSignal) {
  const key = await readSecret(host.userHome, SECRET)
  if (key) return key
  const runtime = host.modelRuntime
  if (!runtime.getProviderAuthStatus('openai').configured || runtime.isUsingOAuth('openai'))
    return undefined
  return (await runtime.getAuth('openai', { signal }))?.auth.apiKey
}

/** GPT-Live is only the audio interface; the standing Voice agent decides and answers. */
export function liveInstructions() {
  return `Listen to the user. Speak exactly the commentary you receive, in the user's language, without adding content. Never answer questions about their work yourself or announce a handoff on your own.

Backchannel policy
Give only short, natural backchannels while listening. Answer connection checks, greetings and thanks yourself in a few words ("Yep, I hear you."). Commentary supplies all substantive answers. Say commentary as your own words: never mention that it came from somewhere else, and never say what you were told to say.

Interruption policy
Stop speaking and listen when the user interrupts.

Delegation policy
Do not generate <|SpawnThinking|>: always. Do not delegate. The Voice agent receives every finished line and handles requests. Thinking notes are quiet context, not words to read aloud.`
}

const Forwarded = defineDoc<{ scheduled: boolean }>({
  kind: 'voice-live.forwarded',
  checkpointWhen: () => false,
  version: 1,
  scope: 'task',
  initial: () => ({ scheduled: false }),
})
export const userActions = ['status', 'start', 'heard', 'asked', 'log', 'end']
const terminal = {
  status: 'terminal',
  outcome: { status: 'completed', result: null },
} as const

async function voiceId(host: ExtensionHost) {
  const standing = await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, context)
  if (!standing?.voice) throw new Error('Start live voice first')
  return standing.voice
}

async function lines(tx: Tx, id: ConversationId, limit: number) {
  const result: VoiceLine[] = []
  let cursor: Cursor | undefined
  do {
    const page = await tx.scanEntries({ conversationId: id, order: 'descending' }, 100, cursor)
    for (const entry of page.items) {
      if (entry.kind === 'voice.line') result.push(entry.data as VoiceLine)
      if (result.length === limit) return result.toReversed()
    }
    cursor = page.next
  } while (cursor)
  return result.toReversed()
}

/** The brief each Voice conversation's session is still putting together; a heard line waits for it. */
const pending = (host: ExtensionHost) =>
  host.resource('voice-live.briefs', () => new Map<ConversationId, Promise<unknown>>())

const briefMessage = (text: string) => ({
  role: 'user' as const,
  content: text,
  timestamp: Date.now(),
})

/** The newest stored brief of Voice conversation `id`, read inside `tx`. */
async function newestBrief(tx: Tx, id: ConversationId) {
  let cursor: Cursor | undefined
  do {
    const page = await tx.scanEntries({ conversationId: id, order: 'descending' }, 100, cursor)
    const found = page.items.find((entry) => entry.kind === 'voice.context')
    if (found) return found
    cursor = page.next
  } while (cursor)
  return undefined
}

/**
 * Put the session's brief into Voice's transcript as a context entry, replacing the previous brief for the model: its
 * edit omits it, and that one's edit the one before, so only the newest counts. `transient`: compaction summaries leave
 * it out, and Voice's next request places it again when compaction cut it (see the beforeRequest hook).
 */
async function placeBrief(
  host: ExtensionHost,
  id: ConversationId,
  session: string,
  brief: VoiceContext,
) {
  const previous = await host.harness().commit((tx) => newestBrief(tx, id), context)
  const conversation = (await host.harness().conversation(id, context))!
  // Admitted, not awaited: while Voice is busy it queues, still ahead of any line heard after it.
  await conversation.submit(
    {
      type: 'write',
      requestId: `voice:context:${session}`,
      entry: {
        kind: 'voice.context',
        data: { ...brief, transient: true },
        ...(brief.error ? {} : { model: [briefMessage(brief.text)] }),
        ...(previous ? { edits: [{ target: previous.id, action: 'omit' as const }] } : {}),
      },
    },
    context,
  )
}

/** Display-only writes need no model message and never launch a turn. */
async function write(
  host: ExtensionHost,
  id: ConversationId,
  kind: 'voice.line' | 'voice.session',
  data: VoiceLine | VoiceSession,
  requestId: string,
) {
  const conversation = (await host.harness().conversation(id, context))!
  const settled = await (
    await conversation.submit({ type: 'write', requestId, entry: { kind, data } }, context)
  ).wait(context)
  if (settled.status !== 'done' || settled.type !== 'write')
    throw new Error(`Voice write failed: ${settled.reason}`)
  return settled.entry
}

function questionsText(questions: Question[]) {
  return questions
    .map((q, i) =>
      [
        `${q.ref ?? i + 1}. ${q.text}`,
        ...(q.options ?? []).map(
          (o, j) =>
            `${o.key ?? String.fromCharCode(97 + j)}: ${o.label}${o.detail ? ` — ${o.detail}` : ''}${o.recommended ? ' (the asker’s pick)' : ''}`,
        ),
        ...(q.scale
          ? [
              `Scale ${q.scale.min} (${q.scale.low ?? ''}) to ${q.scale.max} (${q.scale.high ?? ''})`,
            ]
          : []),
      ].join('\n'),
    )
    .join('\n\n')
}

/** Who asks `message`, for Voice to say: @ultimate, or the branch by title and id. */
function askerOf(host: ExtensionHost, message: Pick<Message, 'from'>, main: number | undefined) {
  if (message.from === main) return '@ultimate'
  const title = host.conversations().find((c) => c.id === message.from)?.title
  return `#${message.from}${title ? ` "${title}"` : ''}`
}

/** One open question to the user in full, the way Voice reads it out. */
function questionText(host: ExtensionHost, message: Message, main: number | undefined) {
  return [
    `Message ${message.id} from ${askerOf(host, message, main)}, asked ${formatAgo(message.at, Date.now(), { ago: true })}:`,
    message.text,
    ...(message.questions?.length ? ['', `Questions:\n${questionsText(message.questions)}`] : []),
  ].join('\n')
}

/** The open questions to the user, oldest first (the Inbox's order), one line each, the way their cards head them. */
export async function openList(host: ExtensionHost, ctx: Context) {
  const [open, standing] = await Promise.all([
    host.need(MessagesApi).openQuestions(ctx),
    host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, ctx),
  ])
  const now = Date.now()
  return open.length
    ? open
        .map(
          (q) =>
            `- message ${q.message} from ${askerOf(host, { from: q.conversation }, standing?.ultimate)}: ${q.text} (asked ${formatAgo(q.at, now, { ago: true })})`,
        )
        .join('\n')
    : 'No open questions.'
}

/** The one-line gist of open question `message`, as its card heads it; undefined once it is not open. */
async function gistOf(host: ExtensionHost, message: number, ctx: Context) {
  return (await host.need(MessagesApi).openQuestions(ctx)).find((q) => q.message === message)?.text
}

/** Voice's spoken line for tool `taskId`, when a tool speaks and ends Voice's turn in one call. */
const speak = (host: ExtensionHost, id: ConversationId, text: string, taskId: number) =>
  write(host, id, 'voice.line', { role: 'ultimate', text, speech: true }, `voice:say:${taskId}`)

/** Both writers share one request id, so the first write's time is the one kept. */
const userLine = (input: { text: string }): VoiceLine => ({
  role: 'user',
  text: input.text,
  forwarded: true,
  at: Date.now(),
})

/** A stable input request id makes answer delivery safe if the task resumes after submitting it. */
async function answerVoice(
  host: ExtensionHost,
  voice: number,
  line: number,
  text: string,
  source?: VoiceAnswer['source'],
) {
  const conversation = (await host.harness().conversation(voice as ConversationId, context))!
  const data: VoiceAnswer = { text, re: line, ...(source ? { source } : {}) }
  await conversation.submit(
    {
      type: 'input',
      requestId: `voice:answer:${line}`,
      whenBusy: 'steer',
      entry: { kind: 'voice.answer', data },
      content: `@ultimate answered (to forwarded line ${line}):\n${text}`,
    },
    context,
  )
}

export function answerTask(host: ExtensionHost) {
  return defineTask<
    {
      voice: number
      main: number
      /** Names the user's forwarded line, written once under `voice:line:<request>`. */
      request: string
      text: string
      firstMessage: number
      /** @ultimate's open question this utterance answers, named by Voice (voice_answer). */
      message?: number
    },
    { phase: 'answer' },
    null
  >({
    name: 'voice-live.answer',
    version: 1,
    initial: () => ({ phase: 'answer' }),
    phases: {
      answer: async (task, runtime, ctx) => {
        const input = task.input
        const main = input.main as ConversationId
        const recipient = (await host.harness().conversation(main, ctx))!
        const line = await write(
          host,
          input.voice as ConversationId,
          'voice.line',
          userLine(input),
          `voice:line:${input.request}`,
        )
        // The question Voice named with voice_answer; none is guessed. Without one the utterance goes in as plain input.
        const question = input.message ?? false
        let receipt
        // A crash after answer() finds this utterance's own reply by its text, never another answer to the question.
        const log = await runtime.snapshot(Messages, ROOT_CONVERSATION_ID, ctx)
        const previous =
          question === false
            ? undefined
            : log?.messages.find(
                (m) => m.from === 'user' && m.re === question && m.text === input.text,
              )
        const reply =
          question === false
            ? undefined
            : (previous?.id ??
              (await host
                .need(MessagesApi)
                .answer(question, input.text, ctx)
                .catch((error: unknown) => {
                  // Answered meanwhile (its card, another utterance): this utterance goes in as plain voice input.
                  if (
                    error instanceof Error &&
                    error.message === 'These questions are no longer open'
                  )
                    return undefined
                  throw error
                })))
        if (reply !== undefined) {
          const watch = (await runtime.watchDoc(Messages, ROOT_CONVERSATION_ID, ctx))!
          const placed = Promise.withResolvers<void>()
          const inspect = (value: typeof watch.value) => {
            const m = value?.messages.find((candidate) => candidate.id === reply)
            if (m?.entry) placed.resolve()
            else if (m && ['failed', 'stopped'].includes(m.state))
              placed.reject(new Error(m.error ?? 'Voice reply was not delivered'))
          }
          watch.start(async (call) => {
            if (call.kind === 'value') inspect(call.value)
          })
          try {
            inspect(watch.value)
            await awaitWithContext(placed.promise, ctx)
          } finally {
            await watch.stop()
          }
          let cursor: Cursor | undefined
          do {
            const page = await host.scanSubmissions({ conversationId: main }, 100, cursor, ctx)
            const found = page.items.find((s) => s.requestId === `board:${reply}`)
            if (found) {
              receipt = await host.harness().submission(found.id, ctx)
              break
            }
            cursor = page.next
          } while (cursor)
          if (!receipt) throw new Error('Voice question reply has no input receipt')
        } else {
          receipt = await recipient.submit(
            {
              type: 'input',
              requestId: `voice:${line}`,
              whenBusy: 'steer',
              entry: {
                kind: 'voice.utterance',
                data: { text: input.text, line },
              },
              content: `The user, by voice (live transcript, may contain mistakes):\n${input.text}`,
            },
            ctx,
          )
        }
        const settled = await receipt.wait(ctx)
        if (settled.status !== 'done' || settled.type !== 'input') {
          // Said out loud too: the user waits by ear, so a silent failure looks like nothing happened.
          await write(
            host,
            input.voice as ConversationId,
            'voice.line',
            {
              role: 'notice',
              text:
                settled.status === 'unanswered' && settled.reason === 'aborted'
                  ? 'Ultimate was stopped before it answered.'
                  : 'Ultimate did not answer that.',
              re: line,
            },
            `voice:notice:${line}`,
          )
          await answerVoice(host, input.voice, line, 'Ultimate did not answer that request.')
          await runtime.commit(
            () => ({
              status: 'terminal',
              outcome: {
                status: 'failed',
                error: { message: 'Ultimate did not answer the voice input' },
              },
            }),
            ctx,
          )
          return
        }
        const source = await host.harness().commit(async (tx) => {
          const answer = await tx.entry(AssistantEntry, settled.answer)
          const message = answer?.model?.[0]
          const plain =
            message?.role === 'assistant'
              ? message.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('')
              : ''
          // A tool-terminated message can have no final prose. Match calls in this run, not another concurrent run.
          const calls = new Set<string>()
          let cursor: Cursor | undefined
          do {
            const page = await tx.scanEntries(
              {
                conversationId: main,
                minEntryId: settled.entry,
                maxEntryId: settled.answer,
                order: 'ascending',
              },
              100,
              cursor,
            )
            for (const entry of page.items)
              for (const m of entry.model ?? [])
                if (m.role === 'assistant')
                  for (const p of m.content) if (p.type === 'toolCall') calls.add(p.id)
            cursor = page.next
          } while (cursor)
          const sent = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.findLast(
            (m) =>
              m.id >= input.firstMessage &&
              m.from === main &&
              m.to === 'user' &&
              m.call &&
              [...calls].some((call) => m.call === call || m.call!.startsWith(`${call}/`)),
          )
          return sent
            ? `${sent.text}${sent.questions?.length ? `\n\nQuestions:\n${questionsText(sent.questions)}` : ''}`
            : plain
        }, ctx)
        await answerVoice(
          host,
          input.voice,
          line,
          source || 'Ultimate finished without an answer.',
          {
            conversation: main,
            entry: settled.answer,
          },
        )
        await runtime.commit(() => terminal, ctx)
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })
}

/** The dock's message when OpenAI refuses a session: its own words, since a bare "(HTTP 429)" hid "no credits". */
function liveFailure({ status, message, code }: OpenAiError) {
  const said = message ? `: ${message}` : ''
  return `OpenAI live session failed (HTTP ${status}${code ? ` ${code}` : ''})${said}`
}

export const actions = {
  status: implementAction(StatusAction, async (_args, { host, signal }) =>
    (await apiKey(host, signal))
      ? { available: true as const }
      : { available: false as const, reason: NO_KEY },
  ),
  start: implementAction(StartAction, async (args, { host, signal }) => {
    const sdp = args && typeof args === 'object' && !Array.isArray(args) ? args.sdp : undefined
    if (typeof sdp !== 'string' || !sdp.trim()) throw new Error('Expected an SDP offer')
    const key = await apiKey(host, signal)
    if (!key) throw new Error(NO_KEY)
    const id = await host.need(SubagentsApi).standing('voice', context)
    // Put together while the session connects; a failure becomes a brief that says so, never a failed start.
    const main = (await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, context))?.ultimate
    const started = performance.now()
    const brief = (
      main
        ? voiceBrief(host, main, context)
        : Promise.reject(new Error('@ultimate is not available'))
    ).then(
      (made) => ({ ...made, ms: Math.round(performance.now() - started) }),
      (error: unknown): VoiceContext => ({
        text: '',
        memories: 0,
        requests: 0,
        branches: 0,
        tokens: 0,
        at: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    const recent = await host.harness().commit((tx) => lines(tx, id, 10), context)
    // Bound both messages and input size, leaving room below the 8,192-token session seed cap.
    const input = recent
      .filter((line) => line.role !== 'note')
      .map((line) => ({
        type: 'message',
        role: line.role === 'user' ? 'user' : 'assistant',
        content: [
          {
            type: line.role === 'user' ? 'input_text' : 'output_text',
            text: line.text.slice(0, 200),
          },
        ],
      }))
    const response = await fetch('https://api.openai.com/v1/live/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session: {
          model: 'gpt-live-1',
          instructions: liveInstructions(),
          audio: { output: { voice: 'marin' } },
          delegation: { type: 'client' },
          ...(input.length ? { input } : {}),
        },
        transport: { type: 'webrtc', sdp },
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    })
    if (!response.ok) throw new Error(liveFailure(await openaiError(response)))
    const answer = (await response.json()) as {
      session?: { id?: string }
      transport?: { type?: string; sdp?: string }
    }
    if (!answer.session?.id || answer.transport?.type !== 'webrtc' || !answer.transport.sdp)
      throw new Error('OpenAI returned no WebRTC session answer')
    await write(
      host,
      id,
      'voice.session',
      { phase: 'started', at: Date.now() },
      `voice:start:${answer.session.id}`,
    )
    const briefs = pending(host)
    const placing = brief
      .then((made) => placeBrief(host, id, answer.session!.id!, made))
      .catch((error: unknown) => console.error('Voice brief:', error))
      .finally(() => {
        if (briefs.get(id) === placing) briefs.delete(id)
      })
    briefs.set(id, placing)
    return { sdp: answer.transport.sdp, conversation: id }
  }),
  heard: implementAction(HeardAction, async (args, { host }) => {
    const text = args && typeof args === 'object' && !Array.isArray(args) ? args.text : undefined
    if (typeof text !== 'string' || !text.trim()) throw new Error('Expected text')
    const id = await voiceId(host)
    // The first line of a session goes in after its brief, so Voice reads it with the context.
    await pending(host).get(id)
    const conversation = (await host.harness().conversation(id, context))!
    await conversation.submit(
      {
        type: 'input',
        whenBusy: 'steer',
        entry: { kind: 'voice.heard', data: { text: text.trim() } },
        content: `The user, by voice (live transcript, may contain mistakes):\n${text.trim()}`,
      },
      context,
    )
    return {}
  }),
  asked: implementAction(AskedAction, async (args, { host }) => {
    const id = args && typeof args === 'object' && !Array.isArray(args) ? args.message : undefined
    if (typeof id !== 'number') throw new Error('Expected a message id')
    const voice = await voiceId(host)
    const [open, standing] = await Promise.all([
      host.need(MessagesApi).openQuestions(context),
      host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, context),
    ])
    const question = open.find((q) => q.message === id)
    // Answered before the user paused: nothing to announce.
    if (!question) return {}
    const data: VoiceQuestion = {
      message: id,
      from: question.conversation,
      title: askerOf(host, { from: question.conversation }, standing?.ultimate),
      gist: question.text,
    }
    const conversation = (await host.harness().conversation(voice, context))!
    // Once per message, however many times the page asks.
    await conversation.submit(
      {
        type: 'input',
        requestId: `voice:asked:${id}`,
        whenBusy: 'steer',
        entry: { kind: 'voice.question', data },
        content: `A new question for the user arrived: message ${id} from ${data.title}: ${data.gist}`,
      },
      context,
    )
    return {}
  }),
  log: implementAction(LogAction, async (args, { host }) => {
    const { role, text } = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
    if ((role !== 'live' && role !== 'notice') || typeof text !== 'string' || !text.trim())
      throw new Error('Expected a live or notice role and text')
    const line = await write(
      host,
      await voiceId(host),
      'voice.line',
      { role, text: text.trim() },
      `voice:log:${crypto.randomUUID()}`,
    )
    return { line }
  }),
  end: implementAction(EndAction, async (args, { host }) => {
    const seconds =
      args && typeof args === 'object' && !Array.isArray(args) ? args.seconds : undefined
    if (
      seconds !== undefined &&
      (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0)
    )
      throw new Error('Expected nonnegative seconds')
    await write(
      host,
      await voiceId(host),
      'voice.session',
      {
        phase: 'ended',
        at: Date.now(),
        ...(seconds !== undefined ? { seconds } : {}),
      },
      `voice:end:${crypto.randomUUID()}`,
    )
    return {}
  }),
}

export default (host: ExtensionHost) => {
  /**
   * Pass `text` to @ultimate as the user's forwarded line, answering its open question `message` when given; the answer
   * task brings @ultimate's answer back to Voice.
   */
  async function forward(api: ToolExecutionApi, ctx: Context, text: string, message?: number) {
    const main = (await api.snapshot(Standing, ROOT_CONVERSATION_ID, ctx))?.ultimate
    if (!main) throw new Error('@ultimate is not available')
    const input = {
      voice: api.conversationId,
      main,
      request: String(api.taskId),
      text,
      ...(message !== undefined ? { message } : {}),
    }
    // Record and create atomically: a crash after scheduling never creates a second answer task.
    await api.commit(async (tx) => {
      const log = await tx.doc(Messages, ROOT_CONVERSATION_ID)
      const receipt = await tx.doc(Forwarded, api.taskId)
      if (receipt.scheduled) return
      await tx.createTask(
        answerTask(host),
        { ...input, firstMessage: log.next },
        {
          conversationId: api.conversationId,
          ownership: { kind: 'conversation' },
          background: true,
        },
      )
      receipt.scheduled = true
    }, ctx)
    host.harness().resume()
    await write(
      host,
      api.conversationId,
      'voice.line',
      userLine(input),
      `voice:line:${input.request}`,
    )
  }
  host.need(MessagesApi)
  host.need(SubagentsApi)
  host.need(LineageApi)
  host.need(ConversationsApi)
  return defineExtension({
    name: 'voice-live',
    tasks: [answerTask(host)],
    hooks: [
      hook(GenerationTask, {
        // A compaction that cut the newest brief leaves Voice without it: place it again after the summary. Like recall,
        // the entry lands after this request's cutoff, so this request gets the same message appended.
        beforeRequest: async (request, api, ctx) => {
          if (
            (await api.snapshot(Standing, ROOT_CONVERSATION_ID, ctx))?.voice !== api.conversationId
          )
            return undefined
          const id = api.conversationId
          const view = await (await host.harness().conversation(id, ctx))!.context(ctx)
          if (!view.head) return undefined
          const message = await host.harness().commit(async (tx) => {
            const newest = await newestBrief(tx, id)
            const data = newest?.data as VoiceContext | undefined
            if (!newest || !data || data.error || view.entries.some((e) => e.id === newest.id))
              return undefined
            const again = briefMessage(data.text)
            await tx.appendEntry(id, {
              kind: 'voice.context',
              data: { ...data, again: true, transient: true },
              model: [again],
            })
            return again
          }, ctx)
          return message ? { messages: [...request.messages, message] } : undefined
        },
      }),
    ],
    tools: [
      defineTool({
        name: 'voice_say',
        deferred: true,
        description:
          'Speak text to the user through GPT-Live. Use for your answer, clarification or brief acknowledgement.',
        parameters: obj({ text: str({ minLength: 1 }) }),
        // The tool task's request id writes the spoken line once; correlation is memoized.
        replay: 'safe',
        async execute({ text }, api, ctx) {
          if (api.conversationId !== (await voiceId(host))) throw new Error('Only Voice speaks')
          // Locate the input this tool round saw, not a later queued/steering input. No model-supplied correlation id.
          const task = await api.getTask(api.taskId, ctx)
          const input = task?.input as ToolTaskInput
          const re =
            (await api.memo('re', ctx)) ??
            (await api.memo(
              're',
              await api.commit(async (tx) => {
                let cursor: Cursor | undefined
                do {
                  const page = await tx.scanEntries(
                    {
                      conversationId: api.conversationId,
                      ...(input.kind === 'model' ? { maxEntryId: input.assistant } : {}),
                      order: 'descending',
                    },
                    100,
                    cursor,
                  )
                  for (const entry of page.items) {
                    if (entry.kind === 'voice.answer') return (entry.data as { re: number }).re
                    if (entry.kind === 'voice.heard') return false
                  }
                  cursor = page.next
                } while (cursor)
                return false
              }, ctx),
              ctx,
            ))
          await write(
            host,
            api.conversationId,
            'voice.line',
            {
              role: 'ultimate',
              text,
              speech: true,
              ...(typeof re === 'number' ? { re } : {}),
            },
            `voice:say:${api.taskId}`,
          )
          return {
            output: [{ type: 'text', text: 'Spoken.' }],
            control: { terminate: true },
          }
        },
      }),
      defineTool({
        name: 'voice_ask_ultimate',
        deferred: true,
        description:
          'Pass a clear, self-contained request in the user’s words to @ultimate. Its answer returns as input; do not wait here.',
        parameters: obj({ request: str({ minLength: 1 }) }),
        // A transactional receipt schedules once; the forwarded line has a stable write request id.
        replay: 'safe',
        async execute({ request }, api, ctx) {
          if (api.conversationId !== (await voiceId(host)))
            throw new Error('Only Voice forwards requests')
          await forward(api, ctx, request)
          return {
            output: [
              {
                type: 'text',
                text: 'Passed to @ultimate. Its answer will arrive as input.',
              },
            ],
          }
        },
      }),
      defineTool({
        name: 'voice_show',
        deferred: true,
        description:
          'Show something on the user’s screen: a surface (`surface`, its id or title: agent, inbox, memory, review, system, pr-triage…), a conversation (`conversation`, its id), or an open question in the Inbox (`message`). Give exactly one. With `say`, also speak that short line and end your turn.',
        parameters: obj({
          surface: opt(str({ minLength: 1 })),
          conversation: opt(int()),
          message: opt(int()),
          say: opt(str({ minLength: 1 })),
        }),
        // Stable request ids write each line once.
        replay: 'safe',
        async execute({ surface, conversation, message, say }, api, ctx) {
          if (api.conversationId !== (await voiceId(host))) throw new Error('Only Voice navigates')
          if ([surface, conversation, message].filter((v) => v !== undefined).length !== 1)
            throw new Error('Give exactly one of surface, conversation or message')
          let go: VoiceGo
          let label: string
          if (message !== undefined) {
            const gist = await gistOf(host, message, ctx)
            if (gist === undefined)
              throw new Error(`Message ${message} is not an open question to the user`)
            go = { message }
            label = `Inbox · ${gist}`
          } else if (conversation !== undefined) {
            const found = host.conversations().find((c) => c.id === conversation)
            if (!found) throw new Error(`No conversation #${conversation}`)
            go = { conversation }
            label = `#${conversation}${found.title ? ` ${found.title}` : ''}`
          } else {
            // The page knows its surfaces; it reports one it does not have as a notice.
            go = { surface: surface! }
            label = surface!
          }
          await write(
            host,
            api.conversationId,
            'voice.line',
            { role: 'action', text: label, go },
            `voice:show:${api.taskId}`,
          )
          if (!say) return { output: [{ type: 'text', text: `Showing ${label}.` }] }
          await speak(host, api.conversationId, say, api.taskId)
          return {
            output: [{ type: 'text', text: 'Shown and spoken.' }],
            control: { terminate: true },
          }
        },
      }),
      defineTool({
        name: 'voice_question',
        deferred: true,
        description:
          'Read the questions waiting on the user. Without `message`: every open one, oldest first (the Inbox order). With `message`: that one in full (who asks, its text, each numbered question with lettered options and the asker’s picks) and, unless `show` is false, its card shown in the Inbox.',
        parameters: obj({ message: opt(int()), show: opt(bool()) }),
        // Reads, and one navigation line under the tool task's stable request id.
        replay: 'safe',
        async execute({ message, show }, api, ctx) {
          if (api.conversationId !== (await voiceId(host)))
            throw new Error('Only Voice reads questions')
          if (message === undefined)
            return { output: [{ type: 'text', text: await openList(host, ctx) }] }
          const [log, standing, gist] = await Promise.all([
            api.snapshot(Messages, ROOT_CONVERSATION_ID, ctx),
            api.snapshot(Standing, ROOT_CONVERSATION_ID, ctx),
            gistOf(host, message, ctx),
          ])
          const found = log?.messages.find((m) => m.id === message)
          if (!found || gist === undefined)
            return {
              output: [
                {
                  type: 'text',
                  text: `Message ${message} is no longer open.\n\nStill open:\n${await openList(host, ctx)}`,
                },
              ],
            }
          if (show !== false)
            await write(
              host,
              api.conversationId,
              'voice.line',
              { role: 'action', text: `Inbox · ${gist}`, go: { message } },
              `voice:show:${api.taskId}`,
            )
          return {
            output: [{ type: 'text', text: questionText(host, found, standing?.ultimate) }],
          }
        },
      }),
      defineTool({
        name: 'voice_answer',
        deferred: true,
        description:
          'Settle open question `message` with the user’s answer `text` (numbered parts with their letters, in their words), or close it unanswered with `dismiss`. Only after you read the answer back and the user confirmed it. Returns the questions still open.',
        parameters: obj({
          message: int(),
          text: opt(str({ minLength: 1 })),
          dismiss: opt(bool()),
        }),
        // The settled reply is memoized; a replay after a crash finds the message no longer open and goes on.
        replay: 'safe',
        async execute({ message, text, dismiss }, api, ctx) {
          if (api.conversationId !== (await voiceId(host)))
            throw new Error('Only Voice answers questions')
          if (!dismiss && !text) throw new Error('Give the answer text, or dismiss')
          const main = (await api.snapshot(Standing, ROOT_CONVERSATION_ID, ctx))?.ultimate
          const found = (await api.snapshot(Messages, ROOT_CONVERSATION_ID, ctx))?.messages.find(
            (m) => m.id === message,
          )
          const done = await api.memo<boolean>('settled', ctx)
          if (!done) {
            if (!found || !openQuestion(found))
              throw new Error(`Message ${message} is not an open question to the user`)
            if (dismiss) await host.need(MessagesApi).dismiss(message, ctx)
            else if (found.from === main) {
              // @ultimate's own question: its answer follows, and comes back to Voice to speak.
              await forward(api, ctx, text!, message)
            } else await host.need(MessagesApi).answer(message, text!, ctx)
            await api.memo('settled', true, ctx)
          }
          if (dismiss || found?.from !== main)
            await write(
              host,
              api.conversationId,
              'voice.line',
              {
                role: 'action',
                text: dismiss
                  ? `Dismissed message ${message}`
                  : `Answered message ${message}: ${text}`,
              },
              `voice:answered:${api.taskId}`,
            )
          return {
            output: [
              {
                type: 'text',
                text: `${dismiss ? 'Dismissed' : 'Answered'}${found?.from === main && !dismiss ? '; @ultimate’s reply will arrive as input' : ''}.\n\nStill open:\n${await openList(host, ctx)}`,
              },
            ],
          }
        },
      }),
      defineTool({
        name: 'voice_note',
        deferred: true,
        description: 'Give GPT-Live quiet context, without speaking it.',
        parameters: obj({ text: str({ minLength: 1 }) }),
        // The tool task's stable request id writes the context note once.
        replay: 'safe',
        async execute({ text }, api) {
          if (api.conversationId !== (await voiceId(host)))
            throw new Error('Only Voice sends thinking notes')
          await write(
            host,
            api.conversationId,
            'voice.line',
            { role: 'note', text },
            `voice:note:${api.taskId}`,
          )
          return {
            output: [{ type: 'text', text: 'Noted.' }],
            control: { terminate: true },
          }
        },
      }),
    ],
  })
}
