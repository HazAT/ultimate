import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { setImmediate as yieldIO } from 'node:timers/promises'
import { join, resolve, sep } from 'node:path'
import { applyImmutable } from '@earendil-works/chord/delta'
import type { Op } from '@earendil-works/chord/delta'
import type {
  ConversationId,
  ConversationView,
  Harness,
  TaskGraph,
} from '@earendil-works/pi-durable'
import { afterAll, inject, vi } from 'vitest'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { Tally } from '../extensions/lineage/api.ts'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { context } from '../server/harness.ts'
import { createServer, prepareServer } from '../server/main.ts'
import type { ServerOptions } from '../server/main.ts'
import type { ConversationSummary, ServerEvents, SystemInfo } from '../shared/protocol.ts'
import type { Api } from '../shared/extension-api.ts'
import type { EventData, EventToken } from '../shared/events.ts'
import { EventFeed, EventLog, eventLog } from '../server/events.ts'
import { copySource } from './source-copy.ts'
import type { Reactor } from '../server/events.ts'
import type { ExtensionHost, Opener } from '../server/extensions.ts'

vi.mock('@earendil-works/pi-ai/providers/faux', async (importOriginal) => {
  const original = await importOriginal<typeof import('@earendil-works/pi-ai/providers/faux')>()
  return {
    ...original,
    fauxProvider: (options: Parameters<typeof original.fauxProvider>[0]) =>
      original.fauxProvider({ ...options, tokensPerSecond: 0 }),
  }
})

/** Every member of `ExtensionHost`, so a member added to it fails here and its test doubles get looked at. */
const hostMembers = {
  ultimateRoot: true,
  projectRoot: true,
  userHome: true,
  home: true,
  modelRuntime: true,
  settings: true,
  build: true,
  images: true,
  uiState: true,
  scanSubmissions: true,
  models: true,
  skills: true,
  restart: true,
  chapter: true,
  access: true,
  notice: true,
  implement: true,
  need: true,
  want: true,
  catalogue: true,
  trace: true,
  resource: true,
  onOpen: true,
  onClose: true,
  onLoadError: true,
  onBeforeLoad: true,
  coreChanged: true,
  harness: true,
  system: true,
  conversations: true,
  projects: true,
  extensions: true,
  projectSetup: true,
  projectSettings: true,
  projectExtensions: true,
  setProjectDecision: true,
  reloadExtensions: true,
  invoke: true,
  doc: true,
  metadata: true,
  emit: true,
  react: true,
  eventLog: true,
} satisfies Record<keyof ExtensionHost, true>

type HostMember = keyof typeof hostMembers & keyof ExtensionHost

/** Members of a hand-built extension host, named as in `ExtensionHost`: shared fixtures check the members they supply. */
type HostMembers = { [K in HostMember]?: unknown }

/**
 * An extension host built by hand from the members a test needs. The member names are checked against `ExtensionHost`
 * (one renamed or removed fails in every test or shared fixture that sets it); their values stay as partial as the
 * test needs.
 */
export function createTestExtensionHost(members: {
  [K in HostMember]?: ExtensionHost[K] extends (...args: infer A) => unknown
    ? { method(...args: A): unknown }['method']
    : unknown
}) {
  return members as ExtensionHost
}

/**
 * `implement`, `need` and `want` over a plain map, for extension hosts built by hand. `need` resolves the provider on
 * each member access like the real handle, so a fixture may implement an API after its consumer took the handle.
 */
export function apis(provided = new Map<string, unknown>()) {
  const host = {
    implement: <S>(api: Api<string, S>, value: S) => void provided.set(api.name, value),
    want: <S>(api: Api<string, S>) => provided.get(api.name) as S | undefined,
    need: <S>(api: Api<string, S>) =>
      new Proxy(
        {},
        {
          get: (_, key) => (provided.get(api.name) as Record<string | symbol, unknown>)?.[key],
        },
      ) as S,
  } satisfies HostMembers
  return { provided, ...host }
}

/**
 * `need` for a hand-built host whose core services stay out of the test: every method resolves undefined, as a worktree
 * lookup for a conversation without one does.
 */
export const idleNeed = <S>(_api: Api<string, S>) =>
  new Proxy({}, { get: (_, key) => (key === 'then' ? undefined : async () => undefined) }) as S

/**
 * `onOpen` for a hand-built host: `open()` runs every registered opener as the server does, each with the stack its
 * cleanups go on; `close()` disposes them, newest first.
 */
export function openers() {
  const registered: Opener[] = []
  const ends: AsyncDisposableStack[] = []
  return {
    onOpen: (callback: Opener) => void registered.push(callback),
    open: async () => {
      for (const callback of registered) {
        const opened = new AsyncDisposableStack()
        ends.push(opened)
        await callback(opened)
      }
    },
    close: async () => {
      for (const opened of ends.splice(0).toReversed()) await opened.disposeAsync()
    },
  }
}

/**
 * A real event log for a hand-built host over `harness`: `emit`, and `react` as extension `name` registers reactors,
 * which run from `start()` (each harness open) until `stop()`. `settled()` holds once every event is handled.
 */
export function eventHost(harness: () => Harness, name: string) {
  const log = eventLog(
    harness,
    () => ({
      index: () => harness().snapshot(EventLog, ROOT_CONVERSATION_ID, context),
      scanEntries: async ({ conversationId, ...query }, limit, cursor, caller) =>
        (await harness().conversation(conversationId, caller))!.entries(
          query,
          limit,
          cursor,
          caller,
        ),
    }),
    (_call, work) => work(),
  )
  const reactors: ReturnType<typeof log.reactor>[] = []
  const host = {
    emit: log.emit,
    /** The event feed by its kind, as the real host's `doc` finds it; other kinds are the fixture's own. */
    doc: (kind: string) => (kind === EventFeed.definition.kind ? EventFeed : undefined),
    react: <T extends EventToken>(
      reactor: string,
      events: readonly T[],
      handler: Reactor<EventData<T>>,
    ) => void reactors.push(log.reactor(`${name}/${reactor}`, events, handler)),
    eventLog: log.eventLog,
  } satisfies HostMembers
  return {
    ...host,
    start: () => Promise.all(reactors.map((reactor) => reactor.start())),
    stop: () => Promise.all(reactors.map((reactor) => reactor.stop())),
    settled: async () =>
      (await log.eventLog.reactors()).every((reactor) => reactor.lag === 0 && !reactor.failure),
  }
}

export function cleanEnv(extra: NodeJS.ProcessEnv = {}) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('ULTIMATE_')),
    ),
    ...extra,
  }
}
// Stubs a test leaves behind end with its file; stubbing restores to unset (test/setup.ts removed ULTIMATE_*).
afterAll(() => vi.unstubAllEnvs())

// Every temp() directory is removed once the test file finishes, so runs do not fill the tmpfs.
const temps = new Set<string>()
afterAll(removeTemps, 60_000)
export async function removeTemps() {
  // Delete disjoint roots only: source copies are registered inside their fixture homes.
  const paths = [...temps]
  const roots = paths.filter((path) => !paths.some((parent) => path.startsWith(parent + sep)))
  await Promise.all(roots.map(removeTemp))
}
export async function removeTemp(path: string) {
  for (const registered of temps)
    if (registered === path || registered.startsWith(path + sep)) temps.delete(registered)
  // Best effort: a closing Vite optimizer can still be writing deps_temp, and cleanup must not fail a test.
  await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {})
}
export async function temp(prefix = 'ultimate-test-', parent = tmpdir()) {
  const path = await mkdtemp(join(parent, prefix))
  temps.add(path)
  return path
}
export { linkDependencies } from './source-copy.ts'
/**
 * Copy `shared/`, `lib/` and every extension's `api.ts` and `refs.ts` into `root`, so partially copied extensions find
 * their contracts and helpers.
 */
export async function copyApis(root: string) {
  await cp(resolve('shared'), join(root, 'shared'), { recursive: true })
  await cp(resolve('lib'), join(root, 'lib'), { recursive: true })
  for (const name of await readdir(resolve('extensions')))
    for (const file of ['api.ts', 'refs.ts']) {
      const contract = resolve('extensions', name, file)
      if (!existsSync(contract)) continue
      await mkdir(join(root, 'extensions', name), { recursive: true })
      await cp(contract, join(root, 'extensions', name, file))
    }
}
export async function sourceCopy(parent: string) {
  await mkdir(parent, { recursive: true })
  const root = await temp('source-', parent)
  await copySource(root)
  new ProjectTrustStore(join(parent, '.ultimate')).set(root, true)
  return root
}
/**
 * Give the source copy `ultimateRoot` a built-in `branch-probe` extension whose `branch` action starts a branch through
 * the lineage service, as the `branch` tool does without its message; post `{ args }` to
 * `/api/extensions/branch-probe/actions/branch`.
 */
export async function branchProbe(ultimateRoot: string) {
  const dir = join(ultimateRoot, 'extensions/branch-probe')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'server.ts'),
    `import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { LineageApi } from ${JSON.stringify(resolve('extensions/lineage/api.ts'))}
export const actions = {
  branch: (args, { host }) => host.need(LineageApi).branch(args, BACKGROUND_CONTEXT),
}
export default { name: 'branch-probe' }
`,
  )
}
type FixtureOptions = ServerOptions & {
  home: string
  userHome: string
  localSetup?: boolean
  /** Keep the first-run welcome; by default it is marked done so it does not cover the UI under test. */
  firstRun?: boolean
}
async function isolated(options: FixtureOptions) {
  const { home, userHome } = options
  const ultimateRoot =
    options.ultimateRoot === resolve('.') ? await sourceCopy(home) : options.ultimateRoot
  const projectRoot =
    !options.projectRoot || options.projectRoot === resolve('.')
      ? ultimateRoot
      : options.projectRoot
  if (options.localSetup !== false)
    new ProjectTrustStore(join(userHome, '.ultimate')).set(projectRoot, true)
  if (!options.firstRun) {
    await mkdir(join(userHome, '.ultimate'), { recursive: true })
    await writeFile(join(userHome, '.ultimate/onboarding.json'), '{"firstRunDone":true}\n')
  }
  const { firstRun: _firstRun, ...server } = options
  return {
    ...server,
    ultimateRoot,
    projectRoot,
    userHome,
    home,
    faux: options.faux ?? fauxProvider(),
    port: options.port ?? 0,
  }
}
export async function fauxServer(options: FixtureOptions) {
  const server = await createServer(await isolated(options))
  const close = server.close.bind(server)
  server.close = async () => {
    await server.vite.watcher.close()
    await close()
  }
  return server
}
/**
 * A faux server on the e2e run's shared source copy, its web UI already built (test/e2e/prebuilt-web.ts), for a test
 * that browses the built-ins without changing their files. Facets or settings of its own rebuild in its home.
 */
export async function prebuiltServer(
  options: Omit<FixtureOptions, 'ultimateRoot' | 'projectRoot'>,
) {
  const { root, web, bundle } = inject('prebuiltWeb')
  const folder = join(options.home, 'web')
  await mkdir(folder, { recursive: true })
  await cp(join(web, 'manifest.json'), join(folder, 'manifest.json'))
  await symlink(join(web, bundle), join(folder, bundle))
  return fauxServer({ ...options, ultimateRoot: root, projectRoot: root })
}
export async function prepareFauxServer(options: FixtureOptions) {
  return prepareServer(await isolated(options))
}
/** A scripted answer that never arrives: its run stays busy until it is aborted. */
export const held: FauxResponseFactory = (_context, options) =>
  new Promise((_answer, fail) =>
    options?.signal?.addEventListener('abort', () => fail(new Error('aborted'))),
  )
/**
 * Make the empty root `id` (default the project's first conversation) a tally from an empty head, as if it had read
 * nothing yet, so tests can branch from it. Does nothing when it already has entries.
 */
export async function seedTally(harness: Harness, id = 1) {
  await harness.commit(async (tx) => {
    const root = id as ConversationId
    if ((await tx.scanEntries({ conversationId: root }, 1)).items.length) return
    const entry = await tx.appendEntry(root, { kind: 'pi.reset', head: 'self' })
    ;(await tx.doc(Tally, root)).since = entry.id
  }, context)
}
export async function until(
  test: () => boolean | Promise<boolean>,
  timeout = 30000,
  tick?: () => Promise<unknown>,
) {
  const deadline = performance.now() + timeout
  while (!(await test())) {
    if (performance.now() > deadline) throw new Error('Timed out')
    await tick?.()
    await yieldIO()
  }
}
export async function post(server: string | { url: string }, path: string, data: unknown = {}) {
  const url = typeof server === 'string' ? server : server.url
  const response = await fetch(url + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url },
    body: JSON.stringify(data),
  })
  return { status: response.status, data: await response.json() }
}
/** Read `/api/events`, subscribing each stream it opens as sub 0 to a conversation (the root by default) and its documents. */
export async function attach(
  server: string | { url: string },
  subscription: { conversation?: number; docs?: string[]; view?: boolean } = {},
) {
  const url = typeof server === 'string' ? server : server.url
  const controller = new AbortController()
  const events: { name: keyof ServerEvents; data: unknown; sub?: number }[] = []
  let system: SystemInfo | undefined
  let view: ConversationView | undefined
  let conversations: ConversationSummary[] = []
  let tasks: TaskGraph | undefined
  let connections = 0
  const task = (async () => {
    while (!controller.signal.aborted) {
      try {
        const response = await fetch(url + '/api/events', { signal: controller.signal })
        if (response.status !== 200) throw new Error(`SSE status ${response.status}`)
        connections++
        const reader = response.body!.getReader()
        let wire = ''
        while (!controller.signal.aborted) {
          const result = await reader.read()
          if (result.done) break
          wire += new TextDecoder().decode(result.value)
          let index: number
          while ((index = wire.indexOf('\n\n')) !== -1) {
            const block = wire.slice(0, index)
            wire = wire.slice(index + 2)
            const name = /^event: (.+)$/m.exec(block)?.[1] as keyof ServerEvents | undefined
            // A subscription's events carry its id on the first data line.
            const lines = [...block.matchAll(/^data: (.+)$/gm)].map((match) => match[1])
            const data = lines.at(-1)
            if (!name || !data) continue
            const parsed: unknown = JSON.parse(data)
            events.push({ name, data: parsed, ...(lines.length > 1 && { sub: Number(lines[0]) }) })
            if (name === 'stream')
              void fetch(`${url}/api/events/${(parsed as { id: string }).id}`, {
                method: 'POST',
                headers: { Origin: url },
                body: JSON.stringify({ subscribe: [{ sub: 0, ...subscription }] }),
              }).catch(() => {
                // The stream ended: its reconnect subscribes again.
              })
            if (name === 'system') system = parsed as SystemInfo
            if (name === 'view') view = parsed as ConversationView
            if (name === 'ops' && view) view = applyImmutable(view, parsed as Op[])
            if (name === 'conversations') conversations = parsed as ConversationSummary[]
            if (name === 'conversationsOps')
              conversations = applyImmutable(conversations, parsed as Op[])
            if (name === 'tasks') tasks = parsed as TaskGraph
            if (name === 'tasksOps' && tasks) tasks = applyImmutable(tasks, parsed as Op[])
          }
        }
      } catch (error) {
        if (controller.signal.aborted) break
        if (!String(error).includes('fetch failed') && !String(error).includes('terminated'))
          throw error
      }
      await yieldIO()
    }
  })()
  await until(() => (subscription.view === false ? connections > 0 : !!view))
  return {
    events,
    system: () => system!,
    view: () => view!,
    /** The conversation list as the stream's snapshot and ops build it. */
    conversations: () => conversations,
    /** The task graph as the stream's snapshot and ops build it. */
    tasks: () => tasks!,
    connections: () => connections,
    async close() {
      controller.abort()
      await task
    },
  }
}
