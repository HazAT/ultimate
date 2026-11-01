import type { Context } from '@earendil-works/chord'
import { Type } from '@earendil-works/pi-ai'
import type { Message } from '@earendil-works/pi-ai'
import {
  CompactionTask,
  defineDoc,
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, DocumentReader, JsonObject, Tx } from '@earendil-works/pi-durable'
import { readSettings, userSettingsPath } from '../../lib/settings.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { ContextUsageDoc } from '../conversations/api.ts'
import { CompactionPoint } from '../lineage/api.ts'
import { Standing } from '../subagents/api.ts'
import { EDITS_ENTRY, NUDGE_ENTRY, plan, renderIndex, TOOL } from './rows.ts'
import type { Compacted, Request } from './rows.ts'

/** The first nudge, and the distance between later ones, unless `compactInPlace` in settings says otherwise. */
export const NUDGE_AT = 200_000
export const NUDGE_EVERY = 100_000

/** `level`: the last nudge's step above `NUDGE_AT`; -1 or absent below it. */
export const Compact = defineDoc<{ level?: number }>({
  kind: 'compact.state',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
export const docs = [Compact]

type CompactHost = Pick<ExtensionHost, 'harness' | 'userHome' | 'projectSettings' | 'implement'>

/** `compactInPlace: { nudgeAt, nudgeEvery }` from the project's settings, else the user's, else the defaults. */
async function nudgeSettings(host: Pick<CompactHost, 'userHome' | 'projectSettings'>) {
  // Invalid settings JSON is reported where settings load; here it counts as unset.
  const user: JsonObject = await readSettings(userSettingsPath(host.userHome)).catch(() => ({}))
  const project = await host.projectSettings()
  const raw = (project.compactInPlace ?? user.compactInPlace) as JsonObject | undefined
  const positive = (value: unknown, fallback: number) =>
    typeof value === 'number' && value > 0 ? value : fallback
  return { at: positive(raw?.nudgeAt, NUDGE_AT), every: positive(raw?.nudgeEvery, NUDGE_EVERY) }
}

/** Whether `id` is @ultimate's conversation, the only one compacted in place. */
const isUltimate = async (read: DocumentReader, id: number, ctx: Context) =>
  (await read.snapshot(Standing, ROOT_CONVERSATION_ID, ctx))?.ultimate === id

async function liveSummary(tx: Tx, id: ConversationId) {
  for (const status of ['pending', 'running', 'waiting', 'completing'] as const)
    if (
      (await tx.scanTasks({ conversationId: id, kind: CompactionTask.definition.name, status }, 1))
        .items.length
    )
      return true
  return false
}

export function nudgeText(tokens: number, index: string): string {
  return `Context is ~${Math.round(tokens / 1000)}k tokens. Compact it in place now with compact_in_place: the index is below, so go straight to "compact" (or "skip" if nothing is worth compacting), then carry on with what you were doing.\n\n${index}`
}

/**
 * In-place compaction for @ultimate: the `compact_in_place` tool collapses older history into notes and trims old tool
 * outputs through context edits, nudges at context sizes ask for it, and Pi's summary compaction runs only when the
 * context overflows (or on request).
 */
export default function compact(host: CompactHost) {
  host.implement(CompactionPoint, {
    declines: async (id, reason, ctx) =>
      reason === 'threshold' && (await isUltimate(host.harness(), id, ctx)),
  })
  return defineExtension({
    name: 'compact',
    hooks: [
      hook(GenerationTask, {
        // A nudge lands after the request's cutoff, so this request gets the same message appended; later requests
        // read it from storage at that position, which keeps the prompt prefix cached.
        beforeRequest: async (request, api, ctx) => {
          const id = api.conversationId
          if (!(await isUltimate(api, id, ctx))) return undefined
          const tokens = (await api.snapshot(ContextUsageDoc, id, ctx))?.tokens
          if (!tokens) return undefined
          const { at, every } = await nudgeSettings(host)
          const level = tokens < at ? -1 : Math.floor((tokens - at) / every)
          const previous = (await api.snapshot(Compact, id, ctx))?.level ?? -1
          const view = await (await host.harness().conversation(id, ctx))!.context(ctx)
          if (level <= previous) {
            // Dropping below a level, after a compaction, arms its nudge again.
            if (level < previous)
              await host.harness().commit(async (tx) => {
                ;(await tx.doc(Compact, id)).level = level
              }, ctx)
            // A request resent after a restart has the cutoff it had before its nudge was placed: add it again. Only
            // hooks that run after this one (recall) append after it, so it lands where it is stored.
            const nudge = view.entries.findLast((entry) => entry.kind === NUDGE_ENTRY)?.model?.[0]
            const sent = (message: Message) =>
              message.role === 'user' &&
              message.timestamp === nudge?.timestamp &&
              message.content === nudge.content
            if (
              !nudge ||
              request.messages.length >= view.messages.length ||
              request.messages.some(sent) ||
              !view.messages.some(sent)
            )
              return undefined
            return { messages: [...request.messages, nudge] }
          }
          const message: Message = {
            role: 'user',
            content: nudgeText(tokens, renderIndex(view, id)),
            timestamp: Date.now(),
          }
          await host.harness().commit(async (tx) => {
            await tx.appendEntry(id, {
              kind: NUDGE_ENTRY,
              data: { tokens, level },
              model: [message],
            })
            ;(await tx.doc(Compact, id)).level = level
          }, ctx)
          return { messages: [...request.messages, message] }
        },
      }),
    ],
    tools: [
      defineTool({
        name: TOOL,
        deferred: true,
        description:
          'Compact your own context in place. Call with action "index" first: it lists the older messages and explains what to do (right after a nudge that carries the index, go straight to "compact"). Then call with action "compact" to collapse ranges of index rows into short notes and trim tool outputs you no longer need; the originals stay in storage. If nothing is worth compacting, call with action "skip": it compacts nothing but drops the nudges and earlier compact_in_place calls from your context.',
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal('index'),
            Type.Literal('compact'),
            Type.Literal('skip'),
          ]),
          trim: Type.Optional(
            Type.Array(Type.Integer(), {
              description: 'compact: ids of index rows whose tool outputs to trim',
            }),
          ),
          collapse: Type.Optional(
            Type.Array(
              Type.Object({
                from: Type.Integer(),
                to: Type.Integer(),
                note: Type.String({ description: 'what still matters from the range' }),
              }),
              { description: 'compact: ranges of index ids (inclusive) to replace with a note' },
            ),
          ),
        }),
        // A rerun finds the edits its first run committed, by call id, and reports them instead of compacting again.
        replay: 'safe',
        async execute(args, api, ctx) {
          const id = api.conversationId
          if (!(await isUltimate(api, id, ctx)))
            throw new Error(`${TOOL} compacts only the standing agent's conversation`)
          const conversation = (await host.harness().conversation(id, ctx))!
          const view = await conversation.context(ctx)
          if (args.action === 'index')
            return { output: [{ type: 'text', text: renderIndex(view, id, api.callId) }] }
          const done = await host.harness().commit((tx) => receipt(tx, id, api.callId), ctx)
          const planned = done ? undefined : plan(view, id, args as Request, api.callId)
          const tail = view.entries.at(-1)?.id ?? 0
          const result: Compacted = done ?? {
            action: args.action,
            before: planned!.before,
            after: planned!.after,
            collapsed: planned!.collapsed,
            trimmed: planned!.trimmed,
          }
          if (planned)
            await api.commit(async (tx) => {
              if (await liveSummary(tx, id))
                throw new Error('A summary compaction is running; nothing was compacted')
              const newer = (await tx.scanEntries({ conversationId: id }, 100)).items.filter(
                (entry) => entry.id > tail,
              )
              if (newer.some((entry) => entry.kind === EDITS_ENTRY || entry.head !== undefined))
                throw new Error(
                  'The context changed meanwhile; nothing was compacted. Call index again.',
                )
              await tx.appendEntry(id, {
                kind: EDITS_ENTRY,
                data: { call: api.callId, ...result },
                edits: planned.edits,
              })
            }, ctx)
          const text =
            result.action === 'skip'
              ? `Skipped; context ~${result.before} -> ~${result.after} tokens.`
              : `Compacted: ${result.collapsed.length} collapsed, ${result.trimmed.length} trimmed; context ~${result.before} -> ~${result.after} tokens.`
          return { output: [{ type: 'text', text }], details: result }
        },
      }),
    ],
  })
}

/** What call `call` already compacted, when a rerun finds its edits. */
async function receipt(tx: Tx, id: ConversationId, call: string) {
  for (const entry of (await tx.scanEntries({ conversationId: id }, 200)).items)
    if (entry.kind === EDITS_ENTRY && (entry.data as { call?: string }).call === call) {
      const { call: _, ...done } = entry.data as Compacted & { call: string }
      return done
    }
  return undefined
}
