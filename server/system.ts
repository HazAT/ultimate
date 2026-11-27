import { stat } from 'node:fs/promises'
import {
  arch,
  cpus,
  freemem,
  homedir,
  hostname,
  platform,
  release,
  totalmem,
  userInfo,
} from 'node:os'
import { relative, join } from 'node:path'
import { projectSkills } from './skills.ts'
import { projectName, projectSetup, projectSettings } from '../lib/project-setup.ts'
import { loadProjectContextFiles } from '@earendil-works/pi-coding-agent'
import type { ExtensionInfo, SystemInfo } from '../shared/protocol.ts'
import type { Watch } from './extensions.ts'
import type { PreparedHost } from './harness.ts'
import { watchRoots } from './watch-roots.ts'
import { exec as run } from '../lib/exec.ts'
import { deadline } from '../lib/timers.shared.ts'
import { corePath } from '../lib/layers.ts'
import { rebuiltOnOpen } from '../lib/errors.shared.ts'
import type { Cancel } from '../lib/timers.shared.ts'

export function skillInfo({
  skills,
  diagnostics,
}: ReturnType<typeof projectSkills>): Pick<SystemInfo, 'skills' | 'skillDiagnostics'> {
  return {
    skills: skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      path: skill.filePath,
      scope: skill.scope,
      overrides: skill.overrides,
      ...(skill.disableModelInvocation && { manual: true as const }),
    })),
    skillDiagnostics: diagnostics.map((diagnostic) => ({
      type: diagnostic.type,
      message: diagnostic.message,
      ...(diagnostic.path && { path: diagnostic.path }),
    })),
  }
}
async function bytes(path: string) {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}
export async function createSystem(
  host: PreparedHost,
  watchRepo: Watch,
  url: string,
  registry: (() => ExtensionInfo[]) & { diagnostics: () => Promise<string[]> },
  emit: (info: SystemInfo) => void,
  notice: (message: string) => void = () => {},
  processInfo: { activationError?: string } = {},
  origins: () => string[] = () => [],
  web: () => SystemInfo['web'] = () => ({ id: '', changed: [] }),
) {
  const startedAt = new Date().toISOString()
  let coreStale = false
  let code: SystemInfo['code'] = {
    ultimateRoot: host.ultimateRoot,
    branch: '',
    sha: '',
    dirty: false,
  }
  let value: SystemInfo
  let previous = ''
  let cancelRefresh: Cancel | undefined
  let lastGit = 0
  let closed = false
  let chain = Promise.resolve()
  const reportError = (error: unknown) => notice(`System refresh failed: ${String(error)}`)
  async function refresh(git = false) {
    if (git) {
      const command = async (args: string[]) => {
        try {
          return (await run('git', args, { cwd: host.ultimateRoot })).stdout.trim()
        } catch {
          return ''
        }
      }
      code = {
        ultimateRoot: host.ultimateRoot,
        branch: await command(['branch', '--show-current']),
        sha: await command(['rev-parse', '--short', 'HEAD']),
        dirty: (await command(['status', '--porcelain'])).length > 0,
        coreStale,
      }
      lastGit = Date.now()
    }
    const cpu = cpus()
    let settingsError: string | undefined
    const settings = await projectSettings(host.projectRoot, host.userHome, (message) => {
      settingsError = message
      notice(message)
    })
    value = {
      build: host.build(),
      project: {
        root: host.projectRoot,
        name: projectName(host.projectRoot, settings),
        ...(await projectSetup(host.projectRoot, host.userHome)),
        settings,
        ...(settingsError ? { settingsError } : {}),
      },
      machine: {
        hostname: hostname(),
        home: homedir(),
        platform: platform(),
        release: release(),
        arch: arch(),
        cpuModel: cpu[0]?.model ?? '',
        cpuCount: cpu.length,
        totalMemory: totalmem(),
        freeMemory: freemem(),
        user: userInfo().username,
      },
      process: {
        pid: process.pid,
        node: process.version,
        startedAt,
        generation: Number(process.env.ULTIMATE_GENERATION ?? 1),
        ...(processInfo.activationError ? { activationError: processInfo.activationError } : {}),
        url,
      },
      access: { origins: origins() },
      persistence: {
        kind: 'sqlite',
        path: host.database,
        sizeBytes: await bytes(host.database),
        walBytes: await bytes(host.database + '-wal'),
      },
      execution: { kind: 'node-local', defaultCwd: host.projectRoot },
      code,
      web: web(),
      extensions: registry(),
      extensionDiagnostics: await registry.diagnostics(),
      ...skillInfo(projectSkills(host)),
      contextFiles: loadProjectContextFiles({
        cwd: host.projectRoot,
        agentDir: join(host.userHome, '.ultimate'),
      }).map((file) => file.path),
    }
    const withoutVolatileSizeAndMemory = JSON.stringify({
      ...value,
      machine: { ...value.machine, freeMemory: 0 },
      persistence: { ...value.persistence, sizeBytes: 0, walBytes: 0 },
    })
    if (withoutVolatileSizeAndMemory !== previous) {
      previous = withoutVolatileSizeAndMemory
      emit(value)
    }
  }
  const changed = () => {
    if (!closed) chain = chain.then(() => refresh()).catch(reportError)
    return chain
  }
  const secrets = join(host.userHome, '.ultimate/secrets.json')
  const schedule = (_event?: string, path?: string | null) => {
    if (path === secrets) {
      rebuiltOnOpen('open reads secrets again', changed())
      rebuiltOnOpen(
        'open checks provider auth again',
        host.modelRuntime.refresh({ allowNetwork: false }),
      )
      return
    }
    if (path && corePath(relative(host.ultimateRoot, path))) {
      coreStale = true
      code.coreStale = true
    }
    if (closed || cancelRefresh) return
    cancelRefresh = deadline(Math.max(100, 2000 - (Date.now() - lastGit)), () => {
      cancelRefresh = undefined
      chain = chain.then(() => refresh(true)).catch(reportError)
    })
  }
  const unwatch = watchRepo((watcher) => {
    const sourceRootsExcludingStorageHome = [
      host.ultimateRoot,
      join(host.projectRoot, '.ultimate'),
      join(host.userHome, '.ultimate/extensions'),
      join(host.userHome, '.ultimate/skills'),
      join(host.projectRoot, '.agents/skills'),
      join(host.projectRoot, '.pi/skills'),
    ]
    const secretsClearMissingSecretNotices = secrets
    watcher.add([...sourceRootsExcludingStorageHome, secretsClearMissingSecretNotices])
    const stopRoots = watchRoots([join(host.projectRoot, '.ultimate')], (root) => {
      watcher.add(root)
      schedule()
    })
    watcher.on('all', schedule)
    return () => {
      stopRoots()
      watcher.off('all', schedule)
    }
  })
  await refresh(true)
  return {
    current: () => value,
    changed,
    async close() {
      closed = true
      cancelRefresh?.()
      unwatch()
      await chain
    },
  }
}
