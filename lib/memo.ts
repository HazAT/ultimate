import { stat } from 'node:fs/promises'
import { ignoring, isMissing } from './errors.ts'

export async function signature(paths: readonly string[]) {
  const stats = await Promise.all(
    paths.map((path) => stat(path, { bigint: true }).catch(ignoring(isMissing))),
  )
  return stats
    .map((found) => (found ? `${found.ino}:${found.size}:${found.mtimeNs}` : '-'))
    .join(',')
}

export function fileMemo<T>(
  compute: () => Promise<{ value: T; paths: readonly string[] }>,
  key: () => string = () => '',
) {
  let last: { value: T; paths: readonly string[]; signature: string } | undefined
  const sign = async (paths: readonly string[]) => `${key()}|${await signature(paths)}`
  return async (): Promise<T> => {
    const before = last && (await sign(last.paths))
    if (last && before === last.signature) return last.value
    const { value, paths } = await compute()
    const samePaths = last !== undefined && paths.join('\0') === last.paths.join('\0')
    last = { value, paths, signature: samePaths ? before! : await sign(paths) }
    return value
  }
}
