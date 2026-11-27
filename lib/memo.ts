import { stat } from 'node:fs/promises'
import { errnoCode } from './errors.shared.ts'

const unreadable = (error: unknown) => {
  const code = errnoCode(error)
  if (code === undefined) throw error
  return ['ENOENT', 'ENOTDIR'].includes(code) ? '-' : `!${code}`
}

export async function signature(paths: readonly string[]) {
  const stats = await Promise.all(
    paths.map((path) =>
      stat(path, { bigint: true }).then(
        (found) => `${found.ino}:${found.size}:${found.mtimeNs}`,
        unreadable,
      ),
    ),
  )
  return stats.join(',')
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
