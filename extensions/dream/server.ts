/**
 * Dream: Ultimate processes what it learned, like people do while they sleep. A dream is ordinary work: @ultimate
 * starts a dream branch that follows DREAM.md, the user decides its proposals, approved ones become ordinary branches.
 * This extension keeps only what must not go wrong in code: the triggers, the next chapter @ultimate prepares, and the
 * switch into it (seed, backup, journaled restart).
 */
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineDoc, defineExtension, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, EntryId, Tx } from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import {
  chapterFiles,
  chapterName,
  PENDING_CHAPTER,
  readChapters,
  requestChapter,
} from '../../lib/chapters.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { CloudApi } from '../cloud/api.ts'
import { Standing, Started as StandingStarted } from '../subagents/api.ts'
import { Fired } from '../automations/api.ts'
import { Branched } from '../lineage/api.ts'
import {
  AsleepAction,
  ChaptersAction,
  DismissAction,
  DreamDoc,
  PrepareAction,
  ReadyAction,
  StartAction,
  StatsAction,
  SwitchAction,
} from './refs.ts'
import type { Dream, Prepared, Sleep, ToolStats } from './refs.ts'
import { busyElsewhere } from './types.ts'
import { deliver, deliverTask } from './delivery.ts'
import { applySeed, buildSeed, SeedState, writeSeed } from './seed.ts'
import { BuiltInDoc, DREAM_ASK, ensureAutomation, fired, PauseDoc } from './built-ins.ts'

export const Next = defineDoc<{ prepared?: Prepared; sleep?: Sleep; dream?: Dream }>({
  kind: DreamDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
export const docs = [Next, SeedState, BuiltInDoc, PauseDoc]
export const userActions = ['start', 'ready', 'dismiss', 'asleep', 'switch']

/** How far back from a branch call the turn that answered a dream request is looked for. */
const TURN_ENTRIES = 200

/**
 * The `dream.requested` entry the turn that made entry `call` in @ultimate's conversation answered: the newest one
 * before it with no finished turn in between (an answer that called no tool ends a turn).
 */
export async function requestOf(tx: Tx, ultimate: number, call: number) {
  const page = await tx.scanEntries(
    { conversationId: ultimate as ConversationId, maxEntryId: call as EntryId },
    TURN_ENTRIES,
  )
  for (const entry of page.items) {
    if (entry.kind === 'dream.requested') return entry.id as number
    const message = entry.model?.at(-1)
    if (entry.id !== call && message?.role === 'assistant' && message.stopReason !== 'toolUse')
      return undefined
  }
  return undefined
}

/**
 * Inside `tx`: branch `id` started by @ultimate's call at entry `call` is the dream when that turn answered a dream
 * request newer than the last dream's. From the start of the event log, so a dream from before this existed is found.
 */
export async function branched(
  tx: Tx,
  { id, by, call, at }: { id: number; by?: number; call?: number; at: number },
) {
  const ultimate = (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate
  if (ultimate === undefined || by !== ultimate || call === undefined) return
  const requested = await requestOf(tx, ultimate, call)
  const doc = await tx.doc(Next, ROOT_CONVERSATION_ID)
  if (requested === undefined || requested <= (doc.dream?.requested ?? 0)) return
  doc.dream = { branch: id, requested, at }
}

const LEARNED_LINES = 3
const LINE_CHARS = 200
/** The most a handover may carry into the new chapter's wake-up: about 3k tokens, beside the memory brief. */
export const HANDOFF_CHARS = 12_000

/** A document value copied out of its transaction's overlay. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const fields = (args: unknown) =>
  args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
const text = (value: unknown, name: string, max: number) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be nonempty text`)
  if (value.trim().length > max) throw new Error(`${name} must be at most ${max} characters`)
  return value.trim()
}

/** Validate what @ultimate prepares for the next chapter. */
export function prepare(args: unknown, now: number): Prepared {
  const input = fields(args)
  if (!Array.isArray(input.learned) || input.learned.length !== LEARNED_LINES)
    throw new Error(`learned must be ${LEARNED_LINES} lines`)
  return {
    chapter: chapterName(input.chapter),
    learned: input.learned.map((line, index) => text(line, `learned[${index}]`, LINE_CHARS)),
    handoff: text(input.handoff, 'handoff', HANDOFF_CHARS),
    at: now,
  }
}

/** Tool calls in `trace.sqlite`: per tool, the most frequent errors, and `enabled` tools never called in its window. */
export function toolStats(database: string, enabled: readonly string[]): ToolStats {
  if (!existsSync(database))
    return { calls: 0, tools: [], unused: [...enabled].toSorted(), errors: [] }
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    const window = db
      .prepare("SELECT min(at) AS since, count(*) AS calls FROM calls WHERE kind = 'tool'")
      .get() as { since: number | null; calls: number }
    const tools = (
      db
        .prepare(
          "SELECT name, count(*) AS calls, sum(ok = 0) AS failed, avg(ms) AS avgMs FROM calls WHERE kind = 'tool' GROUP BY name ORDER BY calls DESC",
        )
        .all() as { name: string; calls: number; failed: number; avgMs: number }[]
    ).map((row) => ({ ...row, avgMs: Math.round(row.avgMs) }))
    const groups = db
      .prepare(
        "SELECT name, substr(error, 1, 160) AS error, count(*) AS count FROM calls WHERE kind = 'tool' AND ok = 0 GROUP BY name, substr(error, 1, 160) ORDER BY count DESC LIMIT 20",
      )
      .all() as { name: string; error: string; count: number }[]
    const sample = db.prepare(
      "SELECT conversation, entry, substr(args, 1, 120) AS args FROM calls WHERE kind = 'tool' AND ok = 0 AND name = ? AND substr(error, 1, 160) = ? ORDER BY at DESC LIMIT 2",
    )
    const errors = groups.map((group) => ({
      ...group,
      examples: (
        sample.all(group.name, group.error) as {
          conversation: number | null
          entry: number | null
          args: string | null
        }[]
      ).map((row) => ({
        at: `#${row.conversation ?? '?'}${row.entry === null ? '' : `/${row.entry}`}`,
        args: row.args ?? '',
      })),
    }))
    const used = new Set(tools.map((tool) => tool.name))
    return {
      ...(window.since === null ? {} : { since: window.since }),
      calls: window.calls,
      tools,
      unused: enabled.filter((name) => !used.has(name)).toSorted(),
      errors,
    }
  } finally {
    db.close()
  }
}

/** The chapter-change lock, and the harness it was last settled for; kept across facet reloads. */
const switching = (host: ExtensionHost) =>
  host.resource('dream.switching', (): { busy: boolean; harness?: object } => ({ busy: false }))

/** Serialize chapter-changing user actions, including their asynchronous backup. */
async function changing<T>(host: ExtensionHost, run: () => Promise<T>) {
  const state = switching(host)
  if (state.busy) throw new Error('A chapter change is already running')
  state.busy = true
  try {
    return await run()
  } finally {
    state.busy = false
  }
}

/**
 * No top-level conversation at work, @ultimate included: a switch parks whatever runs, and parked work in the chapter
 * left behind keeps it from ever being switched back to (`requestChapter` refuses it).
 */
function idle(host: ExtensionHost) {
  const busy = busyElsewhere(host.conversations())
  if (busy.length)
    throw new Error(
      `Wait for these to finish before switching chapters: ${busy.map((item) => `#${item.id} ${item.title}`).join(', ')}`,
    )
}

/**
 * The final cloud backup of the current chapter before a switch touches another store, or why there is none. A failed
 * backup throws: no switch without it.
 */
async function finalBackup(host: ExtensionHost): Promise<NonNullable<Sleep['backup']>> {
  const cloud = host.want(CloudApi)
  const status = await cloud?.status()
  if (status === 'on') return { id: (await cloud!.backup()).id }
  return {
    skipped:
      status === undefined
        ? 'Cloud extension is not enabled'
        : status === 'off'
          ? 'Cloud backups are off'
          : status === 'satellite'
            ? 'This machine is a satellite and never backs up'
            : 'Project has no GitHub origin; cloud backup is local-only',
  }
}

/**
 * The first cloud backup of a chapter Fall asleep opened, when backups are on here and the chapter has none yet. Every
 * open checks again, so a backup a restart cut short runs on the next one; once any backup of the chapter, this one or
 * @ultimate's, is recorded, none follows. Cloud runs one backup at a time and reports a failed upload itself.
 */
export async function firstBackup(host: ExtensionHost) {
  const cloud = host.want(CloudApi)
  if ((await cloud?.status()) !== 'on' || (await cloud!.lastBackup())) return
  // A refusal means another backup is running (@ultimate's, or this one's before a facet reload), or Ultimate is
  // paused: the record that backup writes, or the next open, settles it. Upload failures are already reported.
  await cloud!.backup().catch(() => undefined)
}

/**
 * Journal the switch and restart into it. A successful restart never returns; a refused one returns its reason, and
 * the journal goes. Once the supervisor approves, nothing new starts here: the approval checks once more that nothing
 * is busy and holds the scheduler until the new core takes over. A restart that fails after its approval reopens
 * this process, which drops its own journal and settles the sleep (`settleSleep`).
 */
async function restartChapter(
  host: ExtensionHost,
  name: string,
  before?: () => Promise<unknown>,
): Promise<never> {
  await requestChapter(host.home, name, process.pid)
  try {
    await before?.()
    throw new Error(
      await host.restart(async () => {
        idle(host)
        // Pi upstream: @earendil-works/pi-durable@1.5.0 — patched Harness.hold() keeps the scheduler from starting tasks.
        host.harness().hold()
      }),
    )
  } finally {
    await rm(join(host.home, PENDING_CHAPTER), { force: true })
  }
}

/**
 * On open, a sleep left `switching` either switched (its chapter now exists) or failed after the restart's approval and
 * came back here; one a restart stopped earlier failed. The chapter-change lock of that attempt goes too.
 */
async function settleSleep(host: ExtensionHost) {
  // Only a harness that really opened again settles: a facet reload runs onOpen on the same harness while a chapter
  // change may still be running, and that change keeps its lock.
  const state = switching(host)
  const harness = host.harness()
  if (state.harness === harness) return
  state.harness = harness
  state.busy = false
  const { chapters } = await readChapters(host.home)
  await harness.commit(async (tx) => {
    const doc = await tx.doc(Next, ROOT_CONVERSATION_ID)
    const sleep = doc.sleep
    if (!sleep || sleep.phase === 'asleep' || sleep.phase === 'failed') return
    const switched = sleep.phase === 'switching' && chapters.some((c) => c.name === sleep.chapter)
    doc.sleep = switched
      ? { ...sleep, phase: 'asleep', at: Date.now() }
      : {
          ...sleep,
          phase: 'failed',
          error:
            sleep.phase === 'switching'
              ? 'The restart into the new chapter failed'
              : 'A restart stopped Fall asleep before the switch; nothing moved',
          at: Date.now(),
        }
  }, context)
}

/** Fall asleep into the prepared chapter (or `name`): seed, final backup, nothing at work, journaled restart. */
async function fallAsleep(host: ExtensionHost, input: { name?: unknown }) {
  const chapters = await readChapters(host.home)
  const { prepared, name } = await host.harness().commit(async (tx) => {
    const doc = await tx.doc(Next, ROOT_CONVERSATION_ID)
    if (!doc.prepared)
      throw new Error('Nothing is prepared: @ultimate prepares the next chapter first')
    idle(host)
    const chapter = chapterName(input.name ?? doc.prepared.chapter)
    if (chapters.chapters.some((item) => item.name === chapter))
      throw new Error(`Chapter ${chapter} already exists; use switch instead`)
    doc.sleep = { chapter, phase: 'seeding', at: Date.now() }
    return { prepared: plain(doc.prepared), name: chapter }
  }, context)
  const progress = (change: Partial<Sleep>) =>
    host.harness().commit(async (tx) => {
      const doc = await tx.doc(Next, ROOT_CONVERSATION_ID)
      doc.sleep = { ...doc.sleep!, ...change, at: Date.now() }
      return plain(doc.sleep)
    }, context)
  try {
    const seed = await buildSeed(host, prepared)
    await progress({ phase: 'backing up' })
    await progress({ backup: await finalBackup(host) })
    // The backup can take time; work started since must also finish before we switch.
    idle(host)
    await progress({ phase: 'switching' })
    await writeSeed(chapterFiles(host.home, name).dir, seed)
    return await restartChapter(host, name)
  } catch (error) {
    return { sleep: await progress({ phase: 'failed', error: String(error) }) }
  }
}

const ultimateOf = async (tx: Tx) => {
  const ultimate = (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate
  if (ultimate === undefined) throw new Error('@ultimate has no conversation yet')
  return ultimate
}

export const actions = {
  chapters: implementAction(ChaptersAction, async (_args, { host }) => {
    const { active, chapters } = await readChapters(host.home)
    return {
      active,
      number: chapters.findIndex((item) => item.name === active) + 1,
      newest: chapters.at(-1)!.name,
      chapters: chapters.map((item, index) => ({ ...item, number: index + 1 })),
    }
  }),
  switch: implementAction(SwitchAction, async (args, { host }) =>
    changing(host, async () => {
      const name = chapterName(fields(args).chapter)
      const chapters = await readChapters(host.home)
      if (name === chapters.active) throw new Error(`Chapter ${name} is already active`)
      if (!chapters.chapters.some((item) => item.name === name))
        throw new Error(`Unknown chapter ${name}`)
      idle(host)
      // Once the target is known to be free, the current chapter is backed up before the switch touches any store.
      return restartChapter(host, name, () => finalBackup(host))
    }),
  ),
  asleep: implementAction(AsleepAction, async (args, { host }) =>
    changing(host, () => fallAsleep(host, fields(args))),
  ),
  /** The user's Dream button: the same ask a built-in automation's fire brings, as an input that wakes @ultimate. */
  start: implementAction(StartAction, async (_args, { host }) => {
    await host.harness().commit(async (tx) => {
      const ultimate = await ultimateOf(tx)
      await deliver(host, tx, ultimate, {
        type: 'input',
        requestId: `dream.requested:${Date.now()}`,
        kind: 'dream.requested',
        data: {},
        content: `The user pressed Dream. ${DREAM_ASK}`,
      })
    }, context)
    host.harness().resume()
    return { requested: true as const }
  }),
  /** The user pressed Fall asleep on a finished dream: @ultimate writes its handover and prepares the chapter now. */
  ready: implementAction(ReadyAction, async (_args, { host }) => {
    const asked = await host.harness().commit(async (tx) => {
      const doc = await tx.doc(Next, ROOT_CONVERSATION_ID)
      if (!doc.dream) throw new Error('No dream to wake from: start one with Dream')
      if (doc.prepared && doc.prepared.at > doc.dream.at)
        throw new Error(`Chapter ${doc.prepared.chapter} is already prepared`)
      const at = Date.now()
      doc.dream.asked = at
      delete doc.dream.dismissed
      await deliver(host, tx, await ultimateOf(tx), {
        type: 'input',
        requestId: `dream.ready:${at}`,
        kind: 'dream.ready',
        data: { branch: doc.dream.branch },
        content: `The user pressed Fall asleep after dream #${doc.dream.branch}. Follow "Prepare the fresh chapter" in the clone's extensions/dream/DREAM.md and call prepare now: the Fall asleep card it puts up is what the user waits for. Name in the handoff any branch still running or waiting on an answer.`,
      })
      return at
    }, context)
    host.harness().resume()
    return { asked }
  }),
  /** The user stays in this chapter: the finished dream's Fall asleep cue goes until the next dream. */
  dismiss: implementAction(DismissAction, async (_args, { host }) => {
    await host.harness().commit(async (tx) => {
      const doc = await tx.doc(Next, ROOT_CONVERSATION_ID)
      if (doc.dream) doc.dream.dismissed = true
    }, context)
    return { dismissed: true as const }
  }),
  prepare: implementAction(PrepareAction, async (args, { host }) => {
    const prepared = await host.harness().commit(async (tx) => {
      const doc = await tx.doc(Next, ROOT_CONVERSATION_ID)
      if (doc.sleep && !['asleep', 'failed'].includes(doc.sleep.phase))
        throw new Error(`Falling asleep is under way (${doc.sleep.phase})`)
      doc.prepared = prepare(args, Date.now())
      // A new preparation is a new card: the record of an earlier sleep from this chapter goes.
      delete doc.sleep
      // The Fall asleep card, in @ultimate's conversation; a passive write its running turn reads.
      await deliver(host, tx, await ultimateOf(tx), {
        type: 'write',
        requestId: `dream.prepared:${doc.prepared.at}`,
        kind: 'dream.prepared',
        data: { at: doc.prepared.at },
        content: `You prepared Chapter ${doc.prepared.chapter}; the Fall asleep card above shows it to the user, who taps Fall asleep. Never call asleep yourself.`,
      })
      return plain(doc.prepared)
    }, context)
    host.harness().resume()
    return prepared
  }),
  stats: implementAction(StatsAction, (_args, { host }) =>
    toolStats(
      host.chapter.trace,
      host
        .extensions()
        .filter((item) => item.enabled)
        .flatMap((item) => item.server?.tools.map((tool) => tool.name) ?? []),
    ),
  ),
}

export default function dream(host: ExtensionHost) {
  // One at a time, across facet reloads: two concurrent checks would both make the automation.
  const queue = host.resource('dream.after-compaction', () => ({ last: Promise.resolve() }))
  /** Queue a check behind the last one; a failure becomes a notice. */
  const ensure = () => {
    const run = queue.last.then(() => ensureAutomation(host))
    // The queue only orders the checks: the failure is reported below, and the next check still runs.
    queue.last = run.catch(() => undefined)
    return run.catch((error: unknown) => host.notice(`Dream automations: ${String(error)}`))
  }
  host.onOpen(async () => {
    await settleSleep(host)
    // In the background: an upload takes minutes, and the rest of the opening must not wait for it.
    if (await applySeed(host))
      firstBackup(host).catch((error: unknown) => host.notice(`Chapter backup: ${String(error)}`))
    await ensure()
  })
  // A fresh project has no @ultimate when it opens: the automations follow once it exists. Outside the transaction:
  // making them commits.
  host.react(
    'ultimate-started',
    [StandingStarted],
    (_tx, { data }) => {
      if (data.kind === 'standing' && data.agent === 'ultimate')
        ensure().catch((error: unknown) => host.notice(String(error)))
    },
    { from: 'now' },
  )
  // A built-in automation's fire wakes @ultimate itself; dream adds what a dream is and where its workflow lives.
  host.react('requested', [Fired], (tx, { data }) => fired(host, tx, data.id, data.fire), {
    from: 'now',
  })
  // The branch a dream request's turn started is the dream; once it is concluded, the user is shown Fall asleep.
  host.react('dream-branch', [Branched], (tx, event) =>
    branched(tx, {
      id: event.data.id,
      by: event.context?.conversationId,
      call: event.context?.entryId,
      at: Date.parse(event.at),
    }),
  )
  return defineExtension({ name: 'dream', tasks: [deliverTask(host)] })
}
