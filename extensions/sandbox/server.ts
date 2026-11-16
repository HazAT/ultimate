import { createHash } from 'node:crypto'
import { access, constants, mkdir, readdir, rm } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@earendil-works/chord/context'
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import {
  type ConversationId,
  defineExtension,
  hook,
  type JsonObject,
  type ToolExecutionApi,
  type ToolRegistration,
  ToolTask,
  wrapTool,
} from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import type {
  ExecutionEnv,
  ExecutionError,
  Result,
  ShellExecOptions,
  ShellExecResult,
} from '@earendil-works/pi-durable/env'
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from '@earendil-works/pi-durable/tools'
import { ignoring, isMissing } from '../../lib/errors.ts'
import { exec as execFile } from '../../lib/exec.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Profile } from '../subagents/api.ts'
import { Confinement, WorkspacesApi } from '../workspaces/api.ts'
import { Gate, type Policy, SandboxEnv } from './env.ts'
import { confinedExec, namespaceFlags, nodePrefix, prepareRun, type Run } from './layout.ts'
import { parseAllow, startProxy } from './proxy.ts'

export type Role = { network: string[]; tools: string[] }

export const defaultTools = [
  'bash',
  'read',
  'write',
  'edit',
  'web_search',
  'web_fetch',
  'message',
  'note',
  'memory',
  'plan',
  'workspace',
]

export function roles(settings: JsonObject): Map<string, Role> {
  const section = settings.sandbox
  const configured =
    section && typeof section === 'object' && !Array.isArray(section) ? section.roles : undefined
  if (configured === undefined) return new Map([['worker', { network: [], tools: defaultTools }]])
  if (!configured || typeof configured !== 'object' || Array.isArray(configured))
    throw new Error('sandbox.roles must be an object of role names')
  return new Map(
    Object.entries(configured).map(([name, value]) => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error(`sandbox.roles.${name} must be an object`)
      const role = value as { tools?: unknown; network?: unknown }
      const tools = role.tools ?? defaultTools
      if (!Array.isArray(tools) || !tools.every((tool) => typeof tool === 'string'))
        throw new Error(`sandbox.roles.${name}.tools must be an array of tool names`)
      return [name, { network: parseAllow(role.network ?? []), tools }]
    }),
  )
}

export const unavailable = (detail: string) =>
  `Sandbox unavailable: ${detail}. Install bubblewrap and allow it user namespaces: on Ubuntu 24.04+ add /etc/apparmor.d/bwrap containing "abi <abi/4.0>, include <tunables/global> profile bwrap /usr/bin/bwrap flags=(unconfined) { userns, }" and run sudo apparmor_parser -r /etc/apparmor.d/bwrap; in a Proxmox CT also set nesting=1. bash, read, write and edit stay blocked for this agent until then.`

async function findBwrap() {
  for (const folder of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(folder, 'bwrap')
    const runnable = await access(candidate, constants.X_OK).then(
      () => true,
      () => false,
    )
    if (runnable) return candidate
  }
  throw new Error(unavailable('bwrap is not installed'))
}

async function probe() {
  const bwrap = await findBwrap()
  await execFile(bwrap, [
    ...namespaceFlags,
    '--ro-bind',
    '/',
    '/',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    'true',
  ]).catch((error: Error & { stderr?: string }) => {
    throw new Error(
      unavailable(
        `bwrap could not create its namespaces (${(error.stderr || error.message).trim()})`,
      ),
      { cause: error },
    )
  })
  return bwrap
}

const bridge = join(dirname(fileURLToPath(import.meta.url)), 'bridge.cjs')

export default function sandbox(host: ExtensionHost) {
  const workspaces = host.need(WorkspacesApi)
  const gates = host.resource('sandbox.gates', () => new Map<ConversationId, Gate>())
  const serial = host.resource('sandbox.serial', () => new Map<ConversationId, Promise<unknown>>())
  const proxies = new Map<string, Promise<{ socket: string; close(): Promise<void> }>>()
  let bwrap: Promise<string> | undefined

  const available = () => {
    bwrap ??= probe().catch((error: unknown) => {
      bwrap = undefined
      throw error
    })
    return bwrap
  }

  const inTurn = <T>(id: ConversationId, operation: () => Promise<T>) => {
    const next = (serial.get(id) ?? Promise.resolve()).then(operation, operation)
    serial.set(
      id,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }

  const proxyFor = (allow: string[]) => {
    const key = allow.toSorted().join(',')
    let proxy = proxies.get(key)
    if (!proxy) {
      const socket = join(
        host.home,
        'sandbox',
        `proxy-${createHash('sha256').update(key).digest('hex').slice(0, 12)}.sock`,
      )
      proxy = mkdir(dirname(socket), { recursive: true })
        .then(() => startProxy(socket, allow))
        .then((started) => ({ socket, close: () => started.close() }))
      proxies.set(key, proxy)
      proxy.catch(() => proxies.delete(key))
    }
    return proxy
  }

  const roleOf = async (
    id: ConversationId,
    read: Pick<ToolExecutionApi, 'snapshot'>,
    context: Context,
  ) => {
    const definition = (await read.snapshot(Profile, id, context))?.definition
    if (!definition) return undefined
    return roles(await host.projectSettings()).get(definition)
  }

  const runOf = async (
    id: ConversationId,
    context: Context,
    states: readonly string[] = ['ready'],
  ) => {
    const workspace = await workspaces.get(id, context)
    if (!workspace || !states.includes(workspace.state))
      throw new Error(
        'A sandboxed agent needs its own ready worktree (isolate: worktree); this conversation has none',
      )
    return prepareRun(host.home, id, workspace)
  }

  const runConfined = async (
    id: ConversationId,
    run: Run,
    role: Role,
    spawner: ExecutionEnv,
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> => {
    const program = await available()
    const proxy = role.network.length ? await proxyFor(role.network) : undefined
    return confinedExec(
      run,
      {
        program,
        ...(proxy ? { proxy: { socket: proxy.socket, bridge } } : {}),
        inTurn: (operation) => inTurn(id, operation),
      },
      spawner,
      command,
      options,
      context,
    )
  }

  const sandboxEnv = async (api: ToolExecutionApi, role: Role, context: Context) => {
    const id = api.conversationId
    await available()
    const run = await runOf(id, context)
    const inner = api.env
    if (!inner) throw new Error('No execution environment is configured')
    let gate = gates.get(id)
    if (!gate) gates.set(id, (gate = new Gate()))
    const policy: Policy = {
      read: ['/usr', nodePrefix()],
      write: [run.worktree, run.home, run.tmp],
      readOnly: [join(run.worktree, '.git')],
    }
    return new SandboxEnv(
      inner,
      policy,
      gate,
      (command, options, callContext) =>
        runConfined(id, run, role, inner, command, options, callContext),
      run.tmp,
    )
  }

  const confine = (tool: ToolRegistration) =>
    wrapTool(tool, (inner) => ({
      ...inner,
      async execute(args, api, context) {
        const role = await roleOf(api.conversationId, api, context)
        if (!role) return inner.execute(args, api, context)
        const env = await sandboxEnv(api, role, context)
        return inner.execute(args, Object.create(api, { env: { value: env } }), context)
      },
    }))

  host.implement(Confinement, {
    confined: async (id, context) => (await roleOf(id, host.harness(), context)) !== undefined,
    exec: async (id, command, { cwd, env, signal, timeout }) => {
      const context = withAbortSignal(signal, BACKGROUND_CONTEXT)
      const role = await roleOf(id, host.harness(), context)
      if (!role) throw new Error(`Conversation ${id} is not sandboxed`)
      const run = await runOf(id, context, ['preparing', 'ready'])
      let output = ''
      const result = await runConfined(
        id,
        run,
        role,
        new NodeExecutionEnv({ cwd: run.worktree }),
        command,
        {
          cwd,
          env,
          inheritEnv: false,
          timeout: timeout / 1000,
          onOutput: (text) => (output += text),
        },
        context,
      )
      if (!result.ok) throw new Error(`${output}${result.error.message}`, { cause: result.error })
      if (result.value.exitCode !== 0)
        throw new Error(`${output}exit code ${result.value.exitCode}`)
    },
  })

  host.onOpen(async () => {
    const folder = join(host.home, 'sandbox')
    const entries = (await readdir(folder).catch(ignoring(isMissing))) ?? []
    for (const entry of entries) {
      const id = Number(entry)
      const state =
        Number.isInteger(id) &&
        (await workspaces.get(id as ConversationId, BACKGROUND_CONTEXT))?.state
      const stale =
        entry.endsWith('.sock') ||
        (Number.isInteger(id) && state !== 'preparing' && state !== 'ready')
      if (stale) await rm(join(folder, entry), { recursive: true, force: true })
    }
  })
  host.onClose(async () => {
    for (const proxy of proxies.values()) await (await proxy).close()
    proxies.clear()
  })

  return defineExtension({
    name: 'sandbox',
    wraps: [
      confine(createBashTool() as ToolRegistration),
      confine(createReadTool() as ToolRegistration),
      confine(createWriteTool() as ToolRegistration),
      confine(createEditTool() as ToolRegistration),
    ],
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, context) => {
          const role = await roleOf(api.conversationId, api, context)
          if (!role || role.tools.includes(call.name)) return undefined
          return {
            block: `${call.name} is not available to a sandboxed agent; it may use ${role.tools.join(', ')}`,
          }
        },
      }),
    ],
  })
}
