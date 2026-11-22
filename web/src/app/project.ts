import type { SystemInfo } from '../../../shared/protocol.ts'
import { prettyName, shortenPath } from '../sdk/format.ts'

const worktreeOf = (system: SystemInfo) =>
  /\/\.ultimate\/projects\/(.+)-[\da-f]{8}\/worktrees\/(\d+)$/.exec(system.project.root)

export const isPreview = (system: SystemInfo) =>
  !system.persistence.path.startsWith(`${system.machine.home}/.ultimate/projects/`)

export function projectTitle(system: SystemInfo | undefined) {
  if (!system) return undefined
  const worktree = worktreeOf(system)
  const project = worktree
    ? `${worktree[1]} #${worktree[2]}`
    : shortenPath(system.project.root, { home: system.machine.home })
  return isPreview(system) ? `preview · ${project}` : project
}

export function projectHeading(system: SystemInfo | undefined) {
  if (!system) return undefined
  const worktree = worktreeOf(system)
  const path = worktree
    ? `#${worktree[2]}`
    : shortenPath(system.project.root, { home: system.machine.home })
  const folder = worktree?.[1] ?? system.project.name
  return { folder, name: prettyName(folder), path: isPreview(system) ? `preview · ${path}` : path }
}

export function projectName(system: SystemInfo | undefined) {
  if (!system) return ''
  const worktree = worktreeOf(system)
  const name = worktree?.[1] ?? system.project.name
  const own = name.toLowerCase() === 'ultimate'
  return [own ? '' : name, worktree ? `#${worktree[2]}` : ''].filter(Boolean).join(' ')
}
