import { chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJson } from '../../lib/json-file.ts'
import { readStore, validateName, validateValue } from '../../lib/secrets.ts'
import { acquireLock } from '../../lib/lock.ts'

export async function writeSecret(userHome: string, name: string, value?: string) {
  validateName(name)
  if (value !== undefined) validateValue(value)
  const directory = join(userHome, '.ultimate')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const path = join(directory, 'secrets.json')
  const lock = await acquireLock(path + '.lock', { pid: process.pid }, 120000)
  try {
    const store = await readStore(userHome)
    const updatedAt = new Date().toISOString()
    if (value === undefined) delete store.secrets[name]
    else store.secrets[name] = { value, updatedAt }
    await writeJson(path, store, { mode: 0o600 })
    return { name, set: value !== undefined, ...(value === undefined ? {} : { updatedAt }) }
  } finally {
    await lock.close()
  }
}
