import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { isAbsolute, relative, resolve } from 'node:path'
import { onCommit } from '../../lib/commits.ts'
import type { Context } from '@earendil-works/chord/context'
import { AgentDoc, defineDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { git } from '../../lib/git.ts'
import { inProcess, meansNone, settled } from '../../lib/errors.shared.ts'
import { shortTitle } from '../../lib/title.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { WorkspacesApi } from '../workspaces/api.ts'
import { Standing } from '../subagents/api.ts'
import { checkpointEvery } from '../../shared/checkpoint.ts'

export const Seen = defineDoc<{ main?: string; at?: number }>({
  kind: 'lineage.seen',
  checkpointWhen: checkpointEvery(100),
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

type Main = { cwd: string; target: string; sha: string; workspace?: string }
async function mainOf(host: ExtensionHost, id: ConversationId, ctx: Context) {
  const workspace = await host.need(WorkspacesApi).get(id, ctx)
  const cwd = workspace?.source ?? host.projectRoot
  const target =
    workspace?.target ??
    (await git(cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => ''))
  if (!target) return undefined
  const sha = await git(cwd, 'rev-parse', '--verify', `refs/heads/${target}`).catch(meansNone)
  const main: Main | undefined = sha
    ? { cwd, target, sha, ...(workspace?.state === 'ready' ? { workspace: workspace.path } : {}) }
    : undefined
  return main
}

export async function seedSeen(tx: Tx, id: ConversationId, main: string, at: number) {
  const seen = await tx.doc(Seen, id)
  if (!seen.main) {
    seen.main = main
    seen.at = at
  }
}

export function watchSeen(host: ExtensionHost, ctx: Context) {
  let pending = Promise.resolve()
  const seed = (id: ConversationId) => {
    const next = pending.then(async () => {
      if ((await host.harness().snapshot(Seen, id, ctx))?.main) return
      const main = await mainOf(host, id, ctx)
      if (!main) return
      await host.harness().commit((tx) => seedSeen(tx, id, main.sha, Date.now()), ctx)
    })
    pending = settled(next)
    return next
  }
  host.onOpen(async (opened) => {
    const harness = host.harness()
    const unsubscribe = onCommit(harness, (publication) => {
      for (const change of publication.changes)
        if (change.type === 'conversation' && !change.value.owner)
          inProcess(
            'the first input seeds a conversation whose creation went unseen',
            seed(change.value.id).catch((error: unknown) => {
              host.notice(`Could not record main for #${change.value.id}: ${String(error)}`)
            }),
          )
    })
    opened.defer(async () => {
      unsubscribe()
      await pending
    })
    await seed(ROOT_CONVERSATION_ID)
  })
}

const lines = (output: string) => output.split('\n').filter(Boolean)

async function changedFiles(host: ExtensionHost, id: ConversationId, main: Main, ctx: Context) {
  if (main.workspace) {
    const base = await git(main.workspace, 'merge-base', 'HEAD', main.sha)
    return new Set([
      ...lines(await git(main.workspace, 'diff', '--name-only', base)),
      ...lines(
        await git(main.workspace, 'ls-files', '--others', '--exclude-standard', '--full-name'),
      ),
    ])
  }
  return host.harness().commit((tx) => editedFiles(host, tx, id, main), ctx)
}

async function editedFiles(host: ExtensionHost, tx: Tx, id: ConversationId, main: Main) {
  const cwd = (await tx.doc(AgentDoc, id)).cwd ?? host.projectRoot
  const files = new Set<string>()
  let cursor
  do {
    const page = await tx.scanEntries({ conversationId: id }, 100, cursor)
    for (const entry of page.items) {
      if (entry.conversationId !== id) continue
      for (const message of entry.model ?? []) {
        if (message.role !== 'assistant') continue
        for (const part of message.content) {
          if (part.type !== 'toolCall' || !['edit', 'write'].includes(part.name)) continue
          const path = part.arguments.path
          if (typeof path !== 'string') continue
          const absolute = isAbsolute(path) ? path : resolve(cwd, path)
          files.add(relative(main.cwd, absolute))
        }
      }
    }
    cursor = page.next
  } while (cursor)
  return files
}

const COMMIT_ROWS_OVERLAPS_FIRST = 30
const MAX_PATHS_WITH_OVERLAP_MARKS = 1000

async function catchupText(
  host: ExtensionHost,
  id: ConversationId,
  main: Main,
  since: { main: string; at?: number },
  ctx: Context,
  onlyOverlaps: boolean,
) {
  const range = `${since.main}..${main.sha}`
  const firstParentTargetLogBoundedByRows = (...args: string[]) =>
    git(
      main.cwd,
      'log',
      '--first-parent',
      `--max-count=${COMMIT_ROWS_OVERLAPS_FIRST}`,
      '--format=%x1e%H%x00%s%x00%(trailers:key=Ultimate-Conversation,valueonly)%x00',
      ...args,
    )
  const [count, recent, changed] = await Promise.all([
    git(main.cwd, 'rev-list', '--first-parent', '--count', range).then(Number),
    onlyOverlaps ? '' : firstParentTargetLogBoundedByRows(range),
    changedFiles(host, id, main, ctx),
  ])
  if (!count) return undefined
  const ownFilePathspecForBoundedMergeNames = [...changed]
    .slice(0, MAX_PATHS_WITH_OVERLAP_MARKS)
    .map((path) => (main.workspace ? `:(top,literal)${path}` : `:(literal)${path}`))
  const overlapMarksOrEmpty = ownFilePathspecForBoundedMergeNames.length
    ? await firstParentTargetLogBoundedByRows(
        '--name-only',
        '--no-renames',
        '--diff-merges=first-parent',
        ...(onlyOverlaps ? ['--invert-grep', `--grep=^Ultimate-Conversation: ${id}$`] : []),
        range,
        '--',
        ...ownFilePathspecForBoundedMergeNames,
      ).catch(() => '')
    : ''
  const parse = (records: string) =>
    records
      .split('\x1e')
      .map((record) => record.trim())
      .filter(Boolean)
      .map((record) => {
        const [sha, subject, trailer, paths = ''] = record.split('\0')
        return { sha, subject, trailer, paths: paths.trim().split('\n').filter(Boolean) }
      })
  const overlaps = parse(overlapMarksOrEmpty)
  if (onlyOverlaps && !overlaps.length) return undefined
  const listed = new Set(overlaps.map((commit) => commit.sha))
  const commits = [...overlaps, ...parse(recent).filter((commit) => !listed.has(commit.sha))]
    .map(({ sha, subject, trailer, paths: overlap }) => {
      const conversation = Number(trailer.trim())
      const made = host.conversations().find((summary) => summary.id === conversation)
      const label =
        made?.title &&
        `${made.parentConversationId && made.label ? `${made.label}: ` : ''}${shortTitle(made.title)}`
      return {
        overlap,
        row: `- ${overlap.length && !onlyOverlaps ? '**Overlap** ' : ''}\`${sha.slice(0, 7)}\` ${subject}${conversation ? ` · #${conversation}${label ? ` ${label}` : ''}` : ''}${overlap.length ? ` — ${overlap.map((path) => `\`${path}\``).join(', ')}` : ''}`,
      }
    })
    .slice(0, COMMIT_ROWS_OVERLAPS_FIRST)
  const behind = main.workspace
    ? Number(
        await git(main.workspace, 'rev-list', '--first-parent', '--count', `HEAD..${main.sha}`),
      )
    : 0
  return [
    onlyOverlaps
      ? `${overlaps.length}${overlaps.length === COMMIT_ROWS_OVERLAPS_FIRST ? '+' : ''} new commits on ${main.target} overlap your checkout:`
      : `Since you last worked (${new Date(since.at ?? Date.now()).toISOString()}), ${count} commits landed on ${main.target}:`,
    ...commits.map((commit) => commit.row),
    ...(!onlyOverlaps && count > commits.length
      ? [`and ${count - commits.length} more (\`git log --first-parent ${range}\`).`]
      : []),
    ...(behind
      ? [`Your workspace is ${behind} commits behind ${main.target}; merge it before continuing.`]
      : []),
  ].join('\n\n')
}

type CatchupPlacedOnlyWhileBaselineHolds = { since: string; main: Main; text?: string }

export function catchupPreparation(
  host: ExtensionHost,
  isBranch: (tx: Tx, id: ConversationId) => Promise<boolean>,
) {
  const prepared = new Map<ConversationId, CatchupPlacedOnlyWhileBaselineHolds>()
  const prepare = async (id: ConversationId, ctx: Context) => {
    const harness = host.harness()
    const facts = await harness.commit(async (tx) => {
      const record = await tx.conversation(id)
      if (!record || record.owner) return undefined
      return {
        branch: await isBranch(tx, id),
        ultimate: (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate === id,
        seen: { ...(await tx.doc(Seen, id)) },
      }
    }, ctx)
    prepared.delete(id)
    if (!facts) return
    const main = await mainOf(host, id, ctx)
    if (!main) return
    const since = facts.seen.main
    const text =
      since && since !== main.sha && !facts.ultimate
        ? await catchupText(
            host,
            id,
            main,
            { main: since, at: facts.seen.at },
            ctx,
            facts.branch,
          ).catch((error: unknown) => {
            host.notice(`Skipped the commit catch-up for #${id}: ${String(error)}`)
            return undefined
          })
        : undefined
    prepared.set(id, { since: since ?? '', main, ...(text ? { text } : {}) })
  }
  const preparing = new Map<ConversationId, Promise<void>>()
  const prepareOnce = (id: ConversationId, ctx: Context) => {
    if (!preparing.has(id))
      preparing.set(
        id,
        prepare(id, ctx).finally(() => preparing.delete(id)),
      )
    return preparing.get(id)!
  }
  return {
    prepare: prepareOnce,
    async place(
      placement: { conversationId: ConversationId; tx: NoteBaselineAndInputCommitTogether },
      ctx: Context,
    ) {
      const ready = prepared.get(placement.conversationId)
      prepared.delete(placement.conversationId)
      const placed = await catchup(placement, ready)
      if (placed !== 'unprepared') return placed
      inProcess(
        'an input placed without preparation keeps the baseline, so the next input catches up',
        prepareOnce(placement.conversationId, ctx).catch((error: unknown) => {
          host.notice(
            `Could not prepare the catch-up for #${placement.conversationId}: ${String(error)}`,
          )
        }),
      )
      return undefined
    },
  }
}

type NoteBaselineAndInputCommitTogether = Tx

// Pi upstream: @earendil-works/pi-durable@1.6.0 — patched transactional beforeInput hook. Drop when Pi ships input-placement hooks.
async function catchup(
  placement: { conversationId: ConversationId; tx: NoteBaselineAndInputCommitTogether },
  prepared: CatchupPlacedOnlyWhileBaselineHolds | undefined,
) {
  const { tx, conversationId } = placement
  const record = await tx.conversation(conversationId)
  if (!record || record.owner) return undefined
  const alwaysAdvancedBaseline = await tx.doc(Seen, conversationId)
  if (!prepared || (alwaysAdvancedBaseline.main ?? '') !== prepared.since) return 'unprepared'
  const commits = prepared.text
  alwaysAdvancedBaseline.main = prepared.main.sha
  if (!alwaysAdvancedBaseline.at || commits) alwaysAdvancedBaseline.at = Date.now()
  if (!commits) return undefined
  const text = `${commits}\n\nCheck whether any of this already covers or changes what you are about to do.`
  return {
    entries: [
      {
        kind: 'lineage.note',
        data: { source: 'main', text },
        model: [{ role: 'user' as const, content: text, timestamp: Date.now() }],
      },
    ],
  }
}
