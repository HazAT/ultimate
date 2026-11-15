import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

export type Source = 'builtin' | 'user' | 'project'
export function discoveryRoots(ultimateRoot: string, projectRoot: string, userHome = homedir()) {
  return [
    { source: 'builtin' as const, path: ultimateRoot },
    { source: 'user' as const, path: join(userHome, '.ultimate') },
    { source: 'project' as const, path: join(projectRoot, '.ultimate') },
  ]
}
export function projectHome(projectRoot: string, userHome = homedir()) {
  const hash = createHash('sha256').update(projectRoot).digest('hex').slice(0, 8)
  return join(userHome, '.ultimate', 'projects', `${basename(projectRoot)}-${hash}`)
}
