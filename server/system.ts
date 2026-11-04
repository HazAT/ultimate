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
import { relative, basename, join } from 'node:path'
import { projectSkills } from './skills.ts'
import { projectSetup, projectSettings } from './project-setup.ts'
import { loadProjectContextFiles } from '@earendil-works/pi-coding-agent'
import type { ExtensionInfo, SystemInfo } from '../shared/protocol.ts'
import type { Watch } from './extensions.ts'
import type { PreparedHost } from './harness.ts'
import { watchRoots } from './watch-roots.ts'
import { exec as run } from '../lib/exec.ts'

/** The skills the Info tab lists, with their scope and overrides, and Pi's load diagnostics as text. */
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
  registry: (() => ExtensionInfo[]) & { diagnostics: () => string[] },
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
  let timer: ReturnType<typeof setTimeout> | undefined
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
        name: basename(host.projectRoot),
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
      extensionDiagnostics: registry.diagnostics(),
      ...skillInfo(projectSkills(host)),
      contextFiles: loadProjectContextFiles({
        cwd: host.projectRoot,
        agentDir: join(host.userHome, '.ultimate'),
      }).map((file) => file.path),
    }
    // Free memory and database sizes change all the time: new streams get them fresh, but alone they broadcast nothing,
    // since every tab re-renders whatever reads the system info on each broadcast.
    const json = JSON.stringify({
      ...value,
      machine: { ...value.machine, freeMemory: 0 },
      persistence: { ...value.persistence, sizeBytes: 0, walBytes: 0 },
    })
    if (json !== previous) {
      previous = json
      emit(value)
    }
  }
  const schedule = (_event?: string, path?: string | null) => {
    if (path && /^(server|shared)\//.test(relative(host.ultimateRoot, path))) {
      coreStale = true
      code.coreStale = true
    }
    if (closed || timer) return
    timer = setTimeout(
      () => {
        timer = undefined
        chain = chain.then(() => refresh(true)).catch(reportError)
      },
      Math.max(100, 2000 - (Date.now() - lastGit)),
    )
  }
  // Not the storage home: it changes with every conversation update (conversations.json), each refresh runs git, and
  // nothing broadcast reads it (database sizes are left out above).
  const unwatch = watchRepo((watcher) => {
    watcher.add([
      host.ultimateRoot,
      join(host.projectRoot, '.ultimate'),
      join(host.userHome, '.ultimate/extensions'),
      join(host.userHome, '.ultimate/skills'),
      join(host.projectRoot, '.agents/skills'),
      join(host.projectRoot, '.pi/skills'),
    ])
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
    changed() {
      if (!closed) chain = chain.then(() => refresh()).catch(reportError)
      return chain
    },
    async close() {
      closed = true
      clearTimeout(timer)
      unwatch()
      await chain
    },
  }
}
