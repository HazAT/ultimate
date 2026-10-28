import { readFileSync, writeFileSync } from 'node:fs'
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve as resolvePath } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Context } from '@earendil-works/chord'
import { Type } from '@earendil-works/pi-ai'
import type { ConversationId, ToolExecutionApi } from '@earendil-works/pi-durable'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import type { ExtensionAction } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Subagents } from '../subagents/api.ts'
import { TailscaleApi } from '../tailscale/api.ts'
import { WorkspacesApi } from '../workspaces/api.ts'
import type { WorkspaceService } from '../workspaces/api.ts'
import { cleanPreview, sweepPreviews } from './cleanup.ts'
import { implementAction } from '../../lib/actions.ts'
import { spawnGroup, stopGroup } from '../../lib/process-group.ts'
import type { Group, GroupProcess } from '../../lib/process-group.ts'
import { Previews } from '../conversations/api.ts'
import { ListAction } from './refs.ts'
import type { JsonObject } from '@earendil-works/pi-durable'
import { readSettings, userSettingsPath } from '../../lib/settings.ts'
import { readFamilies } from '../../lib/families-settings.ts'
import { BUILTIN_FAMILIES, DEFAULT_FAMILY, FEATURES } from '../../lib/families.ts'

/** Previews run every agent on the previews family's model unless `instance.model` names another or is `null`. */
export const DEFAULT_PREVIEW_MODEL = BUILTIN_FAMILIES[FEATURES.preview.family].model!

/**
 * The `instance.model` setting, project over user: the `provider/id` a preview runs every agent on, or none. Without
 * it, the model of the family previews are assigned to (`modelFamilies`, default `fast`).
 */
export async function previewModelSetting(
  host: Pick<ExtensionHost, 'userHome' | 'projectSettings' | 'projectRoot'> &
    Partial<Pick<ExtensionHost, 'settings'>>,
): Promise<string | undefined> {
  // Invalid settings JSON is reported where settings load; here it counts as unset.
  const user: JsonObject = await readSettings(userSettingsPath(host.userHome)).catch(() => ({}))
  const project = await host.projectSettings()
  for (const settings of [project, user]) {
    const instance = settings.instance
    if (instance && typeof instance === 'object' && !Array.isArray(instance))
      if (Object.hasOwn(instance, 'model')) {
        const { model } = instance
        if (model === null) return undefined
        if (typeof model !== 'string' || !/^[^/\s]+\/\S+$/.test(model))
          throw new Error(
            `Invalid instance.model ${JSON.stringify(model)}: expected "provider/id" or null`,
          )
        return model
      }
  }
  const families = await readFamilies(host.userHome, host.projectRoot, project)
  const assigned = families.assign.preview ?? FEATURES.preview.family
  const family = Object.hasOwn(families.families, assigned) ? assigned : DEFAULT_FAMILY
  const own = families.families[family].model
  if (own) return own
  // A default family without a model of its own runs Pi's default model.
  if (family === DEFAULT_FAMILY) {
    const provider = host.settings?.getDefaultProvider()
    const id = host.settings?.getDefaultModel()
    return provider && id ? `${provider}/${id}` : DEFAULT_PREVIEW_MODEL
  }
  return DEFAULT_PREVIEW_MODEL
}

/**
 * A preview keeps ordinary parent variables, but gets its own host identity, no inherited cloud settings, and
 * `ULTIMATE_MODEL` only when `model` is set.
 */
export function previewEnv(
  parent: NodeJS.ProcessEnv,
  options: { home: string; project: string; userHome: string; ownerPid: number; model?: string },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(
      Object.entries(parent).filter(
        ([key]) =>
          ![
            'ULTIMATE_SUPERVISED',
            'ULTIMATE_PUBLIC_URL',
            'ULTIMATE_GENERATION',
            'ULTIMATE_PREVIOUS_BUILD',
            'ULTIMATE_HOME',
            'ULTIMATE_PORT',
            'ULTIMATE_CLOUD_URL',
            'ULTIMATE_CLOUD_TOKEN',
            'ULTIMATE_CLOUD_MACHINE',
            'ULTIMATE_MODEL',
          ].includes(key),
      ),
    ),
    ULTIMATE_HOME: options.home,
    ULTIMATE_PROJECT: options.project,
    HOME: options.userHome,
    ULTIMATE_PORT: '0',
    ULTIMATE_NO_OPEN: '1',
    ULTIMATE_INSTANCE_OWNER: String(options.ownerPid),
    ...(options.model ? { ULTIMATE_MODEL: options.model } : {}),
  }
  return env
}

interface Instance {
  id: string
  url: string
  home: string
  pid: number
  temporary: boolean
  /** The conversation whose workspace it previews, or which started it in the shared checkout. */
  conversationId?: number
  child: GroupProcess
  group: Group
  output: string
}

const info = ({ id, url, home, pid, conversationId }: Instance) => ({
  id,
  url,
  home,
  pid,
  conversationId,
})
const live = (item: Instance) => item.child.exitCode === null && item.child.signalCode === null
/** The instances this process runs, shared by the tool and the actions; shutdown stops them all and remembers them. */
function running(host: Pick<ExtensionHost, 'resource' | 'onClose' | 'home'>) {
  const instances: Map<string, Instance> = host.resource('instance', () => {
    host.onClose(async () => {
      const served = [...instances.values()].filter((item) => item.url)
      await Promise.all([...instances.keys()].map((id) => stop(instances, id)))
      for (const item of served) remember(host, item)
    })
    return new Map<string, Instance>()
  })
  return instances
}
/** What `list` shows of a preview. */
const listed = ({
  id,
  url,
  conversationId,
}: {
  id: string
  url: string
  conversationId: number
}) => ({
  id,
  url,
  conversationId,
})
type Listed = ReturnType<typeof listed>
const portOf = (url: string) => new URL(url).port
/**
 * Previews that no longer run, by port, so that links to them can say so: the last 50, kept in the home across
 * restarts, since a restart stops every preview.
 */
export const stopped = (host: Pick<ExtensionHost, 'resource' | 'home'>) =>
  host.resource('instance.stopped', () => {
    const byPort = new Map<string, Listed>()
    try {
      const saved = JSON.parse(readFileSync(join(host.home, 'previews.json'), 'utf8')) as Listed[]
      for (const item of saved) byPort.set(portOf(item.url), item)
    } catch {
      // No previews stopped in this home yet, or an unreadable file: links to earlier ones stay ordinary links.
    }
    return byPort
  })
export function remember(
  host: Pick<ExtensionHost, 'resource' | 'home'>,
  item: Pick<Instance, 'id' | 'url' | 'conversationId'>,
) {
  if (item.conversationId === undefined) return
  const byPort = stopped(host)
  byPort.delete(portOf(item.url))
  byPort.set(portOf(item.url), listed({ ...item, conversationId: item.conversationId }))
  for (const port of [...byPort.keys()].slice(0, -50)) byPort.delete(port)
  writeFileSync(join(host.home, 'previews.json'), JSON.stringify([...byPort.values()]))
}
async function stop(instances: Map<string, Instance>, id: string) {
  const instance = instances.get(id)
  if (!instance) throw new Error(`Unknown instance: ${id}`)
  // The whole group: the preview and whatever it started without a group of its own. Its unreaped leader proves the
  // group is still ours; once it exited, the group stopped with it.
  if (instance.child.pid !== undefined)
    await stopGroup(instance.child.pid, { leader: instance.group, grace: 5000 })
  if (instance.temporary) {
    await unlink(join(instance.home, 'ultimate.lock')).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    await cleanPreview(instance.home)
  }
  instances.delete(id)
}

/**
 * Where the tailnet reaches each preview, by pid. A preview's own `tailscale` extension records its HTTPS port in
 * the user's registry under an owner token that starts with its pid; the host's tailscale status knows the DNS name.
 */
async function tailnet(host: Pick<ExtensionHost, 'want' | 'userHome'>) {
  const published = host.want(TailscaleApi)?.status().url
  if (!published) return new Map<number, string>()
  let registry: { ports?: Record<string, { port: number; owner: string }> }
  try {
    registry = JSON.parse(await readFile(join(host.userHome, '.ultimate/tailscale.json'), 'utf8'))
  } catch {
    // Missing or unreadable, the registry names no addresses; the previews themselves still list.
    return new Map<number, string>()
  }
  const { hostname } = new URL(published)
  return new Map(
    Object.values(registry.ports ?? {}).map(({ port, owner }) => [
      Number(owner.split(':')[0]),
      `https://${hostname}:${port}`,
    ]),
  )
}

export const actions: Record<string, ExtensionAction> = {
  /**
   * The instances that served their UI, running or not since, for the title bar's switcher and preview links. A start
   * that failed is not among them.
   */
  list: implementAction(ListAction, async (_args, { host }) => {
    const addresses = await tailnet(host)
    return [
      ...[...running(host).values()]
        .filter((item) => item.url && item.conversationId !== undefined)
        .map((item) => ({
          ...listed({ ...item, conversationId: item.conversationId! }),
          running: live(item),
          ...(live(item) && addresses.has(item.pid) && { tailnet: addresses.get(item.pid) }),
        })),
      ...[...stopped(host).values()]
        .filter((item) => ![...running(host).values()].some((run) => run.url === item.url))
        .map((item) => ({ ...item, running: false })),
    ]
  }),
}

/**
 * The workspace a preview of conversation `id` serves: its own, else the nearest owner's (a subagent without an isolate
 * works in its parent's worktree, at any depth); undefined means the host checkout.
 */
export async function previewWorkspace(
  host: Pick<ExtensionHost, 'harness'>,
  workspaces: Pick<WorkspaceService, 'get'>,
  id: ConversationId,
  context: Context,
) {
  let current: ConversationId | undefined = id
  while (current !== undefined) {
    const workspace = await workspaces.get(current, context)
    if (workspace) return workspace
    const at: ConversationId = current
    current = (await host.harness().commit((tx) => tx.conversation(at), context))?.owner
      ?.conversationId
  }
  return undefined
}

export default function instanceExtension(
  host: Pick<
    ExtensionHost,
    | 'need'
    | 'implement'
    | 'want'
    | 'resource'
    | 'onClose'
    | 'onOpen'
    | 'notice'
    | 'home'
    | 'ultimateRoot'
    | 'projectRoot'
    | 'userHome'
    | 'modelRuntime'
    | 'harness'
    | 'projectSettings'
    | 'extensions'
    | 'metadata'
  >,
) {
  // Tailscale is optional and resolved where it is called; declared here so the catalogue lists it. Workspaces is core.
  host.want(TailscaleApi)
  const workspaces = host.need(WorkspacesApi)
  const instances = running(host)
  const starts = host.resource('instance.starts', () => ({ pending: 0 }))
  const ownSource = host.projectRoot === host.ultimateRoot
  host.onOpen(async () => {
    void sweepPreviews(tmpdir(), host.notice).catch((error: unknown) => {
      host.notice(`Preview sweep failed: ${String(error)}`)
    })
  })
  async function start(
    args: { home?: string },
    context: Context,
    prepare: () => Promise<{ cwd: string; project: string; conversationId?: number }>,
    output: (text: string) => void = () => {},
  ) {
    let reserved = false
    let pendingHome: string | undefined
    try {
      context.abortSignal?.throwIfAborted()
      if ([...instances.values()].filter(live).length + starts.pending >= 3)
        throw new Error('At most three instances may run at once')
      starts.pending++
      reserved = true
      const { cwd, project, conversationId } = await prepare()
      let home: string
      if (args.home) {
        await mkdir(resolvePath(args.home), { recursive: true })
        home = await realpath(resolvePath(args.home))
      } else {
        // Publish only after the parent's lease exists, so another host's sweep cannot race startup.
        const staging = await mkdtemp(join(tmpdir(), '.ultimate-instance-'))
        home = join(tmpdir(), basename(staging).slice(1))
        try {
          await writeFile(join(staging, 'ultimate.lock'), JSON.stringify({ pid: process.pid }))
          await writeFile(join(staging, 'project.json'), JSON.stringify({ root: project }))
          await rename(staging, home)
          pendingHome = home
        } catch (error) {
          await rm(staging, { recursive: true, force: true })
          throw error
        }
      }
      if (home === (await realpath(host.home)))
        throw new Error('A test instance cannot share the running server home')
      if ([...instances.values()].some((item) => item.home === home && live(item)))
        throw new Error('Home is already owned by an instance')
      context.abortSignal?.throwIfAborted()
      // Explicit homes are retained even when their name matches the automatic sweep's prefix.
      if (args.home) await writeFile(join(home, 'instance-preserve'), '')
      const env = previewEnv(process.env, {
        home,
        project,
        userHome: host.userHome,
        ownerPid: process.pid,
        model: await previewModelSetting(host),
      })
      // No pid file: a preview exits by itself once its owner is gone (ULTIMATE_INSTANCE_OWNER).
      const group = spawnGroup(process.execPath, ['server/main.ts'], {
        cwd,
        env,
        grace: 5000,
      })
      const { child } = group
      const id = randomUUID()
      const item: Instance = {
        id,
        url: '',
        home,
        pid: child.pid ?? 0,
        temporary: !args.home,
        conversationId,
        child,
        group,
        output: '',
      }
      instances.set(id, item)
      pendingHome = undefined
      starts.pending--
      reserved = false
      const append = (chunk: Buffer) => {
        item.output = (item.output + chunk.toString())
          .split('\n')
          .slice(-200)
          .join('\n')
          .slice(-100000)
      }
      let stdout = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        append(chunk)
        stdout += chunk.toString()
        const lines = stdout.split('\n')
        stdout = lines.pop()!.slice(-10000)
        for (const line of lines) {
          const match = /^Ultimate: (http:\/\/127\.0\.0\.1:([1-9]\d*))\r?$/.exec(line)
          if (match) item.url = match[1]
        }
      })
      child.stderr?.on('data', append)
      let failed = false
      child.on('error', (error) => {
        failed = true
        item.output += String(error)
      })
      try {
        output(`Starting ${id}\n`)
        const deadline = Date.now() + 60000
        let ready = false
        while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
          context.abortSignal?.throwIfAborted()
          if (failed) break
          try {
            const response = item.url
              ? await fetch(`${item.url}/api/models`, {
                  signal: context.abortSignal
                    ? AbortSignal.any([context.abortSignal, AbortSignal.timeout(1000)])
                    : AbortSignal.timeout(1000),
                })
              : undefined
            if (response?.ok && !failed && child.exitCode === null && child.signalCode === null) {
              ready = true
              break
            }
          } catch {
            /* server is still booting */
          }
          await sleep(250, undefined, { signal: context.abortSignal })
        }
        context.abortSignal?.throwIfAborted()
        if (!ready) throw new Error(`Instance did not become ready:\n${item.output}`)
        return info(item)
      } catch (error) {
        await stop(instances, id)
        throw error
      }
    } catch (error) {
      if (pendingHome) {
        await unlink(join(pendingHome, 'ultimate.lock'))
        await cleanPreview(pendingHome)
      }
      throw error
    } finally {
      if (reserved) starts.pending--
    }
  }

  async function toolWorkspace(
    args: { subagent?: number },
    api: ToolExecutionApi,
    context: Context,
  ) {
    let cwd = host.ultimateRoot
    let project = host.projectRoot
    let conversationId = api.conversationId
    if (args.subagent !== undefined) {
      const child = (await api.snapshot(Subagents, api.conversationId, context))?.agents[
        String(args.subagent)
      ]
      if (!child) throw new Error(`Unknown subagent: ${args.subagent}`)
      conversationId = child.conversationId
    }
    const workspace =
      args.subagent === undefined
        ? await previewWorkspace(host, workspaces, conversationId, context)
        : await workspaces.get(conversationId, context)
    if (args.subagent !== undefined && !workspace)
      throw new Error('Subagent must have an active worktree isolate')
    if (workspace) {
      if (workspace.state !== 'ready')
        throw new Error('Preview requires an active, ready workspace')
      project = workspace.path
      // In another project the workspace holds that project, so the host's Ultimate runs it.
      if (ownSource) {
        cwd = workspace.path
        for (const [path, directory, message] of [
          ['server/main.ts', false, 'Worktree is not Ultimate: missing server/main.ts'],
          ['node_modules', true, 'Worktree has no node_modules; run pnpm install first'],
        ] as const) {
          const entry = await stat(join(cwd, path)).catch(
            // An unreadable prerequisite fails the explicit preview validation below.
            () => undefined,
          )
          if (!entry || (directory ? !entry.isDirectory() : !entry.isFile()))
            throw new Error(message)
        }
      }
    }
    return { cwd, project, conversationId }
  }

  // Concluding a conversation stops the previews it started; previews outlive an ordinary stop of its run.
  host.implement(Previews, {
    stop: async (ids) => {
      const concluded = new Set(ids)
      const ended = []
      // Deleting the visited entry while iterating a Map is safe.
      for (const item of instances.values()) {
        if (item.conversationId === undefined || !concluded.has(item.conversationId)) continue
        await stop(instances, item.id)
        if (item.url) remember(host, item)
        ended.push(item.id)
      }
      return ended
    },
  })
  return defineExtension({
    name: 'instance',
    sections: [
      section('test_core_changes', () =>
        ownSource
          ? 'Before restarting after core changes, start a second instance, check its API and UI using browser/screenshot, then stop it. An instance runs every agent on the `instance.model` setting (default openai-codex/gpt-6.1-sol, fast) and spends tokens; drive it with real prompts. Instances are temporary and process-local.'
          : "To check changes to this project's .ultimate/ extensions, agents or settings, start a second instance: it runs this Ultimate with your workspace as its project. Look at it with browser/screenshot, then stop it. It runs every agent on the `instance.model` setting (default openai-codex/gpt-6.1-sol, fast) and spends tokens. It does not run the project's own app.",
      ),
    ],
    tools: [
      defineTool({
        name: 'instance',
        description:
          'Start, inspect logs, list or stop isolated standalone Ultimate test servers (maximum three). Defaults to the calling workspace; set subagent to preview an owned child worktree. Instances run every agent on `instance.model` (default openai-codex/gpt-6.1-sol, fast).',
        parameters: Type.Object({
          action: Type.Union(
            ['start', 'stop', 'logs', 'list'].map((action) => Type.Literal(action)),
          ),
          id: Type.Optional(Type.String()),
          home: Type.Optional(Type.String()),
          subagent: Type.Optional(Type.Integer({ minimum: 1 })),
        }),
        async execute(args, api, context) {
          try {
            context.abortSignal?.throwIfAborted()
            let result: unknown
            if (args.action === 'list') result = [...instances.values()].filter(live).map(info)
            else if (args.action === 'stop') {
              const item = instances.get(args.id ?? '')
              await stop(instances, args.id ?? '')
              if (item?.url) remember(host, item)
              result = { stopped: args.id }
            } else if (args.action === 'logs') {
              const item = instances.get(args.id ?? '')
              if (!item) throw new Error(`Unknown instance: ${args.id}`)
              result = item.output.split('\n').slice(-200).join('\n')
            } else {
              result = await start(
                args,
                context,
                () => toolWorkspace(args, api, context),
                (text) => api.output(text),
              )
            }
            return { output: [{ type: 'text', text: JSON.stringify(result) }] }
          } catch (error) {
            return { isError: true, output: [{ type: 'text', text: String(error) }] }
          }
        },
      }),
    ],
  })
}
