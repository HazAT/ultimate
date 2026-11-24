import type {
  ConversationDocToken,
  ConversationId,
  JsonObject,
  Tx,
} from '@earendil-works/pi-durable'
import {
  defineDoc,
  defineExtension,
  GenerationTask,
  hook,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { discoverAgents } from '../../lib/agents.ts'
import { providerKeyStandsIn } from '../../lib/openai.ts'
import { readFamilyLayers } from '../../lib/families-settings.ts'
import { isolatable } from '../../lib/git.ts'
import { implementAction } from '../../lib/actions.ts'
import { meansNone } from '../../lib/errors.ts'
import { readSettings, userSettingsPath } from '../../lib/settings.ts'
import { readSecret, secretMetadata } from '../../lib/secrets.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { HealthApi } from '../health/api.ts'
import { Memory, Roots, Tally } from '../lineage/api.ts'
import { Standing } from '../subagents/api.ts'
import { TailscaleApi } from '../tailscale/api.ts'
import { CheckAction } from './refs.ts'
import type { SetupIssue } from './refs.ts'

const LOGIN = { label: 'Log in', command: 'auth.login' }

const LastWarningsCommittedWithInput = defineDoc<{ key?: string }>({
  kind: 'setup.seen',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  initial: () => ({}),
})
export const docs = [LastWarningsCommittedWithInput]

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
  | 'harness'
>

const configured = (host: Pick<CheckHost, 'modelRuntime'>, provider: string) =>
  host.modelRuntime.getProviderAuthStatus(provider).configured

const loggedIn = (host: Pick<CheckHost, 'modelRuntime'>) =>
  host.modelRuntime.getAvailableSnapshot().length > 0

function loginArea(host: AreaHost): SetupIssue | undefined {
  if (loggedIn(host)) return undefined
  return {
    area: 'Login',
    status: 'warn',
    summary: 'no model provider logged in',
    impact: 'Nothing can run until you log in to a provider or pick a model.',
    fix: LOGIN,
  }
}

async function summaryArea(host: AreaHost): Promise<SetupIssue | undefined> {
  if (!loggedIn(host)) return undefined
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

async function agentsArea(host: AreaHost): Promise<SetupIssue[]> {
  const { definitions, errors, replaced } = await discoverAgents(
    host.ultimateRoot,
    host.projectRoot,
    host.userHome,
    host.modelRuntime,
  )
  const issues: SetupIssue[] = []
  const missing = new Map<string, string[]>()
  for (const definition of definitions)
    if (loggedIn(host) && definition.model && !configured(host, definition.model.provider))
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
  if (!issues.length && loggedIn(host))
    issues.push({ area: 'Agent models', status: 'ok', summary: 'every pinned model has a login' })
  return issues
}

async function familiesArea(host: AreaHost, { settings }: AreaInputs) {
  const { errors } = await readFamilyLayers(host.userHome, host.projectRoot, (await settings) ?? {})
  return errors.map((error): SetupIssue => ({
    area: 'Model families',
    status: 'warn',
    summary: 'a modelFamilies setting is invalid',
    impact: error,
  }))
}

const shortPath = (host: Pick<CheckHost, 'projectRoot' | 'userHome'>, path: string) =>
  path.startsWith(`${host.projectRoot}/`)
    ? path.slice(host.projectRoot.length + 1)
    : path.startsWith(host.userHome)
      ? `~${path.slice(host.userHome.length)}`
      : path

async function providersArea(host: AreaHost): Promise<SetupIssue | undefined> {
  const providers = await host.want(HealthApi)?.providers()
  if (!providers?.length) return undefined
  const failing = providers.filter((provider) => provider.state === 'failing')
  if (failing.length) {
    const billingCannotBeFixedByLogin = failing.every((provider) => provider.cause === 'billing')
    return {
      area: 'Providers',
      status: 'warn',
      summary: failing
        .map((provider) => `${provider.provider} ✗ ${provider.error ?? 'failed'}`)
        .join(' · '),
      impact: billingCannotBeFixedByLogin
        ? 'It refused calls for payment: the account hit a credit or spending limit. Add credits or raise the limit with the provider.'
        : 'Its login was refused, or its calls kept failing on this machine.',
      ...(billingCannotBeFixedByLogin
        ? {}
        : { fix: { label: 'Log in again', command: 'auth.login' } }),
    }
  }
  return {
    area: 'Providers',
    status: 'ok',
    summary: providers.map((provider) => `${provider.provider} ${provider.state}`).join(' · '),
  }
}

async function secretsArea(host: AreaHost): Promise<SetupIssue[]> {
  const set = new Set((await secretMetadata(host.userHome)).map((secret) => secret.name))
  const chosen = new Map<string, string[]>()
  const optional = new Map<string, string[]>()
  for (const extension of host.extensions()) {
    if (!extension.enabled || !extension.server || extension.server.error) continue
    const missing = extension.layer === 'default' ? optional : chosen
    for (const { name, provider } of extension.server.secrets ?? [])
      if (!set.has(name) && !(provider && providerKeyStandsIn(host.modelRuntime, provider)))
        missing.set(name, [...(missing.get(name) ?? []), extension.name])
  }
  for (const name of chosen.keys()) optional.delete(name)
  if (!chosen.size && !optional.size) return [{ area: 'Secrets', status: 'ok', summary: 'all set' }]
  const users = (missing: Map<string, string[]>) => [...new Set([...missing.values()].flat())]
  const issues: SetupIssue[] = []
  if (chosen.size) {
    const names = [...chosen.keys()]
    issues.push({
      area: 'Secrets',
      status: 'warn',
      summary: `${names.join(', ')} missing`,
      impact: `Without it, ${users(chosen).join(', ')} can't work.`,
      fix: { label: 'Add', secret: names[0] },
    })
  }
  if (optional.size) {
    const names = [...optional.keys()]
    issues.push({
      area: 'Secrets',
      status: 'info',
      summary: `optional: ${names.join(', ')} for ${users(optional).join(', ')}`,
      fix: { label: 'Add', secret: names[0] },
    })
  }
  return issues
}

function extensionsArea(host: AreaHost): SetupIssue | undefined {
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

async function cloudArea(host: AreaHost): Promise<SetupIssue | undefined> {
  const invalidSettingsAlreadyReported = () => ({})
  const settings: JsonObject = await readSettings(userSettingsPath(host.userHome)).catch(
    invalidSettingsAlreadyReported,
  )
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

function tailscaleArea(host: AreaHost): SetupIssue | undefined {
  const service = host.want(TailscaleApi)
  if (!service) return undefined
  const { state } = service.status()
  return state === 'ready'
    ? { area: 'Tailscale', status: 'ok', summary: 'published on the tailnet' }
    : { area: 'Tailscale', status: 'info', summary: `${state}: no direct links from other devices` }
}

async function projectArea(
  _host: AreaHost,
  { settings }: AreaInputs,
): Promise<SetupIssue | undefined> {
  if (await settings) return undefined
  return {
    area: 'Project setup',
    status: 'warn',
    summary: "undecided: this project's .ultimate/ is not loaded",
    impact:
      'Its extensions, agents, skills and settings (worktree setup, lander checks) stay off until you choose to use it or keep global.',
    fix: { label: 'Decide', command: 'onboarding.extensions' },
  }
}

async function landerArea(host: AreaHost, inputs: AreaInputs): Promise<SetupIssue | undefined> {
  if (!host.extensions().some((extension) => extension.name === 'workspaces' && extension.enabled))
    return undefined
  const settings = await inputs.settings
  if (!settings) return undefined
  const lander = settings.lander as { checks?: unknown } | undefined
  if (Array.isArray(lander?.checks) && lander.checks.length)
    return { area: 'Lander checks', status: 'ok', summary: `${lander.checks.length} configured` }
  return {
    area: 'Lander checks',
    status: 'info',
    summary: 'none: landings merge without running tests',
    impact: 'Ask @ultimate to set them up (the integrate-ultimate skill).',
  }
}

const INSTALL_MANIFESTS = [
  'package.json',
  'composer.json',
  'Gemfile',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'Cargo.toml',
  'mix.exs',
]

async function worktreeArea(host: AreaHost, inputs: AreaInputs): Promise<SetupIssue | undefined> {
  if (!host.extensions().some((extension) => extension.name === 'workspaces' && extension.enabled))
    return undefined
  const settings = await inputs.settings
  if (!settings) return undefined
  const commands = (settings.isolates as { worktree?: { setup?: unknown } })?.worktree?.setup
  if (Array.isArray(commands) && commands.length)
    return { area: 'Worktree setup', status: 'ok', summary: `${commands.length} commands` }
  if ('reason' in (await isolatable(host.projectRoot))) return undefined
  const manifests = INSTALL_MANIFESTS.filter((name) => existsSync(join(host.projectRoot, name)))
  if (!manifests.length) return undefined
  return {
    area: 'Worktree setup',
    status: 'warn',
    summary: `none, though the project has ${manifests.join(', ')}`,
    impact:
      'New worktrees start without dependencies, .env or a database. Ask @ultimate to set it up (the integrate-ultimate skill).',
  }
}

type ReadCurrentDoc = <T extends JsonObject>(
  doc: ConversationDocToken<T>,
  id: ConversationId,
) => Promise<Readonly<T> | undefined>

const snapshots =
  (host: Pick<CheckHost, 'harness'>): ReadCurrentDoc =>
  (doc, id) =>
    host.harness().snapshot(doc, id, BACKGROUND_CONTEXT)

type AreaHost = Omit<CheckHost, 'projectSettings' | 'projectSetup'>

type AreaInputs = { read: ReadCurrentDoc; settings: Promise<JsonObject | undefined> }

async function memoryArea(host: AreaHost, { read }: AreaInputs): Promise<SetupIssue | undefined> {
  const listed = await read(Roots, ROOT_CONVERSATION_ID)
  const empty: number[] = []
  for (const root of listed?.roots ?? []) {
    const rootHasNeverBranched = (await read(Tally, root))?.since === undefined
    if (rootHasNeverBranched) continue
    const doc = await read(Memory, root)
    if (!Object.keys(doc?.memories ?? {}).length) empty.push(root)
  }
  if (!empty.length) return undefined
  return {
    area: 'Project memory',
    status: 'warn',
    summary: `none in root ${empty.map((root) => `#${root}`).join(', ')}`,
    impact:
      "New branches start from the full project context (large, slow, costly). Ask @ultimate to review the project's memory.",
  }
}

type SetupAreaResult = SetupIssue | SetupIssue[] | undefined
type SetupAreaCheck = (
  host: AreaHost,
  inputs: AreaInputs,
) => SetupAreaResult | Promise<SetupAreaResult>

function checkAreaWithDeferredThrowHandling(
  area: SetupAreaCheck,
  host: AreaHost,
  inputs: AreaInputs,
) {
  return Promise.resolve()
    .then(() => area(host, inputs))
    .catch((error: unknown): SetupIssue => ({
      area: 'Setup check',
      status: 'info',
      summary: `one check failed: ${error instanceof Error ? error.message : String(error)}`,
    }))
}

export async function check(
  host: CheckHost,
  read: ReadCurrentDoc = snapshots(host),
): Promise<SetupIssue[]> {
  const settings = host
    .projectSetup()
    .then(({ config, decision }) =>
      config && decision === null ? undefined : host.projectSettings(),
    )
  const areas = await Promise.all(
    (
      [
        loginArea,
        summaryArea,
        agentsArea,
        familiesArea,
        providersArea,
        secretsArea,
        extensionsArea,
        projectArea,
        cloudArea,
        tailscaleArea,
        landerArea,
        worktreeArea,
        memoryArea,
      ] as SetupAreaCheck[]
    ).map((area) => checkAreaWithDeferredThrowHandling(area, host, { read, settings })),
  )
  const warningsBeforeInformationBeforeOk = { warn: 0, info: 1, ok: 2 }
  return areas
    .flat()
    .filter((issue): issue is SetupIssue => !!issue)
    .toSorted(
      (a, b) =>
        warningsBeforeInformationBeforeOk[a.status] - warningsBeforeInformationBeforeOk[b.status],
    )
}

export function setupNote(issues: SetupIssue[]) {
  const warnings = issues.filter((issue) => issue.status === 'warn')
  if (!warnings.length) return undefined
  return `Setup issues on this machine (the user sees them in the status line):\n${warnings
    .map((issue) => `- ${issue.area}: ${issue.summary}${issue.impact ? `. ${issue.impact}` : ''}`)
    .join('\n')}`
}

export async function noteFor(
  tx: Tx,
  conversationId: ConversationId,
  issues: SetupIssue[] | undefined,
  now: number,
) {
  if (!issues) return undefined
  const text = setupNote(issues)
  const key = text ?? ''
  const seen = await tx.doc(LastWarningsCommittedWithInput, conversationId)
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
  const cache = host.resource('setup.check', () => ({ at: 0, issues: [] as SetupIssue[] }))
  const burstCheckCacheMs = 30_000
  const current = async (tx: Tx) => {
    if (Date.now() - cache.at > burstCheckCacheMs) {
      cache.issues = await check(
        host,
        <T extends JsonObject>(doc: ConversationDocToken<T>, id: ConversationId) =>
          tx.doc(doc, id) as Promise<Readonly<T>>,
      )
      cache.at = Date.now()
    }
    return cache.issues
  }
  return defineExtension({
    name: 'setup',
    hooks: [
      hook(GenerationTask, {
        // Pi upstream: @earendil-works/pi-durable@1.6.0 — patched transactional beforeInput hook.
        beforeInput: async function cachePreservingInputNote(_input, { tx, conversationId }) {
          const standing = await tx.doc(Standing, ROOT_CONVERSATION_ID)
          if (standing.ultimate !== conversationId) return undefined
          return noteFor(tx, conversationId, await current(tx).catch(meansNone), Date.now())
        },
      }),
    ],
  })
}

export const pollActions = ['check']

export const actions = {
  check: implementAction(CheckAction, async (_args, { host }) => check(host)),
}
