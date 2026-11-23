import type { ConversationId, ToolExecutionApi, JsonObject } from '@earendil-works/pi-durable'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import {
  cp,
  lstat,
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
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
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
import { ignoring, isMissing, rebuiltOnOpen, meansNone, overshadowed } from '../../lib/errors.ts'
import { spawnGroup, stopGroup, sweepPidFiles } from '../../lib/process-group.ts'
import { within } from '../../lib/timers.ts'
import type { Group, GroupProcess } from '../../lib/process-group.ts'
import { Previews } from '../conversations/api.ts'
import { ListAction } from './refs.ts'
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
  'extensions',
]

export async function seedUserHome(from: string, to: string) {
  const source = join(from, '.ultimate')
  await mkdir(dirname(to), { recursive: true })
  const staging = await mkdtemp(`${to}.seed-`)
  const target = join(staging, '.ultimate')
  try {
    await mkdir(target, { mode: 0o700 })
    for (const name of PRIVATE_CONFIG_COPIES) {
      if (!(await lstat(join(source, name)).catch(ignoring(isMissing)))) continue
      await cp(join(source, name), join(target, name), {
        recursive: true,
        dereference: true,
        errorOnExist: true,
        force: false,
      })
    }
    await makeOwnerWritable(target)
    await symlink(join(source, 'tailscale.json'), join(target, 'tailscale.json'))
    await rename(staging, to)
  } catch (error) {
    await makeOwnerWritable(staging)
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

export async function linkHome(from: string, to: string) {
  for (const name of await readdir(from)) {
    if (name === '.ultimate') continue
    await symlink(join(from, name), join(to, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
  }
}

export const previewBranch = (home: string) =>
  `ultimate/${createHash('sha256').update(home).digest('hex').slice(0, 6)}-preview`

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
  child: GroupProcess
  group: Group
  pidFile: string
  output: string
  stopping?: RetryableStopInFlight
}

const previewPids = (home: string) => join(home, 'preview-pids')
const startedByThisProcess = (name: string) => name.startsWith(`${process.pid}-`)

const info = ({ id, url, home, pid, conversationId }: Instance) => ({
  id,
  url,
  home,
  pid,
  conversationId,
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
}: {
  id: string
  url: string
  conversationId: ConversationId
}) => ({
  id,
  url,
  conversationId,
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
  item: Pick<Instance, 'id' | 'url' | 'conversationId'>,
) {
  if (item.conversationId === undefined) return
  const byPort = stopped(host)
  byPort.delete(portOf(item.url))
  byPort.set(portOf(item.url), listed({ ...item, conversationId: item.conversationId }))
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
    if (!(await cleanPreview(instance.home)))
      throw new Error(
        `Preview ${instance.id} home was not cleaned because it is locked; retry stop after the lock is released`,
      )
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
  const starts = host.resource('instance.starts', () => ({ pending: 0 }))
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
  async function start(
    args: { home?: string; model?: string | null },
    context: Context,
    prepare: () => Promise<{ cwd: string; project: string; conversationId?: ConversationId }>,
    output: (text: string) => void = () => {},
  ) {
    let reserved = false
    let pendingHome: string | undefined
    try {
      context.abortSignal?.throwIfAborted()
      if (args.home !== undefined && !isAbsolute(args.home))
        throw new Error(
          `home must be an absolute path, got ${JSON.stringify(args.home)}: "~" is not expanded, so build it from $HOME`,
        )
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
        const stagingBeforeStartupLease = await mkdtemp(join(tmpdir(), '.ultimate-instance-'))
        home = join(tmpdir(), basename(stagingBeforeStartupLease).slice(1))
        try {
          await writeFile(
            join(stagingBeforeStartupLease, 'ultimate.lock'),
            JSON.stringify({ pid: process.pid }),
          )
          await writeFile(
            join(stagingBeforeStartupLease, 'project.json'),
            JSON.stringify({ root: project }),
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
      const userHome = join(home, 'user')
      const reusedHomeAlreadyHasPrivateConfig = existsSync(userHome)
      if (!reusedHomeAlreadyHasPrivateConfig) await seedUserHome(host.userHome, userHome)
      else if (
        (await lstat(join(userHome, '.ultimate/extensions')).catch(meansNone))?.isSymbolicLink()
      )
        throw new Error(
          `${home} links the live user extensions (seeded by an older Ultimate); start on a fresh home`,
        )
      await linkHome(host.userHome, userHome)
      const env = previewEnv(process.env, {
        home,
        project,
        userHome,
        ownerPid: process.pid,
        model:
          args.model === undefined ? await previewModelSetting(host) : (args.model ?? undefined),
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
        conversationId,
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
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
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
        for (const [path, directory, message] of [
          ['server/main.ts', false, 'Worktree is not Ultimate: missing server/main.ts'],
          ['node_modules', true, 'Worktree has no node_modules; run pnpm install first'],
        ] as const) {
          const entry = await stat(join(cwd, path)).catch(meansNone)
          if (!entry || (directory ? !entry.isDirectory() : !entry.isFile()))
            throw new Error(message)
        }
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
