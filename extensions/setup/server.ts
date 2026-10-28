import {
  defineDoc,
  defineExtension,
  GenerationTask,
  hook,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type {
  ConversationDocToken,
  ConversationId,
  JsonObject,
  Tx,
} from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { discoverAgents } from '../../lib/agents.ts'
import { isolatable } from '../../lib/git.ts'
import { implementAction } from '../../lib/actions.ts'
import { declaredLander, readSettings, userSettingsPath } from '../../lib/settings.ts'
import { readSecret, secretMetadata } from '../../lib/secrets.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { HealthApi } from '../health/api.ts'
import type { MemoryDoc, RootsDoc } from '../lineage/refs.ts'
import { Standing } from '../subagents/api.ts'
import { TailscaleApi } from '../tailscale/api.ts'
import { CheckAction } from './refs.ts'
import type { SetupIssue } from './refs.ts'

const LOGIN = { label: 'Log in', command: 'auth.login' }

/** The warnings the primary agent last heard about, so its next input carries a line only when they change. */
const Seen = defineDoc<{ key?: string }>({
  kind: 'setup.seen',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  initial: () => ({}),
})
export const docs = [Seen]

type CheckHost = Pick<
  ExtensionHost,
  | 'ultimateRoot'
  | 'projectRoot'
  | 'userHome'
  | 'modelRuntime'
  | 'projectSettings'
  | 'projectSetup'
  | 'extensions'
  | 'need'
  | 'want'
  | 'doc'
  | 'harness'
>

const configured = (host: Pick<CheckHost, 'modelRuntime'>, provider: string) =>
  host.modelRuntime.getProviderAuthStatus(provider).configured

async function summaryArea(host: CheckHost): Promise<SetupIssue> {
  const status = await host.need(ConversationsApi).summaryModelStatus()
  const fix = { label: 'Choose', command: 'conversations.summary-model' }
  const uses = 'Titles, codemode step lines and question cards'
  if (status.problem === 'invalid')
    return {
      area: 'Summary model',
      status: 'warn',
      summary: `invalid setting ${status.configured}`,
      impact: `${uses} are off.`,
      fix,
    }
  if (status.problem === 'unavailable')
    return {
      area: 'Summary model',
      status: 'warn',
      summary: `${status.configured}: no login here`,
      impact: `${uses} are off: every message wakes the agent.`,
      fix,
    }
  const using = `${status.model!.provider}/${status.model!.id}`
  if (status.fellBack)
    return {
      area: 'Summary model',
      status: 'warn',
      summary: `${status.configured}: no login here`,
      impact: `Using ${using} instead for ${uses.toLowerCase()}.`,
      fix,
    }
  return { area: 'Summary model', status: 'ok', summary: using }
}

/**
 * Definitions that pin a model whose provider has no login here. They still load, since Pi resolves a definition's
 * model among every known model, and fail at their first model call.
 */
async function agentsArea(host: CheckHost): Promise<SetupIssue[]> {
  const { definitions, errors, replaced } = await discoverAgents(
    host.ultimateRoot,
    host.projectRoot,
    host.userHome,
    host.modelRuntime,
  )
  const issues: SetupIssue[] = []
  const missing = new Map<string, string[]>()
  for (const definition of definitions)
    if (definition.model && !configured(host, definition.model.provider))
      missing.set(definition.model.provider, [
        ...(missing.get(definition.model.provider) ?? []),
        definition.name,
      ])
  for (const [provider, names] of missing)
    issues.push({
      area: 'Agent models',
      status: 'warn',
      summary: `${names.join(', ')} → ${provider}: no login here`,
      impact: 'They fail at their first model call.',
      fix: LOGIN,
    })
  if (errors.length)
    issues.push({
      area: 'Agent definitions',
      status: 'warn',
      summary: `${errors.map((error) => error.name).join(', ')} failed to load`,
      impact: errors[0].error,
    })
  for (const file of replaced)
    issues.push({
      area: 'Agent definitions',
      status: 'warn',
      summary: `${shortPath(host, file.path)} replaces the built-in ${file.name}`,
      impact:
        'It no longer follows updates to the built-in instructions. Make it an overlay: name, addTools, the settings you change and your additions (docs/subagents.md).',
    })
  if (!issues.length)
    issues.push({ area: 'Agent models', status: 'ok', summary: 'every pinned model has a login' })
  return issues
}

const shortPath = (host: Pick<CheckHost, 'projectRoot' | 'userHome'>, path: string) =>
  path.startsWith(`${host.projectRoot}/`)
    ? path.slice(host.projectRoot.length + 1)
    : path.startsWith(host.userHome)
      ? `~${path.slice(host.userHome.length)}`
      : path

async function providersArea(host: CheckHost): Promise<SetupIssue | undefined> {
  const providers = await host.want(HealthApi)?.providers()
  if (!providers?.length) return undefined
  const failing = providers.filter((provider) => provider.state === 'failing')
  if (failing.length)
    return {
      area: 'Providers',
      status: 'warn',
      summary: failing
        .map((provider) => `${provider.provider} ✗ ${provider.error ?? 'failed'}`)
        .join(' · '),
      impact: 'Its login was refused, or its calls kept failing on this machine.',
      fix: { label: 'Log in again', command: 'auth.login' },
    }
  return {
    area: 'Providers',
    status: 'ok',
    summary: providers.map((provider) => `${provider.provider} ${provider.state}`).join(' · '),
  }
}

async function secretsArea(host: CheckHost): Promise<SetupIssue> {
  const set = new Set((await secretMetadata(host.userHome)).map((secret) => secret.name))
  const missing = new Map<string, string[]>()
  for (const extension of host.extensions()) {
    if (!extension.enabled || !extension.server || extension.server.error) continue
    for (const { name, provider } of extension.server.secrets ?? [])
      if (!set.has(name) && !(provider && configured(host, provider)))
        missing.set(name, [...(missing.get(name) ?? []), extension.name])
  }
  if (!missing.size) return { area: 'Secrets', status: 'ok', summary: 'all set' }
  const names = [...missing.keys()]
  return {
    area: 'Secrets',
    status: 'warn',
    summary: `${names.join(', ')} missing`,
    impact: `Without it, ${[...new Set([...missing.values()].flat())].join(', ')} can't work.`,
    fix: { label: 'Add', secret: names[0] },
  }
}

function extensionsArea(host: CheckHost): SetupIssue | undefined {
  const broken = host
    .extensions()
    .filter((extension) => extension.enabled && extension.server?.error)
  if (!broken.length) return undefined
  return {
    area: 'Extensions',
    status: 'warn',
    summary: `${broken.map((extension) => extension.name).join(', ')} failed to load`,
    impact: broken[0].server!.error!.split('\n')[0],
    fix: { label: 'Open', command: 'onboarding.extensions' },
  }
}

async function cloudArea(host: CheckHost): Promise<SetupIssue | undefined> {
  // Invalid user settings are reported where settings load; here they count as unset.
  const settings: JsonObject = await readSettings(userSettingsPath(host.userHome)).catch(() => ({}))
  const cloud = settings.cloud as { url?: unknown } | undefined
  if (typeof cloud?.url !== 'string')
    return {
      area: 'Cloud backup',
      status: 'info',
      summary: 'off: this project is not backed up',
      fix: { label: 'Join', command: 'cloud.join' },
    }
  const absent = []
  for (const name of ['ULTIMATE_CLOUD_TOKEN', 'ULTIMATE_CLOUD_SNAPSHOT_KEY'])
    if (!(await readSecret(host.userHome, name))) absent.push(name)
  if (absent.length)
    return {
      area: 'Cloud backup',
      status: 'warn',
      summary: `half set up: ${absent.join(', ')} missing`,
      impact: 'Backups and restores fail.',
      fix: { label: 'Join', command: 'cloud.join' },
    }
  return { area: 'Cloud backup', status: 'ok', summary: 'joined' }
}

function tailscaleArea(host: CheckHost): SetupIssue | undefined {
  const service = host.want(TailscaleApi)
  if (!service) return undefined
  const { state } = service.status()
  return state === 'ready'
    ? { area: 'Tailscale', status: 'ok', summary: 'published on the tailnet' }
    : { area: 'Tailscale', status: 'info', summary: `${state}: no direct links from other devices` }
}

async function landerArea(host: CheckHost): Promise<SetupIssue | undefined> {
  if (!host.extensions().some((extension) => extension.name === 'workspaces' && extension.enabled))
    return undefined
  const lander = (await host.projectSettings()).lander as { checks?: unknown } | undefined
  if (Array.isArray(lander?.checks) && lander.checks.length)
    return { area: 'Lander checks', status: 'ok', summary: `${lander.checks.length} configured` }
  // Untrusted settings read as empty; the lander refuses to land while its file declares checks or a push.
  const { decision } = await host.projectSetup()
  if (decision !== true && (await declaredLander(host.projectRoot)).length)
    return {
      area: 'Lander checks',
      status: 'warn',
      summary: `declared but not run: project setup ${decision === false ? 'turned off' : 'not chosen'}`,
      impact: "The lander refuses every submission until you choose this project's setup.",
      fix: { label: 'Choose', command: 'onboarding.extensions' },
    }
  return {
    area: 'Lander checks',
    status: 'info',
    summary: 'none: landings merge without running tests',
    impact: 'Ask @ultimate to set them up (the integrate-ultimate skill).',
  }
}

/** Files that say a fresh checkout needs installing before it runs: a worktree has none of their ignored output. */
const MANIFESTS = [
  'package.json',
  'composer.json',
  'Gemfile',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'Cargo.toml',
  'mix.exs',
]

async function worktreeArea(host: CheckHost): Promise<SetupIssue | undefined> {
  if (!host.extensions().some((extension) => extension.name === 'workspaces' && extension.enabled))
    return undefined
  const commands = ((await host.projectSettings()).isolates as { worktree?: { setup?: unknown } })
    ?.worktree?.setup
  if (Array.isArray(commands) && commands.length)
    return { area: 'Worktree setup', status: 'ok', summary: `${commands.length} commands` }
  if ('reason' in (await isolatable(host.projectRoot))) return undefined
  const manifests = MANIFESTS.filter((name) => existsSync(join(host.projectRoot, name)))
  if (!manifests.length) return undefined
  return {
    area: 'Worktree setup',
    status: 'warn',
    summary: `none, though the project has ${manifests.join(', ')}`,
    impact:
      'New worktrees start without dependencies, .env or a database. Ask @ultimate to set it up (the integrate-ultimate skill).',
  }
}

/** Reads a conversation document; inside a transaction it must read through `tx`, or it waits on its own line. */
type ReadDoc = (
  doc: ConversationDocToken<JsonObject>,
  id: ConversationId,
) => Promise<Readonly<JsonObject> | undefined>

const snapshots =
  (host: Pick<CheckHost, 'harness'>): ReadDoc =>
  (doc, id) =>
    host.harness().snapshot(doc, id, BACKGROUND_CONTEXT)

/** Listed roots without a memory: their branches start from the whole tally instead of a memory brief. */
async function memoryArea(host: CheckHost, read: ReadDoc): Promise<SetupIssue | undefined> {
  const rootsDoc = host.doc('lineage.roots')
  const memoryDoc = host.doc('lineage.memory')
  if (!rootsDoc || !memoryDoc) return undefined
  const listed = (await read(rootsDoc, ROOT_CONVERSATION_ID)) as
    | (typeof RootsDoc)['value']
    | undefined
  const empty: number[] = []
  for (const root of listed?.roots ?? []) {
    const doc = (await read(memoryDoc, root as ConversationId)) as
      | (typeof MemoryDoc)['value']
      | undefined
    if (!Object.keys(doc?.memories ?? {}).length) empty.push(root)
  }
  if (!empty.length) return undefined
  return {
    area: 'Project memory',
    status: 'warn',
    summary: `none in root ${empty.map((root) => `#${root}`).join(', ')}`,
    // No fix button: no command opens @ultimate with a request, so the row says what to ask.
    impact:
      "New branches start from the full project context (large, slow, costly). Ask @ultimate to review the project's memory.",
  }
}

/** Every area, warnings first, then information, then what is set up; a failing area is skipped, not fatal. */
export async function check(
  host: CheckHost,
  read: ReadDoc = snapshots(host),
): Promise<SetupIssue[]> {
  const areas = await Promise.all(
    (
      [
        summaryArea,
        agentsArea,
        providersArea,
        secretsArea,
        extensionsArea,
        cloudArea,
        tailscaleArea,
        landerArea,
        worktreeArea,
        memoryArea,
      ] as ((
        host: CheckHost,
        read: ReadDoc,
      ) => SetupIssue | SetupIssue[] | undefined | Promise<SetupIssue | SetupIssue[] | undefined>)[]
    ).map((area) =>
      // Started inside the promise, so an area that throws synchronously is caught like one that rejects.
      Promise.resolve()
        .then(() => area(host, read))
        .catch((error: unknown): SetupIssue => ({
          area: 'Setup check',
          status: 'info',
          summary: `one check failed: ${error instanceof Error ? error.message : String(error)}`,
        })),
    ),
  )
  const rank = { warn: 0, info: 1, ok: 2 }
  return areas
    .flat()
    .filter((issue): issue is SetupIssue => !!issue)
    .toSorted((a, b) => rank[a.status] - rank[b.status])
}

/** The line the primary agent's input carries, or undefined while no warning stands. */
export function setupNote(issues: SetupIssue[]) {
  const warnings = issues.filter((issue) => issue.status === 'warn')
  if (!warnings.length) return undefined
  return `Setup issues on this machine (the user sees them in the status line):\n${warnings
    .map((issue) => `- ${issue.area}: ${issue.summary}${issue.impact ? `. ${issue.impact}` : ''}`)
    .join('\n')}`
}

/**
 * Inside the input's commit: a note on the primary agent's input when its warnings differ from those it last heard,
 * including "resolved" once they all clear. The note and the doc that remembers it commit together, so an input
 * gets at most one.
 */
export async function noteFor(
  tx: Tx,
  conversationId: ConversationId,
  issues: SetupIssue[] | undefined,
  now: number,
) {
  if (!issues) return undefined
  const text = setupNote(issues)
  const key = text ?? ''
  const seen = await tx.doc(Seen, conversationId)
  if ((seen.key ?? '') === key) return undefined
  seen.key = key
  return {
    entries: [
      {
        kind: 'setup.note',
        data: { warnings: issues.filter((issue) => issue.status === 'warn').length },
        model: [
          {
            role: 'user' as const,
            content: text ?? 'Setup issues resolved: nothing on this machine needs setting up now.',
            timestamp: now,
          },
        ],
      },
    ],
  }
}

export default function setup(host: ExtensionHost) {
  // The check reads files and the model runtime: cached briefly so a burst of inputs reads once.
  const cache = host.resource('setup.check', () => ({ at: 0, issues: [] as SetupIssue[] }))
  const current = async (tx: Tx) => {
    if (Date.now() - cache.at > 30_000) {
      cache.issues = await check(host, (doc, id) => tx.doc(doc, id))
      cache.at = Date.now()
    }
    return cache.issues
  }
  return defineExtension({
    name: 'setup',
    hooks: [
      hook(GenerationTask, {
        // Pi upstream: @earendil-works/pi-durable@1.4.0 — patched transactional beforeInput hook.
        // Only the primary agent hears about setup, and only when its warnings change: a per-input note, never a
        // system-prompt section, keeps the prompt cached.
        beforeInput: async (_input, { tx, conversationId }) => {
          const standing = await tx.doc(Standing, ROOT_CONVERSATION_ID)
          if (standing.ultimate !== conversationId) return undefined
          // A check that fails here only skips the note; the status line still shows the setup.
          return noteFor(tx, conversationId, await current(tx).catch(() => undefined), Date.now())
        },
      }),
    ],
  })
}

export const pollActions = ['check']

export const actions = {
  check: implementAction(CheckAction, async (_args, { host }) => check(host)),
}
