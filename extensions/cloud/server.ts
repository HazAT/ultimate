import { basename } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineExtension } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord/json'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { EventToken } from '../../shared/events.ts'
import { implementAction } from '../../lib/actions.ts'
import { cloudConfig, fetchRegister } from '../../lib/cloud.ts'
import { projectIdentity } from '../../lib/project-identity.ts'
import { readSecret } from '../../lib/secrets.ts'
import { CloudApi } from './api.ts'
import { AutomationsApi } from '../automations/api.ts'
import { PauseApi } from '../pause/api.ts'
import { SecretsApi } from '../secrets/api.ts'
import { TailscaleApi } from '../tailscale/api.ts'
import { backUp, chapterKey, classify, Conflict, readBackup } from './backup.ts'
import { join, joinState, saveCloud } from './join.ts'
import { BackupAction, BackupEvent, JoinAction, JoinStateAction, StateAction } from './refs.ts'
import type { CloudState } from './types.ts'

export const secrets = [
  { name: 'ULTIMATE_CLOUD_TOKEN', description: 'Bearer token for the cloud backup Worker' },
  {
    name: 'ULTIMATE_CLOUD_SNAPSHOT_KEY',
    description: 'Encrypts project backups; use the same value on every machine',
  },
]
const SNAPSHOT_KEY = 'ULTIMATE_CLOUD_SNAPSHOT_KEY'
const BACKUP_TIMEOUT_MS = 10 * 60_000
const PAUSED = 'Ultimate is paused; press Play first'

interface Running {
  backup?: CloudState['backup']
  conflict?: CloudState['conflict']
  lastError?: string
}

async function setup(host: ExtensionHost) {
  const config = await cloudConfig(host)
  if (!config) return { status: 'off' as const }
  if (config.satellite) return { status: 'satellite' as const, config }
  const identity = await projectIdentity(host.projectRoot)
  if (!identity) return { status: 'local' as const, config }
  const { chapter } = host
  return {
    status: 'on' as const,
    config,
    key: chapterKey(identity.key, chapter.name, chapter.number === 1),
    chapter: { name: chapter.name, number: chapter.number },
    dir: chapter.dir,
  }
}

async function recordBackupEventNonfatally<D extends JsonValue>(
  host: ExtensionHost,
  event: EventToken<D>,
  data: D,
) {
  await host
    .harness()
    .commit((tx) => host.emit(tx, event, data), context)
    .catch((error: unknown) => host.notice(`Cloud backup: ${String(error)}`))
}

const reloadSharedBackupState = (host: ExtensionHost) =>
  host.resource('cloud.backup', (): Running => ({}))

function claimBackupBeforeFirstAwait(host: ExtensionHost, running: Running) {
  if (running.backup) throw new Error('a backup is already running')
  if (host.want(PauseApi)?.paused()) throw new Error(PAUSED)
  running.backup = { done: 0, total: 0, uploaded: 0 }
}

export async function backup(host: ExtensionHost, force: boolean) {
  const running = reloadSharedBackupState(host)
  claimBackupBeforeFirstAwait(host, running)
  try {
    const ready = await setup(host)
    if (ready.status === 'off')
      throw new Error('Cloud backups are off: join them with ⌘K → Join cloud backups')
    if (ready.status === 'satellite')
      throw new Error(
        'This machine is a satellite (cloud.satellite in user settings): it never backs up, so it cannot replace the backups of the machine that owns this project',
      )
    if (ready.status === 'local')
      throw new Error(`${host.projectRoot} has no GitHub origin remote, so it cannot be backed up`)
    return await upload(host, running, ready, force)
  } finally {
    running.backup = undefined
  }
}

async function upload(
  host: ExtensionHost,
  running: Running,
  ready: {
    config: { url: string; token: string; machine: string }
    key: string
    chapter: { name: string; number: number }
    dir: string
  },
  force: boolean,
) {
  const started = Date.now()
  await recordBackupEventNonfatally(host, BackupEvent, {
    phase: 'started',
    project: ready.key,
  })
  try {
    const secret = process.env[SNAPSHOT_KEY] ?? (await readSecret(host.userHome, SNAPSHOT_KEY))
    if (!secret)
      throw new Error(`Missing ${SNAPSHOT_KEY}. Add it in the Secrets panel (⌘K → Secrets).`)
    const tailnet = host.want(TailscaleApi)?.status().url
    const done = await backUp({
      ...ready.config,
      secret,
      key: ready.key,
      chapter: ready.chapter,
      dir: ready.dir,
      projectRoot: host.projectRoot,
      force,
      ...(tailnet?.startsWith('https://') ? { tailnet } : {}),
      signal: AbortSignal.timeout(BACKUP_TIMEOUT_MS),
      progress: (read, total, uploaded) => {
        running.backup = { done: read, total, uploaded }
      },
    })
    running.conflict = running.lastError = undefined
    await recordBackupEventNonfatally(host, BackupEvent, {
      phase: 'done',
      project: ready.key,
      bytes: done.bytes,
      uploaded: done.uploaded,
      ms: Date.now() - started,
    })
    return done
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof Conflict) {
      running.conflict = { error: message, ...(error.latest ? { latest: error.latest } : {}) }
      running.lastError = undefined
    } else {
      running.conflict = undefined
      running.lastError = `Backup failed: ${message}`
      host.notice(running.lastError)
    }
    await recordBackupEventNonfatally(host, BackupEvent, {
      phase: 'failed',
      project: ready.key,
      ms: Date.now() - started,
      reason: classify(error),
      ...(error instanceof Conflict ? { error: message } : {}),
    })
    throw error
  }
}

export const actions = {
  state: implementAction(StateAction, async (_args, { host }): Promise<CloudState> => {
    const ready = await setup(host)
    const running = reloadSharedBackupState(host)
    const name = basename(host.projectRoot)
    if (ready.status === 'satellite')
      return { status: 'satellite', name, machine: ready.config.machine }
    if (ready.status !== 'on') return { status: ready.status, name }
    const saved = await readBackup(ready.dir, ready.key)
    return {
      status: 'on',
      name,
      chapter: { name: host.chapter.name, number: host.chapter.number },
      machine: ready.config.machine,
      ...(saved ? { lastBackup: saved.last } : {}),
      ...(running.backup ? { backup: { ...running.backup } } : {}),
      ...(running.conflict ? { conflict: running.conflict } : {}),
      ...(running.lastError ? { lastError: running.lastError } : {}),
    }
  }),
  backup: implementAction(BackupAction, (args, { host }) =>
    backup(host, (args as { force?: unknown } | null)?.force === true),
  ),
  joinState: implementAction(JoinStateAction, (_args, { host }) => joinState(host.userHome)),
  join: implementAction(JoinAction, async (args, { host }) => {
    const store = host.need(SecretsApi)
    return join(
      {
        fetch: (input, init) => fetch(input, init),
        setSecret: (name, value) => store.set(name, value),
        saveCloud: saveCloud(host.userHome),
      },
      args && typeof args === 'object' && !Array.isArray(args) ? args : {},
    )
  }),
}
export const userActions = ['join']
export const traceSealed = true

export default function cloud(host: ExtensionHost) {
  host.implement(CloudApi, {
    backup: () => backup(host, false),
    lastBackup: async () => {
      const ready = await setup(host)
      if (ready.status !== 'on') return undefined
      const saved = await readBackup(ready.dir, ready.key)
      if (saved) return saved.last
      const latest = (await fetchRegister(ready.config)).projects.find(
        (project) => project.key === ready.key,
      )?.latest
      if (!latest) return undefined
      const { id, at, machine, bytes, uploaded } = latest
      return { id, at, machine, bytes, uploaded }
    },
    status: async () => (await setup(host)).status,
  })
  host.want(TailscaleApi)
  host.want(PauseApi)
  host.need(SecretsApi)
  const automations = host.need(AutomationsApi)
  host.onOpen(async (opened) => {
    opened.defer(
      automations.trigger({
        event: BackupEvent,
        description: 'Cloud backup changed phase',
        fields: { phase: 'started | done | failed' },
      }),
    )
  })
  host.react('automations', [BackupEvent], (tx, event) => automations.matched(tx, event), {
    from: { cursorOf: 'automations/events' },
  })
  return defineExtension({ name: 'cloud' })
}
