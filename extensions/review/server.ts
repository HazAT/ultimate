import type { Context } from '@earendil-works/chord/context'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { AgentDoc, defineEntry, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import { formatAgo } from '../../lib/ago.ts'
import { UserInputEvent } from '../../shared/events.ts'
import { git, isolatable } from '../../lib/git.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { SubagentsApi } from '../subagents/api.ts'
import { SubmissionLanded, WorkspacesApi } from '../workspaces/api.ts'
import { checkReview, reviewText } from './comments.ts'
import type { ReviewComments } from './comments.ts'
import { reviewDiff } from './diff.ts'
import { DiffAction, RangesAction, RecipientAction, SendAction } from './refs.ts'
import type { ReviewRange } from './refs.ts'

/** A review the user sent: the input its recipient reads as `reviewText`; card.tsx renders it. */
export const ReviewCommentsEntry = defineEntry<ReviewComments>('review.comments')

const index = (host: ExtensionHost, ctx: Context) =>
  host.harness().snapshot(host.need(WorkspacesApi).doc, ROOT_CONVERSATION_ID, ctx)

/** A conversation argument, checked: `undefined` for a caller that passed none. */
function conversationOf(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error('conversation must be a conversation id')
  return value
}

/**
 * The checkout conversation `id` works in: its ready worktree, else the repository that worktree branched from, else
 * its own cwd, else the project's checkout. The same rule as lineage's catch-up: a project root that is no repository
 * of its own keeps its work in subfolder repositories, and Review has to follow the conversation into them.
 */
async function checkout(host: ExtensionHost, conversation?: number) {
  if (conversation === undefined) return host.projectRoot
  const workspace = (await index(host, context))?.items[String(conversation)]
  if (workspace?.state === 'ready') return workspace.path
  if (workspace?.source) return workspace.source
  const agent = await host.harness().snapshot(AgentDoc, conversation as ConversationId, context)
  return agent?.cwd || host.projectRoot
}

/** The branch `branch` lands on: its worktree's target, else the project's checkout, else the branch `cwd` is on. */
async function target(host: ExtensionHost, branch: string, cwd: string) {
  const items = Object.values((await index(host, context))?.items ?? {})
  const owned = items.find((item) => item.branch === branch)
  if (owned) return owned.target
  const project = await isolatable(host.projectRoot)
  if (!('reason' in project)) return project.target
  // A project root outside Git: what branches land on is the branch of the conversation's own checkout.
  const on = await git(cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(
    // Outside a repository, or on a detached HEAD, there is no branch here to land on.
    () => '',
  )
  if (on) return on
  throw new Error(project.reason)
}

/**
 * What a `branch:<name>` spec shows once its ref is gone (it landed and its worktree was removed): its latest landing as
 * `<base>...<tip>`, the commits it submitted against the target they landed on. That is the diff the branch showed just
 * before it landed, so draft comments keep their lines. `uncommitted` when no landing is known; else the spec itself.
 */
async function resolve(host: ExtensionHost, cwd: string, spec: string) {
  if (!spec.startsWith('branch:')) return spec
  const branch = spec.slice('branch:'.length)
  const present = await git(
    cwd,
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `refs/heads/${branch}`,
  ).catch(
    // `--quiet` exits 1 for an unknown ref: the branch is gone.
    () => '',
  )
  if (present) return spec
  const doc = await index(host, context)
  const owner = Object.entries(doc?.items ?? {}).find(([, item]) => item.branch === branch)?.[0]
  const landed = Object.values(doc?.results ?? {}).findLast(
    (result) => result.outcome === 'landed' && String(result.conversationId) === owner,
  )
  if (landed?.base) return `${landed.base}...${landed.tip}`
  // Past the index's latest outcomes, the landing event: what the target gained, merged with what landed meanwhile.
  const [event] = await host.eventLog
    .recent({ events: [SubmissionLanded], limit: 200 })
    .then((landings) => landings.filter(({ data }) => String(data.conversationId) === owner))
  return event ? `${event.data.base}...${event.data.sha}` : 'uncommitted'
}

/** A git or landing time in seconds, as the range list shows it. */
const ago = (seconds: number) => formatAgo(seconds * 1000)

async function ranges(host: ExtensionHost, conversation?: number): Promise<ReviewRange[]> {
  const cwd = await checkout(host, conversation)
  const items = Object.entries((await index(host, context))?.items ?? {})
  const titles = new Map(host.conversations().map((item) => [item.id, item.title]))
  const owner = new Map(
    items
      .filter(([, item]) => item.state !== 'removed')
      .map(([id, item]) => [item.branch, Number(id)]),
  )
  const [branches, commits, landings] = await Promise.all([
    git(
      cwd,
      'for-each-ref',
      '--sort=-committerdate',
      '--count=20',
      '--format=%(refname:short)%09%(committerdate:unix)',
      'refs/heads/ultimate/',
    ).catch(
      // No repository: the selector offers free entry only.
      () => '',
    ),
    git(cwd, 'log', '-n', '15', '--format=%H%x09%ct%x09%s').catch(
      // No commit yet: nothing to list.
      () => '',
    ),
    host.eventLog.recent({ events: [SubmissionLanded], limit: 10 }),
  ])
  const list: ReviewRange[] = [
    { spec: 'uncommitted', group: 'Working tree', label: 'Uncommitted changes' },
  ]
  for (const line of branches.split('\n').filter(Boolean)) {
    const [branch, at] = line.split('\t') as [string, string]
    const id = owner.get(branch)
    // Only branches of a live worktree: a landed and removed one has nothing left to review.
    if (id === undefined) continue
    list.push({
      spec: `branch:${branch}`,
      group: 'Branches',
      label: titles.get(id) ?? `#${id}`,
      detail: `#${id} · ${ago(Number(at))}`,
      conversation: id,
    })
  }
  for (const { data, at } of landings)
    list.push({
      spec: `${data.base}...${data.sha}`,
      group: 'Landings',
      label: data.feature ? `${data.feature} · ${data.title}` : data.title || data.sha.slice(0, 7),
      detail: `${data.sha.slice(0, 7)} · ${data.commitCount} commit${data.commitCount === 1 ? '' : 's'} · ${ago(Date.parse(at) / 1000)}`,
      conversation: data.conversationId,
    })
  for (const line of commits.split('\n').filter(Boolean)) {
    const [sha, at, subject] = line.split('\t') as [string, string, string]
    list.push({
      spec: sha,
      group: 'Commits',
      label: subject,
      detail: `${sha.slice(0, 7)} · ${ago(Number(at))}`,
    })
  }
  return list
}

/** The conversation of an `uncommitted:<id>` spec, else undefined. */
const worktreeOf = (spec: string) => {
  const id = /^uncommitted:([1-9]\d*)$/.exec(spec.trim())?.[1]
  return id === undefined ? undefined : Number(id)
}

const known = (host: ExtensionHost, id: number) =>
  host.conversations().some((conversation) => conversation.id === id)

/** Who a review of `spec` goes to unless the user picks another: see `RecipientAction`. */
async function recipient(host: ExtensionHost, spec: string, cwd: string): Promise<number> {
  const owner = async () => {
    const worktree = worktreeOf(spec)
    if (worktree !== undefined) return worktree
    if (spec.startsWith('branch:')) {
      const branch = spec.slice('branch:'.length)
      const items = Object.entries((await index(host, context))?.items ?? {})
      return Number(items.find(([, item]) => item.branch === branch)?.[0]) || undefined
    }
    const range = /^[^.]+\.\.\.([^.]+)$/.exec(spec)
    let head = spec
    if (range) {
      const landings = await host.eventLog.recent({ events: [SubmissionLanded], limit: 200 })
      const sha = await git(
        cwd,
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        `${range[1]}^{commit}`,
      )
      const landed = landings.find(({ data }) => data.sha === sha)?.data.conversationId
      if (landed !== undefined) return landed
      // Not landed (a pull request, say): the head commit's trailer names its branch.
      head = range[1]
    }
    if (spec === 'uncommitted' || spec.startsWith('-')) return undefined
    const trailer = await git(
      cwd,
      'log',
      '-1',
      '--format=%(trailers:key=Ultimate-Conversation,valueonly)',
      '--end-of-options',
      head,
    )
    return Number(trailer.split('\n')[0]) || undefined
  }
  const found = await owner().catch(
    // An unknown ref or a missing repository has no owner: the review goes to the primary agent.
    () => undefined,
  )
  if (found !== undefined && known(host, found)) return found
  return host.need(SubagentsApi).standing('ultimate', context)
}

export const userActions = ['send']

export const actions = {
  diff: implementAction(DiffAction, async (args, { host, signal }) => {
    const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
    if (typeof input.spec !== 'string') throw new Error('Expected { spec }')
    // `uncommitted:<id>` names a worktree's uncommitted changes: the same diff, run in that checkout.
    const worktree = worktreeOf(input.spec)
    const cwd = await checkout(host, worktree ?? conversationOf(input.conversation))
    const shown =
      worktree === undefined ? await resolve(host, cwd, input.spec.trim()) : 'uncommitted'
    const diff = await reviewDiff(cwd, shown, {
      target: (branch) => target(host, branch, cwd),
      signal,
    })
    if (worktree !== undefined)
      return { ...diff, spec: input.spec, title: `Uncommitted changes in #${worktree}` }
    // A landed branch keeps its spec on screen, and so its drafts; one gone without a landing moves on to `shown`.
    return shown === 'uncommitted' ? diff : { ...diff, spec: input.spec }
  }),
  ranges: implementAction(RangesAction, (args, { host }) => {
    const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
    return ranges(host, conversationOf(input.conversation))
  }),
  recipient: implementAction(RecipientAction, async (args, { host }) => {
    const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
    if (typeof input.spec !== 'string') throw new Error('Expected { spec }')
    const cwd = await checkout(host, conversationOf(input.conversation))
    return { conversation: await recipient(host, input.spec, cwd) }
  }),
  send: implementAction(SendAction, async (args, { host, device }) => {
    const id =
      args && typeof args === 'object' && !Array.isArray(args) ? args.conversation : undefined
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || !known(host, id))
      throw new Error('conversation must be an existing conversation id')
    const review = checkReview(args)
    const conversation = await host.harness().conversation(id as ConversationId, context)
    if (!conversation) throw new Error(`No conversation #${id}`)
    const content = reviewText(review)
    const submission = await conversation.submit(
      {
        type: 'input',
        content,
        entry: { kind: ReviewCommentsEntry.kind, data: review },
        // A review is the user's input: it steers a busy recipient as a message typed into it would.
        whenBusy: 'steer',
      },
      context,
    )
    // In a commit of its own right after the input's, which Pi admits with no hook: a crash in between loses it.
    const admitted = await submission.status(context)
    await host.harness().commit(
      (tx) =>
        host.emit(tx, UserInputEvent, {
          conversation: id,
          kind: 'review',
          ...(admitted.entry === undefined
            ? { submission: submission.id }
            : { entry: admitted.entry }),
          length: content.length,
          ...device,
        }),
      context,
    )
    return { conversation: id }
  }),
}

export default { name: 'review' }
