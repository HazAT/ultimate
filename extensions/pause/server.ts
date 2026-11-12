import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { onCommit } from '../../lib/commits.ts'
import { defineDoc, LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, Cursor, SubmissionId } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { rateLimited } from '../../lib/rate-limit.ts'
import { Standing } from '../subagents/api.ts'
import { PauseApi } from './api.ts'
import { lasted } from './lasted.ts'
import { AutoPlayAction, PauseAction, PauseDoc, PlayAction, StateAction } from './refs.ts'
import type {
  AutoPlayed,
  HeldNote,
  Hold,
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

type Host = Pick<
  ExtensionHost,
  'harness' | 'resource' | 'onOpen' | 'onClose' | 'onRelease' | 'implement' | 'conversations'
>

/** The flag timers read synchronously; shared across reloads, set from the doc each time the harness opens. */
const flag = (host: Pick<ExtensionHost, 'resource'>) =>
  host.resource('pause.flag', () => ({ paused: false }))

const read = async (host: Host) =>
  (await host.harness().snapshot(State, ROOT_CONVERSATION_ID, context)) ?? { paused: false }

/** Run pause, play and the reopen hold one at a time, across reloads: an interleaving could release a paused host. */
function serial<T>(host: Pick<ExtensionHost, 'resource'>, work: () => Promise<T>): Promise<T> {
  const queue = host.resource('pause.queue', () => ({
    chain: Promise.resolve() as Promise<unknown>,
  }))
  const next = queue.chain.then(work)
  // The caller gets the failure; the chain only waits for the work to settle.
  queue.chain = next.catch(() => undefined)
  return next
}

/**
 * Background phases that only wait on other work (a run, a submission, a timer), which a pause holds: they never end
 * while paused and execute nothing meanwhile, so they never keep the pause from being safe.
 */
const PASSIVE: Record<string, string[]> = {
  'ultimate.subagent-reporter': ['deliver', 'retry'],
  'ultimate.automation-scheduler': ['sleep'],
  'ultimate.automation-run': ['deliver'],
  'board.delivery': ['deliver', 'reply'],
  'board.route': ['observe'],
  'conversations.summary': ['observe'],
  'lineage.notify': ['wait'],
}
export const passive = (record: { kind: string; state: unknown }) => {
  const phase = (record.state as { checkpoint?: { phase?: string } }).checkpoint?.phase
  return !!phase && (PASSIVE[record.kind] ?? []).includes(phase)
}

/**
 * Tasks with a running invocation that execute something (a model response, a tool, a summary streaming): each
 * finishes on its own, then nothing starts after it. Passive waiters never count.
 */
async function running(host: Host): Promise<RunningTask[]> {
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
    ...(doc.held === undefined ? {} : { held: doc.held }),
    ...(doc.autoPlay === undefined ? {} : { autoPlay: doc.autoPlay }),
    ...(autoPlayAt(doc) === undefined ? {} : { autoPlayAt: autoPlayAt(doc) }),
    running: await running(host),
  }
}

// Pi upstream: @earendil-works/pi-durable@1.5.2 — patched Harness.hold()/release() keep the scheduler from starting tasks.
/**
 * Hold the scheduler, then record the pause and each run mid-turn now (its task and first input), which Play notes;
 * `cause` is why: a rate limit, or an extension's hold. A pause already recorded keeps its start and the explanation
 * shown, and gains the cause's if it had none.
 */
async function hold(host: Host, cause?: Cause) {
  const harness = host.harness()
  harness.hold()
  flag(host).paused = true
  await harness.commit(async (tx) => {
    const doc = await tx.doc(State, ROOT_CONVERSATION_ID)
    // Only a rate limit plays by itself: the user's Pause and an extension's hold wait for Play.
    if (!(cause && 'limit' in cause)) doc.manual = true
    if (cause && 'limit' in cause && !doc.limit) doc.limit = cause.limit
    if (cause && 'held' in cause && !doc.held) doc.held = cause.held
    if (doc.paused) return
    const runs: NonNullable<PauseDocState['runs']> = {}
    // Sleeping: a generation waiting out its retry backoff, as one that just hit a rate limit does.
    for (const status of ['pending', 'running', 'waiting', 'sleeping'] as const) {
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
    Object.assign(doc, { paused: true, since: Date.now(), runs })
  }, context)
  arm(host, await read(host))
}

async function pause(host: Host) {
  await hold(host)
  return state(host)
}

/** Why the host is held: a rate limit that paused it, or an extension's hold. */
type Cause = { limit: RateLimit } | { held: Hold }

/** An extension holds the host with its reason, as the user's Pause does; serialized with Play so the two never race. */
async function holdBy(host: Host, request: Hold) {
  const { source, reason } = (request ?? {}) as Partial<Hold>
  if (typeof source !== 'string' || !source.trim() || typeof reason !== 'string' || !reason.trim())
    throw new Error('hold needs { source, reason }: the extension holding the pause, and why')
  const wasPaused = flag(host).paused
  try {
    await hold(host, { held: { source: source.trim(), reason: reason.trim() } })
  } catch (error) {
    // The commit recorded nothing, so nothing would show the hold or offer Play: release what it took, as `limited` does.
    if (!wasPaused) {
      flag(host).paused = false
      host.harness().release()
    }
    throw error
  }
  return state(host)
}

/** When `doc`'s pause plays by itself: a rate-limit pause the user did not also pause, with the setting on. */
const autoPlayAt = (doc: PauseDocState) =>
  doc.paused && doc.limit && !doc.manual && doc.autoPlay && doc.since !== undefined
    ? doc.since + doc.autoPlay * 60_000
    : undefined

/** The timer that plays a rate-limit pause by itself; outside the scheduler, which the pause holds. */
const timer = (host: Pick<ExtensionHost, 'resource'>) =>
  host.resource('pause.autoplay', () => ({ handle: undefined as NodeJS.Timeout | undefined }))

/** Set the timer for `doc`'s pause, or clear it when that pause never plays by itself. */
function arm(host: Host, doc: PauseDocState) {
  const slot = timer(host)
  clearTimeout(slot.handle)
  slot.handle = undefined
  const at = autoPlayAt(doc)
  if (at === undefined) return
  slot.handle = setTimeout(
    () => {
      autoPlay(host).catch((error: unknown) => {
        // The pause stands with Play in the status line; the user can still press it.
        console.error('pause: playing by itself failed:', error)
      })
    },
    Math.max(0, at - Date.now()),
  )
  // A pending Play keeps no process alive; the pause document re-arms it on the next open.
  slot.handle.unref()
}

/**
 * Play the pause by itself once its time came (`now`, for tests), once: Play ends the pause, and a limit that still
 * holds pauses again with a new start and a full grace period. Tells @ultimate with a `pause.autoplay` entry first,
 * while the pause is still recorded: a crash before Play reopens paused, re-arms the timer, and the entry's request ID
 * keeps the second announcement from repeating.
 */
export async function autoPlay(host: Host, now = Date.now()) {
  return serial(host, async () => {
    const doc = await read(host)
    const at = autoPlayAt(doc)
    if (at === undefined || now < at) return false
    const data: AutoPlayed = { since: doc.since!, at: now, minutes: doc.autoPlay! }
    const harness = host.harness()
    const ultimate = (await harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))?.ultimate
    if (ultimate !== undefined)
      await (
        await harness.conversation(ultimate, context)
      )?.submit(
        {
          type: 'write',
          requestId: `pause.autoplay:${data.since}`,
          entry: {
            kind: 'pause.autoplay',
            data,
            model: [
              {
                role: 'user',
                content: `Ultimate played by itself ${lasted(now - data.since)} after the rate limit paused it (the user's setting: ${data.minutes} min).`,
                timestamp: now,
              },
            ],
          },
        },
        context,
      )
    await play(host, true)
    return true
  })
}

/** The user's setting: play by itself `minutes` after a rate limit paused Ultimate; `null` turns it off. */
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
  arm(host, await read(host))
  return state(host)
}

/**
 * A model answered with a rate limit: pause, so nothing retries into it, and tell @ultimate with one `pause.limit`
 * card. Pi has already scheduled that generation's retry; the hold parks it, and every other run at its next step,
 * until Play. The caller holds the scheduler already, in the commit's publication, before that retry's timer can fire.
 */
async function limited(host: Host, limit: RateLimit) {
  try {
    await hold(host, { limit })
  } catch (error) {
    // The commit recorded nothing, so nothing shows the pause or offers Play: let the work go on rather than hold it
    // unseen. Pi's retry and the watchdog's report still stand.
    flag(host).paused = false
    host.harness().release()
    throw error
  }
  await card(host, await read(host))
  await held(host, limit)
}

/**
 * The parent of a subagent that hit the limit, mid-turn, sits held with nothing in its transcript saying why: leave it
 * one `pause.held` entry naming the child. Only kind and data, so it shows at once while the parent is held and wakes
 * nobody; the parent's model learns of the pause from its Play note. Keyed by the child's run, so Plays that pause
 * again into the same limit add none.
 */
async function held(host: Host, limit: RateLimit) {
  const harness = host.harness()
  const child = limit.conversationId as ConversationId
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

/** The `pause.limit` card for the limit that paused the host, once per pause (its request ID is the pause's start). */
async function card(host: Host, doc: PauseDocState) {
  const harness = host.harness()
  const ultimate = (await harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))?.ultimate
  if (!doc.paused || !doc.limit || ultimate === undefined) return
  // Only kind and data, so Pi appends it at once even while @ultimate's own run is held; the model learns of the limit
  // from the note Play leaves on each held run.
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

/**
 * Whether Play notes conversation `id`: its run recorded at the pause continues (the same task, or the run it handed
 * over to, which keeps its inputs), or it completed during the drain. A run stopped meanwhile, or a new one, gets none.
 */
async function noted(host: Host, id: ConversationId, recorded: { task: number; input?: number }) {
  const harness = host.harness()
  const run = (await harness.snapshot(LiveDoc, id, context))?.run
  if (
    run &&
    (run.taskId === recorded.task ||
      (recorded.input !== undefined && run.inputs[0] === recorded.input))
  )
    return 'continued'
  // Only the recorded input's own answer counts as the run finishing: a completed generation may have handed the run
  // to a successor that was stopped, leaving the input unanswered.
  if (recorded.input === undefined) return undefined
  const input = await (
    await harness.submission(recorded.input as SubmissionId, context)
  )?.status(context)
  return input?.status === 'done' ? 'finished' : undefined
}

/**
 * Leave one note on each run that was mid-turn at the pause and still is, placed at its next step, then record the
 * end and release the scheduler. A retry after a crash finds the notes by request ID and leaves no second one.
 * `auto` when the user's setting played it, not the user.
 */
async function play(host: Host, auto = false) {
  const harness = host.harness()
  const doc = await read(host)
  if (doc.paused && doc.since !== undefined) {
    const until = Date.now()
    const span = `${lasted(until - doc.since)}${
      doc.limit
        ? ` (${doc.limit.provider} rate limited ${doc.limit.model})`
        : doc.held
          ? ` (${doc.held.source}: ${doc.held.reason})`
          : ''
    }`
    for (const [key, recorded] of Object.entries(doc.runs ?? {})) {
      const id = Number(key) as ConversationId
      const how = await noted(host, id, recorded)
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
      await conversation?.submit(
        {
          type: 'write',
          requestId: `pause.note:${note.since}`,
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
    delete current.held
    delete current.manual
  }, context)
  arm(host, await read(host))
  flag(host).paused = false
  harness.release()
  return state(host)
}

export default function pauseExtension(host: Host) {
  host.implement(PauseApi, {
    paused: () => flag(host).paused,
    hold: (request) => serial(host, () => holdBy(host, request)),
  })
  let unsubscribe: (() => void) | undefined
  const close = async () => {
    unsubscribe?.()
    unsubscribe = undefined
    clearTimeout(timer(host).handle)
  }
  host.onClose(close)
  host.onRelease(close)
  // The server resumes scheduling only after every opener settled, so a paused host reopens with nothing started.
  host.onOpen(async () => {
    unsubscribe?.()
    // Before watching: scheduling starts only after the openers, so no model answer arrives in between.
    await serial(host, async () => {
      const doc = await read(host)
      flag(host).paused = doc.paused
      if (!doc.paused) return
      host.harness().hold()
      arm(host, doc)
      // A crash between the pause and its card left none; its request ID makes this a no-op otherwise.
      await card(host, doc)
    })
    // Every model answer Pi records lands in a commit; the first rate-limited one pauses.
    unsubscribe = onCommit(host.harness(), (publication) => {
      // Pi commits a retried answer with its generation sleeping until the retry. The answer that spent the last retry
      // ends the run in the same commit instead: holding then continues nothing and only delays the failure's report.
      const retrying = new Set(
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
        // A host already paused stays paused: requests in flight that hit the limit park the same way, and only the
        // first limit is recorded, into a pause the user started too.
        if (
          change.type !== 'entry' ||
          !retrying.has(change.value.conversationId) ||
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
        flag(host).paused = true
        host.harness().hold()
        serial(host, () => limited(host, limit)).catch((error: unknown) => {
          // A failed pause released its hold (limited); a failed card leaves the pause standing in the status line.
          console.error('pause: pausing for a rate limit failed:', error)
        })
      }
    })
  })
  return { name: 'pause' }
}

export const actions = {
  state: implementAction(StateAction, (_args, { host }) => state(host)),
  pause: implementAction(PauseAction, (_args, { host }) => serial(host, () => pause(host))),
  play: implementAction(PlayAction, (_args, { host }) => serial(host, () => play(host))),
  autoPlay: implementAction(AutoPlayAction, (args, { host }) =>
    serial(host, () => setAutoPlay(host, (args as { minutes?: unknown } | null)?.minutes)),
  ),
}
/** Pause, Play and the setting that plays by itself are the user's: no agent unpauses into a rate limit. */
export const userActions = ['pause', 'play', 'autoPlay']
