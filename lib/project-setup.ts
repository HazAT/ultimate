import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import type { JsonObject } from '@earendil-works/pi-durable'
import { errnoCode, isMissing } from './errors.ts'

export function projectDiagnostics(projectRoot: string, userHome = homedir()) {
  const { error } = readDecision(projectRoot, userHome)
  return error ? [error] : []
}

export async function projectSettings(
  projectRoot: string,
  userHome: string,
  report: (message: string) => void = () => {},
): Promise<JsonObject> {
  if (!useProjectSetup(projectRoot, userHome)) return {}
  try {
    const value = JSON.parse(await readFile(join(projectRoot, '.ultimate/settings.json'), 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Project settings must be a JSON object')
    return value
  } catch (error) {
    if (!isMissing(error)) report(String(error))
    return {}
  }
}

export function decisionRoot(projectRoot: string) {
  const root = realpathSync(resolve(projectRoot))
  let link: string
  try {
    link = readFileSync(join(root, '.git'), 'utf8')
  } catch (error) {
    const folderOwnsDecision = isMissing(error) || errnoCode(error) === 'EISDIR'
    if (folderOwnsDecision) return root
    throw error
  }
  const gitdir = resolve(root, link.match(/^gitdir: (.+)$/m)![1])
  const submoduleOwnsDecision = !existsSync(join(gitdir, 'commondir'))
  if (submoduleOwnsDecision) return root
  const common = resolve(gitdir, readFileSync(join(gitdir, 'commondir'), 'utf8').trim())
  return basename(common) === '.git' ? realpathSync(dirname(common)) : root
}

export function readDecision(projectRoot: string, userHome = homedir()) {
  try {
    const root = decisionRoot(projectRoot)
    const entry = new ProjectTrustStore(join(userHome, '.ultimate')).getEntry(root)
    return { decision: entry?.path === root ? entry.decision : null }
  } catch (error) {
    return { decision: null, error: String(error) }
  }
}

export function projectDecision(projectRoot: string, userHome = homedir()) {
  return readDecision(projectRoot, userHome).decision
}

export function useProjectSetup(projectRoot: string, userHome?: string) {
  return projectDecision(projectRoot, userHome) === true
}

export async function projectSetup(projectRoot: string, userHome?: string) {
  const root = join(projectRoot, '.ultimate')
  const config = ['extensions', 'agents', 'skills', 'settings.json'].some((name) =>
    existsSync(join(root, name)),
  )
  const readme = await readFile(join(root, 'README.md'), 'utf8').then(
    (text) =>
      Array.from(text)
        .slice(0, 16 * 1024)
        .join(''),
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    },
  )
  return { config, decision: projectDecision(projectRoot, userHome), ...(readme ? { readme } : {}) }
}
