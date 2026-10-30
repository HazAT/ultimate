import type { ComponentType } from 'react'
import type { ConversationSummary } from '../../../shared/protocol.ts'
import { events } from './events.ts'
import { errorMessage } from './format.ts'
import { needsAttention } from './types.ts'
import type {
  CodeBlockRenderer,
  CompactCallTest,
  CompactDocs,
  CompactQuietTest,
  CompactRow,
  CompactSummaryProps,
  CommandContribution,
  ComposerRenderer,
  Contribution,
  DocumentContribution,
  EntryRenderer,
  InboxRenderer,
  IntroContribution,
  LinkRenderer,
  PanelContribution,
  SlotName,
  SurfaceContribution,
  ToolRenderer,
  UltimateContext,
  WebExtension,
} from './types.ts'

/** Lazily imports one `extensions/<name>/web.tsx`; the key of its loader is the file path. */
export type ExtensionLoader = () => Promise<unknown>

export interface ExtensionRecord {
  name: string
  /** The installed version; kept when a later load fails, like the server facet. */
  extension?: WebExtension
  /** Why the latest load failed. */
  error?: string
  loading: boolean
  /** Bumped on every install, so error boundaries reset. */
  version: number
}

export interface SlotItem {
  key: string
  extension: string
  version: number
  component: ComponentType
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

export function extensionName(path: string): string | undefined {
  return /extensions\/([^/]+)\/web\.tsx(?:\?.*)?$/.exec(path)?.[1]
}

type Check = (value: unknown) => boolean
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null
const isString: Check = (value) => typeof value === 'string'
const isNumber: Check = (value) => typeof value === 'number'
const isBoolean: Check = (value) => typeof value === 'boolean'
const isFunction: Check = (value) => typeof value === 'function'
/** A function or class component, or an exotic one such as `memo(…)`. */
const isComponent: Check = (value) => isFunction(value) || (isObject(value) && '$$typeof' in value)
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

/** What each contribution must look like; a facet that does not match keeps its previous version installed. */
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
  surfaces: [
    arrayOf(
      fields({
        id: isString,
        title: isString,
        icon: isComponent,
        description: optional(isString),
        order: optional(isNumber),
        component: isComponent,
      }),
    ),
    'an array of { id, title, icon, description?, order?, component }',
  ],
  tools: [objectOf(isComponent), 'an object of tool name → component'],
  toolLines: [objectOf(isComponent), 'an object of tool name → line component'],
  entries: [objectOf(isComponent), 'an object of entry kind → component'],
  inbox: [isComponent, 'an inbox renderer component'],
  composer: [isComponent, 'a composer renderer component'],
  composerInput: [
    arrayOf(fields({ drop: optional(isFunction), paste: optional(isFunction) })),
    'an array of { drop?, paste? }',
  ],
  link: [isComponent, 'a link renderer component'],
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
      quiet: optional(isFunction),
      summary: optional(isComponent),
      thread: optional(isFunction),
    }),
    'a { when, tools?, docs?, quiet?, summary?, thread? } object',
  ],
  intro: [
    fields({
      when: isFunction,
      title: isString,
      hint: optional(isString),
      placeholder: optional(isString),
      card: optional(isComponent),
    }),
    'a { when, title, hint?, placeholder?, card? } object',
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
  if (!isObject(extension)) throw new Error('web.tsx must default-export defineWebExtension({ … })')
  for (const [key, [check, shape]] of Object.entries(shapes))
    if (!optional(check)(extension[key])) throw new Error(`${key} must be ${shape}`)
  return extension
}

/**
 * The installed web facets. Each loads on its own: a broken one records its error and leaves the others (and its own
 * previous version) running.
 */
export function createRegistry() {
  let records: readonly ExtensionRecord[] = []
  let readiness = { ready: false, timedOut: false, failed: [] as string[], pending: [] as string[] }
  let started = false
  let generation = 0
  let pending = new Set<string>()
  let settled = false
  let deadline: ReturnType<typeof setTimeout> | undefined
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
      clearTimeout(deadline)
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
      update(name, (record) =>
        record.extension === extension && !record.error && !record.loading
          ? record
          : { name, extension, loading: false, version: record.version + 1 },
      )
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
    /** The stream's first system snapshot is the other half of page readiness. */
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
    /** Load facets in discovery order (built-in → user → project, then name), dropping missing facets. */
    async setLoaders(loaders: Readonly<Record<string, ExtensionLoader>>) {
      if (!started) deadline = setTimeout(() => refreshReady(true), 8000)
      started = true
      const current = ++generation
      settled = false
      tokens.clear()
      const entries = Object.entries(loaders).flatMap(([path, loader]) => {
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
    /** Install a facet that hot-reloaded on its own. */
    replace(name: string, module: unknown) {
      tokens.set(name, {})
      pending.delete(name)
      install(name, module)
    },
    /** Record a failed hot reload; the previous version stays installed. */
    fail(name: string, error: unknown) {
      if (records.some((record) => record.name === name)) fail(name, error)
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

/** Components for a slot, by `order`, then discovery order, then position. */
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

/** Every facet that provides `point`, in discovery order: for points that combine their providers' values. */
export function provisionsOf(records: readonly ExtensionRecord[], point: string) {
  return records.flatMap(({ name, extension, version }) =>
    (extension?.provides ?? [])
      .filter((provision) => provision.point === point)
      .map((provision) => ({ extension: name, version, use: provision.use })),
  )
}

/** The facet that provides `point`: the last in discovery order. */
export function provisionOf(records: readonly ExtensionRecord[], point: string) {
  return provisionsOf(records, point).at(-1)
}

export function panelItems(records: readonly ExtensionRecord[]): PanelItem[] {
  return records
    .flatMap(({ name, extension, version }) =>
      (extension?.panels ?? []).map((panel) => ({ ...panel, extension: name, version })),
    )
    .toSorted((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

/**
 * The shown panel, `selected` or else the first with a tab (none while only tabless ones exist), and the tab row: every
 * panel with a tab, plus a tabless one (`tab: false`) while it is shown.
 */
export function shownPanels(panels: readonly PanelItem[], selected: string | null) {
  const active =
    panels.find((panel) => panel.id === selected) ?? panels.find((panel) => panel.tab !== false)
  return { active, tabs: panels.filter((panel) => panel.tab !== false || panel === active) }
}

/** The home surface: shown by default, and whenever the chosen surface cannot be. */
export const HOME = 'agent'

/** Surfaces as the switcher lists them: Agent first, then by `order` and title. A later facet wins an id. */
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

/**
 * Which surface shows. The chosen one (`shell.surface`), else the project's `defaultSurface` when installed, else
 * Agent. While facets still load, a surface not yet installed is `pending`; after that, a chosen surface that is
 * missing falls back to Agent and is named in `missing`. `surface` is undefined only while pending or when even
 * Agent is not installed.
 */
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

/**
 * Whether `command` applies in `context`. A `when` that throws hides the command and goes to `report`, so one broken
 * extension cannot take down the palette, shortcuts, or the shell around them.
 */
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

/**
 * The shell's own commands (`base`), then every extension's. A later one wins an id, like surfaces: it takes the place
 * of the command it replaces.
 */
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

/** Document renderers by kind; the last extension in discovery order wins a kind. */
export function documentItems(records: readonly ExtensionRecord[]): Map<string, DocumentItem> {
  const byKind = new Map<string, DocumentItem>()
  for (const { name, extension, version } of records)
    for (const document of extension?.documents ?? [])
      byKind.set(document.kind, { ...document, extension: name, version })
  return byKind
}

/**
 * The last facet's intro whose `when` matches `conversation`, with the facet's name and version for its card's error
 * boundary; a throwing `when` is reported and skipped.
 */
export function introOf(
  records: readonly ExtensionRecord[],
  conversation: ConversationSummary | undefined,
  report: (extension: string, error: unknown) => void,
): (IntroContribution & { extension: string; version: number }) | undefined {
  if (!conversation) return undefined
  const record = records.findLast(({ name, extension }) => {
    if (!extension?.intro) return false
    try {
      return extension.intro.when(conversation)
    } catch (error) {
      report(name, error)
      return false
    }
  })
  return (
    record?.extension?.intro && {
      ...record.extension.intro,
      extension: record.name,
      version: record.version,
    }
  )
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

/**
 * Each facet's input handlers, a later facet's first: a project's before a user's, and both before a built-in's, so a
 * project can take what a built-in would have handled. Within a facet, array order. An event goes to the first handler
 * that claims it.
 */
export function composerInputs(records: readonly ExtensionRecord[]) {
  return records
    .toReversed()
    .flatMap(({ name, version, extension }) =>
      (extension?.composerInput ?? []).map((handler) => ({ extension: name, version, ...handler })),
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

/** Every renderer of an entry kind, in discovery order: each one wraps the rendering of the one before it. */
export function entryRenderers(
  records: readonly ExtensionRecord[],
  kind: string,
): { extension: string; version: number; component: EntryRenderer }[] {
  return records.flatMap((record) => {
    const component = record.extension?.entries?.[kind]
    return component ? [{ extension: record.name, version: record.version, component }] : []
  })
}

/** Every tool renderer in discovery order: each receives the previous rendering as `core`. */
export function toolRenderers(
  records: readonly ExtensionRecord[],
  name: string,
): { extension: string; version: number; component: ToolRenderer }[] {
  return records.flatMap((record) => {
    const component = record.extension?.tools?.[name]
    return component ? [{ extension: record.name, version: record.version, component }] : []
  })
}

/** The one-line renderer of tool `name`: the last facet providing it. */
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

/** Every Markdown link renderer in discovery order: each receives the previous rendering as `core`. */
export function linkRenderers(
  records: readonly ExtensionRecord[],
): { extension: string; version: number; component: LinkRenderer }[] {
  return records.flatMap((record) => {
    const component = record.extension?.link
    return component ? [{ extension: record.name, version: record.version, component }] : []
  })
}

/** Every code block renderer of `language` in discovery order: each receives the previous rendering as `core`. */
export function codeBlockRenderers(
  records: readonly ExtensionRecord[],
  language: string,
): { extension: string; version: number; component: CodeBlockRenderer }[] {
  return records.flatMap((record) => {
    const component = record.extension?.codeBlocks?.[language]
    return component ? [{ extension: record.name, version: record.version, component }] : []
  })
}

/** The languages some extension renders code blocks of. */
export function codeBlockLanguages(records: readonly ExtensionRecord[]): string[] {
  return [...new Set(records.flatMap((record) => Object.keys(record.extension?.codeBlocks ?? {})))]
}

/** Message contributions, preserving discovery order and each facet's array order. */
export function messageItems(
  records: readonly ExtensionRecord[],
  contribution: 'messageActions' | 'messageDetails' | 'answerLabels' | 'userBubble',
) {
  return records.flatMap(({ name, extension, version }) =>
    (extension?.[contribution] ?? []).map((component, index) => ({
      key: `${name}:${index}`,
      extension: name,
      version,
      component,
    })),
  )
}

/** The kinds of the root conversation's documents that `compact` contributions read (`docs`), sorted. */
export const compactDocs = (records: readonly ExtensionRecord[]) =>
  [...new Set(records.flatMap(({ extension }) => extension?.compact?.docs ?? []))].toSorted()

/**
 * Which calls stay visible when `conversation` uses compact mode, or `undefined` when no facet makes it one; `docs` are
 * the root documents of `compactDocs` kinds. A `when` or a call test that throws counts as no and goes to `report`, so
 * one broken extension cannot take down the transcript.
 */
export function compactTools(
  records: readonly ExtensionRecord[],
  conversation: ConversationSummary | undefined,
  rootDocs: CompactDocs,
  report: (extension: string, error: unknown) => void,
):
  | {
      keeps: CompactCallTest
      quiet: CompactQuietTest
      thread?: (row: CompactRow, docs: CompactDocs) => boolean
      summary?: {
        extension: string
        version: number
        component: ComponentType<CompactSummaryProps>
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
  // Rows that ask the user to act (`attention` renderers) never fold: their calls stay out of runs of work, and the rows
  // count as thread, never background.
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
  const asking = (row: CompactRow) =>
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
    quiet: (row, docs) => {
      if (asking(row)) return false
      const verdicts = matching.map(({ name, compact }) => {
        try {
          return compact.quiet?.(row, docs) ?? false
        } catch (error) {
          report(name, error)
          return false
        }
      })
      return verdicts.includes(true) || (verdicts.includes('hidden') ? 'hidden' : false)
    },
    thread: matching.some(({ compact }) => compact.thread)
      ? (row, docs) =>
          asking(row) ||
          matching.some(({ name, compact }) => {
            try {
              return compact.thread?.(row, docs) ?? false
            } catch (error) {
              report(name, error)
              // A broken test keeps the row readable.
              return true
            }
          })
      : undefined,
    summary: matching.flatMap(({ name, version, compact }) =>
      compact.summary ? [{ extension: name, version, component: compact.summary }] : [],
    )[0],
  }
}
