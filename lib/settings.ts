import { join } from 'node:path'
import type { JsonObject } from '@earendil-works/pi-durable'
import { readJson, updateJson } from './json-file.ts'

/** This machine's settings file, `~/.ultimate/settings.json`. */
export const userSettingsPath = (userHome: string) => join(userHome, '.ultimate/settings.json')

/** A settings file's JSON object; a missing file is empty. */
export async function readSettings(path: string): Promise<JsonObject> {
  const value = await readJson<unknown>(path, {})
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Settings must be a JSON object')
  return value as JsonObject
}

/**
 * What a project's `.ultimate/settings.json` declares for the lander (`checks`, `push`), read from the file whether or
 * not the project's setup is trusted.
 */
export async function declaredLander(projectRoot: string) {
  const lander = (await readSettings(join(projectRoot, '.ultimate/settings.json'))).lander as
    | { checks?: unknown; push?: unknown }
    | undefined
  return [
    ...(Array.isArray(lander?.checks) && lander.checks.length ? ['checks'] : []),
    ...(lander?.push ? ['push'] : []),
  ]
}

/** Read, change and save a settings file, one change at a time per path, preserving other keys. */
export const updateSettings = (path: string, modify: (value: JsonObject) => void) =>
  updateJson(path, readSettings, modify)
