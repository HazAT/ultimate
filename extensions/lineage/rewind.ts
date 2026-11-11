/**
 * Going back to an entry in place: everything after it leaves the model's context through omit edits on one note entry,
 * which says what changed in the checkout since (and, when asked, summarizes the set-aside path). The conversation keeps
 * its id, its checkout and its files; nothing runs until the next input. Entries up to the point keep their exact
 * contributions, so the next request repeats the old prefix and a warm provider cache can hit.
 */
import type { Context } from '@earendil-works/chord/context'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { Message } from '@earendil-works/pi-ai'
import { serializeConversation } from '@earendil-works/pi-coding-agent'
import {
  AgentDoc,
  defineTask,
  InboxDoc,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ContextEdit, ConversationId, Cursor, EntryId, Tx } from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import type { ActionInput } from '../../lib/actions.ts'
import { git } from '../../lib/git.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { defineEvent } from '../../shared/events.ts'
import { Committed } from '../coding-tools/api.ts'
import { ConversationsApi } from '../conversations/api.ts'
import type { ResponseReceipt } from '../conversations/summary.ts'
import type { SummaryModel } from '../conversations/summary-model.ts'
import { Started } from '../subagents/api.ts'
import { isAbsolute, relative } from 'node:path'
import { getOrThrow } from '@earendil-works/pi-durable/env'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import type { JsonValue } from '@earendil-works/chord/json'
import type { EventData, EventRecord, EventToken } from '../../shared/events.ts'
import { WorkspacesApi } from '../workspaces/api.ts'
import { Roots } from './api.ts'
import { RewindAction, RewindPreviewAction, Rewound } from './refs.ts'
import type { RewindDependent, RewindFile } from './refs.ts'

type View = {
  entries: readonly { id: number; kind: string }[]
  contributions: readonly (readonly Message[])[]
}
type Facts = {
  files: RewindFile[]
  commits: { sha: string; subject: string }[]
  dependents: RewindDependent[]
}
/** The facts and the context revision they were gathered against: the newest entry the model saw then. */
type Gathered = { revision: number | null; facts: Facts }

/**
 * Messages’ `board.sent`, read by kind: messages depends on lineage, so lineage importing Messages’ token would close a cycle.
 * Only the fields read here; Messages’ refs.ts owns the full shape.
 */
const MessageSent = defineEvent<{ from: number | 'user'; to: number | 'user' }>('board.sent')

/** How many events a go-back reads from the log per page. */
const EVENTS = 5000

const SUMMARY_SYSTEM =
  'Summarize the part of a coding conversation the user set aside by going back to an earlier point. The agent will continue from that earlier point and reads this summary instead. In short Markdown bullets: what was tried, decided and achieved, what is unfinished. Preserve exact file paths, names and errors. Do not continue the conversation; output only the summary.'

/** Why conversation `id` cannot go back to entry `at` now, inside `tx` before its first table write; undefined when it can. */
export async function refusal(tx: Tx, id: ConversationId, at: number) {
  if (!(await tx.conversation(id))) return `No conversation #${id}`
  if ((await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots.includes(id))
    return "Roots can't go back: a root's context is its tally."
  const found = await tx.scanEntries(
    { conversationId: id, minEntryId: at as EntryId, maxEntryId: at as EntryId },
    1,
  )
  if (!found.items.length) return `Entry ${at} is not in #${id}`
  const live = await tx.doc(LiveDoc, id)
  if (live.run || (await tx.doc(InboxDoc, id)).items.length)
    return `#${id} is busy: stop it or wait until it is idle, then go back.`
  // A compaction placed after the go-back would summarize the set-aside path back into the context.
  if (live.compactions?.length) return `#${id} is compacting: wait until it finishes, then go back.`
  const marker = await tx.latestHeadMarker(id)
  if (marker && marker.id > at)
    return `#${id} was compacted after this point; it can't go back past a compaction.`
  return undefined
}

const json = (messages: readonly Message[] | undefined) => JSON.stringify(messages ?? [])

/**
 * The edits that make `current` contribute what `past` (the context as of entry `at`) did: every entry after `at` that
 * still contributes is omitted, and an entry up to `at` that an earlier go-back changed gets its old messages back.
 * `steps` counts the entries set aside with messages other than system prompt changes: inputs, answers, tool calls and
 * results, notes.
 */
export function rewindPlan(current: View, past: View, at: number) {
  const before = new Map(past.entries.map((entry, index) => [entry.id, past.contributions[index]]))
  const edits: ContextEdit[] = []
  let steps = 0
  current.entries.forEach((entry, index) => {
    const now = current.contributions[index]
    if (entry.id > at) {
      if (!now.length) return
      edits.push({ target: entry.id as EntryId, action: 'omit' })
      if (now.some((message) => message.role !== 'system')) steps++
      return
    }
    const then = before.get(entry.id)
    if (json(now) === json(then)) return
    edits.push(
      then?.length
        ? { target: entry.id as EntryId, action: 'replace', messages: [...then] }
        : { target: entry.id as EntryId, action: 'omit' },
    )
  })
  return { edits, steps }
}

const rows = (text: string) => text.split('\n').filter(Boolean)

// Pi upstream: @earendil-works/pi-durable@1.5.2 src/tools/path-utils.ts — copied unexported normalizeToolPath (unicode spaces, leading @), which edit and write apply before env.absolutePath. Drop when Pi exports resolveToolPath's normalization.
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g
function normalizeToolPath(path: string) {
  const normalized = path.replace(UNICODE_SPACES, ' ')
  return normalized.startsWith('@') ? normalized.slice(1) : normalized
}

/**
 * The paths the edit and write calls among `messages` touched, resolved as those tools resolve them in `cwd` (`~`, a
 * leading `@`, `file://`): relative to `top` inside the checkout, absolute in `outside` otherwise.
 */
export async function editedPaths(
  messages: readonly Message[],
  cwd: string,
  top: string,
  ctx: Context,
) {
  const env = new NodeExecutionEnv({ cwd })
  const inside = new Set<string>()
  const outside = new Set<string>()
  for (const message of messages)
    if (message.role === 'assistant')
      for (const block of message.content)
        if (
          block.type === 'toolCall' &&
          (block.name === 'edit' || block.name === 'write') &&
          typeof block.arguments.path === 'string'
        ) {
          const path = getOrThrow(
            await env.absolutePath(normalizeToolPath(block.arguments.path), ctx),
          )
          const local = relative(top, path)
          if (local && !local.startsWith('..') && !isAbsolute(local)) inside.add(local)
          else outside.add(path)
        }
  return { inside, outside }
}

/**
 * `paths` (relative to the checkout `top`) as they are now: lines added and removed since `base` (HEAD without one;
 * none in a repository without a commit), new and untracked, or neither when Git shows no difference to count.
 */
async function fileStates(top: string, paths: ReadonlySet<string>, base: string | undefined) {
  if (!paths.size) return []
  const listed = [...paths]
  const head = await git(top, 'rev-parse', '--verify', '--quiet', 'HEAD').catch(
    // A repository before its first commit has no HEAD to count lines against.
    () => undefined,
  )
  const counts = new Map<string, { added: number; removed: number }>()
  if (head)
    for (const line of rows(
      await git(top, 'diff', '--numstat', '--no-renames', base ?? 'HEAD', '--', ...listed),
    )) {
      // Binary files count `-` lines.
      const [added, removed, path] = line.split('\t')
      counts.set(path, { added: Number(added) || 0, removed: Number(removed) || 0 })
    }
  const untracked = new Set(
    rows(await git(top, 'ls-files', '--others', '--exclude-standard', '--', ...listed)),
  )
  return listed.map((path): RewindFile => {
    if (untracked.has(path)) return { path, untracked: true }
    return { path, ...counts.get(path) }
  })
}

/**
 * What happened in `id`'s checkout and tree after entry `at`. Entry and event ids share one sequence, so an event after
 * the entry has a larger id. Its commits since; the files the set-aside path touched (the commits' files, and what its
 * edit and write calls named in every stored entry after `at`), counted against the checkout's tip at `at` (its newest commit before, else
 * the parent of its first after, else its worktree's base), so changes from before the entry stay out; and the
 * conversations it started or messaged since.
 */
async function facts(host: ExtensionHost, id: ConversationId, at: number, ctx: Context) {
  /** Every event of `token` after entry `at`, oldest first: the log pages by id, so no window cuts it short. */
  const since = async <D extends JsonValue>(token: EventToken<D>) => {
    const found: EventRecord<D>[] = []
    for (let after = at; ;) {
      const page = await host.eventLog.recent({
        events: [token],
        since: after,
        order: 'ascending',
        limit: EVENTS,
      })
      found.push(...page)
      if (page.length < EVENTS) return found
      after = page.at(-1)!.id
    }
  }
  const own = (data: { conversation?: number; parent?: number }) =>
    data.conversation === id || data.parent === id
  const cwd = (await host.harness().snapshot(AgentDoc, id, ctx))?.cwd ?? host.projectRoot
  const top = await git(cwd, 'rev-parse', '--show-toplevel').catch(
    // Outside a repository no commit is this checkout's.
    () => undefined,
  )
  // Only commits made in this checkout: a command may commit in another repository.
  const here = (data: { conversation: number; repo: string; worktree?: string }) =>
    own(data) && (data.worktree ?? data.repo) === top
  const after = (await since(Committed)).filter((event) => here(event.data))
  let before: EventRecord<EventData<typeof Committed>> | undefined
  for (let until = at + 1; !before;) {
    const page = await host.eventLog.recent({ events: [Committed], before: until, limit: EVENTS })
    before = page.find((event) => here(event.data))
    if (page.length < EVENTS) break
    until = page.at(-1)!.id
  }
  const base =
    before?.data.sha ??
    after[0]?.data.parents[0] ??
    (await host.need(WorkspacesApi).get(id, ctx))?.base
  // Every stored entry after the point, also ones an earlier go-back set aside: their writes are still on disk.
  const conversation = (await host.harness().conversation(id, ctx))!
  const written: Message[] = []
  let cursor: Cursor | undefined
  do {
    const page = await conversation.entries(
      { minEntryId: (at + 1) as EntryId, order: 'ascending' },
      256,
      cursor,
      ctx,
    )
    for (const entry of page.items) written.push(...(entry.model ?? []))
    cursor = page.next
  } while (cursor)
  const edited = top
    ? await editedPaths(written, cwd, top, ctx)
    : { inside: new Set<string>(), outside: new Set<string>() }
  const paths = edited.inside
  if (top)
    for (const { data } of after)
      for (const path of rows(
        // A merge lists its changes against its first parent; a root commit against nothing.
        await git(
          top,
          'diff-tree',
          '-r',
          '--no-commit-id',
          '--name-only',
          '--root',
          '--diff-merges=first-parent',
          data.sha,
        ).catch(
          // A commit an amend or rebase dropped may be gone; its files show through the other commits and edits.
          () => '',
        ),
      ))
        paths.add(path)
  const files = [
    ...(top ? await fileStates(top, paths, base) : []),
    // Git cannot count a file outside the checkout: it is listed as changed.
    ...[...edited.outside].map((path): RewindFile => ({ path, outside: true })),
  ]
  const dependents = new Map<number, RewindDependent>()
  for (const event of await since(Started))
    if (own(event.data) && event.data.kind !== 'standing' && event.data.id !== id)
      dependents.set(event.data.id, {
        id: event.data.id,
        via: event.data.kind === 'branch' ? 'branch' : 'subagent',
      })
  for (const { data } of await since(MessageSent))
    if (
      data.from === id &&
      typeof data.to === 'number' &&
      data.to !== id &&
      !dependents.has(data.to)
    )
      dependents.set(data.to, { id: data.to, via: 'message' })
  return {
    files,
    commits: after.map((event) => ({ sha: event.data.sha, subject: event.data.subject })),
    dependents: [...dependents.values()],
  } satisfies Facts
}

/** The note the model reads after going back to `#id/at`. */
export function noteText(id: number, at: number, found: Facts, summary?: string) {
  const lines = [
    `You went back to #${id}/${at}. What came after it is set aside: it is no longer in your context.`,
  ]
  if (summary) lines.push('', 'Summary of the set-aside path:', summary)
  lines.push('')
  if (found.files.length)
    lines.push(
      'Since then these files changed in your worktree:',
      ...found.files.map(
        (file) =>
          `- ${file.path} ${file.outside ? '(changed, outside the checkout)' : file.untracked ? '(new, untracked)' : file.added === undefined ? '(changed)' : `(+${file.added} −${file.removed})`}`,
      ),
    )
  else lines.push('Your worktree has no changes since then.')
  if (found.commits.length)
    lines.push(
      `Commits since: ${found.commits.map((commit) => `${commit.sha.slice(0, 7)} ${commit.subject}`).join('; ')}`,
    )
  if (found.files.length || found.commits.length)
    lines.push("They're still there; decide whether to keep or undo them.")
  if (found.dependents.length)
    lines.push(
      '',
      `Built on the set-aside path and still running on their own: ${found.dependents.map((dependent) => `#${dependent.id}`).join(', ')}.`,
    )
  return lines.join('\n')
}

/**
 * The views a go-back compares: the context now and as of entry `at`, the plan between them, the messages it sets
 * aside, and the revision: the newest entry of the context now.
 */
async function views(host: ExtensionHost, id: ConversationId, at: number, ctx: Context) {
  const conversation = (await host.harness().conversation(id, ctx))!
  const current = await conversation.context(ctx)
  const past = await conversation.context(ctx, { at: at as EntryId })
  const setAside = current.entries.flatMap((entry, index) =>
    entry.id > at
      ? current.contributions[index].filter((message) => message.role !== 'system')
      : [],
  )
  const revision = (current.entries.at(-1)?.id as number | undefined) ?? null
  return { current, past, plan: rewindPlan(current, past, at), setAside, revision }
}

/**
 * Why the context moved past `revision`: an entry after it that changes what the model sees (a turn, a note, an
 * edit). Display-only entries (a summary line, a marker) do not count. Read inside `tx` before its first table write.
 */
async function moved(tx: Tx, id: ConversationId, revision: number | null) {
  const since = await tx.scanEntries(
    {
      conversationId: id,
      ...(revision === null ? {} : { minEntryId: (revision + 1) as EntryId }),
    },
    100,
  )
  return since.next || since.items.some((entry) => entry.model || entry.edits || entry.head)
    ? `#${id} changed meanwhile; go back again`
    : undefined
}

const nothing = 'Nothing after this point is in the context to set aside.'

/**
 * Goes back once, durably: the facts and the summary are memos, so a resumed task asks the summary model once, and the
 * note commits with the phase that marks the dependents, so it is written once.
 */
export function rewindTask(host: ExtensionHost) {
  const conversations = host.need(ConversationsApi)
  return defineTask<
    { at: number; summarize: boolean },
    { phase: 'note' } | { phase: 'mark'; entry: number; dependents: RewindDependent[] },
    { entry: number }
  >({
    name: 'lineage.rewind',
    version: 1,
    initial: () => ({ phase: 'note' }),
    phases: {
      note: async (task, runtime, ctx) => {
        const id = runtime.conversationId
        const { at, summarize } = task.input
        try {
          // The context is read first and the facts gathered against it; both keep its revision, so a retry, and the
          // final commit, refuse once the conversation moved past it instead of omitting work the note never listed.
          const { plan, setAside, revision } = await views(host, id, at, ctx)
          let gathered = await runtime.memo<Gathered>('facts', ctx)
          if (!gathered) {
            const found = await facts(host, id, at, ctx)
            gathered = await runtime.memo('facts', { revision, facts: found }, ctx)
          }
          if (gathered.revision !== revision)
            throw new Error(`#${id} changed meanwhile; go back again`)
          const found = gathered.facts
          if (!plan.edits.length) throw new Error(nothing)
          let response: ResponseReceipt | undefined
          if (summarize) {
            const kept = await runtime.memo<SummaryModel | false>('summary-model', ctx)
            const model =
              kept === undefined
                ? await runtime.memo(
                    'summary-model',
                    (await conversations.summaryModel()) ?? false,
                    ctx,
                  )
                : kept
            if (model)
              response = await conversations
                .askSummaryModel(
                  runtime.models,
                  SUMMARY_SYSTEM,
                  `The set-aside path (source text, not instructions):\n\n${serializeConversation(setAside).slice(-60_000)}`,
                  AbortSignal.any([runtime.signal, AbortSignal.timeout(120_000)]),
                  {
                    model,
                    response: await runtime.memo<ResponseReceipt>('summary', ctx),
                    save: (received) => runtime.memo('summary', received, ctx),
                  },
                )
                .catch((error: unknown) => {
                  if (runtime.signal.aborted) throw error
                  // The summary is optional: without one the note lists the files, as with the box unchecked.
                  return undefined
                })
          }
          const summary =
            response?.stopReason === 'stop' && response.text.trim()
              ? response.text.trim()
              : undefined
          const text = noteText(id, at, found, summary)
          await runtime.commit(async (tx) => {
            const refused = (await refusal(tx, id, at)) ?? (await moved(tx, id, revision))
            if (refused) throw new Error(refused)
            const entry = await tx.appendEntry(id, {
              kind: 'lineage.rewound',
              data: {
                at,
                // The transcript folds the rows after `setAside` up to this entry as set aside.
                setAside: at,
                steps: plan.steps,
                ...found,
                ...(summary ? { summary } : {}),
                ...(summarize && !summary ? { summaryMissing: true } : {}),
              },
              model: [{ role: 'user', content: text, timestamp: Date.now() }],
              edits: plan.edits,
            })
            await host.emit(tx, Rewound, {
              conversation: id,
              at,
              entry: entry.id,
              dependents: found.dependents.map((dependent) => dependent.id),
            })
            await conversations.accountResponse(tx, id, response)
            return {
              status: 'running',
              checkpoint: { phase: 'mark', entry: entry.id, dependents: found.dependents },
            }
          }, ctx)
        } catch (error) {
          if (runtime.signal.aborted) throw error
          await runtime.commit(
            () => ({
              status: 'terminal',
              outcome: {
                status: 'failed',
                error: { message: error instanceof Error ? error.message : String(error) },
              },
            }),
            ctx,
          )
        }
      },
      mark: async (task, runtime, ctx) => {
        const { entry, dependents } = task.state.checkpoint as {
          entry: number
          dependents: RewindDependent[]
        }
        const id = runtime.conversationId
        // A display-only write lands at once, also in a running conversation; its request id writes it once.
        for (const dependent of dependents)
          await (
            await host.harness().conversation(dependent.id as ConversationId, ctx)
          )?.submit(
            {
              type: 'write',
              requestId: `lineage:rewound:${entry}`,
              entry: {
                kind: 'lineage.rewound-dependent',
                data: { from: id, at: task.input.at, entry, via: dependent.via },
              },
            },
            ctx,
          )
        await runtime.commit(
          () => ({ status: 'terminal', outcome: { status: 'completed', result: { entry } } }),
          ctx,
        )
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })
}

function point(args: ActionInput<{ conversation: number; at: number }>) {
  const input = (args && typeof args === 'object' && !Array.isArray(args) ? args : {}) as {
    conversation?: unknown
    at?: unknown
  }
  for (const key of ['conversation', 'at'] as const) {
    const value = input[key]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
      throw new Error(`${key} must be a positive integer`)
  }
  return { id: input.conversation as ConversationId, at: input.at as number }
}

export const rewindActions = {
  /** What going back would set aside and leave in the checkout, or why it cannot now. */
  rewindPreview: implementAction(RewindPreviewAction, async (args, { host }) => {
    const { id, at } = point(args)
    const summaryModel = !!(await host.need(ConversationsApi).summaryModel())
    const empty = { steps: 0, files: [], commits: [], dependents: [], summaryModel }
    const refused = await host.harness().commit((tx) => refusal(tx, id, at), context)
    if (refused) return { ...empty, refused }
    const { plan } = await views(host, id, at, context)
    if (!plan.edits.length) return { ...empty, refused: nothing }
    return { ...(await facts(host, id, at, context)), steps: plan.steps, summaryModel }
  }),
  /** Go back to `at` in place; resolves once the note is written, or rejects with why it could not. */
  rewind: implementAction(RewindAction, async (args, { host }) => {
    const { id, at } = point(args)
    const summarize = (args as { summarize?: unknown }).summarize === true
    const task = await host.harness().commit(async (tx) => {
      const refused = await refusal(tx, id, at)
      if (refused) throw new Error(refused)
      return tx.createTask(
        rewindTask(host),
        { at, summarize },
        { conversationId: id, ownership: { kind: 'conversation' }, background: false },
      )
    }, context)
    host.harness().resume()
    const { outcome } = (await host.harness().waitForTask(task, context)).state
    if (outcome.status === 'completed') return outcome.result
    throw new Error(outcome.status === 'failed' ? outcome.error.message : 'Going back stopped')
  }),
}
