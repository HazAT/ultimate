import type { Component } from 'solid-js'
import { deadline } from '../../../lib/timers.shared.ts'
import type { Cancel } from '../../../lib/timers.shared.ts'
import type { ConversationSummary } from '../../../shared/protocol.ts'
import { events } from './events.ts'
import { errorMessage } from './format.ts'
import { needsAttention } from './types.ts'
import type {
  CodeBlockRenderer,
  CompactCallTest,
  CompactDocs,
  CompactRow,
  CompactSummaryProps,
  CommandContribution,
  ComposerRenderer,
  Contribution,
  DocumentContribution,
  EntryRenderer,
  InboxRenderer,
  InlineCodeRenderer,
  LinkRenderer,
  PanelContribution,
  SlotName,
  SurfaceContribution,
  ToolRenderer,
  UltimateContext,
  WebExtension,
} from './types.ts'

export type ExtensionLoader = () => Promise<unknown>
type BuiltinUserProjectByName = Readonly<Record<string, ExtensionLoader>>

export interface ExtensionRecord {
  name: string
  extension?: WebExtension

  error?: string
  loading: boolean

  version: number
}

export interface SlotItem {
  key: string
  extension: string
  version: number
  component: Component
  phone: boolean
}
export interface PanelItem extends PanelContribution {
  extension: string
  version: number
}
export interface SurfaceItem extends SurfaceContribution {
  extension: string
  version: number
}
export interface CommandItem extends CommandContribution {
  extension: string
}
export interface DocumentItem extends DocumentContribution {
  extension: string
  version: number
}

const facetPath = /extensions\/([^/]+)\/web(\.solid)?\.tsx(?:\?.*)?$/

export function extensionName(path: string): string | undefined {
  return facetPath.exec(path)?.[1]
}

type Check = (value: unknown) => boolean
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null
const isString: Check = (value) => typeof value === 'string'
const isNumber: Check = (value) => typeof value === 'number'
const isBoolean: Check = (value) => typeof value === 'boolean'
const isFunction: Check = (value) => typeof value === 'function'

const isComponent: Check = isFunction
const optional =
  (check: Check): Check =>
  (value) =>
    value === undefined || check(value)
const fields =
  (checks: Record<string, Check>): Check =>
  (value) =>
    isObject(value) && Object.entries(checks).every(([key, check]) => check(value[key]))
const arrayOf =
  (item: Check): Check =>
  (value) =>
    Array.isArray(value) && value.every(item)
const objectOf =
  (item: Check): Check =>
  (value) =>
    isObject(value) && !Array.isArray(value) && Object.values(value).every(item)
const isContribution: Check = (value) =>
  isFunction(value) ||
  fields({ component: isComponent, order: optional(isNumber), phone: optional(isBoolean) })(value)

const shapes: Record<keyof WebExtension, [Check, string]> = {
  slots: [
    objectOf((value) => isContribution(value) || arrayOf(isContribution)(value)),
    'an object of slot name → a component, { component, order?, phone? }, or an array of them',
  ],
  panels: [
    arrayOf(
      fields({
        id: isString,
        title: isString,
        icon: optional(isComponent),
        component: isComponent,
        order: optional(isNumber),
        tab: optional(isBoolean),
      }),
    ),
    'an array of { id, title, icon?, component, order?, tab? }',
  ],
  panelBadges: [objectOf(isComponent), 'an object of panel id → badge component'],
  surfaces: [
    arrayOf(
      fields({
        id: isString,
        title: isString,
        icon: isComponent,
        description: optional(isString),
        order: optional(isNumber),
        component: isComponent,
        badge: optional(isComponent),
      }),
    ),
    'an array of { id, title, icon, description?, order?, component, badge? }',
  ],
  tools: [objectOf(isComponent), 'an object of tool name → component'],
  toolLines: [objectOf(isComponent), 'an object of tool name → line component'],
  entries: [objectOf(isComponent), 'an object of entry kind → component'],
  inbox: [isComponent, 'an inbox renderer component'],
  composer: [isComponent, 'a composer renderer component'],
  link: [isComponent, 'a link renderer component'],
  inlineCode: [isComponent, 'an inline code renderer component'],
  codeBlocks: [objectOf(isComponent), 'an object of code block language → component'],
  messageActions: [arrayOf(isComponent), 'an array of message action components'],
  messageDetails: [arrayOf(isComponent), 'an array of message detail components'],
  answerLabels: [arrayOf(isComponent), 'an array of answer label components'],
  userBubble: [arrayOf(isComponent), 'an array of user bubble components'],
  compact: [
    fields({
      when: isFunction,
      tools: optional(arrayOf((tool) => isString(tool) || isFunction(tool))),
      docs: optional(arrayOf(isString)),
      thread: optional(isFunction),
      summary: optional(isComponent),
    }),
    'a { when, tools?, docs?, thread?, summary? } object',
  ],
  documents: [
    arrayOf(
      fields({
        kind: isString,
        title: isString,
        icon: optional(isComponent),
        component: isComponent,
      }),
    ),
    'an array of { kind, title, icon?, component }',
  ],
  commands: [
    arrayOf(
      fields({
        id: isString,
        title: isString,
        keys: optional(isString),
        group: optional(isString),
        whileTyping: optional((value) => typeof value === 'boolean'),
        when: optional(isFunction),
        run: isFunction,
      }),
    ),
    'an array of { id, title, keys?, group?, whileTyping?, when?, run }',
  ],
  provides: [
    arrayOf(fields({ point: isString, use: isFunction })),
    'an array of provide(Point, useValue)',
  ],
}

function validate(module: unknown): WebExtension {
  const extension = isObject(module) && 'default' in module ? module.default : undefined
  if (!isObject(extension))
    throw new Error('A web facet must default-export defineWebExtension({ … })')
  for (const [key, [check, shape]] of Object.entries(shapes))
    if (!optional(check)(extension[key])) throw new Error(`${key} must be ${shape}`)
  return extension
}

export function createRegistry() {
  let records: readonly ExtensionRecord[] = []
  let readiness = { ready: false, timedOut: false, failed: [] as string[], pending: [] as string[] }
  let started = false
  let generation = 0
  let pending = new Set<string>()
  let settled = false
  let cancelDeadline: Cancel | undefined
  let systemReceived = false
  const refreshReady = (timedOut = readiness.timedOut) => {
    const failed = records.filter((record) => record.error).map((record) => record.name)
    const loading = [...pending]
    const ready = readiness.ready || timedOut || (settled && systemReceived)
    const becameReady = ready && !readiness.ready
    if (
      ready !== readiness.ready ||
      timedOut !== readiness.timedOut ||
      failed.join('\0') !== readiness.failed.join('\0') ||
      loading.join('\0') !== readiness.pending.join('\0')
    ) {
      readiness = { ready, timedOut, failed, pending: loading }
      emit()
    }
    if (becameReady) {
      cancelDeadline?.()
      events.emit('ultimate:ready', { failed, pending: loading, timedOut })
    }
  }
  const tokens = new Map<string, object>()
  const listeners = new Set<() => void>()
  const emit = () => {
    for (const listener of listeners) listener()
  }
  const update = (name: string, change: (record: ExtensionRecord) => ExtensionRecord) => {
    records = records.map((record) => (record.name === name ? change(record) : record))
    refreshReady()
    emit()
  }
  const install = (name: string, module: unknown) => {
    try {
      const extension = validate(module)
      update(name, (record) => {
        return record.extension === extension && !record.error && !record.loading
          ? record
          : { ...record, extension, loading: false, error: undefined, version: record.version + 1 }
      })
      events.emit('ultimate:extension-loaded', { name })
    } catch (error) {
      fail(name, error)
    }
  }
  const fail = (name: string, error: unknown) => {
    const text = errorMessage(error)
    update(name, (record) => ({ ...record, loading: false, error: text }))
    events.emit('ultimate:extension-failed', { name, error: text })
  }

  return {
    getSnapshot: () => records,
    getReady: () => readiness,

    receiveSystem() {
      systemReceived = true
      refreshReady()
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async setLoaders(lastWinsDiscoveryOrder: BuiltinUserProjectByName) {
      if (!started) cancelDeadline = deadline(8000, () => refreshReady(true))
      started = true
      const current = ++generation
      settled = false
      tokens.clear()
      const entries = Object.entries(lastWinsDiscoveryOrder).flatMap(([path, loader]) => {
        const name = extensionName(path)
        return name ? [{ name, loader }] : []
      })
      pending = new Set(entries.map(({ name }) => name))
      const previous = new Map(records.map((record) => [record.name, record]))
      records = entries.map(({ name }) => previous.get(name) ?? { name, loading: true, version: 0 })
      refreshReady()
      emit()
      await Promise.allSettled(
        entries.map(async ({ name, loader }) => {
          const token = {}
          tokens.set(name, token)
          try {
            const module = await loader()
            if (tokens.get(name) === token) {
              pending.delete(name)
              install(name, module)
            }
          } catch (error) {
            if (tokens.get(name) === token) {
              pending.delete(name)
              fail(name, error)
            }
          }
        }),
      )
      if (current === generation) {
        settled = true
        refreshReady()
      }
    },
  }
}
export type Registry = ReturnType<typeof createRegistry>

function normalize(value: Contribution | readonly Contribution[] | undefined) {
  if (!value) return []
  const list: readonly Contribution[] = Array.isArray(value) ? value : [value as Contribution]
  return list.map((item) =>
    typeof item === 'function'
      ? { component: item, order: 0, phone: false }
      : { order: 0, phone: false, ...item },
  )
}

export function slotItems(records: readonly ExtensionRecord[], slot: SlotName): SlotItem[] {
  return records
    .flatMap(({ name, extension, version }) =>
      normalize(extension?.slots?.[slot]).map((item, index) => ({
        key: `${name}:${index}`,
        extension: name,
        version,
        component: item.component,
        order: item.order ?? 0,
        phone: item.phone ?? false,
      })),
    )
    .toSorted((a, b) => a.order - b.order)
    .map(({ order: _order, ...item }) => item)
}

export function provisionsOf(records: readonly ExtensionRecord[], point: string) {
  return records.flatMap(({ name, extension, version }) =>
    (extension?.provides ?? [])
      .filter((provision) => provision.point === point)
      .map((provision) => ({ extension: name, version, use: provision.use })),
  )
}

export function panelItems(records: readonly ExtensionRecord[]): PanelItem[] {
  return records
    .flatMap(({ name, extension, version }) =>
      (extension?.panels ?? []).map((panel) => ({ ...panel, extension: name, version })),
    )
    .toSorted((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

export function panelBadges(
  records: readonly ExtensionRecord[],
  id: string,
): { extension: string; version: number; component: Component }[] {
  return records.flatMap((record) => {
    const component = record.extension?.panelBadges?.[id]
    return component ? [{ extension: record.name, version: record.version, component }] : []
  })
}

export function shownPanels<P extends Pick<PanelItem, 'id' | 'tab'>>(
  panels: readonly P[],
  selected: string | null,
) {
  const active =
    panels.find((panel) => panel.id === selected) ?? panels.find((panel) => panel.tab !== false)
  return { active, tabs: panels.filter((panel) => panel.tab !== false || panel === active) }
}

export const HOME = 'agent'

export function surfaceItems(records: readonly ExtensionRecord[]): SurfaceItem[] {
  const byId = new Map<string, SurfaceItem>()
  for (const { name, extension, version } of records)
    for (const surface of extension?.surfaces ?? [])
      byId.set(surface.id, { ...surface, extension: name, version })
  return [...byId.values()].toSorted(
    (a, b) =>
      Number(b.id === HOME) - Number(a.id === HOME) ||
      (a.order ?? 0) - (b.order ?? 0) ||
      a.title.localeCompare(b.title),
  )
}

export function resolveSurface(
  surfaces: readonly SurfaceItem[],
  { chosen, preferred, loading }: { chosen?: string; preferred?: string; loading: boolean },
): { surface?: SurfaceItem; pending: boolean; missing?: string } {
  const find = (id: string | undefined) => surfaces.find((surface) => surface.id === id)
  const wanted = chosen ?? (find(preferred) || loading ? preferred : undefined) ?? HOME
  const surface = find(wanted)
  if (surface) return { surface, pending: false }
  if (loading) return { pending: true }
  return { surface: find(HOME), pending: false, missing: chosen }
}

export function commandApplies(
  command: CommandItem,
  context: UltimateContext,
  report: (command: CommandItem, error: unknown) => void,
): boolean {
  if (!command.when) return true
  try {
    return command.when(context)
  } catch (error) {
    report(command, error)
    return false
  }
}

export function commandItems(
  records: readonly ExtensionRecord[],
  base: readonly CommandItem[] = [],
): CommandItem[] {
  const byId = new Map(base.map((command) => [command.id, command]))
  for (const { name, extension } of records)
    for (const command of extension?.commands ?? [])
      byId.set(command.id, { ...command, extension: name })
  return [...byId.values()]
}

export function documentItems(records: readonly ExtensionRecord[]): Map<string, DocumentItem> {
  const byKind = new Map<string, DocumentItem>()
  for (const { name, extension, version } of records)
    for (const document of extension?.documents ?? [])
      byKind.set(document.kind, { ...document, extension: name, version })
  return byKind
}

export function composerRenderers(
  records: readonly ExtensionRecord[],
): { extension: string; version: number; component: ComposerRenderer }[] {
  return records.flatMap((record) =>
    record.extension?.composer
      ? [{ extension: record.name, version: record.version, component: record.extension.composer }]
      : [],
  )
}

export function inboxRenderer(
  records: readonly ExtensionRecord[],
): { extension: string; version: number; component: InboxRenderer } | undefined {
  for (const record of records.toReversed())
    if (record.extension?.inbox)
      return { extension: record.name, version: record.version, component: record.extension.inbox }
  return undefined
}

export function entryRenderers(
  records: readonly ExtensionRecord[],
  kind: string,
): { extension: string; version: number; component: EntryRenderer }[] {
  return records.flatMap((record) => {
    const component = record.extension?.entries?.[kind]
    return component ? [{ extension: record.name, version: record.version, component }] : []
  })
}

export function toolRenderers(
  records: readonly ExtensionRecord[],
  name: string,
): { extension: string; version: number; component: ToolRenderer }[] {
  return records.flatMap((record) => {
    const component = record.extension?.tools?.[name]
    return component ? [{ extension: record.name, version: record.version, component }] : []
  })
}

export function toolLine(records: readonly ExtensionRecord[], name: string) {
  const record = records.findLast((candidate) => candidate.extension?.toolLines?.[name])
  return (
    record && {
      extension: record.name,
      version: record.version,
      component: record.extension!.toolLines![name],
    }
  )
}

export function linkRenderers(
  records: readonly ExtensionRecord[],
): { extension: string; version: number; component: LinkRenderer }[] {
  return records.flatMap((record) => {
    const component = record.extension?.link
    return component ? [{ extension: record.name, version: record.version, component }] : []
  })
}

export function inlineCodeRenderers(
  records: readonly ExtensionRecord[],
): { extension: string; version: number; component: InlineCodeRenderer }[] {
  return records.flatMap((record) => {
    const component = record.extension?.inlineCode
    return component ? [{ extension: record.name, version: record.version, component }] : []
  })
}

export function codeBlockRenderers(
  records: readonly ExtensionRecord[],
  language: string,
): { extension: string; version: number; component: CodeBlockRenderer }[] {
  return records.flatMap((record) => {
    const component = record.extension?.codeBlocks?.[language]
    return component ? [{ extension: record.name, version: record.version, component }] : []
  })
}

export function messageItems<
  C extends 'messageActions' | 'messageDetails' | 'answerLabels' | 'userBubble',
>(
  records: readonly ExtensionRecord[],
  contribution: C,
): {
  key: string
  extension: string
  version: ExtensionRecord['version']
  component: NonNullable<WebExtension[C]>[number]
}[] {
  return records.flatMap(({ name, extension, version }) =>
    ((extension?.[contribution] ?? []) as NonNullable<WebExtension[C]>).map((component, index) => ({
      key: `${name}:${index}`,
      extension: name,
      version,
      component,
    })),
  )
}

export const compactDocs = (records: readonly ExtensionRecord[]) =>
  [...new Set(records.flatMap(({ extension }) => extension?.compact?.docs ?? []))].toSorted()

export function compactTools(
  records: readonly ExtensionRecord[],
  conversation: ConversationSummary | undefined,
  rootDocs: CompactDocs,
  report: (extension: string, error: unknown) => void,
):
  | {
      keeps: CompactCallTest
      thread?: (row: CompactRow, docs: CompactDocs) => boolean | 'hidden'
      summary?: {
        extension: string
        version: number
        component: Component<CompactSummaryProps>
      }
    }
  | undefined {
  if (!conversation) return undefined
  const matching = records.flatMap(({ name, version, extension }) => {
    if (!extension?.compact) return []
    try {
      return extension.compact.when(conversation, rootDocs)
        ? [{ name, version, compact: extension.compact }]
        : []
    } catch (error) {
      report(name, error)
      return []
    }
  })
  if (!matching.length) return undefined

  const asks = (kind: 'entries' | 'tools') =>
    new Set(
      records.flatMap(({ extension }) =>
        Object.entries(extension?.[kind] ?? {}).flatMap(([key, renderer]) =>
          needsAttention(renderer) ? [key] : [],
        ),
      ),
    )
  const askingKinds = asks('entries')
  const askingTools = asks('tools')
  const rowRequiresAttentionAndCannotFold = (row: CompactRow) =>
    askingKinds.has(row.entry.kind) || row.calls.some((call) => askingTools.has(call.name))
  const tools = matching.flatMap(({ name, compact }) =>
    (compact.tools ?? []).map((tool) => ({ name, tool })),
  )
  const names = new Set([
    ...askingTools,
    ...tools.flatMap(({ tool }) => (typeof tool === 'string' ? [tool] : [])),
  ])
  const tests = tools.flatMap(({ name, tool }) =>
    typeof tool === 'function' ? [{ name, test: tool }] : [],
  )
  return {
    keeps: (call, docs) =>
      names.has(call.name) ||
      tests.some(({ name, test }) => {
        try {
          return test(call, docs)
        } catch (error) {
          report(name, error)
          return false
        }
      }),
    thread: matching.some(({ compact }) => compact.thread)
      ? (row, docs) => {
          if (rowRequiresAttentionAndCannotFold(row)) return true
          const verdicts = matching.map(({ name, compact }) => {
            try {
              return compact.thread?.(row, docs) ?? false
            } catch (error) {
              report(name, error)

              const keepRowReadableOnPredicateFailure = true
              return keepRowReadableOnPredicateFailure
            }
          })
          if (verdicts.includes(true)) return true
          const everyFacetHidesRow = verdicts.every((v) => v === 'hidden')
          return everyFacetHidesRow ? 'hidden' : false
        }
      : undefined,
    summary: matching.flatMap(({ name, version, compact }) =>
      compact.summary ? [{ extension: name, version, component: compact.summary }] : [],
    )[0],
  }
}
