import type { ConversationId, EntryId, Tx } from '@earendil-works/pi-durable'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineDoc, defineExtension, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import { rebuiltOnOpen, meansNone, settled } from '../../lib/errors.ts'
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

const REQUEST_LOOKBACK_ENTRIES = 200

export async function requestOf(tx: Tx, ultimate: ConversationId, call: EntryId) {
  const page = await tx.scanEntries(
    { conversationId: ultimate, maxEntryId: call },
    REQUEST_LOOKBACK_ENTRIES,
  )
  for (const entry of page.items) {
    if (entry.kind === 'dream.requested') return entry.id
    const message = entry.model?.at(-1)
    const previousTurnFinished =
      entry.id !== call && message?.role === 'assistant' && message.stopReason !== 'toolUse'
    if (previousTurnFinished) return undefined
  }
  return undefined
}

export async function branched(
  tx: Tx,
  { id, by, call, at }: { id: ConversationId; by?: number; call?: EntryId; at: number },
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
export const HANDOFF_CHARS = 12_000

const detachOverlay = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const fields = (args: unknown) =>
  args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
const text = (value: unknown, name: string, max: number) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be nonempty text`)
  if (value.trim().length > max) throw new Error(`${name} must be at most ${max} characters`)
  return value.trim()
}

export function prepare(args: unknown, now: number): Prepared {
  const input = fields(args)
  if (!Array.isArray(input.learned) || input.learned.length !== LEARNED_LINES)
    throw new Error(`learned must be an array of ${LEARNED_LINES} strings`)
  return {
    chapter: chapterName(input.chapter),
    learned: input.learned.map((line, index) => text(line, `learned[${index}]`, LINE_CHARS)),
    handoff: text(input.handoff, 'handoff', HANDOFF_CHARS),
    at: now,
  }
}

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
          conversation: ConversationId | null
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

const reloadStableChapterChangeLock = (host: ExtensionHost) =>
  host.resource('dream.switching', (): { busy: boolean; harness?: object } => ({ busy: false }))

async function withChapterChangeLock<T>(host: ExtensionHost, run: () => Promise<T>) {
  const state = reloadStableChapterChangeLock(host)
  if (state.busy) throw new Error('A chapter change is already running')
  state.busy = true
  try {
    return await run()
  } finally {
    state.busy = false
  }
}

function requireNoWorkParkedBySwitch(host: ExtensionHost) {
  const busy = busyElsewhere(host.conversations())
  if (busy.length)
    throw new Error(
      `Wait for these to finish before switching chapters: ${busy.map((item) => `#${item.id} ${item.title}`).join(', ')}`,
    )
}

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

export async function firstBackup(host: ExtensionHost) {
  const cloud = host.want(CloudApi)
  if ((await cloud?.status()) !== 'on' || (await cloud!.lastBackup())) return
  await cloud!.backup().catch(meansNone)
}

async function restartChapter(
  host: ExtensionHost,
  name: string,
  backupBeforeRestart?: () => Promise<unknown>,
): Promise<never> {
  await requestChapter(host.home, name, process.pid)
  try {
    await backupBeforeRestart?.()
    throw new Error(
      await host.restart(async () => {
        requireNoWorkParkedBySwitch(host)
        // Pi upstream: @earendil-works/pi-durable@1.6.0 — patched Harness.hold() keeps the scheduler from starting tasks.
        host.harness().hold()
      }),
    )
  } finally {
    await rm(join(host.home, PENDING_CHAPTER), { force: true })
  }
}

async function settleSleep(host: ExtensionHost) {
  const state = reloadStableChapterChangeLock(host)
  const harness = host.harness()
  const facetReloadDuringSameHarness = state.harness === harness
  if (facetReloadDuringSameHarness) return
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

async function fallAsleep(host: ExtensionHost, input: { name?: unknown }) {
  const chapters = await readChapters(host.home)
  const { prepared, name } = await host.harness().commit(async (tx) => {
    const doc = await tx.doc(Next, ROOT_CONVERSATION_ID)
    if (!doc.prepared)
      throw new Error('Nothing is prepared: @ultimate prepares the next chapter first')
    requireNoWorkParkedBySwitch(host)
    const chapter = chapterName(input.name ?? doc.prepared.chapter)
    if (chapters.chapters.some((item) => item.name === chapter))
      throw new Error(`Chapter ${chapter} already exists; use switch instead`)
    doc.sleep = { chapter, phase: 'seeding', at: Date.now() }
    return { prepared: detachOverlay(doc.prepared), name: chapter }
  }, context)
  const progress = (change: Partial<Sleep>) =>
    host.harness().commit(async (tx) => {
      const doc = await tx.doc(Next, ROOT_CONVERSATION_ID)
      doc.sleep = { ...doc.sleep!, ...change, at: Date.now() }
      return detachOverlay(doc.sleep)
    }, context)
  try {
    const seed = await buildSeed(host, prepared)
    await progress({ phase: 'backing up' })
    await progress({ backup: await finalBackup(host) })
    requireNoWorkParkedBySwitch(host)
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

function resetPreparationSleep(doc: { sleep?: Sleep }) {
  delete doc.sleep
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
    withChapterChangeLock(host, async () => {
      const name = chapterName(fields(args).chapter)
      const chapters = await readChapters(host.home)
      if (name === chapters.active) throw new Error(`Chapter ${name} is already active`)
      if (!chapters.chapters.some((item) => item.name === name))
        throw new Error(`Unknown chapter ${name}`)
      requireNoWorkParkedBySwitch(host)
      return restartChapter(host, name, () => finalBackup(host))
    }),
  ),
  asleep: implementAction(AsleepAction, async (args, { host }) =>
    withChapterChangeLock(host, () => fallAsleep(host, fields(args))),
  ),
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
      resetPreparationSleep(doc)
      await deliver(host, tx, await ultimateOf(tx), {
        type: 'write',
        requestId: `dream.prepared:${doc.prepared.at}`,
        kind: 'dream.prepared',
        data: { at: doc.prepared.at },
        content: `You prepared Chapter ${doc.prepared.chapter}; the Fall asleep card above shows it to the user, who taps Fall asleep. Never call asleep yourself.`,
      })
      return detachOverlay(doc.prepared)
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
  const reloadStableCreationQueue = host.resource('dream.after-compaction', () => ({
    last: Promise.resolve(),
  }))
  const initializeWithOwnCommit = () => {
    const run = reloadStableCreationQueue.last.then(() => ensureAutomation(host))
    reloadStableCreationQueue.last = settled(run)
    return run.catch((error: unknown) => host.notice(`Dream automations: ${String(error)}`))
  }
  const backupInBackground = () => {
    rebuiltOnOpen(
      'each open of a seeded chapter checks for its first backup again',
      firstBackup(host).catch((error: unknown) => host.notice(`Chapter backup: ${String(error)}`)),
    )
  }
  host.onOpen(async () => {
    await settleSleep(host)
    if (await applySeed(host)) backupInBackground()
    await initializeWithOwnCommit()
  })
  host.react(
    'ultimate-started',
    [StandingStarted],
    (_tx, { data }) => {
      if (data.kind === 'standing' && data.agent === 'ultimate')
        rebuiltOnOpen(
          'open ensures the built-in dream automations again',
          initializeWithOwnCommit().catch((error: unknown) => host.notice(String(error))),
        )
    },
    { from: 'now' },
  )
  host.react('requested', [Fired], (tx, { data }) => fired(host, tx, data.id, data.fire), {
    from: 'now',
  })
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
