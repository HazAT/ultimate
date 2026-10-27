/**
 * Dream: a working session in which Ultimate processes what it learned. The user starts it; @ultimate starts a dream
 * branch that runs six passes and files a journal here; the proposals go to the user as decisions, and the approved
 * ones are followed until their branches land. Nothing here changes code, memory or storage by itself.
 */
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineDoc, defineExtension, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { TaskGraph, Tx } from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import { git } from '../../lib/git.ts'
import {
  chapterFiles,
  chapterName,
  PENDING_CHAPTER,
  readChapters,
  requestChapter,
} from '../../lib/chapters.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { CloudApi } from '../cloud/api.ts'
import { InstanceApi } from '../instance/api.ts'
import { Standing, Started as StandingStarted } from '../subagents/api.ts'
import { SubmissionLanded } from '../workspaces/api.ts'
import { Fired } from '../automations/api.ts'
import {
  AsleepAction,
  ChaptersAction,
  SwitchAction,
  DecideAction,
  DreamDoc,
  EndAction,
  HandoffAction,
  JournalAction,
  PassAction,
  StartAction,
  StatsAction,
} from './refs.ts'
import type { PassState, Proposal, Session, Sleep, ToolStats, Waiting } from './refs.ts'
import { busyElsewhere, PASSES } from './types.ts'
import { deliver, deliverTask } from './delivery.ts'
import { applySeed, buildSeed, SeedState, writeSeed } from './seed.ts'
import { gate } from './gate.ts'
import {
  BuiltInDoc,
  PauseDoc,
  compactionDream,
  ensureAutomation,
  HANDOFF_CHARS,
  liveTasks,
} from './before-compaction.ts'
import type { Origin } from './before-compaction.ts'
import type { PassName } from './types.ts'

export const Sessions = defineDoc<{ next: number; sessions: Session[]; waiting?: Waiting }>({
  kind: DreamDoc.kind,
  checkpointWhen: () => false,
  // Version 1 named a built-in automation's session `afterCompaction`; the record itself is the same. Versions before
  // 3 ran five passes: their sessions get `project` as waiting, or as skipped once the journal is filed.
  version: 3,
  migrate: (value) => {
    const doc = value as { next: number; sessions: (Session & { afterCompaction?: unknown })[] }
    return {
      ...doc,
      sessions: doc.sessions.map(({ afterCompaction, ...session }) => ({
        ...session,
        ...(afterCompaction
          ? { beforeCompaction: afterCompaction as Session['beforeCompaction'] }
          : {}),
        passes: {
          ...session.passes,
          project:
            session.passes.project ??
            (session.journal
              ? { status: 'done' as const, note: 'not part of this dream' }
              : { status: 'waiting' as const }),
        },
      })),
    }
  },
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ next: 1, sessions: [] }),
})
export const docs = [Sessions, SeedState, BuiltInDoc, PauseDoc]
export const userActions = ['start', 'end', 'asleep', 'switch']

const LEARNED_LINES = 3
const LINE_CHARS = 200
const JOURNAL_CHARS = 20_000
const PROPOSALS = 40
const PROPOSAL_ID = /^[a-z0-9][a-z0-9-]{0,47}$/
const STATUSES = ['waiting', 'running', 'done', 'failed'] as const
const DECISIONS = ['approved', 'rejected', 'applied', 'landed'] as const
/** What an ended session still accepts: an approved proposal settling, never one reopening. */
const SETTLING = ['rejected', 'applied', 'landed']

const fields = (args: unknown) =>
  args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
const text = (value: unknown, name: string, max: number) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be nonempty text`)
  if (value.trim().length > max) throw new Error(`${name} must be at most ${max} characters`)
  return value.trim()
}
const optional = (value: unknown, name: string, max: number) =>
  value === undefined ? undefined : text(value, name, max)
const positive = (value: unknown, name: string) => {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new Error(`${name} must be a positive integer`)
  return value as number
}

async function find(tx: Tx, id: unknown) {
  const found = (await tx.doc(Sessions, ROOT_CONVERSATION_ID)).sessions.find(
    (item) => item.id === id,
  )
  if (!found) throw new Error(`No dream session ${String(id)}`)
  return found
}

/** The open session `id`; an ended one refuses further changes. */
async function open(tx: Tx, id: unknown) {
  const found = await find(tx, id)
  if (found.endedAt !== undefined) throw new Error(`Dream session ${found.id} has ended`)
  return found
}

const unsettled = (found: Session) =>
  found.proposals.some((item) => item.status === 'open' || item.status === 'approved')

/** A session ends by itself once its journal is filed and every proposal is rejected, applied or landed. */
function settle(found: Session, now: number) {
  if (found.journal && found.endedAt === undefined && !unsettled(found)) found.endedAt = now
}

/**
 * The full sha of commit `sha` when it is reachable from HEAD in `repo`; refuses an unknown or unreachable one. How
 * `decide` verifies a proposal landed outside a workspace (a fix merged by hand).
 */
export async function reachable(repo: string, sha: string) {
  const full = await git(repo, 'rev-parse', '--verify', '--quiet', `${sha}^{commit}`).catch(() => {
    throw new Error(`Unknown commit ${sha} in ${repo}`)
  })
  await git(repo, 'merge-base', '--is-ancestor', full, 'HEAD').catch(() => {
    throw new Error(`Commit ${sha} is not reachable from HEAD in ${repo}`)
  })
  return full
}

/** Record a new session in `tx`; refuses while one is open. */
export async function startSession(tx: Tx, now: number, origin: Origin = {}) {
  const doc = await tx.doc(Sessions, ROOT_CONVERSATION_ID)
  const active = doc.sessions.find((item) => item.endedAt === undefined)
  if (active)
    throw new Error(
      `Dream session ${active.id} is still open; finish or end it before dreaming again`,
    )
  const passes = Object.fromEntries(PASSES.map((pass) => [pass, { status: 'waiting' }])) as Record<
    PassName,
    PassState
  >
  const created: Session = {
    id: doc.next++,
    startedAt: now,
    passes,
    proposals: [],
    ...(origin.beforeCompaction ? { beforeCompaction: origin.beforeCompaction } : {}),
    ...(origin.handoff ? { handoff: origin.handoff } : {}),
  }
  doc.sessions.push(created)
  return created.id
}

/** The dream branch reports pass `pass` of `session`; its first report names it the session's dreamer. */
export async function reportPass(tx: Tx, args: unknown, caller: number | undefined) {
  const input = fields(args)
  const found = await open(tx, input.session)
  if (!PASSES.includes(input.pass as PassName))
    throw new Error(`pass must be one of ${PASSES.join(', ')}`)
  if (!STATUSES.includes(input.status as PassState['status']))
    throw new Error(`status must be one of ${STATUSES.join(', ')}`)
  const note = optional(input.note, 'note', LINE_CHARS)
  found.passes[input.pass as PassName] = {
    status: input.status as PassState['status'],
    ...(note ? { note } : {}),
  }
  if (caller !== undefined) found.dreamer ??= caller
  return found
}

/**
 * File the journal of `session` once; `filed` says this call filed it. A repeated call, even after the session ended,
 * returns the journal already filed, unchanged.
 */
export async function fileJournal(tx: Tx, args: unknown, now: number) {
  const input = fields(args)
  const found = await find(tx, input.session)
  if (found.journal) return { found, filed: false }
  if (found.endedAt !== undefined) throw new Error(`Dream session ${found.id} has ended`)
  if (!Array.isArray(input.learned) || input.learned.length !== LEARNED_LINES)
    throw new Error(`learned must be ${LEARNED_LINES} lines`)
  const learned = input.learned.map((line, index) => text(line, `learned[${index}]`, LINE_CHARS))
  const body = text(input.text, 'text', JOURNAL_CHARS)
  if (!Array.isArray(input.proposals) || input.proposals.length > PROPOSALS)
    throw new Error(`proposals must be a list of at most ${PROPOSALS}`)
  const seen = new Set<string>()
  const proposals = input.proposals.map((value, index): Proposal => {
    const item = fields(value)
    if (typeof item.id !== 'string' || !PROPOSAL_ID.test(item.id) || seen.has(item.id))
      throw new Error(`proposals[${index}].id must be a unique slug`)
    seen.add(item.id)
    if (!PASSES.includes(item.pass as PassName))
      throw new Error(`proposals[${index}].pass must be one of ${PASSES.join(', ')}`)
    const size = optional(item.size, `proposals[${index}].size`, 40)
    const risk = optional(item.risk, `proposals[${index}].risk`, LINE_CHARS)
    const retire = optional(item.retire, `proposals[${index}].retire`, 48)
    return {
      id: item.id,
      pass: item.pass as PassName,
      title: text(item.title, `proposals[${index}].title`, LINE_CHARS),
      ...(size ? { size } : {}),
      ...(risk ? { risk } : {}),
      ...(retire ? { retire } : {}),
      status: 'open',
    }
  })
  const chapter = input.chapter === undefined ? undefined : chapterName(input.chapter)
  found.journal = { learned, text: body, ...(chapter ? { chapter } : {}), at: now }
  found.proposals = proposals
  settle(found, now)
  return { found, filed: true }
}

/**
 * @ultimate records the user's decision on one proposal; an approved one names its branch. `landed` takes the `sha`
 * the action verified with `reachable`; an approved proposal turning `applied` names what was written in `reason`. An
 * ended session only lets approved proposals settle.
 */
export async function decide(tx: Tx, args: unknown, now: number) {
  const input = fields(args)
  const found = await find(tx, input.session)
  const proposal = found.proposals.find((item) => item.id === input.proposal)
  if (!proposal) throw new Error(`No proposal ${String(input.proposal)} in session ${found.id}`)
  if (proposal.status === 'landed') throw new Error(`Proposal ${proposal.id} already landed`)
  if (!DECISIONS.includes(input.status as (typeof DECISIONS)[number]))
    throw new Error(`status must be one of ${DECISIONS.join(', ')}`)
  const status = input.status as Proposal['status']
  if (found.endedAt !== undefined && (proposal.status !== 'approved' || !SETTLING.includes(status)))
    throw new Error(
      `Dream session ${found.id} has ended: only an approved proposal may still become rejected, applied or landed`,
    )
  if (status === 'landed' && proposal.status !== 'approved')
    throw new Error(`Proposal ${proposal.id} must be approved before it lands`)
  const reason = optional(input.reason, 'reason', LINE_CHARS)
  if (status === 'applied' && proposal.status === 'approved' && !reason)
    throw new Error(
      `reason must name what was written when approved proposal ${proposal.id} is applied`,
    )
  if (status === 'landed') proposal.sha = text(input.sha, 'sha', 64)
  if (status === 'approved') proposal.branch = positive(input.branch, 'branch')
  else if (status !== 'landed') delete proposal.branch
  proposal.status = status
  if (reason) proposal.reason = reason
  else delete proposal.reason
  settle(found, now)
  return { found, proposal: { ...proposal } }
}

/**
 * A landed branch lands the approved proposals it carries, in every session, ended ones included; returns the sessions
 * that carried one.
 */
export async function landed(tx: Tx, branch: number, sha: string, now: number) {
  const touched: Session[] = []
  for (const found of (await tx.doc(Sessions, ROOT_CONVERSATION_ID)).sessions) {
    const carried = found.proposals.filter(
      (proposal) => proposal.status === 'approved' && proposal.branch === branch,
    )
    for (const proposal of carried) {
      proposal.status = 'landed'
      proposal.sha = sha
    }
    settle(found, now)
    if (carried.length) touched.push(found)
  }
  return touched
}

/** The model text of a filed journal: what @ultimate reads, with the proposal ids `decide` takes. */
export function journalText(found: Session) {
  return [
    `Dream session ${found.id} journal (the card above shows it to the user).`,
    ...found.journal!.learned.map((line) => `- ${line}`),
    '',
    found.proposals.length
      ? `Proposals (record each decision with ultimate.action('dream', 'decide', {session: ${found.id}, proposal, status, branch?, sha?, repo?, reason?})):`
      : 'No proposals.',
    ...found.proposals.map(
      (item) =>
        `- ${item.id} [${item.pass}]${item.size ? ` (${item.size})` : ''}: ${item.title}${item.retire ? ` — retires memory ${item.retire} once landed` : ''}`,
    ),
  ].join('\n')
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
    const errors = db
      .prepare(
        "SELECT name, substr(error, 1, 160) AS error, count(*) AS count FROM calls WHERE kind = 'tool' AND ok = 0 GROUP BY name, substr(error, 1, 160) ORDER BY count DESC LIMIT 20",
      )
      .all() as { name: string; error: string; count: number }[]
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

const ultimateOf = async (tx: Tx) => (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate

/** Serialize chapter-changing user actions, including their asynchronous gate and backup. */
/** The chapter-change lock, and the harness it was last settled for; kept across facet reloads. */
const switching = (host: ExtensionHost) =>
  host.resource('dream.switching', (): { busy: boolean; harness?: object } => ({ busy: false }))

async function changing<T>(host: ExtensionHost, run: () => Promise<T>) {
  const release = lockChapter(host)
  try {
    return await run()
  } finally {
    release()
  }
}

/** Take the chapter-change lock, or refuse; returns its release, which frees only this hold. */
function lockChapter(host: ExtensionHost) {
  const state = switching(host)
  if (state.busy) throw new Error('A chapter change is already running')
  state.busy = true
  let held = true
  return () => {
    if (held) state.busy = false
    held = false
  }
}

/**
 * No top-level conversation at work, @ultimate included: a switch parks whatever runs, and parked work in the chapter
 * left behind keeps it from ever being switched back to (`requestChapter` refuses it).
 */
async function idle(host: ExtensionHost, _tx: Tx) {
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
 * else is busy and holds the scheduler until the new core takes over. A restart that fails after its approval reopens
 * this process, which drops its own journal (`by`) and settles the session (`settleSleep`).
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
        await host.harness().commit((tx) => idle(host, tx), context)
        // Pi upstream: @earendil-works/pi-durable@1.4.0 — patched Harness.hold() keeps the scheduler from starting tasks.
        host.harness().hold()
      }),
    )
  } finally {
    await rm(join(host.home, PENDING_CHAPTER), { force: true })
  }
}

/**
 * On open, a sleep left `switching` either switched (its chapter now exists) or failed after the restart's approval and
 * came back here. The chapter-change lock of that failed attempt goes too: its promise never settles.
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
  await host.harness().commit(async (tx) => {
    for (const found of (await tx.doc(Sessions, ROOT_CONVERSATION_ID)).sessions) {
      const sleep = found.sleep
      // A restart stopped the gates: nothing switched, and nothing will continue them.
      if (sleep && ['seeding', 'checking', 'backing up'].includes(sleep.phase)) {
        found.sleep = {
          ...sleep,
          phase: 'failed',
          error: 'A restart stopped Fall asleep before the switch; nothing moved',
          at: Date.now(),
        }
        continue
      }
      if (sleep?.phase !== 'switching') continue
      found.sleep = chapters.some((chapter) => chapter.name === sleep.chapter)
        ? { ...sleep, phase: 'asleep', at: Date.now() }
        : {
            ...sleep,
            phase: 'failed',
            error: 'The restart into the new chapter failed',
            at: Date.now(),
          }
    }
  }, context)
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
      await host.harness().commit((tx) => idle(host, tx), context)
      // Once the target is known to be free, the current chapter is backed up before the switch touches any store.
      return restartChapter(host, name, () => finalBackup(host))
    }),
  ),
  asleep: implementAction(AsleepAction, async (args, { host }) => {
    const input = fields(args)
    return changing(host, async () => fallAsleep(host, await admitSleep(host, input)))
  }),
  start: implementAction(StartAction, async (_args, { host }) => askHandoff(host)),
  handoff: implementAction(HandoffAction, async (args, { host }) =>
    host.harness().commit(async (tx) => {
      const body = text(fields(args).text, 'text', HANDOFF_CHARS)
      const waiting = (await tx.doc(Sessions, ROOT_CONVERSATION_ID)).waiting
      if (!waiting) throw new Error('No dream waits for a handoff')
      // A second call replaces the first: the dream reads the handoff only once it starts.
      waiting.handoff = { text: body, at: Date.now() }
      return { task: waiting.task }
    }, context),
  ),
  end: implementAction(EndAction, async (args, { host }) =>
    host.harness().commit(async (tx) => {
      const found = await open(tx, fields(args).session)
      found.endedAt = Date.now()
      return { session: found.id }
    }, context),
  ),
  pass: implementAction(PassAction, async (args, { host, conversationId }) =>
    host.harness().commit(async (tx) => {
      const found = await reportPass(tx, args, conversationId)
      return { session: found.id }
    }, context),
  ),
  journal: implementAction(JournalAction, async (args, { host }) => {
    const result = await host.harness().commit(async (tx) => {
      const { found, filed } = await fileJournal(tx, args, Date.now())
      await settled(host, tx, found)
      if (filed) {
        const ultimate = await ultimateOf(tx)
        if (ultimate === undefined) throw new Error('@ultimate has no conversation yet')
        // A passive write: @ultimate reads it with the dream branch's answer, which wakes it.
        await deliver(host, tx, ultimate, {
          type: 'write',
          session: found.id,
          kind: 'dream.journal',
          content: journalText(found),
        })
      }
      return { session: found.id, proposals: found.proposals.length }
    }, context)
    host.harness().resume()
    return result
  }),
  decide: implementAction(DecideAction, async (args, { host }) => {
    const input = fields(args)
    const sha =
      input.status === 'landed'
        ? await reachable(
            optional(input.repo, 'repo', 4096) ?? host.projectRoot,
            text(input.sha, 'sha', 64),
          )
        : undefined
    const decided = await host.harness().commit(async (tx) => {
      const { found, proposal } = await decide(tx, { ...input, sha }, Date.now())
      await settled(host, tx, found)
      return proposal
    }, context)
    host.harness().resume()
    return decided
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

/**
 * The user's Dream button: ask @ultimate for its handoff; the dream starts once it is recorded and nothing else works.
 * Refuses while other top-level conversations actively work (besides @ultimate), a session is open or a request waits.
 */
export async function askHandoff(host: ExtensionHost) {
  const tasks = await liveTasks(host)
  // On its own: the refusal below rolls its transaction back, and a request whose wait faulted must look again.
  await host.harness().commit((tx) => compaction(host).healed(tx), context)
  const task = await host.harness().commit(async (tx) => {
    const ultimate = (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate
    if (ultimate === undefined) throw new Error('@ultimate has no conversation yet')
    refuseBusy(host, ultimate, tasks)
    return (await compaction(host).request(tx, Date.now(), ultimate)).task
  }, context)
  host.harness().resume()
  return { task }
}

/** A read-only dream waits only for conversations actively `working` in `tasks`; without them, for any `busy` one. */
function refuseBusy(host: ExtensionHost, ultimate: number, tasks?: TaskGraph['tasks']) {
  const busy = busyElsewhere(host.conversations(), ultimate, tasks)
  if (busy.length)
    throw new Error(
      `Wait for these to finish before dreaming: ${busy.map((item) => `#${item.id} ${item.title}`).join(', ')}`,
    )
}

/**
 * Start a dream session inside `tx` for a handoff request (`origin`): the user's Dream button, or the built-in
 * automation (`origin.beforeCompaction`). Refuses while other top-level conversations work (besides @ultimate: those
 * actively working in the live `tasks`) or a session is open.
 */
export async function startDreamIn(
  host: ExtensionHost,
  tx: Tx,
  origin: Origin = {},
  tasks?: TaskGraph['tasks'],
) {
  const ultimate = (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate
  if (ultimate === undefined) throw new Error('@ultimate has no conversation yet')
  refuseBusy(host, ultimate, tasks)
  const session = await startSession(tx, Date.now(), origin)
  const before = origin.beforeCompaction
  const who = before
    ? `Dream session ${session} started after your context passed its threshold (automation ${before.automation} "${before.name}")`
    : `The user started dream session ${session}`
  const handoff = origin.handoff
  const read = handoff?.text
    ? ` It carries your handoff: the dream branch reads it first.`
    : handoff?.missing
      ? ` It started without your handoff (${handoff.missing}); the dream reads your transcript instead.`
      : ''
  await deliver(host, tx, ultimate, {
    type: 'input',
    session,
    kind: 'dream.started',
    content: `${who}.${read} Follow "For @ultimate" in the clone's extensions/dream/DREAM.md: start the dream branch now.`,
  })
  return { session }
}

/**
 * Check that session `input.session` may fall asleep now and claim its sleep: a filed journal, every proposal settled,
 * a new chapter name, and no conversation at work.
 */
async function admitSleep(host: ExtensionHost, input: { session?: unknown; name?: unknown }) {
  const chapters = await readChapters(host.home)
  return host.harness().commit(async (tx) => {
    const found = await sleepable(tx, input.session)
    await idle(host, tx)
    const name = chapterName(input.name ?? found.journal!.chapter)
    if (chapters.chapters.some((item) => item.name === name))
      throw new Error(`Chapter ${name} already exists; use switch instead`)
    found.sleep = { chapter: name, phase: 'seeding', at: Date.now() }
    return { session: found.id, name }
  }, context)
}

/**
 * Session `id` (default: the newest with a journal) when it may fall asleep: journal filed, proposals settled, no other
 * sleep under way.
 */
async function sleepable(tx: Tx, id: unknown) {
  const found =
    id === undefined
      ? (await tx.doc(Sessions, ROOT_CONVERSATION_ID)).sessions.findLast((item) => item.journal)
      : await find(tx, id)
  if (!found) throw new Error('No dream session has a journal yet')
  if (!found.journal) throw new Error(`Dream session ${found.id} has no journal`)
  if (unsettled(found)) throw new Error('Settle every dream proposal before falling asleep')
  if (found.sleep && found.sleep.phase !== 'failed')
    throw new Error(`Dream session ${found.id} is already falling asleep (${found.sleep.phase})`)
  return found
}

/**
 * Every gate of Fall asleep after admission: seed, scratch preview with one repair, final backup, nothing at work, then
 * the journaled restart that rolls back when it fails.
 */
async function fallAsleep(
  host: ExtensionHost,
  { session, name }: { session: number; name: string },
) {
  const progress = (change: Partial<Sleep>) =>
    host.harness().commit(async (tx) => {
      const found = await find(tx, session)
      found.sleep = { ...found.sleep!, ...change, at: Date.now() }
      return JSON.parse(JSON.stringify(found.sleep)) as Sleep
    }, context)
  try {
    const instances = host.want(InstanceApi)
    if (!instances) throw new Error('Fall asleep needs the instance extension for its gate')
    const build = () => buildSeed(host, session)
    let seed = await build()
    await progress({ phase: 'checking' })
    let result = await gate(seed, name, instances)
    if (!result.ok) {
      await progress({ phase: 'seeding', checks: result.checks })
      seed = await build()
      await progress({ phase: 'checking' })
      result = await gate(seed, name, instances)
    }
    if (!result.ok)
      return {
        session,
        sleep: await progress({
          phase: 'failed',
          checks: result.checks,
          error: 'Chapter gate failed after one repair',
        }),
      }
    await progress({ phase: 'backing up', checks: result.checks })
    await progress({ backup: await finalBackup(host) })
    // The gate and backup can take time; work started since admission must also finish before we switch.
    await host.harness().commit((tx) => idle(host, tx), context)
    await progress({ phase: 'switching' })
    await writeSeed(chapterFiles(host.home, name).dir, seed)
    return await restartChapter(host, name)
  } catch (error) {
    return { session, sleep: await progress({ phase: 'failed', error: String(error) }) }
  }
}

/** Dream before compaction, bound to this extension's documents, lock and session start. */
const compaction = (host: ExtensionHost) =>
  compactionDream(host, {
    Sessions,
    switching: () => switching(host).busy,
    start: (tx, origin, tasks) => startDreamIn(host, tx, origin, tasks),
    tasks: () => liveTasks(host),
  })

/**
 * Inside `tx`: the built-in automation's session that has just settled gets its "worth a fresh chapter?" check, once. An
 * ended session counts only once nothing is open or approved.
 */
const settled = async (host: ExtensionHost, tx: Tx, found: Session) => {
  if (!unsettled(found)) await compaction(host).settled(tx, found)
}

export default function dream(host: ExtensionHost) {
  const { Wait, Retired, Settle, fired, healed } = compaction(host)
  // One at a time, across facet reloads: two concurrent checks would both make the automation.
  const queue = host.resource('dream.after-compaction', () => ({ last: Promise.resolve() }))
  /** Queue a check behind the last one; a failure becomes a notice. */
  const ensure = () => {
    const run = queue.last.then(() => ensureAutomation(host))
    // The queue only orders the checks: the failure is reported below, and the next check still runs.
    queue.last = run.catch(() => undefined)
    return run.catch((error: unknown) => host.notice(`Dream before compaction: ${String(error)}`))
  }
  host.onOpen(async () => {
    await settleSleep(host)
    const seed = await applySeed(host)
    // In the background: an upload takes minutes, and the rest of the opening must not wait for it.
    if (seed && !seed.gate)
      firstBackup(host).catch((error: unknown) => host.notice(`Chapter backup: ${String(error)}`))
    await ensure()
    // A request whose wait faulted, as one did across a reload that changed its contract, looks again.
    await host.harness().commit((tx) => healed(tx), context)
  })
  // A fresh project has no @ultimate when it opens: the automation follows once it exists. Outside the transaction:
  // making it commits.
  host.react(
    'ultimate-started',
    [StandingStarted],
    (_tx, { data }) => {
      if (data.kind === 'standing' && data.agent === 'ultimate')
        ensure().catch((error: unknown) => host.notice(String(error)))
    },
    { from: 'now' },
  )
  // Approved proposals are followed to landing: their branch's landing settles them.
  host.react('landed', [SubmissionLanded], async (tx, { data }) => {
    for (const found of await landed(tx, data.conversationId, data.sha, Date.now()))
      await settled(host, tx, found)
  })
  // Only the built-in automation's fires start a dream: after @ultimate's handoff, once every other conversation is done.
  host.react('after-compaction', [Fired], (tx, { data }) => fired(tx, data.id, Date.now()), {
    from: 'now',
  })
  return defineExtension({
    name: 'dream',
    tasks: [deliverTask(host), Wait, Retired, Settle],
  })
}
