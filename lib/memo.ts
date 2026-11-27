import { stat } from 'node:fs/promises'
import { errnoCode, ignoring } from './errors.shared.ts'

const absent = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes(errnoCode(error) ?? '')

export async function signature(paths: readonly string[]) {
  const stats = await Promise.all(
    paths.map((path) => stat(path, { bigint: true }).catch(ignoring(absent))),
  )
  return stats
    .map((found) => (found ? `${found.ino}:${found.size}:${found.mtimeNs}` : '-'))
    .join(',')
}

export type FileMemoState<T> = {
  last?: { value: T; paths: readonly string[]; signature: string }
}

export function fileMemo<T>(
  source: {
    paths: () => Promise<readonly string[]>
    read: () => Promise<T>
    key?: () => string
  },
  state: FileMemoState<T> = {},
) {
  const sign = async (paths: readonly string[]) =>
    `${source.key?.() ?? ''}|${await signature(paths)}`
  return async (): Promise<T> => {
    const cached = state.last
    if (cached && (await sign(cached.paths)) === cached.signature) return cached.value
    const paths = await source.paths()
    const before = await sign(paths)
    const value = await source.read()
    const unchangedWhileRead = (await sign(paths)) === before
    state.last = unchangedWhileRead ? { value, paths, signature: before } : undefined
    return value
  }
}
