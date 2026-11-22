import { parseConversationId } from '../../lib/ids.ts'
import type { ConversationId, Cursor, SubmissionId } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { onCommit } from '../../lib/commits.ts'
import { defineDoc, LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { rebuiltOnOpen, inProcess, settled } from '../../lib/errors.ts'
import { deadline } from '../../lib/timers.ts'
import type { Cancel } from '../../lib/timers.ts'
import { rateLimited } from '../../lib/rate-limit.ts'
import { Standing } from '../subagents/api.ts'
import { PauseApi } from './api.ts'
import { formatDuration } from '../../lib/format.ts'
import { AutoPlayAction, PauseAction, PauseDoc, PlayAction, StateAction } from './refs.ts'
import type {
  AutoPlayed,
  HeldNote,
  PauseDocState,
  PauseNote,
  PauseState,
  RateLimit,
  RunningTask,
} from './refs.ts'

const State = defineDoc<PauseDocState>({
  kind: PauseDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ paused: false }),
})
export const docs = [State]

type Host = Pick<ExtensionHost, 'harness' | 'resource' | 'onOpen' | 'implement' | 'conversations'>

const sharedPauseFlag = (host: Pick<ExtensionHost, 'resource'>) =>
  host.resource('pause.flag', () => ({ paused: false }))

function holdRetryDuringPublication(host: Host) {
  sharedPauseFlag(host).paused = true
  host.harness().hold()
}

const read = async (host: Host) =>
  (await host.harness().snapshot(State, ROOT_CONVERSATION_ID, context)) ?? { paused: false }

function serializePause<T>(
  host: Pick<ExtensionHost, 'resource'>,
  work: () => Promise<T>,
): Promise<T> {
  const queue = host.resource('pause.queue', () => ({
    chain: Promise.resolve() as Promise<unknown>,
  }))
  const next = queue.chain.then(work)
  queue.chain = settled(next)
  return next
}

const HELD_WAIT_PHASES: Record<string, string[]> = {
  'ultimate.subagent-reporter': ['deliver'],
  'ultimate.automation-run': ['deliver'],
  'board.delivery': ['deliver', 'reply'],
  'board.settle': ['observe'],
  'lineage.notify': ['wait'],
}
export const passive = (record: { kind: string; state: unknown }) => {
  const phase = (record.state as { checkpoint?: { phase?: string } }).checkpoint?.phase
  return !!phase && (HELD_WAIT_PHASES[record.kind] ?? []).includes(phase)
}

async function activeTasks(host: Host): Promise<RunningTask[]> {
  const harness = host.harness()
  const { tasks } = await harness.inspect(context)
  const titles = new Map(host.conversations().map((c) => [c.id, c.label ?? c.title]))
  const tools = new Map<number, Map<number, string>>()
  const toolName = async (conversationId: ConversationId, task: number) => {
    if (!tools.has(conversationId)) {
      const live = await harness.snapshot(LiveDoc, conversationId, context)
      const slots = [...(live?.tools ?? []), ...(live?.nestedTools ?? [])]
      tools.set(
        conversationId,
        new Map(
          slots.flatMap((slot) => (slot.taskId === undefined ? [] : [[slot.taskId, slot.name]])),
        ),
      )
    }
    return tools.get(conversationId)!.get(task)
  }
  const result: RunningTask[] = []
  for (const { record, state: inspected } of tasks) {
    if (inspected.kind !== 'running' || (record.background && passive(record))) continue
    const what =
      record.kind === 'pi.generation'
        ? 'model response'
        : record.kind === 'pi.tool'
          ? ((await toolName(record.conversationId, record.id)) ?? 'tool call')
          : record.kind
    const title = titles.get(record.conversationId)
    result.push({
      task: record.id,
      conversationId: record.conversationId,
      ...(title ? { title } : {}),
      what,
      ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
    })
  }
  return result
}

async function state(host: Host): Promise<PauseState> {
  const doc = await read(host)
  return {
    paused: doc.paused,
    ...(doc.since === undefined ? {} : { since: doc.since }),
    ...(doc.limit === undefined ? {} : { limit: doc.limit }),
    ...(doc.autoPlay === undefined ? {} : { autoPlay: doc.autoPlay }),
    ...(autoPlayAt(doc) === undefined ? {} : { autoPlayAt: autoPlayAt(doc) }),
    running: await activeTasks(host),
  }
}

// Pi upstream: @earendil-works/pi-durable@1.6.0 — patched Harness.hold()/release() keep the scheduler from starting tasks.
async function holdAndRecordPause(host: Host, limit?: RateLimit) {
  const harness = host.harness()
  harness.hold()
  sharedPauseFlag(host).paused = true
  await harness.commit(async (tx) => {
    const doc = await tx.doc(State, ROOT_CONVERSATION_ID)
    if (doc.paused) {
      if (limit && !doc.limit) doc.limit = limit
      const userPressedPause = !limit
      if (userPressedPause) doc.manual = true
      return
    }
    const runs: NonNullable<PauseDocState['runs']> = {}
    const statusesWithRetryBackoff = ['pending', 'running', 'waiting', 'sleeping'] as const
    for (const status of statusesWithRetryBackoff) {
      let cursor: Cursor | undefined
      do {
        const page = await tx.scanTasks({ kind: 'pi.generation', status }, 100, cursor)
        for (const task of page.items) {
          const run = (await tx.doc(LiveDoc, task.conversationId)).run
          if (run?.taskId === task.id)
            runs[task.conversationId] = { task: task.id, input: run.inputs[0] }
        }
        cursor = page.next
      } while (cursor)
    }
    Object.assign(doc, {
      paused: true,
      since: Date.now(),
      runs,
      ...(limit ? { limit } : { manual: true }),
    })
  }, context)
  rearmAutoPlay(host, await read(host))
}

async function pause(host: Host) {
  await holdAndRecordPause(host)
  return state(host)
}

const autoPlayAt = (doc: PauseDocState) =>
  doc.paused && doc.limit && !doc.manual && doc.autoPlay && doc.since !== undefined
    ? doc.since + doc.autoPlay * 60_000
    : undefined

const outsideSchedulerTimer = (host: Pick<ExtensionHost, 'resource'>) =>
  host.resource('pause.autoplay', () => ({ cancel: undefined as Cancel | undefined }))

function rearmAutoPlay(host: Host, doc: PauseDocState) {
  const slot = outsideSchedulerTimer(host)
  slot.cancel?.()
  slot.cancel = undefined
  const at = autoPlayAt(doc)
  if (at === undefined) return
  slot.cancel = deadline(
    Math.max(0, at - Date.now()),
    () => {
      rebuiltOnOpen(
        'open re-arms auto-play from the persisted pause deadline',
        autoPlay(host).catch((error: unknown) => {
          console.error('pause: playing by itself failed:', error)
        }),
      )
    },
    { unref: true },
  )
}

export async function autoPlay(host: Host, now = Date.now()) {
  return serializePause(host, async () => {
    const doc = await read(host)
    const at = autoPlayAt(doc)
    if (at === undefined || now < at) return false
    const data: AutoPlayed = { since: doc.since!, at: now, minutes: doc.autoPlay! }
    const autoPlayOncePerPause = `pause.autoplay:${data.since}`
    const harness = host.harness()
    const ultimate = (await harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))?.ultimate
    if (ultimate !== undefined)
      await (
        await harness.conversation(ultimate, context)
      )?.submit(
        {
          type: 'write',
          requestId: autoPlayOncePerPause,
          entry: {
            kind: 'pause.autoplay',
            data,
            model: [
              {
                role: 'user',
                content: `Ultimate played by itself ${formatDuration(now - data.since)} after the rate limit paused it (the user's setting: ${data.minutes} min).`,
                timestamp: now,
              },
            ],
          },
        },
        context,
      )
    await noteRunsThenRelease(host, true)
    return true
  })
}

async function setAutoPlay(host: Host, minutes: unknown) {
  if (
    minutes !== null &&
    (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440)
  )
    throw new Error('minutes must be a whole number from 1 to 1440, or null to turn it off')
  await host.harness().commit(async (tx) => {
    const doc = await tx.doc(State, ROOT_CONVERSATION_ID)
    if (minutes === null) delete doc.autoPlay
    else doc.autoPlay = minutes
  }, context)
  rearmAutoPlay(host, await read(host))
  return state(host)
}

async function holdRetryOrRelease(host: Host, limit: RateLimit) {
  try {
    await holdAndRecordPause(host, limit)
  } catch (error) {
    sharedPauseFlag(host).paused = false
    host.harness().release()
    throw error
  }
  await writePauseLimitOnce(host, await read(host))
  await writeHeldRunOnce(host, limit)
}

async function writeHeldRunOnce(host: Host, limit: RateLimit) {
  const harness = host.harness()
  const child = limit.conversationId
  const parent = await harness.commit(
    async (tx) => (await tx.conversation(child))?.owner?.conversationId,
    context,
  )
  const input = (await harness.snapshot(LiveDoc, child, context))?.run?.inputs[0]
  if (parent === undefined || input === undefined) return
  if (!(await harness.snapshot(LiveDoc, parent, context))?.run) return
  const data: HeldNote = { child, provider: limit.provider, model: limit.model, at: limit.at }
  await (
    await harness.conversation(parent, context)
  )?.submit(
    {
      type: 'write',
      requestId: `pause.held:${child}:${input}`,
      entry: { kind: 'pause.held', data },
    },
    context,
  )
}

async function writePauseLimitOnce(host: Host, doc: PauseDocState) {
  const harness = host.harness()
  const ultimate = (await harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))?.ultimate
  if (!doc.paused || !doc.limit || ultimate === undefined) return
  await (
    await harness.conversation(ultimate, context)
  )?.submit(
    {
      type: 'write',
      requestId: `pause.limit:${doc.since}`,
      entry: { kind: 'pause.limit', data: doc.limit },
    },
    context,
  )
}

async function recordedRunOutcome(
  host: Host,
  id: ConversationId,
  recorded: { task: number; input?: number },
) {
  const harness = host.harness()
  const run = (await harness.snapshot(LiveDoc, id, context))?.run
  if (
    run &&
    (run.taskId === recorded.task ||
      (recorded.input !== undefined && run.inputs[0] === recorded.input))
  )
    return 'continued'
  if (recorded.input === undefined) return undefined
  const recordedInputOutcome = await (
    await harness.submission(recorded.input as SubmissionId, context)
  )?.status(context)
  return recordedInputOutcome?.status === 'done' ? 'finished' : undefined
}

async function noteRunsThenRelease(host: Host, auto = false) {
  const harness = host.harness()
  const doc = await read(host)
  if (doc.paused && doc.since !== undefined) {
    const until = Date.now()
    const span = `${formatDuration(until - doc.since)}${doc.limit ? ` (${doc.limit.provider} rate limited ${doc.limit.model})` : ''}`
    for (const [key, recorded] of Object.entries(doc.runs ?? {})) {
      const id = parseConversationId(Number(key))
      const how = await recordedRunOutcome(host, id, recorded)
      if (!how) continue
      const note: PauseNote = {
        since: doc.since,
        until,
        ...(how === 'finished' && { finished: true }),
        ...(auto && { auto: true }),
      }
      const content =
        how === 'finished'
          ? `Paused for ${span} after this run's last answer.`
          : `Paused for ${span}; the run continued after ${auto ? 'Ultimate played by itself' : 'Play'}.`
      const conversation = await harness.conversation(id, context)
      const noteOncePerPause = `pause.note:${note.since}`
      await conversation?.submit(
        {
          type: 'write',
          requestId: noteOncePerPause,
          entry: {
            kind: 'pause.note',
            data: note,
            model: [{ role: 'user', content, timestamp: note.until }],
          },
        },
        context,
      )
    }
  }
  await harness.commit(async (tx) => {
    const current = await tx.doc(State, ROOT_CONVERSATION_ID)
    current.paused = false
    delete current.since
    delete current.runs
    delete current.limit
    delete current.manual
  }, context)
  rearmAutoPlay(host, await read(host))
  sharedPauseFlag(host).paused = false
  harness.release()
  return state(host)
}

export default function pauseExtension(host: Host) {
  host.implement(PauseApi, { paused: () => sharedPauseFlag(host).paused })
  host.onOpen(async (opened) => {
    opened.defer(() => outsideSchedulerTimer(host).cancel?.())
    await serializePause(host, async () => {
      const doc = await read(host)
      sharedPauseFlag(host).paused = doc.paused
      if (!doc.paused) return
      host.harness().hold()
      rearmAutoPlay(host, doc)
      await writePauseLimitOnce(host, doc)
    })
    const unsubscribe = onCommit(host.harness(), (publication) => {
      const generationsSleepingBeforeRetry = new Set(
        publication.changes.flatMap((change) =>
          change.type === 'task' &&
          change.value.kind === 'pi.generation' &&
          change.value.state.status === 'sleeping'
            ? [change.value.conversationId]
            : [],
        ),
      )
      for (const change of publication.changes) {
        const message = change.type === 'entry' ? change.value.model?.[0] : undefined
        if (
          change.type !== 'entry' ||
          !generationsSleepingBeforeRetry.has(change.value.conversationId) ||
          message?.role !== 'assistant' ||
          message.stopReason !== 'error' ||
          !rateLimited(message.errorMessage ?? '')
        )
          continue
        const limit: RateLimit = {
          provider: message.provider,
          model: message.model,
          error: message.errorMessage!,
          at: message.timestamp,
          conversationId: change.value.conversationId,
        }
        holdRetryDuringPublication(host)
        inProcess(
          'the rate-limit hold controls generation retries in this process',
          serializePause(host, () => holdRetryOrRelease(host, limit)).catch((error: unknown) => {
            console.error('pause: pausing for a rate limit failed:', error)
          }),
        )
      }
    })
    opened.defer(unsubscribe)
  })
  return { name: 'pause' }
}

export const actions = {
  state: implementAction(StateAction, (_args, { host }) => state(host)),
  pause: implementAction(PauseAction, (_args, { host }) => serializePause(host, () => pause(host))),
  play: implementAction(PlayAction, (_args, { host }) =>
    serializePause(host, () => noteRunsThenRelease(host)),
  ),
  autoPlay: implementAction(AutoPlayAction, (args, { host }) =>
    serializePause(host, () => setAutoPlay(host, (args as { minutes?: unknown } | null)?.minutes)),
  ),
}
export const userActions = ['pause', 'play', 'autoPlay']
