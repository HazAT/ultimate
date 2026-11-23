import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { apply } from '@earendil-works/chord/delta'
import { defineExtension, UsageDoc } from '@earendil-works/pi-durable'
import type {
  CommitPublication,
  ConversationId,
  Cursor,
  EntryId,
  Harness,
} from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { meansNone, rebuiltOnOpen } from '../../lib/errors.ts'
import { batch, deadline } from '../../lib/timers.ts'
import type { Cancel } from '../../lib/timers.ts'
import {
  earlier,
  emptyHistory,
  HISTORY_FILE,
  historyOf,
  loadHistory,
  replaceChapter,
  saveHistory,
} from './history.ts'
import type { Origin } from './history.ts'
import { chaptersToImport, readChapter } from './import.ts'
import { advance, createState, overheadRows, usageTotal } from './model/rows.ts'
import type { RowState, UsageLike } from './model/rows.ts'
import type { Conversation, Price, Row, Snapshot, SnapshotArgs } from './model/types.ts'

export const COALESCE_MS = 2000
export const SAVE_MS = 60_000
const PROFILE = 'ultimate.agent-profile'
const FAMILY = 'models.family'
const CONCLUDED = 'ext.conversations.concluded'
const ROOT = 1

type Summary = {
  id: number
  parentConversationId?: number
  branchOf?: { conversationId: number }
  label?: string
  title?: string
  busy: boolean
}
type ModelInfo = { provider: string; id: string; cost?: Partial<Price> }

type Live = {
  state: RowState
  usage: UsageLike | null
  overhead: Row[]
  owner?: number
  parent?: number
  definition?: string
  family: string | null
}

const snapshots = new WeakMap<object, (asked: SnapshotArgs) => Promise<Snapshot | null>>()
export const actions = {
  async snapshot(args: unknown, { host }: { host: object }): Promise<Snapshot | null> {
    const held = args as { version?: unknown; epoch?: unknown } | null
    if (held !== null && (typeof held?.version !== 'number' || typeof held?.epoch !== 'string'))
      throw new Error('the version held is { version: number, epoch: string }')
    const read = snapshots.get(host)
    if (!read) throw new Error('Spend is not open yet')
    return read(held ? { version: held.version as number, epoch: held.epoch as string } : null)
  },
}
export const pollActions = ['snapshot']

export function describe(
  id: number,
  live: Pick<Live, 'owner' | 'parent' | 'definition' | 'family' | 'usage'>,
  summary: Summary | undefined,
  concluded: ReadonlySet<number>,
): Omit<Conversation, 'root'> {
  const label = summary?.label
  return {
    id,
    title: summary?.title || (id === ROOT ? '@ultimate' : `#${id}`),
    agent: live.definition || label?.split(' · ')[0] || (id === ROOT ? 'ultimate' : 'agent'),
    ...(label ? { label } : {}),
    family: live.family,
    ...(live.owner !== undefined ? { owner: live.owner } : {}),
    ...(live.parent !== undefined ? { parent: live.parent } : {}),
    busy: summary?.busy ?? false,
    concluded: concluded.has(id),
    usage: usageTotal(live.usage),
    live: true,
  }
}

export function withRoots(conversations: Omit<Conversation, 'root'>[]): Conversation[] {
  const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]))
  const rootOf = (id: number) => {
    const seen = new Set<number>()
    let at = byId.get(id)
    while (at && !seen.has(at.id)) {
      seen.add(at.id)
      const up = at.owner ?? at.parent
      if (up === undefined || !byId.has(up)) return up ?? at.id
      at = byId.get(up)
    }
    return at?.id ?? id
  }
  return conversations.map((conversation) => ({ ...conversation, root: rootOf(conversation.id) }))
}

const pricesOf = (models: ModelInfo[]) => {
  const prices: Record<string, Price> = {}
  for (const model of models)
    if (model.cost)
      prices[`${model.provider}/${model.id}`] = {
        input: model.cost.input ?? 0,
        output: model.cost.output ?? 0,
        cacheRead: model.cost.cacheRead ?? 0,
        cacheWrite: model.cost.cacheWrite ?? 0,
      }
  return prices
}

export default function costs(host: ExtensionHost) {
  const path = join(host.home, HISTORY_FILE)
  let epoch = 0
  let stopObserving: (() => void) | undefined
  let opened: Promise<void> | undefined
  let lives = new Map<number, Live>()
  let past: { conversations: Conversation[]; rows: Map<number, Row[]> } = {
    conversations: [],
    rows: new Map(),
  }
  let chapter = ''
  let origin = new Map<number, Origin>()
  let prices: Record<string, Price> = {}
  let pricedKeys = new Set<string>()
  let ready = false
  let profiles = new Map<number, string | undefined>()
  let families = new Map<number, string | null>()
  let usages = new Map<number, UsageLike | null>()
  const coalescedReads = new Map<number, ReturnType<typeof batch>>()
  const queues = new Map<number, Promise<void>>()
  let canSave = true
  let initialized = false
  let failure: unknown
  let saveDeadline: Cancel | undefined
  let lastSave = 0
  let version = Date.now()
  const instance = randomUUID()
  let versions = new Map<number, number>()
  let keys = new Map<number, string>()
  const dirty = new Set<number>()
  let pricesKey = ''
  let since: number | null = null
  let summaries = new Map<number, Summary>()
  let concluded = new Set<number>()

  const changed = (id?: number) => {
    if (id !== undefined) dirty.add(id)
    scheduleSave()
  }
  const scheduleSave = () => {
    if (!canSave || saveDeadline) return
    saveDeadline = deadline(Math.max(0, lastSave + SAVE_MS - Date.now()), () => {
      saveDeadline = undefined
      queueSave()
    })
  }
  let saving = Promise.resolve()
  const queueSave = () => {
    saving = saving
      .then(save)
      .catch((error: unknown) => host.notice(`Spend: could not save ${path}: ${String(error)}`))
  }
  const save = async () => {
    await opened
    if (!canSave || !initialized) return
    lastSave = Date.now()
    const { conversations } = await update()
    if (!canSave || !initialized) return
    await saveHistory(
      path,
      historyOf({ conversations, rows: rowsFor, prices, chapter, origin, savedAt: lastSave }),
    )
  }

  const enqueue = (id: number, work: () => Promise<void>) => {
    const next = (queues.get(id) ?? Promise.resolve()).then(work).catch((error: unknown) => {
      host.notice(`Spend: could not read #${id}: ${String(error)}`)
    })
    queues.set(id, next)
    return next
  }
  const liveOf = (id: number) => {
    let live = lives.get(id)
    if (!live) {
      live = { state: createState(id), usage: null, overhead: [], family: null }
      lives.set(id, live)
    }
    live.definition = profiles.get(id)
    live.family = families.get(id) ?? null
    return live
  }
  const read = async (harness: Harness, id: number, at: number) => {
    const live = liveOf(id)
    const conversation = await harness.conversation(id as ConversationId, context)
    if (!conversation || at !== epoch) return
    const query = {
      order: 'ascending' as const,
      ...(live.state.last ? { minEntryId: (live.state.last + 1) as EntryId } : {}),
    }
    let cursor: Cursor | undefined
    do {
      const page = await conversation.entries(query, 200, cursor, context)
      if (at !== epoch) return
      const added = advance(live.state, page.items)
      if (ready && added.some((row) => !pricedKeys.has(`${row.provider}/${row.model}`)))
        rebuiltOnOpen('opening Spend reads the prices again', refreshPrices())
      cursor = page.next
    } while (cursor)
    live.usage = usages.get(id) ?? null
    live.overhead = overheadRows(live.state, live.usage)
    changed(id)
  }
  const refreshPrices = async () => {
    const at = epoch
    for (const live of lives.values())
      for (const row of live.state.rows) pricedKeys.add(`${row.provider}/${row.model}`)
    const models = await host.models().catch(() => [])
    if (at !== epoch) return
    prices = { ...prices, ...pricesOf(models) }
    changed()
  }
  const coalesce = (harness: Harness, id: number, at: number) => {
    let due = coalescedReads.get(id)
    if (!due) {
      due = batch(COALESCE_MS, () => {
        coalescedReads.delete(id)
        rebuiltOnOpen(
          `opening Spend reads #${id} again`,
          enqueue(id, () => read(harness, id, at)),
        )
      })
      coalescedReads.set(id, due)
    }
    due()
  }

  const observe = (harness: Harness, at: number) => {
    const advanceCommit = (publication: CommitPublication) => {
      for (const change of publication.changes) {
        if (change.type === 'conversation') {
          const record = change.value
          const live = liveOf(record.id)
          live.owner = record.owner?.conversationId
          live.parent = record.parent?.conversationId
          changed(record.id)
          continue
        }
        if (change.type !== 'document' || change.conversationId === undefined) continue
        const id = change.conversationId
        const value = change.kind === 'change' ? change.value : null
        if (change.record.kind === PROFILE) {
          profiles.set(id, (value as { definition?: string } | null)?.definition)
          liveOf(id)
        } else if (change.record.kind === FAMILY) {
          families.set(id, (value as { name?: string | null } | null)?.name ?? null)
          liveOf(id)
        } else if (change.record.kind === UsageDoc.definition.kind) {
          usages.set(id, value)
          coalesce(harness, id, at)
        }
      }
    }
    const observation = harness.observeCommits({ advance: advanceCommit, end: () => {} })
    return () => observation.detach()
  }

  const open = async () => {
    const at = epoch
    const harness = host.harness()
    chapter = host.chapter.name
    let history = emptyHistory()
    try {
      history = await loadHistory(path)
    } catch (error) {
      canSave = false
      host.notice(`Spend: ${String(error)}; it is left as it is and nothing is saved over it`)
    }
    if (at !== epoch) return
    const toImport = await chaptersToImport(host.home, chapter).catch((error: unknown) => {
      host.notice(`Spend: could not list the earlier chapters: ${String(error)}`)
      return []
    })
    for (const { name, database } of toImport) {
      try {
        const imported = readChapter(database, { apply, usage: UsageDoc.definition.kind })
        if (!imported.conversations.length) continue
        if (at !== epoch) return
        history = replaceChapter(history, name, {
          conversations: withRoots(
            imported.conversations.map((item) => ({
              ...describe(
                item.id,
                item,
                {
                  id: item.id,
                  busy: false,
                  ...(item.title ? { title: item.title } : {}),
                  ...(item.label ? { label: item.label } : {}),
                },
                new Set<number>(),
              ),
              live: false,
            })),
          ),
          rows: imported.rows,
        })
      } catch (error) {
        host.notice(`Spend: could not import chapter ${name}: ${String(error)}`)
      }
    }
    stopObserving = observe(harness, at)
    const records = await harness.commit(async (tx) => {
      const found = []
      let cursor: Cursor | undefined
      do {
        const page = await tx.scanConversations({}, 256, cursor)
        found.push(...page.items)
        cursor = page.next
      } while (cursor !== undefined)
      return found
    }, context)
    if (at !== epoch) return
    const profileDoc = host.doc(PROFILE)
    const familyDoc = host.doc(FAMILY)
    let unread = 0
    const counted = (work: () => Promise<void>) => () =>
      work().catch((error: unknown) => {
        unread++
        throw error
      })
    await Promise.all(
      records.map((record) =>
        enqueue(
          record.id,
          counted(async () => {
            const [usage, profile, family] = await Promise.all([
              harness.snapshot(UsageDoc, record.id, context),
              profileDoc && harness.snapshot(profileDoc, record.id, context),
              familyDoc && harness.snapshot(familyDoc, record.id, context),
            ])
            if (!profiles.has(record.id))
              profiles.set(record.id, (profile as { definition?: string })?.definition)
            if (!families.has(record.id))
              families.set(record.id, (family as { name?: string | null })?.name ?? null)
            if (!usages.has(record.id))
              usages.set(record.id, (usage as UsageLike | undefined) ?? null)
            const live = liveOf(record.id)
            live.owner = record.owner?.conversationId
            live.parent = record.parent?.conversationId
            await read(harness, record.id, at)
          }),
        ),
      ),
    )
    if (at !== epoch) return
    if (unread) {
      canSave = false
      host.notice(
        `Spend: ${unread} conversation(s) could not be read; the history is left as it is and not saved over`,
      )
    }
    const kept = earlier(history, chapter, new Set(records.map((record) => record.id as number)))
    const rows = new Map<number, Row[]>()
    for (const row of kept.rows) {
      const list = rows.get(row.conversation)
      if (list) list.push(row)
      else rows.set(row.conversation, [row])
    }
    past = { conversations: kept.conversations, rows }
    origin = kept.origin
    prices = history.prices
    await refreshPrices()
    ready = true
    initialized = true
  }

  const stableRows = (id: number) => lives.get(id)?.state.rows ?? past.rows.get(id) ?? []
  const restRows = (id: number) => lives.get(id)?.overhead ?? []
  const rowsFor = (id: number) => [...stableRows(id), ...restRows(id)]
  let stamps = new Map<number, number[]>()
  const held = (id: number, after: number) => {
    const list = stamps.get(id) ?? []
    const newer = list.findIndex((stamped) => stamped > after)
    return newer < 0 ? list.length : newer
  }
  const update = async () => {
    await opened
    for (const summary of host.conversations()) summaries.set(summary.id, summary)
    const ui = await host.uiState(context).catch(meansNone)
    const concludedIds = ui?.[CONCLUDED]
    if (Array.isArray(concludedIds)) concluded = new Set(concludedIds as number[])
    const conversations = withRoots([
      ...[...lives].map(([id, live]) => describe(id, live, summaries.get(id), concluded)),
      ...past.conversations.filter((conversation) => !lives.has(conversation.id)),
    ]).toSorted((a, b) => a.id - b.id)
    let bumped = false
    for (const conversation of conversations) {
      const key = JSON.stringify(conversation)
      const list = stamps.get(conversation.id) ?? []
      const stable = stableRows(conversation.id).length
      if (
        key === keys.get(conversation.id) &&
        !dirty.has(conversation.id) &&
        list.length === stable
      )
        continue
      keys.set(conversation.id, key)
      versions.set(conversation.id, ++version)
      while (list.length < stable) list.push(version)
      stamps.set(conversation.id, list)
      bumped = true
    }
    dirty.clear()
    const key = JSON.stringify(prices)
    if (key !== pricesKey) {
      pricesKey = key
      version++
      bumped = true
    }
    if (bumped) {
      since = null
      for (const conversation of conversations)
        for (const row of rowsFor(conversation.id))
          if (since === null || row.at < since) since = row.at
    }
    return { conversations, bumped }
  }

  const delta = async (asked: SnapshotArgs): Promise<Snapshot | null> => {
    await opened
    if (!initialized) throw failure ?? new Error('Spend is not open yet')
    const { conversations, bumped } = await update()
    if (bumped) scheduleSave()
    const after = asked?.epoch === instance ? asked.version : undefined
    if (after === version) return null
    const known = after !== undefined && after < version
    const newer = known
      ? conversations.filter((conversation) => versions.get(conversation.id)! > after)
      : conversations
    const rows = (id: number) => {
      const from = known ? held(id, after) : 0
      return { from, rows: [...stableRows(id).slice(from), ...restRows(id)] }
    }
    return {
      epoch: instance,
      version,
      since,
      conversations: newer,
      rows: Object.fromEntries(
        newer.map((conversation) => [conversation.id, rows(conversation.id)]),
      ),
      prices,
    }
  }

  const flush = async () => {
    if (!coalescedReads.size) return
    const pending = [...coalescedReads.keys()]
    for (const due of coalescedReads.values()) due.cancel()
    coalescedReads.clear()
    await Promise.all(pending.map((id) => enqueue(id, () => read(host.harness(), id, epoch))))
  }

  const stop = async (pending = true) => {
    stopObserving?.()
    stopObserving = undefined
    if (pending) {
      await flush()
      await Promise.all(queues.values())
    }
    epoch++
    for (const due of coalescedReads.values()) due.cancel()
    coalescedReads.clear()
    if (saveDeadline) {
      saveDeadline()
      saveDeadline = undefined
      if (initialized && canSave) queueSave()
    }
    await saving
  }
  snapshots.set(host, (asked) => delta(asked))
  host.onClose(() => stop())
  host.onOpen(async (session) => {
    await stop(false)
    session.defer(() => stop())
    ready = false
    initialized = false
    failure = undefined
    canSave = true
    lives = new Map()
    profiles = new Map()
    families = new Map()
    usages = new Map()
    pricedKeys = new Set()
    summaries = new Map()
    concluded = new Set()
    queues.clear()
    versions = new Map()
    keys = new Map()
    stamps = new Map()
    dirty.clear()
    pricesKey = ''
    opened = open().catch((error: unknown) => {
      failure = error
      host.notice(`Spend unavailable: ${String(error)}`)
    })
    await opened
  })
  return defineExtension({ name: 'ai-spend' })
}
