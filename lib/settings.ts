import { join } from 'node:path'
import type { JsonObject } from '@earendil-works/pi-durable'
import { readJson, updateJson } from './json-file.ts'

export const userSettingsPath = (userHome: string) => join(userHome, '.ultimate/settings.json')

export async function readSettings(path: string): Promise<JsonObject> {
  const value = await readJson<unknown>(path, {})
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Settings must be a JSON object')
  return value as JsonObject
}

export const updateSettings = (path: string, modify: (value: JsonObject) => void) =>
  updateJson(path, readSettings, modify)

export function extensionLists(value: JsonObject) {
  const extensions = value.extensions ?? {}
  if (typeof extensions !== 'object' || Array.isArray(extensions))
    throw new Error('extensions must be a JSON object')
  for (const key of ['enable', 'disable']) {
    const names = extensions[key]
    if (
      names !== undefined &&
      (!Array.isArray(names) || names.some((name) => typeof name !== 'string'))
    )
      throw new Error(`extensions.${key} must be an array of names`)
  }
  value.extensions = extensions
  return extensions
}

export function toggleExtension(extensions: JsonObject, name: string, enabled: boolean) {
  const key = enabled ? 'enable' : 'disable'
  const opposite = enabled ? 'disable' : 'enable'
  extensions[key] = [...new Set([...((extensions[key] as string[]) ?? []), name])]
  if (extensions[opposite] !== undefined)
    extensions[opposite] = (extensions[opposite] as string[]).filter((entry) => entry !== name)
}
