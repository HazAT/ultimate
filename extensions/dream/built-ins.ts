/**
 * The two built-in dream triggers, ordinary context automations that wake @ultimate: "Dream before compaction" when its
 * context passes 70%, and "Dream after a pause" at 50% once the user has been away 8 hours. Dream makes each once per
 * chapter, so the user sees them in the Automations panel and can pause, delete or re-threshold them like any other;
 * a new chapter makes them again as the seed carried them. A fire leaves a `dream.requested` entry beside the
 * automation's own wake-up, which says what a dream is and where its workflow lives.
 */
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { Tx } from '@earendil-works/pi-durable'
import { join } from 'node:path'
import { readJson } from '../../lib/json-file.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { AutomationsApi } from '../automations/api.ts'
import type { Automation } from '../automations/refs.ts'
import { Standing } from '../subagents/api.ts'
import { deliver } from './delivery.ts'
import type { RequestedEntry } from './refs.ts'
import type { Seed } from './types.ts'

/** The built-in automation's name, shown in the Automations panel. */
export const AUTOMATION_NAME = 'Dream before compaction'
/** Its trigger as dream first makes it; the user may change the threshold. */
export const CONDITION = { metric: 'context' as const, of: '@ultimate', above: 70 }
/**
 * The second built-in: after a long pause with @ultimate half full, dream while the user is away. At 8 hours keep-warm
 * has just renewed the prompt cache, so the dream's handoff reads it instead of rewriting it.
 */
export const PAUSE_NAME = 'Dream after a pause'
export const PAUSE_CONDITION = {
  metric: 'context' as const,
  of: '@ultimate',
  above: 50,
  idleFor: 8 * 3600_000,
}

/**
 * The built-in automation dream created in this chapter, by id; `deleted` once the user deleted it, so it is not made
 * again. On conversation 1 of each chapter. The kind keeps its first name.
 */
export const BuiltInDoc = defineDoc<{ id?: string; deleted?: true }>({
  kind: 'dream.after-compaction',
  checkpointWhen: () => false,
  // Version 1 read a seed from before this feature as "deleted": a deletion it recorded was never the user's.
  version: 2,
  migrate: (value) => {
    const { id } = value as { id?: string }
    return id === undefined ? {} : { id }
  },
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

/** The pause built-in's id and deletion, as `BuiltInDoc` keeps the first one's. */
export const PauseDoc = defineDoc<{ id?: string; deleted?: true }>({
  kind: 'dream.after-pause',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

/** One built-in automation: where its id is kept, how it is made, and its state in a chapter's seed. */
type BuiltIn = {
  doc: typeof BuiltInDoc
  name: string
  condition: typeof CONDITION | typeof PAUSE_CONDITION
  seed: (seed: Seed | undefined) => Seed['builtIn']
}
const BUILT_INS: BuiltIn[] = [
  { doc: BuiltInDoc, name: AUTOMATION_NAME, condition: CONDITION, seed: (seed) => seed?.builtIn },
  {
    doc: PauseDoc,
    name: PAUSE_NAME,
    condition: PAUSE_CONDITION,
    seed: (seed) => seed?.builtInPause,
  },
]

/** A pause in whole hours, as the prompts say it: `9 h`. */
export const hoursOf = (ms: number) => `${Math.round(ms / 3600_000)} h`

/** What @ultimate reads when a dream is asked for, by the user or a built-in automation. */
export const DREAM_ASK =
  'Dream now: follow "For @ultimate" in the clone\'s extensions/dream/DREAM.md. Write your handoff into the dream branch\'s prompt in this turn, while your context still holds everything, and start that branch. If a dream branch is already running, say so in one line and do nothing else.'

/**
 * Make sure this chapter has both built-in automations, unless the user deleted one. A new chapter makes each as its
 * seed carried it: paused stays paused, and one deleted before the switch is not made again.
 */
export async function ensureAutomation(host: ExtensionHost) {
  if (!host.extensions().some((item) => item.name === 'automations' && item.enabled)) return
  // Every caller reads the chapter's own seed, so whichever runs first keeps its paused or deleted automation so.
  const seed = await readJson<Seed | undefined>(join(host.chapter.dir, 'seed.json'), undefined)
  for (const builtIn of BUILT_INS) await ensureOne(host, builtIn, seed)
}

async function ensureOne(host: ExtensionHost, builtIn: BuiltIn, seed: Seed | undefined) {
  const { doc, name, condition } = builtIn
  const carried = builtIn.seed(seed)
  const harness = host.harness()
  const state = await harness.snapshot(doc, ROOT_CONVERSATION_ID, context)
  if (state?.deleted) return
  const remember = (change: { id?: string; deleted?: true }) =>
    harness.commit(async (tx) => {
      Object.assign(await tx.doc(doc, ROOT_CONVERSATION_ID), change)
    }, context)
  if (!state?.id && carried === null) return remember({ deleted: true })
  const signal = new AbortController().signal
  if (state?.id) {
    // Session-scoped ledger: its list action reads it, as the seed does.
    const list = (await host.invoke('automations', 'list', null, signal)) as Automation[]
    // Gone from the list: the user deleted it, and that choice holds.
    if (!list.some((item) => item.id === state.id)) return remember({ deleted: true })
    return
  }
  // Never made here: on a fresh project the automation follows @ultimate's start.
  const ultimate = (await harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))?.ultimate
  if (ultimate === undefined) return
  // A create whose receipt was lost gets the automation it made back from its key, not a second one.
  const created = (await host.invoke(
    'automations',
    'create',
    { name, condition, subscribers: ['@ultimate'], key: `dream:${doc.definition.kind}` },
    signal,
  )) as Automation
  if (carried?.enabled === false && created.enabled)
    await host.need(AutomationsApi).pause(created.id)
  await remember({ id: created.id })
}

/**
 * Inside `tx`: a fire of automation `id`, when it is one of dream's built-ins, leaves @ultimate a passive
 * `dream.requested` entry that its fire's own wake-up reads. `fire` keys the request, so a replay writes it once.
 */
export async function fired(host: ExtensionHost, tx: Tx, id: string, fire: number) {
  let builtIn: BuiltIn | undefined
  for (const item of BUILT_INS)
    if ((await tx.doc(item.doc, ROOT_CONVERSATION_ID)).id === id) builtIn = item
  const ultimate = (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate
  if (!builtIn || ultimate === undefined) return
  const automation = await host.need(AutomationsApi).read(tx, id)
  const condition = automation?.condition
  const pause =
    builtIn.doc === PauseDoc && condition && automation
      ? Date.now() - (condition.inputAt ?? automation.createdAt)
      : undefined
  const data: RequestedEntry = {
    automation: {
      id,
      name: automation?.name ?? builtIn.name,
      ...(pause !== undefined ? { pause } : {}),
    },
  }
  await deliver(host, tx, ultimate, {
    type: 'write',
    requestId: `dream.requested:${id}:${fire}`,
    kind: 'dream.requested',
    data,
    content: `Your context passed the threshold of automation ${id} "${data.automation!.name}"${pause !== undefined ? ` while the user has been away ${hoursOf(pause)}` : ''}. ${DREAM_ASK}`,
  })
}
