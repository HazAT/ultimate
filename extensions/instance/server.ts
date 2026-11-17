import type { ConversationId, ToolExecutionApi, JsonObject } from '@earendil-works/pi-durable'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import {
  cp,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve as resolvePath } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Context } from '@earendil-works/chord/context'
import { int, nullable, obj, opt, str } from '@earendil-works/pi-schema'
import { strEnum } from '../../lib/schema.ts'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import type { ExtensionAction } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Subagents } from '../subagents/api.ts'
import { TailscaleApi } from '../tailscale/api.ts'
import { WorkspacesApi } from '../workspaces/api.ts'
import type { WorkspaceService } from '../workspaces/api.ts'
import { cleanPreview, makeOwnerWritable, sweepPreviews } from './cleanup.ts'
import { implementAction } from '../../lib/actions.ts'
import { git, isolatable } from '../../lib/git.ts'
import { inProcess, rebuiltOnOpen, meansNone, overshadowed } from '../../lib/errors.ts'
import { spawnGroup, stopGroup, sweepPidFiles } from '../../lib/process-group.ts'
import { every, within } from '../../lib/timers.ts'
import type { Cancel } from '../../lib/timers.ts'
import type { Group, GroupProcess } from '../../lib/process-group.ts'
import { Previews } from '../conversations/api.ts'
import { ListAction, StartAction, StopAction } from './refs.ts'
import { setup } from '../../lib/worktree-setup.ts'
import { readSettings, userSettingsPath } from '../../lib/settings.ts'
import { readFamilies } from '../../lib/families-settings.ts'
import { BUILTIN_FAMILIES, DEFAULT_FAMILY, FEATURES } from '../../lib/families.ts'

export const DEFAULT_PREVIEW_MODEL = BUILTIN_FAMILIES[FEATURES.preview.family].model!

export async function previewModelSetting(
  host: Pick<ExtensionHost, 'userHome' | 'projectSettings' | 'projectRoot'> &
    Partial<Pick<ExtensionHost, 'settings'>>,
): Promise<string | undefined> {
  const userSettingsOrUnset: JsonObject = await readSettings(userSettingsPath(host.userHome)).catch(
    () => ({}),
  )
  const project = await host.projectSettings()
  for (const settings of [project, userSettingsOrUnset]) {
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
  const unpinnedPiDefault = family === DEFAULT_FAMILY
  if (unpinnedPiDefault) {
    const provider = host.settings?.getDefaultProvider()
    const id = host.settings?.getDefaultModel()
    return provider && id ? `${provider}/${id}` : DEFAULT_PREVIEW_MODEL
  }
  return DEFAULT_PREVIEW_MODEL
}

const PRIVATE_CONFIG_COPIES = [
  'settings.json',
  'model-families.json',
  'trust.json',
  'onboarding.json',
  'secrets.json',
  'claude-accounts.json',
  'agents',
  'skills',
]
const SHARED_CODE_AND_REGISTRY = ['extensions', 'tailscale.json']

export async function seedUserHome(from: string, to: string) {
  const source = join(from, '.ultimate')
  const target = join(to, '.ultimate')
  await mkdir(target, { recursive: true, mode: 0o700 })
  const missing = (error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  }
  for (const name of PRIVATE_CONFIG_COPIES)
    await cp(join(source, name), join(target, name), {
      recursive: true,
      dereference: true,
      errorOnExist: true,
      force: false,
    }).catch(missing)
  await makeOwnerWritable(target)
  for (const name of SHARED_CODE_AND_REGISTRY) await symlink(join(source, name), join(target, name))
}

export async function linkHome(from: string, to: string) {
  for (const name of await readdir(from)) {
    if (name === '.ultimate') continue
    await symlink(join(from, name), join(to, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
  }
}

export const previewBranch = (home: string, suffix = 'preview') =>
  `ultimate/${createHash('sha256').update(home).digest('hex').slice(0, 6)}-${suffix}`

export function guardConfig(branch: string) {
  const previewBranchPrefix = ` refs/heads/${branch.slice(0, branch.lastIndexOf('-') + 1)}`
  const rejectNonPreviewRefTransaction = `[ "$1" != prepared ] || ! grep -E ' refs/(heads|tags)/' | grep -qvF '${previewBranchPrefix}' || { echo 'A preview moves only its own branches.' >&2; exit 1; } #`
  return [
    '[url "ultimate-preview-never-pushes://"]',
    '\tpushInsteadOf =',
    '[hook "ultimate-preview"]',
    '\tevent = reference-transaction',
    `\tcommand = "${rejectNonPreviewRefTransaction.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`,
    '',
  ].join('\n')
}

function includeGuardForRepositoryOnly(parent: NodeJS.ProcessEnv, common: string, config: string) {
  let count = Number(parent.GIT_CONFIG_COUNT ?? 0)
  const env: NodeJS.ProcessEnv = {}
  for (const pattern of [common, `${common}/`]) {
    env[`GIT_CONFIG_KEY_${count}`] = `includeIf.gitdir:${pattern}.path`
    env[`GIT_CONFIG_VALUE_${count++}`] = config
  }
  env.GIT_CONFIG_COUNT = String(count)
  return env
}

export function previewEnv(
  parent: NodeJS.ProcessEnv,
  options: {
    home: string
    project: string
    userHome: string
    ownerPid: number
    model?: string
    git?: { common: string; branch: string; config: string }
  },
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
            'ULTIMATE_USER_HOME',
            'ULTIMATE_PORT',
            'ULTIMATE_CLOUD_URL',
            'ULTIMATE_CLOUD_TOKEN',
            'ULTIMATE_CLOUD_MACHINE',
            'ULTIMATE_MODEL',
            'ULTIMATE_PREVIEW_BRANCH',
          ].includes(key),
      ),
    ),
    ULTIMATE_HOME: options.home,
    ULTIMATE_PROJECT: options.project,
    HOME: options.userHome,
    ULTIMATE_USER_HOME: options.userHome,
    ULTIMATE_PORT: '0',
    ULTIMATE_NO_OPEN: '1',
    ULTIMATE_INSTANCE_OWNER: String(options.ownerPid),
    ...(options.model ? { ULTIMATE_MODEL: options.model } : {}),
    ...(options.git
      ? {
          ULTIMATE_PREVIEW_BRANCH: options.git.branch,
          ...includeGuardForRepositoryOnly(parent, options.git.common, options.git.config),
        }
      : {}),
  }
  return env
}

type RetryableStopInFlight = Promise<void>

interface Instance {
  id: string
  url: string
  home: string
  pid: number
  temporary: boolean
  conversationId?: ConversationId
  label?: string
  ref?: string
  stopWatchingIdle?: Cancel
  child: GroupProcess
  group: Group
  pidFile: string
  output: string
  stopping?: RetryableStopInFlight
}

const previewPids = (home: string) => join(home, 'preview-pids')
const startedByThisProcess = (name: string) => name.startsWith(`${process.pid}-`)

const info = ({ id, url, home, pid, conversationId, label, ref }: Instance) => ({
  id,
  url,
  home,
  pid,
  conversationId,
  label,
  ref,
})
const live = (item: Instance) => item.child.exitCode === null && item.child.signalCode === null
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
const listed = ({
  id,
  url,
  conversationId,
  label,
  ref,
}: Pick<Instance, 'id' | 'url' | 'conversationId' | 'label' | 'ref'>) => ({
  id,
  url,
  ...(conversationId !== undefined && { conversationId }),
  ...(label !== undefined && { label }),
  ...(ref !== undefined && { ref }),
})
type Listed = ReturnType<typeof listed>
const portOf = (url: string) => new URL(url).port
export const stopped = (host: Pick<ExtensionHost, 'resource' | 'home'>) =>
  host.resource('instance.stopped', () => {
    const byPort = new Map<string, Listed>()
    try {
      const saved = JSON.parse(readFileSync(join(host.home, 'previews.json'), 'utf8')) as Listed[]
      for (const item of saved) byPort.set(portOf(item.url), item)
    } catch (error) {
      meansNone(error)
    }
    return byPort
  })
export function remember(
  host: Pick<ExtensionHost, 'resource' | 'home'>,
  item: Pick<Instance, 'id' | 'url' | 'conversationId' | 'label' | 'ref'>,
) {
  const byPort = stopped(host)
  byPort.delete(portOf(item.url))
  byPort.set(portOf(item.url), listed(item))
  for (const port of [...byPort.keys()].slice(0, -50)) byPort.delete(port)
  writeFileSync(join(host.home, 'previews.json'), JSON.stringify([...byPort.values()]))
}
function stop(instances: Map<string, Instance>, id: string) {
  const instance = instances.get(id)
  if (!instance) return Promise.reject(new Error(`Unknown instance: ${id}`))
  instance.stopping ??= stopInstance(instances, instance).catch((error: unknown) => {
    instance.stopping = undefined
    throw error
  })
  return instance.stopping
}
async function stopInstance(instances: Map<string, Instance>, instance: Instance) {
  instance.stopWatchingIdle?.()
  const unreapedGroupLeaderPid = instance.child.pid
  if (unreapedGroupLeaderPid !== undefined)
    await stopGroup(unreapedGroupLeaderPid, {
      leader: instance.group,
      grace: 5000,
      pidFile: instance.pidFile,
    })
  if (instance.temporary) {
    await unlink(join(instance.home, 'ultimate.lock')).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    await cleanPreview(instance.home)
  }
  instances.delete(instance.id)
}

async function tailnet(host: Pick<ExtensionHost, 'want' | 'userHome'>) {
  const published = host.want(TailscaleApi)?.status().url
  if (!published) return new Map<number, string>()
  let registry: { ports?: Record<string, { port: number; owner: string }> }
  try {
    registry = JSON.parse(await readFile(join(host.userHome, '.ultimate/tailscale.json'), 'utf8'))
  } catch {
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
  list: implementAction(ListAction, async (_args, { host }) => {
    const addresses = await tailnet(host)
    return [
      ...[...running(host).values()]
        .filter((item) => item.url)
        .map((item) => ({
          ...listed(item),
          running: live(item),
          ...(live(item) && addresses.has(item.pid) && { tailnet: addresses.get(item.pid) }),
        })),
      ...[...stopped(host).values()]
        .filter((item) => ![...running(host).values()].some((run) => run.url === item.url))
        .map((item) => ({ ...item, running: false })),
    ]
  }),
  start: implementAction(StartAction, async (args, { host }) => {
    const ref = stringArg(args, 'ref', 200)
    const label = stringArg(args, 'label', 80)
    const { id } = await start(host, {}, BACKGROUND_CONTEXT, (home) =>
      refCheckout(host, ref, label, home),
    )
    const item = running(host).get(id)!
    watchIdle(host, item)
    return { ...listed(item), running: true }
  }),
  stop: implementAction(StopAction, async (args, { host }) => {
    const item = running(host).get(stringArg(args, 'id', 100))
    if (!item?.label) throw new Error('No such preview started by the user')
    await stop(running(host), item.id)
    remember(host, item)
    return null
  }),
}

export const userActions = ['start', 'stop']

function stringArg(args: unknown, name: string, max: number) {
  const value = (args as Record<string, unknown> | null)?.[name]
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed || trimmed.length > max)
    throw new Error(`${name} must be a non-empty string of at most ${max} characters`)
  return trimmed
}

export const idle = { limit: 60 * 60_000, every: 60_000 }

async function pages(item: Instance) {
  if (!live(item)) return 0
  try {
    const response = await fetch(`${item.url}/api/pages`, {
      signal: AbortSignal.timeout(5000),
    })
    return response.ok ? ((await response.json()) as { pages: number }).pages : 0
  } catch {
    return 0
  }
}

function watchIdle(
  host: Pick<ExtensionHost, 'resource' | 'onClose' | 'home' | 'notice'>,
  item: Instance,
) {
  let seen = Date.now()
  item.stopWatchingIdle = every(
    idle.every,
    () => {
      inProcess(
        'the idle check of a preview ends with the process that stops its previews on close',
        pages(item)
          .then(async (open) => {
            if (open > 0) seen = Date.now()
            if (live(item) && Date.now() - seen < idle.limit) return
            await stop(running(host), item.id)
            remember(host, item)
          })
          .catch((error: unknown) => {
            if (!running(host).has(item.id)) return
            host.notice(`Stopping idle preview ${item.label} failed: ${String(error)}`)
          }),
      )
    },
    { unref: true },
  )
}

async function refCheckout(
  host: Pick<ExtensionHost, 'projectRoot' | 'ultimateRoot' | 'projectSettings'>,
  ref: string,
  label: string,
  home: string,
) {
  const top = await git(host.projectRoot, 'rev-parse', '--show-toplevel').catch(() => '')
  if (!top) throw new Error('Cannot preview a commit: the project is not a Git repository')
  const source = await realpath(top)
  const commit = await git(
    source,
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `${ref}^{commit}`,
  ).catch(() => '')
  if (!commit) throw new Error(`Unknown commit ${ref}: fetch it first`)
  const path = join(home, 'checkouts', basename(source))
  const branch = previewBranch(home, 'checkout')
  await git(source, 'worktree', 'add', '-b', branch, path, commit)
  const project = join(path, relative(source, await realpath(host.projectRoot)))
  if (host.projectRoot !== host.ultimateRoot)
    return { cwd: host.ultimateRoot, project, label, ref: commit }
  await setup(source, path, await host.projectSettings(), new AbortController().signal)
  await ultimateCheckout(path)
  return { cwd: path, project, label, ref: commit }
}

async function ultimateCheckout(cwd: string) {
  for (const [path, directory, message] of [
    ['server/main.ts', false, 'Worktree is not Ultimate: missing server/main.ts'],
    ['node_modules', true, 'Worktree has no node_modules; run pnpm install first'],
  ] as const) {
    const entry = await stat(join(cwd, path)).catch(meansNone)
    if (!entry || (directory ? !entry.isDirectory() : !entry.isFile())) throw new Error(message)
  }
}

async function previewGit(project: string, home: string) {
  const checkout = await isolatable(project)
  if ('reason' in checkout) return undefined
  const branch = previewBranch(home)
  if (!(await git(project, 'branch', '--list', branch))) await git(project, 'branch', branch)
  const common = await git(project, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  const config = join(home, 'preview.gitconfig')
  await writeFile(config, guardConfig(branch))
  return { common: await realpath(common), branch, config }
}

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

async function start(
  host: Pick<
    ExtensionHost,
    'resource' | 'onClose' | 'home' | 'userHome' | 'projectRoot' | 'projectSettings'
  >,
  args: { home?: string; model?: string | null },
  context: Context,
  prepare: (
    home: string,
  ) => Promise<
    { cwd: string; project: string } & Partial<Pick<Instance, 'conversationId' | 'label' | 'ref'>>
  >,
  output: (text: string) => void = () => {},
) {
  const instances = running(host)
  const starts = host.resource('instance.starts', () => ({ pending: 0 }))
  let reserved = false
  let pendingHome: string | undefined
  try {
    context.abortSignal?.throwIfAborted()
    if ([...instances.values()].filter(live).length + starts.pending >= 3)
      throw new Error('At most three instances may run at once')
    starts.pending++
    reserved = true
    let home: string
    if (args.home) {
      await mkdir(resolvePath(args.home), { recursive: true })
      home = await realpath(resolvePath(args.home))
    } else {
      const stagingBeforeStartupLease = await mkdtemp(join(tmpdir(), '.ultimate-instance-'))
      home = join(tmpdir(), basename(stagingBeforeStartupLease).slice(1))
      try {
        await writeFile(
          join(stagingBeforeStartupLease, 'ultimate.lock'),
          JSON.stringify({ pid: process.pid }),
        )
        await rename(stagingBeforeStartupLease, home)
        pendingHome = home
      } catch (error) {
        await rm(stagingBeforeStartupLease, { recursive: true, force: true })
        throw error
      }
    }
    if (home === (await realpath(host.home)))
      throw new Error('A test instance cannot share the running server home')
    for (const item of instances.values())
      if (item.home === home) {
        const stopBeforeRestartingSameHome = item.stopping
        await stopBeforeRestartingSameHome?.catch(overshadowed)
      }
    if ([...instances.values()].some((item) => item.home === home && live(item)))
      throw new Error('Home is already owned by an instance')
    context.abortSignal?.throwIfAborted()
    if (args.home) await writeFile(join(home, 'instance-preserve'), '')
    const { cwd, project, ...listedAs } = await prepare(home)
    if (!args.home) await writeFile(join(home, 'project.json'), JSON.stringify({ root: project }))
    context.abortSignal?.throwIfAborted()
    const userHome = join(home, 'user')
    const reusedHomeAlreadyHasPrivateConfig = existsSync(userHome)
    if (!reusedHomeAlreadyHasPrivateConfig) await seedUserHome(host.userHome, userHome)
    await linkHome(host.userHome, userHome)
    const env = previewEnv(process.env, {
      home,
      project,
      userHome,
      ownerPid: process.pid,
      model: args.model === undefined ? await previewModelSetting(host) : (args.model ?? undefined),
      git: await previewGit(project, home),
    })
    await mkdir(previewPids(host.home), { recursive: true })
    const pidFile = join(previewPids(host.home), `${process.pid}-${randomUUID()}.pid`)
    const group = spawnGroup(process.execPath, ['server/main.ts'], {
      cwd,
      env,
      grace: 5000,
      pidFile,
    })
    const { child } = group
    const id = randomUUID()
    const item: Instance = {
      id,
      url: '',
      home,
      pid: child.pid ?? 0,
      temporary: !args.home,
      ...listedAs,
      child,
      group,
      pidFile,
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
    const notReady = () => new Error(`Instance did not become ready:\n${item.output}`)
    const serving = new Promise<void>((resolve, reject) => {
      let stdout = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        append(chunk)
        stdout += chunk.toString()
        const lines = stdout.split('\n')
        stdout = lines.pop()!.slice(-10000)
        for (const line of lines) {
          const match = /^Ultimate: (http:\/\/127\.0\.0\.1:([1-9]\d*))\r?$/.exec(line)
          if (match) {
            item.url = match[1]
            resolve()
          }
        }
      })
      child.on('error', (error) => {
        item.output += String(error)
        reject(notReady())
      })
      child.on('exit', () => reject(notReady()))
      const signal = context.abortSignal
      if (signal?.aborted) reject(signal.reason)
      signal?.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      })
    })
    child.stderr?.on('data', append)
    try {
      output(`Starting ${id}\n`)
      await within(60000, serving, notReady, context.abortSignal)
      context.abortSignal?.throwIfAborted()
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
  host.want(TailscaleApi)
  const workspaces = host.need(WorkspacesApi)
  const instances = running(host)
  const projectIsUltimateSource = host.projectRoot === host.ultimateRoot
  host.onOpen(async () => {
    await sweepPidFiles(previewPids(host.home), startedByThisProcess).catch((error: unknown) => {
      host.notice(`Stopping previews a crash left running failed: ${String(error)}`)
    })
    rebuiltOnOpen(
      'every open sweeps preview directories again',
      sweepPreviews(tmpdir(), host.notice).catch((error: unknown) => {
        host.notice(`Preview sweep failed: ${String(error)}`)
      }),
    )
  })
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
      if (projectIsUltimateSource) {
        cwd = workspace.path
        await ultimateCheckout(cwd)
      }
    }
    return { cwd, project, conversationId }
  }

  host.implement(Previews, {
    stop: async (concludedConversationIds) => {
      const concluded = new Set(concludedConversationIds)
      const ended = []
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
      section('test_core_changes', async () => {
        const model = await previewModelSetting(host)
        const runs = model
          ? `every agent on ${model} (the \`instance.model\` setting)`
          : 'the configured models (`instance.model` is null)'
        return projectIsUltimateSource
          ? `Before restarting after core changes, start a second instance, check its API and UI using browser/screenshot, then stop it. An instance runs ${runs} and spends tokens; drive it with real prompts. Instances are temporary and process-local.`
          : `To check changes to this project's .ultimate/ extensions, agents or settings, start a second instance: it runs this Ultimate with your workspace as its project. Look at it with browser/screenshot, then stop it. It runs ${runs} and spends tokens. It does not run the project's own app.`
      }),
    ],
    tools: [
      defineTool({
        name: 'instance',
        description:
          'Start, inspect logs, list or stop isolated standalone Ultimate test servers (maximum three). Defaults to the calling workspace; set subagent to preview an owned child worktree. model on start pins every agent to one provider/id, or null runs each on its own configured model; omitted, the instance.model setting applies.',
        parameters: obj({
          action: strEnum(['start', 'stop', 'logs', 'list']),
          id: opt(str()),
          home: opt(str()),
          subagent: opt(int({ minimum: 1 })),
          model: opt(nullable(str({ pattern: '^[^/\\s]+/\\S+$' }))),
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
                host,
                args,
                context,
                () => toolWorkspace(args, api, context),
                (text) => api.output(text),
              )
            }
            return { output: [{ type: 'text', text: JSON.stringify(result) }] }
          } catch (error) {
            return {
              isError: true,
              output: [{ type: 'text', text: String(error) }],
            }
          }
        },
      }),
    ],
  })
}
