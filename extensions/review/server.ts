import { parseConversationId } from '../../lib/ids.shared.ts'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord/context'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { AgentDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import { formatAgo } from '../../lib/format.shared.ts'
import { UserInputEvent } from '../../shared/events.ts'
import { git, isolatable } from '../../lib/git.ts'
import { meansNone } from '../../lib/errors.shared.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { SubagentsApi } from '../subagents/api.ts'
import { SubmissionLanded, WorkspacesApi } from '../workspaces/api.ts'
import { checkReview, reviewText } from './comments.shared.ts'
import { reviewDiff } from './diff.ts'
import { DiffAction, RangesAction, RecipientAction, SendAction } from './refs.ts'
import { ReviewCommentsEntry } from './entries.shared.ts'
import type { ReviewRange } from './refs.ts'

const index = (host: ExtensionHost, ctx: Context) =>
  host.harness().snapshot(host.need(WorkspacesApi).doc, ROOT_CONVERSATION_ID, ctx)

function conversationOf(value: unknown): ConversationId | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error('conversation must be a conversation id')
  return parseConversationId(value)
}

async function sourceCheckout(host: ExtensionHost, conversation?: ConversationId) {
  if (conversation === undefined) return host.projectRoot
  const workspace = (await index(host, context))?.items[String(conversation)]
  if (workspace?.state === 'ready') return workspace.path
  if (workspace?.source) return workspace.source
  const agent = await host.harness().snapshot(AgentDoc, conversation, context)
  return agent?.cwd || host.projectRoot
}

async function target(host: ExtensionHost, branch: string, cwd: string) {
  const items = Object.values((await index(host, context))?.items ?? {})
  const owned = items.find((item) => item.branch === branch)
  if (owned) return owned.target
  const project = await isolatable(host.projectRoot)
  if (!('reason' in project)) return project.target

  const on = await git(cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => '')
  if (on) return on
  throw new Error(project.reason)
}

async function resolveLandedBranch(host: ExtensionHost, cwd: string, spec: string) {
  if (!spec.startsWith('branch:')) return spec
  const branch = spec.slice('branch:'.length)
  const existingBranchRef = await git(
    cwd,
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `refs/heads/${branch}`,
  ).catch(() => '')
  if (existingBranchRef) return spec
  const doc = await index(host, context)
  const owner = Object.entries(doc?.items ?? {}).find(([, item]) => item.branch === branch)?.[0]
  const landed = Object.values(doc?.results ?? {}).findLast(
    (result) => result.outcome === 'landed' && String(result.conversationId) === owner,
  )
  if (landed?.base) return `${landed.base}...${landed.tip}`

  const [event] = await host.eventLog
    .recent({ events: [SubmissionLanded], limit: 200 })
    .then((landings) => landings.filter(({ data }) => String(data.conversationId) === owner))
  return event ? `${event.data.base}...${event.data.sha}` : 'uncommitted'
}

const agoFromEpochSeconds = (seconds: number) => formatAgo(seconds * 1000)

async function ranges(host: ExtensionHost, conversation?: ConversationId): Promise<ReviewRange[]> {
  const cwd = await sourceCheckout(host, conversation)
  const items = Object.entries((await index(host, context))?.items ?? {})
  const titles = new Map(host.conversations().map((item) => [item.id, item.title]))
  const liveWorktreeOwners = new Map(
    items
      .filter(([, item]) => item.state !== 'removed')
      .map(([id, item]) => [item.branch, parseConversationId(Number(id))]),
  )
  const [branches, commits, landings] = await Promise.all([
    git(
      cwd,
      'for-each-ref',
      '--sort=-committerdate',
      '--count=20',
      '--format=%(refname:short)%09%(committerdate:unix)',
      'refs/heads/ultimate/',
    ).catch(() => ''),
    git(cwd, 'log', '-n', '15', '--format=%H%x09%ct%x09%s').catch(() => ''),
    host.eventLog.recent({ events: [SubmissionLanded], limit: 10 }),
  ])
  const list: ReviewRange[] = [
    { spec: 'uncommitted', group: 'Working tree', label: 'Uncommitted changes' },
  ]
  for (const line of branches.split('\n').filter(Boolean)) {
    const [branch, at] = line.split('\t') as [string, string]
    const id = liveWorktreeOwners.get(branch)

    if (id === undefined) continue
    list.push({
      spec: `branch:${branch}`,
      group: 'Branches',
      label: titles.get(id) ?? `#${id}`,
      detail: `#${id} · ${agoFromEpochSeconds(Number(at))}`,
      conversation: id,
    })
  }
  for (const { data, at } of landings)
    list.push({
      spec: `${data.base}...${data.sha}`,
      group: 'Landings',
      label: data.feature ? `${data.feature} · ${data.title}` : data.title || data.sha.slice(0, 7),
      detail: `${data.sha.slice(0, 7)} · ${data.commitCount} commit${data.commitCount === 1 ? '' : 's'} · ${agoFromEpochSeconds(Date.parse(at) / 1000)}`,
      conversation: data.conversationId,
    })
  for (const line of commits.split('\n').filter(Boolean)) {
    const [sha, at, subject] = line.split('\t') as [string, string, string]
    list.push({
      spec: sha,
      group: 'Commits',
      label: subject,
      detail: `${sha.slice(0, 7)} · ${agoFromEpochSeconds(Number(at))}`,
    })
  }
  return list
}

const worktreeOf = (spec: string) => {
  const id = /^uncommitted:([1-9]\d*)$/.exec(spec.trim())?.[1]
  return id === undefined ? undefined : parseConversationId(Number(id))
}

const known = (host: ExtensionHost, id: ConversationId) =>
  host.conversations().some((conversation) => conversation.id === id)

async function recipient(host: ExtensionHost, spec: string, cwd: string): Promise<ConversationId> {
  const owner = async () => {
    const worktree = worktreeOf(spec)
    if (worktree !== undefined) return worktree
    if (spec.startsWith('branch:')) {
      const branch = spec.slice('branch:'.length)
      const items = Object.entries((await index(host, context))?.items ?? {})
      const id = Number(items.find(([, item]) => item.branch === branch)?.[0])
      return id ? parseConversationId(id) : undefined
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
    const id = Number(trailer.split('\n')[0])
    return id ? parseConversationId(id) : undefined
  }
  const found = await owner().catch(meansNone)
  if (found !== undefined && known(host, found)) return found
  return host.need(SubagentsApi).standing('ultimate', context)
}

export const userActions = ['send']

export const actions = {
  diff: implementAction(DiffAction, async (args, { host, signal }) => {
    const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
    if (typeof input.spec !== 'string') throw new Error('Expected { spec }')

    const worktree = worktreeOf(input.spec)
    const cwd = await sourceCheckout(host, worktree ?? conversationOf(input.conversation))
    const shown =
      worktree === undefined
        ? await resolveLandedBranch(host, cwd, input.spec.trim())
        : 'uncommitted'
    const diff = await reviewDiff(cwd, shown, {
      target: (branch) => target(host, branch, cwd),
      signal,
    })
    if (worktree !== undefined)
      return { ...diff, spec: input.spec, title: `Uncommitted changes in #${worktree}` }

    const branchGoneWithoutLanding = shown === 'uncommitted'
    return branchGoneWithoutLanding ? diff : { ...diff, spec: input.spec }
  }),
  ranges: implementAction(RangesAction, (args, { host }) => {
    const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
    return ranges(host, conversationOf(input.conversation))
  }),
  recipient: implementAction(RecipientAction, async (args, { host }) => {
    const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
    if (typeof input.spec !== 'string') throw new Error('Expected { spec }')
    const cwd = await sourceCheckout(host, conversationOf(input.conversation))
    return { conversation: await recipient(host, input.spec, cwd) }
  }),
  send: implementAction(SendAction, async (args, { host, device }) => {
    const value =
      args && typeof args === 'object' && !Array.isArray(args) ? args.conversation : undefined
    const id = typeof value === 'number' ? parseConversationId(value) : undefined
    if (id === undefined || !Number.isSafeInteger(id) || !known(host, id))
      throw new Error('conversation must be an existing conversation id')
    const review = checkReview(args)
    const conversation = await host.harness().conversation(id, context)
    if (!conversation) throw new Error(`No conversation #${id}`)
    const content = reviewText(review)
    const submission = await conversation.submit(
      {
        type: 'input',
        content,
        entry: { kind: ReviewCommentsEntry.kind, data: review },

        whenBusy: 'steer',
      },
      context,
    )

    const admittedInput = await submission.status(context)
    await host.harness().commit(
      (tx) =>
        host.emit(tx, UserInputEvent, {
          conversation: id,
          kind: 'review',
          ...(admittedInput.entry === undefined
            ? { submission: submission.id }
            : { entry: admittedInput.entry }),
          length: content.length,
          ...device,
        }),
      context,
    )
    return { conversation: id }
  }),
}

export default { name: 'review' }
