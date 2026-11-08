import { readFile, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { compareExtensions, discoverExtensions } from './discovery.ts'
import { decisionRoot, projectSetup, projectSettings, projectDiagnostics } from './project-setup.ts'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { discoveryRoots, projects } from './project.ts'
import type { ProjectInfo } from './project.ts'
import { extensionSettingsFiles } from './extension-settings.ts'
import { watchRoots } from './watch-roots.ts'
import { actionExec } from './actions.ts'
import type { ExtensionAction } from './actions.ts'
import type { JsonValue } from '@earendil-works/chord'
import { join, resolve } from 'node:path'
import type {
  ConversationDocToken,
  Extension,
  Harness,
  JsonObject,
} from '@earendil-works/pi-durable'
import type { ViteDevServer } from 'vite-plus'
import type { ConversationSummary, ExtensionInfo, SystemInfo } from '../shared/protocol.ts'
import type { PreparedHost } from './harness.ts'
import { Metadata } from './metadata.ts'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { AgentDoc, LiveDoc } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { Access } from './request-security.ts'
import { EventFeed, eventLog } from './events.ts'
import { contractOutline } from '../lib/api-files.ts'
import type { EventHost } from './events.ts'
import { extensionApis } from './extension-apis.ts'
import type { TraceReader } from './trace.ts'
import type { Api, Catalogue } from '../shared/extension-api.ts'
import type { Device } from '../shared/events.ts'

export type ExtensionHost = Pick<
  PreparedHost,
  | 'ultimateRoot'
  | 'projectRoot'
  | 'userHome'
  | 'home'
  | 'modelRuntime'
  | 'settings'
  | 'build'
  | 'uiState'
  | 'scanSubmissions'
  | 'models'
  | 'skills'
  | 'restart'
  | 'chapter'
> & {
  access: Pick<Access, 'allow'>
  notice(message: string): void
  /**
   * Provide the service of `api`. Facet scope only: staged until the facet installs, replaced on reload, kept when a
   * reload fails, and removed when the facet is disabled, removed or closed.
   */
  implement<S>(api: Api<string, S>, value: NoInfer<S>): void
  /** A handle to the current provider of `api`; throws while none is enabled, except during facet setup. */
  need<S>(api: Api<string, S>): S
  /** A handle to the current provider of `api`, or undefined while none is enabled. */
  want<S>(api: Api<string, S>): S | undefined
  /** Who provides, needs and wants each API, plus missing providers and dependency cycles. */
  catalogue(): Catalogue
  /** The recorded calls: services, actions, reactor runs and tools. */
  trace: TraceReader
  resource<T>(key: string, create: () => T): T
  /** Run `callback` each time the harness opens, at once when it is open; the server serves once it settles. */
  onOpen(callback: () => Promise<void>): void
  /** Run `callback` each time before the harness closes while the process stays: on a core swap. */
  onRelease(callback: () => Promise<void>): void
  onClose(cleanup: () => Promise<void>): void
  /** Run `callback` each time an extension's server facet fails to load, with its name and error; facet-scoped. */
  onLoadError(callback: (name: string, error: string) => void): void
  harness(): Harness
  system(): SystemInfo
  /** Summaries of every conversation, as the web's conversation list shows them; empty until the harness is open. */
  conversations(): ConversationSummary[]
  /** Read JSON manifests in the user's central project homes, never another project's SQLite; unknown roots remain absent. Includes this home and live supervisor URLs. */
  projects(): Promise<ProjectInfo[]>
  /** Discovered extensions, including disabled project folders, with effective deciding layers. */
  extensions(): ExtensionInfo[]
  /** Project setup availability, the decision of the root (a linked worktree's main checkout), and capped README. */
  projectSetup(): ReturnType<typeof projectSetup>
  /** Parsed project settings only after a local decision; otherwise empty. Invalid JSON reports a notice and returns empty. */
  projectSettings(): Promise<JsonObject>
  /** Read-only inventory of project folders, including replacements of active extensions. */
  projectExtensions(): Promise<ExtensionInfo[]>
  /** Remember the local/global choice and apply it through the live settings reload path. */
  setProjectDecision(local: boolean): Promise<void>
  /** Apply settings writes to the registry, browser facets, and styles before returning. */
  reloadExtensions(): Promise<void>
  /** Call an installed extension action on behalf of a conversation; rejects user-only actions. */
  invoke(
    name: string,
    action: string,
    args: JsonValue,
    signal: AbortSignal,
    conversationId?: number,
  ): Promise<unknown>
  doc(kind: string): ConversationDocToken<JsonObject> | undefined
  metadata: typeof Metadata
} & EventHost
const runOpener = (callback: () => Promise<void>) =>
  callback().catch((error: unknown) => console.error('Extension onOpen:', error))
const runReleaser = (callback: () => Promise<void>) =>
  callback().catch((error: unknown) => console.error('Extension onRelease:', error))
/** Attach listeners to Vite's current watcher and to each replacement; `attach` returns their removal. */
export type Watch = (attach: (watcher: ViteDevServer['watcher']) => () => void) => () => void
export async function loadExtensions(
  vite: ViteDevServer,
  host: PreparedHost,
  changed: () => void | Promise<void>,
  runtime: Pick<ExtensionHost, 'harness' | 'system' | 'conversations' | 'access'>,
  watch: Watch,
  notice: (message: string) => void = () => {},
  /** Bring the web bundle up to date with the settings just applied. */
  rebuildWeb: () => Promise<void> = async () => {},
) {
  const trace = host.callTrace
  const log = eventLog(runtime.harness, trace.run, trace.keep)
  const roots = discoveryRoots(host.ultimateRoot, host.projectRoot, host.userHome)
  const directories = roots.map((root) => join(root.path, 'extensions'))
  const provided = new Map<ExtensionHost, Map<string, unknown>>()
  const providers = new Map<string, { owner: ExtensionHost; value: unknown }>()
  const facetHosts = new Map<string, ExtensionHost>()
  const subscriptions = new Map<ExtensionHost, Set<() => void>>()
  const facetOpeners = new Map<ExtensionHost, Set<() => Promise<void>>>()
  const facetReleasers = new Map<ExtensionHost, Set<() => Promise<void>>>()
  const facetCleanups = new Map<ExtensionHost, Set<() => Promise<void>>>()
  /** Each facet's distinct notice messages, and whether each is recorded as an event yet. */
  const facetNotices = new Map<ExtensionHost, Map<string, boolean>>()
  const extensionOf = (facetHost: ExtensionHost) =>
    [...facetHosts].find(([, current]) => current === facetHost)?.[0]
  const apis = extensionApis(
    (name) => {
      const service = providers.get(name)
      const extension = service && extensionOf(service.owner)
      return extension ? { extension, value: service.value } : undefined
    },
    () =>
      [...providers].flatMap(([name, { owner }]) => {
        const extension = extensionOf(owner)
        return extension ? [[name, extension] as [string, string]] : []
      }),
    (owner) => [...facetHosts.values()].includes(owner as ExtensionHost),
    trace.run,
  )
  let missingApis = new Set<string>()
  const dispose = async (facetHost: ExtensionHost | undefined) => {
    if (!facetHost) return
    apis.dispose(facetHost)
    for (const [name, service] of providers) if (service.owner === facetHost) providers.delete(name)
    provided.delete(facetHost)
    for (const stop of subscriptions.get(facetHost) ?? []) stop()
    subscriptions.delete(facetHost)
    for (const callback of facetOpeners.get(facetHost) ?? []) openers.delete(callback)
    facetOpeners.delete(facetHost)
    for (const callback of facetReleasers.get(facetHost) ?? []) releasers.delete(callback)
    facetReleasers.delete(facetHost)
    for (const cleanup of facetCleanups.get(facetHost) ?? []) {
      try {
        await cleanup()
      } catch (error) {
        notice(`Extension cleanup failed: ${String(error)}`)
      }
    }
    facetCleanups.delete(facetHost)
    facetNotices.delete(facetHost)
  }
  const scope = (name: string): ExtensionHost => {
    const stops = new Set<() => void>()
    let sharedResource = false
    const facetHost = {
      ...extensionHost,
      get chapter() {
        return extensionHost.chapter
      },
      implement: (api, value) => {
        provided.get(facetHost)!.set(api.name, value)
        if (facetHosts.get(name) === facetHost) providers.set(api.name, { owner: facetHost, value })
      },
      need: <S>(api: Api<string, S>): S =>
        apis.need(facetHost, name, api, facetHosts.get(name) !== facetHost),
      want: <S>(api: Api<string, S>): S | undefined => apis.want(facetHost, name, api),
      notice: (message) => {
        // Each distinct message once per facet load: a notice raised by a commit watcher cannot loop through its event.
        // One raised while storage is closed is recorded when it opens.
        const messages = facetNotices.get(facetHost)
        // Pending facet work can finish after reload or shutdown; it must not revive a disposed facet's notices.
        if (!messages) return
        if (!messages.has(message)) {
          messages.set(message, open)
          if (open) log.notice(name, message)
        }
        notice(message)
        void Promise.resolve(changed()).catch((error: unknown) =>
          console.error('Publishing extension changes failed:', error),
        )
      },
      resource: <T>(key: string, create: () => T) =>
        extensionHost.resource(key, () => {
          const previous = sharedResource
          sharedResource = true
          try {
            return create()
          } finally {
            sharedResource = previous
          }
        }),
      access: {
        allow: (rule) => {
          const remove = runtime.access.allow(rule)
          const stop = () => {
            remove()
            stops.delete(stop)
          }
          stops.add(stop)
          return stop
        },
      },
      onOpen: (callback) => {
        if (sharedResource) extensionHost.onOpen(callback)
        else {
          facetOpeners.get(facetHost)!.add(callback)
          openers.add(callback)
          // oxlint-disable-next-line typescript/no-floating-promises -- runOpener catches and reports opener failures.
          if (open && [...facetHosts.values()].includes(facetHost)) void runOpener(callback)
        }
      },
      onRelease: (callback) => {
        if (sharedResource) extensionHost.onRelease(callback)
        else {
          facetReleasers.get(facetHost)!.add(callback)
          releasers.add(callback)
        }
      },
      onClose: (cleanup) => {
        if (sharedResource) extensionHost.onClose(cleanup)
        else facetCleanups.get(facetHost)!.add(cleanup)
      },
      onLoadError: (callback) => {
        loadErrorListeners.add(callback)
        stops.add(() => loadErrorListeners.delete(callback))
      },
      react: (reactorName, tokens, handler, options) => {
        const reactor = log.reactor(`${name}/${reactorName}`, tokens, handler, options)
        facetHost.onOpen(reactor.start)
        facetHost.onRelease(reactor.stop)
        stops.add(reactor.stop)
      },
    } satisfies ExtensionHost
    provided.set(facetHost, new Map())
    subscriptions.set(facetHost, stops)
    facetOpeners.set(facetHost, new Set())
    facetReleasers.set(facetHost, new Set())
    facetCleanups.set(facetHost, new Set())
    facetNotices.set(facetHost, new Map())
    return facetHost
  }
  const actions = new Map<string, Record<string, ExtensionAction>>()
  const userActions = new Map<string, string[]>()
  /** Read-only actions a surface polls: the trace counts their successful calls instead of writing them. */
  const pollActions = new Map<string, string[]>()
  const settingsReloads = new Set<string>()
  const records = new Map<string, ExtensionInfo>()
  /** Each loaded extension's folder with symlinks resolved, where Vite keys its modules. */
  const targets = new Map<string, string>()
  const documents = new Map<string, ConversationDocToken<JsonObject>[]>()
  const findDoc = (kind: string) =>
    [
      EventFeed as never as ConversationDocToken<JsonObject>,
      // A conversation's live round without its transcript, for watchers of many conversations (the sound of agents).
      LiveDoc as never as ConversationDocToken<JsonObject>,
      ...[...documents.values()].flat(),
    ].find((doc) => doc.definition.kind === kind)
  const openers = new Set<() => Promise<void>>()
  const loadErrorListeners = new Set<(name: string, error: string) => void>()
  const releasers = new Set<() => Promise<void>>()
  let open = false
  const cleanups = new Set<() => Promise<void>>()
  const resources = new Map<string, unknown>()
  async function invoke(
    name: string,
    action: string,
    args: JsonValue,
    signal: AbortSignal,
    conversationId?: number,
    caller = 'ui',
    device?: Device,
  ) {
    const table = actions.get(name)
    const fn = table && Object.hasOwn(table, action) ? table[action] : undefined
    if (!fn) throw new Error(`Unknown extension action: ${name}/${action}`)
    if (
      conversationId !== undefined &&
      (!Number.isSafeInteger(conversationId) || conversationId < 1)
    )
      throw new Error('Invalid conversationId')
    const call = { caller, callee: name, name: `${name}/${action}`, args, conversationId }
    const poll = pollActions.get(name)?.includes(action)
    return trace.run({ kind: 'action', ...call, ...(poll ? { poll } : {}) }, () =>
      fn(args, {
        host: facetHosts.get(name)!,
        conversationId,
        ...(device ? { device } : {}),
        signal,
        exec: async (command, commandArgs, options) => {
          const agent =
            conversationId === undefined
              ? undefined
              : await runtime
                  .harness()
                  .snapshot(AgentDoc, conversationId as ConversationId, BACKGROUND_CONTEXT)
          return actionExec(options?.cwd ?? agent?.cwd ?? host.projectRoot, signal)(
            command,
            commandArgs,
            options,
          )
        },
      }),
    )
  }
  const extensionHost: ExtensionHost = {
    invoke: async (name, action, args, signal, conversationId) => {
      if (userActions.get(name)?.includes(action))
        throw new Error(`${name}/${action} is a user-only action`)
      return invoke(name, action, args, signal, conversationId, 'agent')
    },
    emit: log.emit,
    react: () => {
      throw new Error('Reactors require a facet scope')
    },
    eventLog: log.eventLog,
    implement: () => {
      throw new Error('Providers require a facet scope')
    },
    need: () => {
      throw new Error('Consumers require a facet scope')
    },
    want: () => {
      throw new Error('Consumers require a facet scope')
    },
    catalogue: () => apis.catalogue(),
    trace: trace.reader,
    access: runtime.access,
    notice,
    resource: <T>(key: string, create: () => T) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key) as T
    },
    onOpen: (callback) => {
      openers.add(callback)
      // oxlint-disable-next-line typescript/no-floating-promises -- runOpener catches and reports opener failures.
      if (open) void runOpener(callback)
    },
    onRelease: (callback) => {
      releasers.add(callback)
    },
    onClose: (cleanup) => cleanups.add(cleanup),
    onLoadError: (callback) => loadErrorListeners.add(callback),
    ultimateRoot: host.ultimateRoot,
    projectRoot: host.projectRoot,
    userHome: host.userHome,
    home: host.home,
    modelRuntime: host.modelRuntime,
    settings: host.settings,
    build: host.build,
    uiState: (caller) => host.uiState(caller),
    scanSubmissions: (query, limit, cursor, caller) =>
      host.scanSubmissions(query, limit, cursor, caller),
    models: () => host.models(),
    skills: (cwd) => host.skills(cwd),
    restart: (approved) => host.restart(approved),
    get chapter() {
      return host.chapter
    },
    harness: runtime.harness,
    system: runtime.system,
    conversations: runtime.conversations,
    projects: () => projects(host.userHome, host.home),
    extensions: () => info(),
    projectSetup: () => projectSetup(host.projectRoot, host.userHome),
    projectSettings: () => projectSettings(host.projectRoot, host.userHome, notice),
    projectExtensions: async () => {
      const available = await discoverExtensions(
        host.ultimateRoot,
        host.projectRoot,
        host.userHome,
        true,
      )
      return available
        .filter((entry) => entry.source === 'project')
        .map((entry) => ({
          name: entry.name,
          path: entry.path,
          source: entry.source,
          enabled: records.get(entry.name)?.path === entry.path && records.get(entry.name)!.enabled,
          layer: available.settings.layers.get(entry.name) ?? 'folder',
          actions: [],
          events: [],
          facets: {
            server: entry.files.includes('server.ts'),
            web: entry.files.includes('web.tsx'),
          },
          ...(existsSync(join(host.ultimateRoot, 'extensions', entry.name))
            ? { replaces: 'builtin' as const }
            : {}),
        }))
    },
    setProjectDecision: async (local) => {
      new ProjectTrustStore(join(host.userHome, '.ultimate')).set(
        decisionRoot(host.projectRoot),
        local,
      )
      await extensionHost.reloadExtensions()
    },
    reloadExtensions: async () => {
      const work = chain.then(() => reloadSettings())
      // The caller gets the failure; the chain recovers so later reloads still run.
      chain = work.catch(() => changed())
      await work
      await rebuildWeb()
    },
    doc: findDoc,
    metadata: Metadata,
  }
  const installed = host.extensionOrders
  const info = () =>
    [...records.values()].toSorted((a, b) =>
      compareExtensions(
        { ...a, order: installed.get(a.name) },
        { ...b, order: installed.get(b.name) },
      ),
    )
  let chain = Promise.resolve()
  /** Runs `work` after earlier reloads; a failure becomes a notice and still publishes what is loaded. */
  function enqueue(work: () => Promise<void>) {
    chain = chain.then(work).catch((error: unknown) => {
      notice(`Extension reload failed: ${String(error)}`)
      return changed()
    })
  }
  /** Drops `name`'s server facet: its host, tools, documents and actions. */
  async function unload(name: string) {
    await dispose(facetHosts.get(name))
    facetHosts.delete(name)
    if (installed.delete(name)) host.registry.uninstall({ name })
    documents.delete(name)
    actions.delete(name)
    userActions.delete(name)
    pollActions.delete(name)
    settingsReloads.delete(name)
  }
  let closed = false
  const settingsFiles = [
    ...extensionSettingsFiles(host.projectRoot, host.userHome),
    join(host.userHome, '.ultimate/trust.json'),
  ]
  let previousSettings: string | undefined
  let diagnostics: string[] = []
  async function discover() {
    const active = await discoverExtensions(host.ultimateRoot, host.projectRoot, host.userHome)
    const available = await discoverExtensions(
      host.ultimateRoot,
      host.projectRoot,
      host.userHome,
      true,
      active.settings,
    )
    const winners = [
      ...active,
      ...available
        .filter((entry) => !active.some((current) => current.name === entry.name))
        .map((entry) => ({ ...entry, enabled: false })),
    ].toSorted(compareExtensions)
    return Object.assign(winners, { settings: active.settings })
  }
  async function reload(
    selected?: Set<string>,
    servers = selected,
    winners?: Awaited<ReturnType<typeof discover>>,
  ) {
    winners ??= await discover()
    const folders = winners.map((winner) => winner.name)
    const settings = winners.settings
    diagnostics = [
      ...settings.notices,
      ...projectDiagnostics(host.projectRoot, host.userHome),
      ...[...settings.overrides.keys()]
        .filter((name) => !folders.includes(name))
        .map((name) => `Unknown extension: ${name}`),
      ...winners
        .filter((winner) => winner.core && settings.overrides.get(winner.name) === false)
        .map((winner) => `${winner.name} is core and stays enabled; extensions.disable ignores it`),
    ]
    const signature = JSON.stringify([settings.contents, folders, diagnostics])
    if (signature !== previousSettings) {
      for (const message of diagnostics) notice(message)
      previousSettings = signature
    }
    for (const {
      name,
      path,
      target,
      source,
      enabled,
      files,
      core,
      error: discoveryError,
    } of winners) {
      const previous = records.get(name)
      host.extensionSources.set(name, source)
      const layer = settings.layers.get(name) ?? (source === 'builtin' ? 'default' : 'folder')
      if (selected && !selected.has(name) && previous) {
        if (previous) previous.layer = layer
        continue
      }
      let readme: string | undefined
      if (files.includes('README.md'))
        readme = (await readFile(join(path, 'README.md'), 'utf8')).trim().split(/\n\s*\n/)[0]
      const record: ExtensionInfo = {
        name,
        path,
        source,
        enabled,
        ...(core ? { core } : {}),
        layer,
        actions: Object.keys(actions.get(name) ?? {}),
        events: (await contractOutline({ name, path, enabled })).events,
        readme,
        facets: { server: files.includes('server.ts'), web: files.includes('web.tsx') },
        ...(previous?.server ? { server: previous.server } : {}),
      }
      if (enabled && record.facets.server && (!servers || servers.has(name))) {
        const facetHost = scope(name)
        try {
          // Vite keeps a URL bound to the file it first resolved to, so a repointed link loads by its target.
          const module = await vite.ssrLoadModule(join(target, 'server.ts'))
          const extension: Extension =
            typeof module.default === 'function' ? await module.default(facetHost) : module.default
          if (!extension || extension.name !== name)
            throw new Error('Extension name must match its folder')
          const docs: ConversationDocToken<JsonObject>[] = module.docs ?? []
          if (!Array.isArray(docs) || docs.some((doc) => doc.definition.scope !== 'conversation'))
            throw new Error('docs must contain conversation document tokens')
          const exportedActions: Record<string, ExtensionAction> = module.actions ?? {}
          if (Object.values(exportedActions).some((action) => typeof action !== 'function'))
            throw new Error('actions must contain functions')
          const exportedUserActions: unknown = module.userActions ?? []
          if (
            !Array.isArray(exportedUserActions) ||
            exportedUserActions.some(
              (action) => typeof action !== 'string' || !Object.hasOwn(exportedActions, action),
            )
          )
            throw new Error('userActions must contain registered action names')
          const exportedPollActions: unknown = module.pollActions ?? []
          if (
            !Array.isArray(exportedPollActions) ||
            exportedPollActions.some(
              (action) => typeof action !== 'string' || !Object.hasOwn(exportedActions, action),
            )
          )
            throw new Error('pollActions must contain registered action names')
          // A function derives them from the facet's config; it runs again on each reload.
          const secrets = validateSecrets(
            typeof module.secrets === 'function'
              ? await module.secrets(facetHost)
              : (module.secrets ?? []),
          )
          // Pi lets the last extension win a tool name silently. A later source layer overriding a tool on purpose is
          // fine (a project's bash over coding-tools); within one layer, the extension holding the name keeps it.
          const taken = host.registry
            .snapshot()
            .tools()
            .filter(
              (entry) =>
                entry.extension.name !== name &&
                host.extensionSources.get(entry.extension.name) === source &&
                extension.tools?.some((tool) => tool.name === entry.tool.name),
            )
            .map((entry) => `${entry.tool.name} is already provided by ${entry.extension.name}`)
          if (taken.length) throw new Error(taken.join('; '))
          host.registry.install(trace.tools(extension))
          const previousHost = facetHosts.get(name)
          facetHosts.set(name, facetHost)
          for (const [key, value] of provided.get(facetHost)!)
            providers.set(key, { owner: facetHost, value })
          await dispose(previousHost)
          if (open) await Promise.all([...facetOpeners.get(facetHost)!].map(runOpener))
          actions.set(name, exportedActions)
          userActions.set(name, exportedUserActions)
          pollActions.set(name, exportedPollActions)
          if (module.reloadOnSettings === true) settingsReloads.add(name)
          else settingsReloads.delete(name)
          record.actions = Object.keys(exportedActions)
          installed.set(name, module.order ?? 0)
          documents.set(name, docs)
          record.server = {
            loadedAt: new Date().toISOString(),
            tools:
              extension.tools?.map((tool) => ({
                name: tool.name,
                description: tool.description.trim().split('\n')[0] ?? '',
              })) ?? [],
            sections: extension.sections?.map((section) => section.key) ?? [],
            hooks: extension.hooks?.length ?? 0,
            docs: docs.map((doc) => doc.definition.kind),
            secrets,
          }
        } catch (error) {
          await dispose(facetHost)
          record.server = {
            ...(previous?.server ?? { tools: [], sections: [], hooks: 0, docs: [] }),
            error: String(error),
          }
          for (const listener of loadErrorListeners) listener(name, String(error))
        }
      } else if (!enabled || !record.facets.server) {
        await unload(name)
        record.actions = []
        delete record.server
      }
      if (enabled && discoveryError)
        record.server = { tools: [], sections: [], hooks: 0, docs: [], error: discoveryError }
      if (enabled && !record.server?.error) host.builds.extension(name, path)
      if (!enabled) host.builds.remove(name)
      records.set(name, record)
      targets.set(name, target)
    }
    for (const name of records.keys()) {
      if (!folders.includes(name)) {
        await unload(name)
        records.delete(name)
        targets.delete(name)
        host.extensionSources.delete(name)
        host.builds.remove(name)
      }
    }
    host.builds.refresh(winners.map(({ name, enabled }) => [name, enabled]))
    const missing = new Set(apis.missing())
    for (const message of missing) if (!missingApis.has(message)) notice(message)
    missingApis = missing
    await changed()
  }
  async function reloadSettings() {
    const winners = await discover()
    await reload(
      new Set(
        winners
          .filter((entry) => {
            const previous = records.get(entry.name)
            return (
              !previous ||
              previous.enabled !== entry.enabled ||
              previous.path !== entry.path ||
              targets.get(entry.name) !== entry.target ||
              settingsReloads.has(entry.name)
            )
          })
          .map((entry) => entry.name),
      ),
      undefined,
      winners,
    )
  }
  await reload()
  // A restarted Vite starts with an empty module graph, so the next change reloads every extension.
  let graphLost = false
  // Vite owns the transitive local module graph; query-string imports do not.
  const onChange = (file: string) => {
    if (
      closed ||
      ![host.ultimateRoot, host.projectRoot, ...roots.slice(1).map((root) => root.path)].some(
        (root) => resolve(file).startsWith(root + '/'),
      ) ||
      file.includes('/node_modules/')
    )
      return
    if (settingsFiles.includes(resolve(file))) {
      enqueue(reloadSettings)
      return
    }
    const directory = directories.find((root) => file.startsWith(root + '/'))
    if (!directory && !/\.[cm]?[jt]s$/.test(file)) return
    if (graphLost) {
      graphLost = false
      enqueue(() => reload())
      return
    }
    enqueue(async () => {
      try {
        const selected = new Set<string>()
        // Vite keys its graph by real path, while the watcher reports a symlinked extension's files through the
        // link. A file removed since the event has no real path; its link path then misses the graph, as before.
        const modules = vite.moduleGraph.getModulesByFile(await realpath(file).catch(() => file))
        const visited = new Set<import('vite-plus').ModuleNode>()
        const visit = (module: import('vite-plus').ModuleNode) => {
          if (visited.has(module)) return
          visited.add(module)
          for (const name of records.keys())
            if (module.file === join(targets.get(name)!, 'server.ts')) selected.add(name)
          for (const importer of module.importers) visit(importer)
        }
        for (const module of modules ?? []) visit(module)
        for (const module of visited) vite.moduleGraph.invalidateModule(module)
        const name = directory ? file.slice(directory.length + 1).split('/')[0] : undefined
        const servers = new Set(selected)
        if (name) {
          selected.add(name)
          if (directory && file === join(directory, name, 'server.ts')) servers.add(name)
        }
        await reload(selected, servers)
      } catch (error) {
        for (const record of records.values())
          if (record.server) record.server.error = String(error)
        throw error
      }
    })
  }
  const onStructure = (file: string) => {
    const directory = directories.find((root) => file.startsWith(root + '/'))
    if (!directory) return onChange(file)
    if (graphLost) {
      graphLost = false
      enqueue(() => reload())
      return
    }
    const name = file.slice(directory.length + 1).split('/')[0]
    enqueue(() => reload(new Set([name]), new Set([name])))
  }
  const structure = ['add', 'unlink', 'addDir', 'unlinkDir'] as const
  let attached = false
  const unwatch = watch((watcher) => {
    graphLost = attached
    attached = true
    const watchedRoots = [
      ...directories,
      ...settingsFiles,
      ...roots.slice(1).map((root) => join(root.path, 'skills')),
    ]
    watcher.add(watchedRoots)
    const stopRoots = watchRoots(watchedRoots, (root) => {
      watcher.add(root)
      enqueue(() => (settingsFiles.includes(root) ? reloadSettings() : reload()))
    })
    watcher.on('change', onChange)
    for (const event of structure) watcher.on(event, onStructure)
    return () => {
      stopRoots()
      watcher.off('change', onChange)
      for (const event of structure) watcher.off(event, onStructure)
    }
  })
  return {
    info: Object.assign(info, {
      diagnostics: () => [
        ...new Set([
          ...diagnostics,
          ...[...facetNotices.values()].flatMap((messages) => [...messages.keys()]),
          ...apis.missing(),
          ...projectDiagnostics(host.projectRoot, host.userHome),
        ]),
      ],
    }),
    action(name: string, action: string) {
      const table = actions.get(name)
      return table && Object.hasOwn(table, action) ? table[action] : undefined
    },
    invoke,
    doc: findDoc,
    catalogue: () => apis.catalogue(),
    trace: trace.reader,
    /** The harness is open: run the `onOpen` callbacks. */
    async opened() {
      trace.open()
      open = true
      for (const [name, facetHost] of facetHosts)
        for (const [message, recorded] of facetNotices.get(facetHost) ?? [])
          if (!recorded) {
            log.notice(name, message)
            facetNotices.get(facetHost)!.set(message, true)
          }
      await Promise.all([...openers].map(runOpener))
    },
    /** The harness is about to close: run the `onRelease` callbacks. */
    async released() {
      open = false
      await Promise.all([...releasers].map(runReleaser))
      trace.close()
    },
    async close() {
      closed = true
      unwatch()
      await chain
      for (const facetHost of subscriptions.keys()) await dispose(facetHost)
      const results = await Promise.allSettled([...cleanups].map(async (cleanup) => cleanup()))
      for (const result of results)
        if (result.status === 'rejected')
          notice(`Process resource cleanup failed: ${String(result.reason)}`)
      trace.close()
    },
  }
}
export function validateSecrets(
  value: unknown,
): NonNullable<NonNullable<ExtensionInfo['server']>['secrets']> {
  if (!Array.isArray(value)) throw new Error('secrets must be an array of declarations')
  return value.map((item) => {
    if (
      !item ||
      typeof item.name !== 'string' ||
      !/^[A-Z][A-Z0-9_]*$/.test(item.name) ||
      typeof item.description !== 'string' ||
      !item.description.trim()
    )
      throw new Error('secrets require an uppercase name and non-empty description')
    if (item.url !== undefined) {
      try {
        if (
          typeof item.url !== 'string' ||
          !['http:', 'https:'].includes(new URL(item.url).protocol)
        )
          throw new Error()
      } catch {
        throw new Error('secret URLs must use http(s)')
      }
    }
    if (item.provider !== undefined && (typeof item.provider !== 'string' || !item.provider))
      throw new Error('secret providers must be non-empty strings')
    return {
      name: item.name,
      description: item.description,
      ...(item.url === undefined ? {} : { url: item.url }),
      ...(item.provider === undefined ? {} : { provider: item.provider }),
    }
  })
}
export type Extensions = Awaited<ReturnType<typeof loadExtensions>>
