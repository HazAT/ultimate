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
