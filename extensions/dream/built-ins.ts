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

export const AUTOMATION_NAME = 'Dream before compaction'
export const CONDITION = { metric: 'context' as const, of: '@ultimate', above: 70 }
export const PAUSE_NAME = 'Dream after a pause'
const IDLE_WITH_RENEWED_KEEP_WARM_CACHE_MS = 8 * 3600_000
export const PAUSE_CONDITION = {
  metric: 'context' as const,
  of: '@ultimate',
  above: 50,
  idleFor: IDLE_WITH_RENEWED_KEEP_WARM_CACHE_MS,
}
function discardLegacySeedDeletion(value: unknown) {
  const { id } = value as { id?: string }
  return id === undefined ? {} : { id }
}

export const BuiltInDoc = defineDoc<{ id?: string; deleted?: true }>({
  kind: 'dream.after-compaction',
  checkpointWhen: () => false,
  version: 2,
  migrate: discardLegacySeedDeletion,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

export const PauseDoc = defineDoc<{ id?: string; deleted?: true }>({
  kind: 'dream.after-pause',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

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

export const hoursOf = (ms: number) => `${Math.round(ms / 3600_000)} h`

export const DREAM_ASK =
  'Dream now: follow "For @ultimate" in the clone\'s extensions/dream/DREAM.md. Write your handoff into the dream branch\'s prompt in this turn, while your context still holds everything, and start that branch. If a dream branch is already running, say so in one line and do nothing else.'

export async function ensureAutomation(host: ExtensionHost) {
  if (!host.extensions().some((item) => item.name === 'automations' && item.enabled)) return
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
  const deletedInPreviousChapter = !state?.id && carried === null
  if (deletedInPreviousChapter) return remember({ deleted: true })
  const signal = new AbortController().signal
  if (state?.id) {
    const list = (await host.invoke('automations', 'list', null, signal)) as Automation[]
    const deletedByUser = !list.some((item) => item.id === state.id)
    if (deletedByUser) return remember({ deleted: true })
    return
  }
  const ultimate = (await harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))?.ultimate
  if (ultimate === undefined) return
  const createdOrRecoveredByKey = (await host.invoke(
    'automations',
    'create',
    { name, condition, subscribers: ['@ultimate'], key: `dream:${doc.definition.kind}` },
    signal,
  )) as Automation
  if (carried?.enabled === false && createdOrRecoveredByKey.enabled)
    await host.need(AutomationsApi).pause(createdOrRecoveredByKey.id)
  await remember({ id: createdOrRecoveredByKey.id })
}

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
