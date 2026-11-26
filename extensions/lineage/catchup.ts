import type { ConversationId, EntryDraft, Tx } from '@earendil-works/pi-durable'
import { isAbsolute, relative, resolve } from 'node:path'
import { onCommit } from '../../lib/commits.ts'
import type { Context } from '@earendil-works/chord/context'
import { AgentDoc, defineDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { git } from '../../lib/git.ts'
import { inProcess, meansNone } from '../../lib/errors.ts'
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
async function mainOf(
  host: ExtensionHost,
  id: ConversationId,
  ctx: Context,
  tx?: Tx,
): Promise<Main | undefined> {
  const service = host.need(WorkspacesApi)
  const workspace = tx
    ? (await tx.doc(service.doc, ROOT_CONVERSATION_ID)).items[String(id)]
    : await service.get(id, ctx)
  const cwd = workspace?.source ?? host.projectRoot
  const target =
    workspace?.target ??
    (await git(cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => ''))
  if (!target) return undefined
  const sha = await git(cwd, 'rev-parse', '--verify', `refs/heads/${target}`).catch(meansNone)
  return sha
    ? { cwd, target, sha, ...(workspace?.state === 'ready' ? { workspace: workspace.path } : {}) }
    : undefined
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
    pending = pending.then(async () => {
      if ((await host.harness().snapshot(Seen, id, ctx))?.main) return
      const main = await mainOf(host, id, ctx)
      if (!main) return
      await host.harness().commit((tx) => seedSeen(tx, id, main.sha, Date.now()), ctx)
    })
    return pending
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

async function changedFiles(host: ExtensionHost, id: ConversationId, main: Main, tx: Tx) {
  if (main.workspace) {
    const base = await git(main.workspace, 'merge-base', 'HEAD', main.sha)
    return new Set([
      ...lines(await git(main.workspace, 'diff', '--name-only', base)),
      ...lines(
        await git(main.workspace, 'ls-files', '--others', '--exclude-standard', '--full-name'),
      ),
    ])
  }
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
  tx: Tx,
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
    changedFiles(host, id, main, tx),
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

type NoteBaselineAndInputCommitTogether = Tx

// Pi upstream: @earendil-works/pi-durable@1.6.0 — patched transactional beforeInput hook. Drop when Pi ships input-placement hooks.
export async function catchup(
  host: ExtensionHost,
  _input: EntryDraft,
  placement: { conversationId: ConversationId; tx: NoteBaselineAndInputCommitTogether },
  ctx: Context,
  isBranch: (tx: Tx, id: ConversationId) => Promise<boolean>,
) {
  const { tx, conversationId } = placement
  const record = await tx.conversation(conversationId)
  if (!record || record.owner) return undefined
  const main = await mainOf(host, conversationId, ctx, tx)
  const alwaysAdvancedBaseline = await tx.doc(Seen, conversationId)
  const ultimate = (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate === conversationId
  const commits =
    main && !ultimate && alwaysAdvancedBaseline.main && alwaysAdvancedBaseline.main !== main.sha
      ? await catchupText(
          host,
          conversationId,
          main,
          {
            main: alwaysAdvancedBaseline.main,
            at: alwaysAdvancedBaseline.at,
          },
          tx,
          await isBranch(tx, conversationId),
        ).catch((error: unknown) => {
          host.notice(`Skipped the commit catch-up for #${conversationId}: ${String(error)}`)
          return undefined
        })
      : undefined
  if (main) {
    alwaysAdvancedBaseline.main = main.sha
    if (!alwaysAdvancedBaseline.at || commits) alwaysAdvancedBaseline.at = Date.now()
  }
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
