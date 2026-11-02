import { isAbsolute, relative, resolve } from 'node:path'
import { onCommit } from '../../lib/commits.ts'
import type { Context } from '@earendil-works/chord'
import { AgentDoc, defineDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate'
import type {
  ConversationId,
  EntryDraft,
  EntryId,
  EntryRecord,
  Tx,
} from '@earendil-works/pi-durable'
import { git } from '../../lib/git.ts'
import { shortTitle } from '../../lib/title.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { WorkspacesApi } from '../workspaces/api.ts'
import type { OpenAbstract } from './server.ts'

/**
 * What a conversation last saw: the target tip (`main`, at time `at`) and the last entry of its tree's tally it
 * accounted for (`tally`). A branch gets its own baseline, not its source's.
 */
export const Seen = defineDoc<{ main?: string; at?: number; tally?: number }>({
  kind: 'lineage.seen',
  checkpointWhen: () => false,
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
  // A shared conversation follows the branch the project checkout is on, like a workspace's target.
  const target =
    workspace?.target ??
    (await git(cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => ''))
  if (!target) return undefined
  // Projects without a main branch have nothing to catch up on.
  const sha = await git(cwd, 'rev-parse', '--verify', `refs/heads/${target}`).catch(
    // An unborn target branch has no commits to catch up on.
    () => undefined,
  )
  // Only a ready checkout exists on disk: a concluded conversation's is released, and its next request recreates it.
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

/** Seed existing conversations on open and new ones on creation; commits never overwrite a saved baseline. */
export function watchSeen(host: ExtensionHost, ctx: Context) {
  let unsubscribe: (() => void) | undefined
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
  host.onOpen(async () => {
    const harness = host.harness()
    // Not a reactor: it seeds every new top-level conversation, a Pi record, not only lineage's branches and roots.
    unsubscribe = onCommit(harness, (publication) => {
      for (const change of publication.changes)
        if (change.type === 'conversation' && !change.value.owner)
          void seed(change.value.id).catch((error: unknown) => {
            host.notice(`Could not record main for #${change.value.id}: ${String(error)}`)
          })
    })
    const records = await harness.commit(async (tx) => {
      const ids: ConversationId[] = []
      let cursor
      do {
        const page = await tx.scanConversations({}, 100, cursor)
        ids.push(...page.items.filter((record) => !record.owner).map((record) => record.id))
        cursor = page.next
      } while (cursor)
      return ids
    }, ctx)
    for (const id of records) await seed(id)
  })
  host.onClose(async () => {
    unsubscribe?.()
    await pending
  })
}

/** Files this conversation changed: its workspace diff, or its own edit/write calls in a shared checkout. */
async function changedFiles(host: ExtensionHost, id: ConversationId, main: Main, tx: Tx) {
  if (main.workspace) {
    const base = await git(main.workspace, 'merge-base', 'HEAD', main.sha)
    return new Set(
      (await git(main.workspace, 'diff', '--name-only', base)).split('\n').filter(Boolean),
    )
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

async function catchupText(
  host: ExtensionHost,
  id: ConversationId,
  main: Main,
  since: { main: string; at?: number },
  tx: Tx,
) {
  const range = `${since.main}..${main.sha}`
  const [count, records, changed] = await Promise.all([
    git(main.cwd, 'rev-list', '--count', range).then(Number),
    git(
      main.cwd,
      'log',
      '--name-only',
      '--no-renames',
      '--diff-merges=first-parent',
      '--format=%x1e%H%x00%s%x00%(trailers:key=Ultimate-Conversation,valueonly)%x00',
      range,
    ),
    changedFiles(host, id, main, tx),
  ])
  if (!count) return undefined
  const commits = records
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, subject, trailer, paths] = record.split('\0')
      const overlap = paths
        .trim()
        .split('\n')
        .filter((path) => changed.has(path))
      const conversation = Number(trailer.trim())
      // Subagents are never summary-titled; older ones carry their whole prompt as title, so one line each.
      const made = host.conversations().find((summary) => summary.id === conversation)
      const label =
        made?.title &&
        `${made.parentConversationId && made.label ? `${made.label}: ` : ''}${shortTitle(made.title)}`
      return {
        overlap,
        row: `- ${overlap.length ? '**Overlap** ' : ''}\`${sha.slice(0, 7)}\` ${subject}${conversation ? ` · #${conversation}${label ? ` ${label}` : ''}` : ''}${overlap.length ? ` — ${overlap.map((path) => `\`${path}\``).join(', ')}` : ''}`,
      }
    })
    .toSorted((a, b) => Number(b.overlap.length > 0) - Number(a.overlap.length > 0))
    .slice(0, 30)
  const behind = main.workspace
    ? Number(await git(main.workspace, 'rev-list', '--count', `HEAD..${main.sha}`))
    : 0
  return [
    `Since you last worked (${new Date(since.at ?? Date.now()).toISOString()}), ${count} commits landed on ${main.target}:`,
    ...commits.map((commit) => commit.row),
    ...(count > commits.length
      ? [`and ${count - commits.length} more (\`git log ${range}\`).`]
      : []),
    ...(behind
      ? [`Your workspace is ${behind} commits behind ${main.target}; merge it before continuing.`]
      : []),
  ].join('\n\n')
}

/** The first input `id` placed itself; its own entries all follow the entry it was forked at. */
async function firstInput(tx: Tx, id: ConversationId, forkedAt = 0) {
  let cursor
  do {
    const page = await tx.scanEntries(
      { conversationId: id, minEntryId: (forkedAt + 1) as EntryId, order: 'ascending' },
      100,
      cursor,
    )
    const first = page.items.find((entry) => entry.conversationId === id && entry.input)
    if (first) return first.id
    cursor = page.next
  } while (cursor)
  return undefined
}

/** A tally a top-level conversation catches up on: its tree root, once that root is a tally. */
export type Tree = { root: ConversationId; since: number; abstracts: Record<string, OpenAbstract> }

/** Tokens the tally part of a catch-up may take. */
export const TALLY_BUDGET = 6000

/** What one conversation of the tree did since the baseline, as model-visible in the tally now. */
type Activity = {
  id: number
  last: number
  title?: string
  feature?: string
  prompt?: string
  abstract?: { at: number; text: string }
  landings: {
    sha: string
    target: string
    at: number
    divergence: string
    state?: { at: number; text: string }
  }[]
  notes: string[]
}

/** A block's tokens with the blank line that separates it from the next. */
const cost = (text: string) => estimateTextTokens(`${text}\n\n`)
const oneLine = (text: string) => text.replace(/\s*\n\s*/g, ' ').trim()

function full(activity: Activity) {
  const { id, title, feature, prompt, abstract, landings, notes } = activity
  if (!abstract && !landings.length && !notes.length) return `**#${id}** started: ${prompt}`
  // Without a liquid abstract, the state its newest landing froze is its latest.
  const frozen = abstract ? undefined : landings.findLast((landing) => landing.state)?.state
  const state = abstract ?? frozen
  const items = [
    ...(state
      ? state.text
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => (/^[-*] /.test(line) ? line : `- ${line}`))
      : prompt
        ? [`- Started: ${prompt}`]
        : []),
    ...landings.map(
      (landing) =>
        `- Landed \`${landing.sha.slice(0, 7)}\` on ${landing.target} (#${id}/${landing.at}). Diverged: ${oneLine(landing.divergence)}`,
    ),
    ...notes.map((note) => `- Note: ${oneLine(note)}`),
  ]
  return [
    `**#${id}${title ? ` ${title}` : ''}**${feature ? ` · ${feature}` : ''}${abstract ? ` — abstract as of #${id}/${abstract.at}:` : frozen ? ` — state at landing, as of #${id}/${frozen.at}:` : ':'}`,
    ...items,
  ].join('\n')
}

const collapsed = ({ id, title, feature, landings }: Activity) =>
  `- #${id}${title ? ` ${title}` : ''}${feature ? ` · ${feature}` : ''} — ${landings.length ? `landed \`${landings.at(-1)!.sha.slice(0, 7)}\`` : 'in progress'}`

/**
 * What the tree's tally learned after `baseline`, for conversation `id`: each other conversation's latest abstract (or
 * its prompt while it has none), landings and notes, and a distillation of the tally itself. The newest stay in full;
 * when they exceed the budget the oldest collapse to one line each. Deterministic: it runs inside input placement.
 */
export async function tallyText(
  id: ConversationId,
  tree: Tree,
  baseline: number,
  tx: Tx,
  budget = TALLY_BUDGET,
) {
  const { root } = tree
  const marker = await tx.latestHeadMarker(root)
  const entries: EntryRecord[] = []
  let cursor
  do {
    const page = await tx.scanEntries(
      { conversationId: root, minEntryId: (baseline + 1) as EntryId, order: 'ascending' },
      100,
      cursor,
    )
    entries.push(...page.items)
    cursor = page.next
  } while (cursor)
  const tip = entries.at(-1)?.id
  // The prompts of the conversations it was forked from are in its context already, as their first inputs, when every
  // fork on the way up was made at or after that input.
  const sources = new Set<number>()
  let cut = Number.POSITIVE_INFINITY
  for (let record = await tx.conversation(id); record?.parent;) {
    cut = Math.min(cut, record.parent.at)
    const up = record.parent.conversationId
    if (up === root) break
    record = await tx.conversation(up)
    const first = await firstInput(tx, up, record?.parent?.at)
    if (first !== undefined && first <= cut) sources.add(up)
  }
  const activities = new Map<number, Activity>()
  const of = (conversation: number, entry: EntryRecord) => {
    let activity = activities.get(conversation)
    if (!activity)
      activities.set(
        conversation,
        (activity = { id: conversation, last: 0, landings: [], notes: [] }),
      )
    activity.last = entry.id
    return activity
  }
  // Entries a compaction or genesis replaced are no longer in the tally; its distillation stands for them.
  const visible = entries.filter(
    (entry) => (!marker || entry.id >= marker.head) && entry.id !== marker?.id,
  )
  for (const entry of visible) {
    const data = (entry.data ?? {}) as Record<string, unknown>
    if (entry.kind === 'lineage.abstract') {
      // An open abstract's anchor or a carrier updating it: the abstract as it reads now. A frozen one is the landing's.
      const conversation = data.conversation as number
      const open = tree.abstracts[String(conversation)] as OpenAbstract | undefined
      if (conversation === id || open?.anchor !== ((data.anchor as number | undefined) ?? entry.id))
        continue
      const activity = of(conversation, entry)
      activity.abstract = { at: open.at, text: open.text }
      if (open.title) activity.title = open.title
      if (open.feature) activity.feature = open.feature
    } else if (!entry.model) continue
    else if (entry.kind === 'lineage.branched') {
      const conversation = data.branch as number
      if (conversation === id || sources.has(conversation)) continue
      of(conversation, entry).prompt = oneLine((data.intent as string).split('\n')[0])
    } else if (entry.kind === 'lineage.note' && typeof data.from === 'number' && data.from !== id) {
      const activity = of(data.from, entry)
      if (data.source === 'lander') {
        const state = data.abstract as Omit<OpenAbstract, 'anchor'> | undefined
        activity.landings.push({
          sha: data.sha as string,
          target: data.target as string,
          at: data.at as number,
          divergence: (data.divergence as string | undefined) ?? 'not stated',
          ...(state ? { state: { at: state.at, text: state.text } } : {}),
        })
        activity.title ??= state?.title ?? (data.title as string | undefined)
        activity.feature ??= state?.feature ?? (data.feature as string | undefined)
      } else activity.notes.push(data.text as string)
    }
  }
  for (const activity of activities.values()) activity.title ??= activity.prompt
  const newest = [...activities.values()].toSorted((a, b) => b.last - a.last)
  const blocks = newest.map((activity) => ({ full: full(activity), line: collapsed(activity) }))
  const distilled =
    marker && marker.id > baseline && marker.model
      ? marker.model.flatMap((message) =>
          message.role !== 'user'
            ? []
            : typeof message.content === 'string'
              ? [message.content]
              : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
        )
      : undefined
  if (distilled)
    blocks.push({
      full: `**#${root}'s tally was distilled** (#${root}/${marker!.id}):\n\n${distilled
        .join('\n')
        .replace(/^<\/?[a-z][^>\n]*>$/gm, '')
        .trim()}`,
      line: `- #${root}'s tally was distilled at #${root}/${marker!.id}`,
    })
  if (!blocks.length) return { tip }
  const header = `Meanwhile in #${root}'s tree:`
  const pointer = `Earlier, collapsed (read them in full with codemode \`ultimate.entries(${root})\`):`
  let used = cost(header) + cost(`- and ${blocks.length} more`)
  const kept: string[] = []
  const lines: string[] = []
  let dropped = 0
  for (const block of blocks) {
    if (!lines.length && !dropped && used + cost(block.full) <= budget) {
      kept.unshift(block.full)
      used += cost(block.full)
      continue
    }
    if (!lines.length && !dropped) used += cost(pointer)
    if (!dropped && used + cost(block.line) <= budget) {
      lines.unshift(block.line)
      used += cost(block.line)
    } else dropped++
  }
  return {
    tip,
    text: [
      header,
      ...(lines.length || dropped
        ? [[pointer, ...(dropped ? [`- and ${dropped} more`] : []), ...lines].join('\n')]
        : []),
      ...kept,
    ].join('\n\n'),
  }
}

// Pi upstream: @earendil-works/pi-durable@1.5.0 — patched transactional beforeInput hook. Drop when Pi ships input-placement hooks.
/** The note, baseline and first input commit together, before any request can see them. */
export async function catchup(
  host: ExtensionHost,
  _input: EntryDraft,
  api: { conversationId: ConversationId; tx: Tx },
  ctx: Context,
  treeOf: (tx: Tx, id: ConversationId) => Promise<Tree | undefined>,
) {
  const { tx, conversationId } = api
  const record = await tx.conversation(conversationId)
  if (!record || record.owner) return undefined
  const tree = await treeOf(tx, conversationId)
  const main = await mainOf(host, conversationId, ctx, tx)
  const seen = await tx.doc(Seen, conversationId)
  // Conversations from before the tally was tracked catch up from its start.
  const meanwhile = tree
    ? await tallyText(conversationId, tree, seen.tally ?? tree.since, tx)
    : undefined
  const commits =
    main && seen.main && seen.main !== main.sha
      ? await catchupText(host, conversationId, main, { main: seen.main, at: seen.at }, tx)
      : undefined
  if (meanwhile?.tip !== undefined) seen.tally = meanwhile.tip
  if (main) {
    seen.main = main.sha
    if (!seen.at || commits) seen.at = Date.now()
  }
  if (!meanwhile?.text && !commits) return undefined
  const text = [
    ...(meanwhile?.text ? [meanwhile.text] : []),
    ...(commits ? [commits] : []),
    'Check whether any of this already covers or changes what you are about to do.',
  ].join('\n\n')
  return {
    entries: [
      {
        kind: 'lineage.note',
        // Where this catch-up left the tally: a fork of this conversation inherits that position.
        data: { source: 'main', text, ...(seen.tally === undefined ? {} : { tally: seen.tally }) },
        model: [{ role: 'user' as const, content: text, timestamp: Date.now() }],
      },
    ],
  }
}
