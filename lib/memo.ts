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

export function fileMemo<T>(source: {
  paths: () => Promise<readonly string[]>
  read: () => Promise<T>
  key?: () => string
}) {
  let last: { value: T; paths: readonly string[]; signature: string } | undefined
  const sign = async (paths: readonly string[]) =>
    `${source.key?.() ?? ''}|${await signature(paths)}`
  return async (): Promise<T> => {
    const cached = last
    if (cached && (await sign(cached.paths)) === cached.signature) return cached.value
    const paths = await source.paths()
    const before = await sign(paths)
    const value = await source.read()
    const unchangedWhileRead = (await sign(paths)) === before
    last = unchangedWhileRead ? { value, paths, signature: before } : undefined
    return value
  }
}
