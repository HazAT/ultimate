import type {
  ConversationId,
  ConversationDocToken,
  Extension,
  Harness,
  JsonObject,
} from '@earendil-works/pi-durable'
import { readFile, realpath } from 'node:fs/promises'
import { existsSync, lstatSync, watch as watchDirectory } from 'node:fs'
import { compareExtensions, discoverExtensions, webFacet } from '../lib/discovery.ts'
import {
  decisionRoot,
  projectSetup,
  projectSettings,
  projectDiagnostics,
} from '../lib/project-setup.ts'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { projects } from './project.ts'
import { discoveryRoots } from '../lib/project-paths.ts'
import type { ProjectInfo } from './project.ts'
import { extensionSettingsFiles } from '../lib/extension-settings.ts'
import { watchRoots } from './watch-roots.ts'
import { actionExec } from './actions.ts'
import type { ExtensionAction } from './actions.ts'
import type { JsonValue } from '@earendil-works/chord/json'
import { join, resolve } from 'node:path'
import type { ViteDevServer } from 'vite-plus'
import type { ConversationSummary, ExtensionInfo, SystemInfo } from '../shared/protocol.ts'
import type { PreparedHost } from './harness.ts'
import { Metadata } from './metadata.ts'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { AgentDoc, LiveDoc } from '@earendil-works/pi-durable'
import type { Access } from './request-security.ts'
import { EventFeed, eventLog, uiChange } from './events.ts'
import { contractOutline } from '../lib/api-files.ts'
import type { EventHost } from './events.ts'
import { extensionApis } from './extension-apis.ts'
import type { TraceReader } from './trace.ts'
import type { Api, Catalogue } from '../shared/extension-api.ts'
import { inExtensionTests } from '../shared/extension-api.ts'
import { secretMetadata } from '../lib/secrets.ts'
import { ChangedEvent } from '../shared/events.ts'
import type { Device, UiSource } from '../shared/events.ts'
import { inProcess, isMissing, meansNone } from '../lib/errors.ts'

export type ExtensionHost = Pick<
  PreparedHost,
  | 'ultimateRoot'
  | 'projectRoot'
  | 'userHome'
  | 'home'
  | 'modelRuntime'
  | 'settings'
  | 'build'
  | 'images'
  | 'uiState'
  | 'scanSubmissions'
  | 'models'
  | 'skills'
  | 'restart'
  | 'chapter'
> & {
  access: Pick<Access, 'allow'>
  notice(message: string, options?: { untilSecretSet?: string }): void
  implement<S>(api: Api<string, S>, value: NoInfer<S>): void
  need<S>(api: Api<string, S>): S
  want<S>(api: Api<string, S>): S | undefined
  catalogue(): Catalogue
  trace: TraceReader
  resource<T>(key: string, create: () => T): T
  onOpen(callback: Opener): void
  onClose(cleanup: () => Promise<void>): void
  onLoadError(callback: (name: string, error: string) => void): void
  onBeforeLoad(callback: () => Promise<void>): void
  harness(): Harness
  system(): SystemInfo
  conversations(): ConversationSummary[]
  projects(): Promise<ProjectInfo[]>
  extensions(): ExtensionInfo[]
  projectSetup(): ReturnType<typeof projectSetup>
  projectSettings(): Promise<JsonObject>
  projectExtensions(): Promise<ExtensionInfo[]>
  setProjectDecision(local: boolean): Promise<void>
  reloadExtensions(): Promise<void>
  invoke(
    name: string,
    action: string,
    args: JsonValue,
    signal: AbortSignal,
    conversationId?: ConversationId,
  ): Promise<unknown>
  doc(kind: string): ConversationDocToken<JsonObject> | undefined
  metadata: typeof Metadata
} & EventHost
export type Opener = (opened: AsyncDisposableStack) => Promise<void>
export type Watch = (attach: (watcher: ViteDevServer['watcher']) => () => void) => () => void
export async function loadExtensions(
  vite: ViteDevServer,
  host: PreparedHost,
  changed: () => void | Promise<void>,
  runtime: Pick<ExtensionHost, 'harness' | 'system' | 'conversations' | 'access'>,
  watch: Watch,
  notice: (message: string) => void = () => {},
  rebuildWeb: () => Promise<void> = async () => {},
) {
  const trace = host.callTrace
  const log = eventLog(runtime.harness, trace.run, trace.keep)
  const roots = discoveryRoots(host.ultimateRoot, host.projectRoot, host.userHome)
  const directories = roots.map((root) => join(root.path, 'extensions'))
  const stagedServicesByFacet = new Map<ExtensionHost, Map<string, unknown>>()
  const providers = new Map<string, { owner: ExtensionHost; value: unknown }>()
  const facetHosts = new Map<string, ExtensionHost>()
  const subscriptions = new Map<ExtensionHost, Set<() => void>>()
  const facetOpeners = new Map<ExtensionHost, Set<Opener>>()
  const facetCleanups = new Map<ExtensionHost, Set<() => Promise<void>>>()
  type FacetNotice = { recordedInEventLog: boolean; untilSecretSet?: string }
  const facetNotices = new Map<ExtensionHost, Map<string, FacetNotice>>()
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
    stagedServicesByFacet.delete(facetHost)
    for (const stop of subscriptions.get(facetHost) ?? []) stop()
    subscriptions.delete(facetHost)
    for (const callback of facetOpeners.get(facetHost) ?? []) {
      openers.delete(callback)
      await endOpen(callback)
    }
    facetOpeners.delete(facetHost)
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
    const onFacetOpen = (callback: Opener) => {
      facetOpeners.get(facetHost)!.add(callback)
      openers.add(callback)
      if (open && [...facetHosts.values()].includes(facetHost))
        inProcess('the onOpen callback belongs to this loaded extension facet', runOpener(callback))
    }
    const facetHost = {
      ...extensionHost,
      get chapter() {
        return extensionHost.chapter
      },
      implement: (api, value) => {
        stagedServicesByFacet.get(facetHost)!.set(api.name, value)
        if (facetHosts.get(name) === facetHost) providers.set(api.name, { owner: facetHost, value })
      },
      need: <S>(api: Api<string, S>): S =>
        apis.need(facetHost, name, api, facetHosts.get(name) !== facetHost),
      want: <S>(api: Api<string, S>): S | undefined => apis.want(facetHost, name, api),
      notice: (message, options) => {
        const messages = facetNotices.get(facetHost)
        const facetWasDisposed = !messages
        if (facetWasDisposed) return
        const firstNoticeOfMessageThisFacetLoad = !messages.has(message)
        if (firstNoticeOfMessageThisFacetLoad) {
          messages.set(message, { recordedInEventLog: open, ...options })
          if (open) log.notice(name, message)
        }
        notice(message)
        inProcess(
          'extension change notifications belong to this extension host',
          Promise.resolve(changed()).catch((error: unknown) =>
            console.error('Publishing extension changes failed:', error),
          ),
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
        else onFacetOpen(callback)
      },
      onClose: (cleanup) => {
        if (sharedResource) extensionHost.onClose(cleanup)
        else facetCleanups.get(facetHost)!.add(cleanup)
      },
      onLoadError: (callback) => {
        loadErrorListeners.add(callback)
        stops.add(() => loadErrorListeners.delete(callback))
      },
      onBeforeLoad: (callback) => {
        beforeLoad.add(callback)
        stops.add(() => beforeLoad.delete(callback))
      },
      react: (reactorName, tokens, handler, options) => {
        const reactor = log.reactor(`${name}/${reactorName}`, tokens, handler, options)
        onFacetOpen(async (opened) => {
          opened.defer(reactor.stop)
          await reactor.start()
        })
      },
    } satisfies ExtensionHost
    stagedServicesByFacet.set(facetHost, new Map())
    subscriptions.set(facetHost, stops)
    facetOpeners.set(facetHost, new Set())
    facetCleanups.set(facetHost, new Set())
    facetNotices.set(facetHost, new Map())
    return facetHost
  }
  const actions = new Map<string, Record<string, ExtensionAction>>()
  const userActions = new Map<string, string[]>()
  const pollActions = new Map<string, string[]>()
  const settingsReloads = new Set<string>()
  const records = new Map<string, ExtensionInfo>()
  const targets = new Map<string, string>()
  const documents = new Map<string, ConversationDocToken<JsonObject>[]>()
  const findDoc = (kind: string) =>
    [
      EventFeed as never as ConversationDocToken<JsonObject>,
      LiveDoc as never as ConversationDocToken<JsonObject>,
      ...[...documents.values()].flat(),
    ].find((doc) => doc.definition.kind === kind)
  const openers = new Set<Opener>()
  type OpenRun = { run: Promise<void>; opened: AsyncDisposableStack; ending?: Promise<void> }
  const openRuns = new Map<Opener, OpenRun>()
  const runOpener = (callback: Opener) => {
    const startedThisOpen = openRuns.get(callback)
    if (startedThisOpen && !startedThisOpen.ending) return startedThisOpen.run
    const opened = new AsyncDisposableStack()
    const run = (async () => {
      await startedThisOpen?.ending
      try {
        await callback(opened)
      } catch (error) {
        console.error('Extension onOpen:', error)
        await opened.disposeAsync()
      }
    })().catch((error: unknown) => notice(`Extension open cleanup failed: ${String(error)}`))
    openRuns.set(callback, { run, opened })
    return run
  }
  const endOpen = async (callback: Opener) => {
    const current = openRuns.get(callback)
    if (!current) return
    current.ending ??= (async () => {
      try {
        await current.run
        await current.opened.disposeAsync()
      } catch (error) {
        notice(`Extension open cleanup failed: ${String(error)}`)
      } finally {
        if (openRuns.get(callback) === current) openRuns.delete(callback)
      }
    })()
    await current.ending
  }
  const loadErrorListeners = new Set<(name: string, error: string) => void>()
  const beforeLoad = new Set<() => Promise<void>>()
  async function preparationError() {
    let failed: string | undefined
    for (const callback of beforeLoad)
      try {
        await callback()
      } catch (error) {
        failed ??= error instanceof Error ? error.message : String(error)
      }
    return failed
  }
  let lastReportedPreparationFailure: string | undefined
  async function prepareLoadBestEffort() {
    const failed = await preparationError()
    if (failed && failed !== lastReportedPreparationFailure) notice(`Loading as it is: ${failed}`)
    lastReportedPreparationFailure = failed
    const modules = join(host.ultimateRoot, 'node_modules')
    for (const environment of Object.values(vite.environments))
      await environment.pluginContainer.watchChange(modules, { event: 'create' })
  }
  let open = false
  const cleanups = new Set<() => Promise<void>>()
  const resources = new Map<string, unknown>()
  async function invoke(
    name: string,
    action: string,
    args: JsonValue,
    signal: AbortSignal,
    conversationId?: ConversationId,
    caller = 'ui',
    device?: Device,
    source: UiSource = { source: 'person' },
  ) {
    if (caller === 'agent' && userActions.get(name)?.includes(action))
      throw new Error(`${name}/${action} is a user-only action`)
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
    const by = caller === 'agent' ? { source: 'agent' as const } : { ...source, ...device }
    return trace.run({ kind: 'action', ...call, ...(poll ? { poll } : {}) }, () =>
      fn(args, {
        host: facetHosts.get(name)!,
        conversationId,
        ...(device ? { device } : {}),
        by,
        uiChanged: async (tx, change) => {
          const data = uiChange(by, { ...change, conversation: conversationId })
          if (data) await log.emit(tx, ChangedEvent, data)
        },
        signal,
        exec: async (command, commandArgs, options) => {
          const agent =
            conversationId === undefined
              ? undefined
              : await runtime.harness().snapshot(AgentDoc, conversationId, BACKGROUND_CONTEXT)
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
    invoke: (name, action, args, signal, conversationId) =>
      invoke(name, action, args, signal, conversationId, 'agent'),
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
      if (open) inProcess('the onOpen callback belongs to this extension host', runOpener(callback))
    },
    onClose: (cleanup) => cleanups.add(cleanup),
    onLoadError: (callback) => loadErrorListeners.add(callback),
    onBeforeLoad: (callback) => beforeLoad.add(callback),
    ultimateRoot: host.ultimateRoot,
    projectRoot: host.projectRoot,
    userHome: host.userHome,
    home: host.home,
    modelRuntime: host.modelRuntime,
    settings: host.settings,
    build: host.build,
    images: host.images,
    uiState: (caller) => host.uiState(caller),
    scanSubmissions: (query, limit, cursor, caller) =>
      host.scanSubmissions(query, limit, cursor, caller),
    models: () => host.models(),
    skills: (cwd) => host.skills(cwd),
    restart: async (approved) => (await preparationError()) ?? host.restart(approved),
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
            web: webFacet(entry.files) !== undefined,
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
      const work = chain
        .then(() => (closed ? undefined : prepareLoadBestEffort()))
        .then(() => (closed ? undefined : reloadSettings()))
      const recoveredQueueForLaterReloads = work.catch(() => changed())
      chain = recoveredQueueForLaterReloads
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
  function enqueue(work: () => Promise<void>) {
    chain = chain
      .then(() => (closed ? undefined : prepareLoadBestEffort()))
      .then(() => (closed ? undefined : work()))
      .catch((error: unknown) => {
        notice(`Extension reload failed: ${String(error)}`)
        return changed()
      })
  }
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
  const discoveryFailed = new Set<string>()
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
        .map((entry) => ({ ...entry, enabled: false, missing: [] })),
    ].toSorted(compareExtensions)
    return Object.assign(winners, { settings: active.settings })
  }
  async function reload(
    selected?: Set<string>,
    servers = selected,
    winners?: Awaited<ReturnType<typeof discover>>,
  ) {
    winners ??= await discover()
    for (const winner of winners) {
      const previous = records.get(winner.name)
      if (
        selected &&
        (!previous ||
          previous.enabled !== winner.enabled ||
          (previous.offForMissing ?? []).join() !== winner.missing.join() ||
          (discoveryFailed.has(winner.name) && !winner.error))
      ) {
        selected.add(winner.name)
        servers?.add(winner.name)
      }
    }
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
      ...winners
        .filter((winner) => winner.missing.length)
        .map(
          (winner) =>
            `${winner.name} stays off: it requires ${winner.missing.join(' and ')}, which ${winner.missing.length === 1 ? 'is' : 'are'} off`,
        ),
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
      requires,
      missing,
      error: discoveryError,
    } of winners) {
      if (closed) return
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
        ...(requires ? { requires } : {}),
        ...(missing.length ? { offForMissing: missing } : {}),
        layer,
        actions: Object.keys(actions.get(name) ?? {}),
        events: (await contractOutline({ name, path, enabled })).events,
        readme,
        facets: { server: files.includes('server.ts'), web: webFacet(files) !== undefined },
        ...(previous?.server ? { server: previous.server } : {}),
      }
      if (enabled && record.facets.server && (!servers || servers.has(name))) {
        const facetHost = scope(name)
        try {
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
          const secrets = validateSecrets(
            typeof module.secrets === 'function'
              ? await module.secrets(facetHost)
              : (module.secrets ?? []),
          )
          const sameLayerToolConflicts = host.registry
            .snapshot()
            .tools()
            .filter(
              (entry) =>
                entry.extension.name !== name &&
                host.extensionSources.get(entry.extension.name) === source &&
                extension.tools?.some((tool) => tool.name === entry.tool.name),
            )
            .map((entry) => `${entry.tool.name} is already provided by ${entry.extension.name}`)
          if (sameLayerToolConflicts.length) throw new Error(sameLayerToolConflicts.join('; '))
          host.registry.install(trace.tools(extension))
          const previousHost = facetHosts.get(name)
          facetHosts.set(name, facetHost)
          for (const [key, value] of stagedServicesByFacet.get(facetHost)!)
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
      if (enabled && discoveryError) {
        record.server = { tools: [], sections: [], hooks: 0, docs: [], error: discoveryError }
        discoveryFailed.add(name)
      } else discoveryFailed.delete(name)
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
  let reloadAllAfterGraphReplacement = false
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
    if (directory && inExtensionTests(file.slice(directory.length + 1))) return
    if (reloadAllAfterGraphReplacement) {
      reloadAllAfterGraphReplacement = false
      enqueue(() => reload())
      return
    }
    enqueue(async () => {
      try {
        const selected = new Set<string>()
        const modulesByRealPathOrRemovedLink = vite.moduleGraph.getModulesByFile(
          await realpath(file).catch(() => file),
        )
        const visited = new Set<import('vite-plus').ModuleNode>()
        const visit = (module: import('vite-plus').ModuleNode) => {
          if (visited.has(module)) return
          visited.add(module)
          for (const name of records.keys())
            if (module.file === join(targets.get(name)!, 'server.ts')) selected.add(name)
          for (const importer of module.importers) visit(importer)
        }
        for (const module of modulesByRealPathOrRemovedLink ?? []) visit(module)
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
    if (inExtensionTests(file.slice(directory.length + 1))) return
    if (reloadAllAfterGraphReplacement) {
      reloadAllAfterGraphReplacement = false
      enqueue(() => reload())
      return
    }
    const name = file.slice(directory.length + 1).split('/')[0]
    enqueue(() => reload(new Set([name]), new Set([name])))
  }
  const structure = ['add', 'unlink', 'addDir', 'unlinkDir'] as const
  const watchRemovals = (directory: string) => {
    try {
      return watchDirectory(directory, (_event, name) => {
        if (closed || !name || records.get(name)?.path !== join(directory, name)) return
        if (lstatSync(join(directory, name), { throwIfNoEntry: false })) return
        enqueue(() => reload(new Set([name])))
      })
    } catch (error) {
      if (!isMissing(error)) throw error
      return undefined
    }
  }
  let attached = false
  const unwatch = watch((watcher) => {
    reloadAllAfterGraphReplacement = attached
    attached = true
    const watchedRoots = [
      ...directories,
      ...settingsFiles,
      ...roots.slice(1).map((root) => join(root.path, 'skills')),
    ]
    watcher.add(watchedRoots)
    const entries = new Map(directories.map((directory) => [directory, watchRemovals(directory)]))
    const stopRoots = watchRoots(watchedRoots, (root) => {
      watcher.add(root)
      if (entries.has(root)) {
        entries.get(root)?.close()
        entries.set(root, watchRemovals(root))
      }
      enqueue(() => (settingsFiles.includes(root) ? reloadSettings() : reload()))
    })
    watcher.on('change', onChange)
    for (const event of structure) watcher.on(event, onStructure)
    return () => {
      stopRoots()
      for (const entry of entries.values()) entry?.close()
      watcher.off('change', onChange)
      for (const event of structure) watcher.off(event, onStructure)
    }
  })
  return {
    info: Object.assign(info, {
      diagnostics: async () => {
        const storedSecrets = new Set(
          (await secretMetadata(host.userHome).catch(meansNone))?.map((secret) => secret.name),
        )
        return [
          ...new Set([
            ...diagnostics,
            ...[...facetNotices.values()].flatMap((messages) =>
              [...messages]
                .filter(
                  ([, { untilSecretSet }]) => !untilSecretSet || !storedSecrets.has(untilSecretSet),
                )
                .map(([message]) => message),
            ),
            ...apis.missing(),
            ...projectDiagnostics(host.projectRoot, host.userHome),
          ]),
        ]
      },
    }),
    action(name: string, action: string) {
      const table = actions.get(name)
      return table && Object.hasOwn(table, action) ? table[action] : undefined
    },
    invoke,
    doc: findDoc,
    catalogue: () => apis.catalogue(),
    trace: trace.reader,
    restartRefusal: preparationError,
    prepareLoadBestEffort,
    async opened() {
      trace.open()
      open = true
      for (const [name, facetHost] of facetHosts)
        for (const [message, recorded] of facetNotices.get(facetHost) ?? [])
          if (!recorded.recordedInEventLog) {
            log.notice(name, message)
            recorded.recordedInEventLog = true
          }
      await Promise.all([...openers].map(runOpener))
    },
    async released() {
      open = false
      await Promise.all([...openRuns.keys()].map(endOpen))
      trace.close()
    },
    async close() {
      closed = true
      unwatch()
      await chain
      for (const facetHost of subscriptions.keys()) await dispose(facetHost)
      await Promise.all([...openRuns.keys()].map(endOpen))
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
