import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readlink, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { errnoCode, isMissing, settled } from './errors.ts'

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if (!isMissing(error)) throw error
    return fallback
  }
}

export async function writeTarget(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  try {
    return await writeTarget(resolve(dirname(path), await readlink(path)))
  } catch (error) {
    const code = errnoCode(error)
    const missingOrNotSymlink = code === 'ENOENT' || code === 'EINVAL'
    if (missingOrNotSymlink) return path
    throw error
  }
}

export async function writeTextAtomically(
  path: string,
  text: string,
  { mode }: { mode?: number } = {},
) {
  const target = await writeTarget(path)
  await mkdir(dirname(target), { recursive: true })
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`)
  try {
    const file = await open(temporary, 'wx', mode)
    try {
      await file.writeFile(text)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true })
  }
}

export const writeJson = (path: string, value: unknown, options: { mode?: number } = {}) =>
  writeTextAtomically(path, JSON.stringify(value, null, 2) + '\n', options)

const writesSerializedByPath = new Map<string, Promise<void>>()
export async function updateJson<T>(
  path: string,
  readAndValidate: (path: string) => Promise<T>,
  modify: (value: T) => void,
) {
  const readModifyWrite = settled(writesSerializedByPath.get(path) ?? Promise.resolve()).then(
    async () => {
      const value = await readAndValidate(path)
      modify(value)
      await writeJson(path, value)
    },
  )
  writesSerializedByPath.set(path, readModifyWrite)
  try {
    await readModifyWrite
  } finally {
    if (writesSerializedByPath.get(path) === readModifyWrite) writesSerializedByPath.delete(path)
  }
}
