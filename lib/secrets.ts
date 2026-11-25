import { open } from 'node:fs/promises'
import { defaultProviderAuthContext } from '@earendil-works/pi-ai'
import type { AuthContext } from '@earendil-works/pi-ai'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { isMissing, meansNone } from './errors.ts'

export type Store = { secrets: Record<string, { value: string; updatedAt: string }> }
export function validateName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(name))
    throw new Error('Secret name must match ^[A-Z][A-Z0-9_]*$')
}
export function validateValue(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    Buffer.byteLength(value) > 16384 ||
    /[\0\r\n]/.test(value)
  )
    throw new Error('Secret value must be non-empty, at most 16 KiB, with no NUL or newline')
}
export async function readStore(userHome: string): Promise<Store> {
  const path = join(userHome, '.ultimate/secrets.json')
  let file
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (isMissing(error)) return { secrets: {} }
    throw new Error('Cannot open secret store', { cause: error })
  }
  try {
    if ((await file.stat()).mode & 0o077)
      throw new Error('Secret store permissions are unsafe. Run chmod 600 ~/.ultimate/secrets.json')
    let data: Store
    try {
      data = JSON.parse(await file.readFile('utf8'))
      if (!data || !data.secrets || typeof data.secrets !== 'object' || Array.isArray(data.secrets))
        throw new Error()
      for (const [name, item] of Object.entries(data.secrets)) {
        validateName(name)
        validateValue(item.value)
        if (typeof item.updatedAt !== 'string') throw new Error()
      }
    } catch {
      throw new Error('Invalid secret store; repair ~/.ultimate/secrets.json or remove it')
    }
    return data
  } finally {
    await file.close()
  }
}
export async function readSecret(userHome: string, name: string): Promise<string | undefined> {
  validateName(name)
  return (await readStore(userHome)).secrets[name]?.value
}
export async function secretMetadata(userHome: string) {
  return Object.entries((await readStore(userHome)).secrets).map(([name, item]) => ({
    name,
    set: true,
    updatedAt: item.updatedAt,
  }))
}
export function secretsAuthContext(userHome: string): AuthContext {
  const ambient = defaultProviderAuthContext()
  return {
    ...ambient,
    env: async (name) =>
      (await ambient.env(name)) ??
      (await readStore(userHome).catch(meansNone))?.secrets[name]?.value,
  }
}
