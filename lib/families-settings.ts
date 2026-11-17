import { join, resolve } from 'node:path'
import type { JsonObject } from '@earendil-works/pi-durable'
import { mergeFamilies, parseFamilies } from './families.ts'
import type { Families } from './families.ts'
import { readJson, updateJson } from './json-file.ts'
import { decisionRoot, projectSettings } from './project-setup.ts'
import { readSettings, userSettingsPath } from './settings.ts'

export const familiesPath = (userHome: string) => join(userHome, '.ultimate/model-families.json')

type Stored = { recent?: unknown; projects?: Record<string, unknown> }
type Layer = ReturnType<typeof parseFamilies>

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export function projectKey(projectRoot: string) {
  try {
    return decisionRoot(projectRoot)
  } catch {
    return resolve(projectRoot)
  }
}

async function readStored(path: string): Promise<Stored> {
  const value = await readJson<unknown>(path, {})
  if (!isObject(value)) throw new Error(`${path} must be a JSON object`)
  return value
}

export type FamilyLayers = {
  user: Layer
  base: Layer
  from: 'project' | 'recent' | 'builtin'
  project: Layer
  errors: string[]
}

export async function readFamilyLayers(
  userHome: string,
  projectRoot: string,
  settings?: JsonObject,
): Promise<FamilyLayers> {
  const errors: string[] = []
  const parseLayerOrReportEmpty = (value: unknown, where: string) => {
    try {
      return parseFamilies(value)
    } catch (error) {
      errors.push(`${where}: ${error instanceof Error ? error.message : String(error)}`)
      return parseFamilies(undefined)
    }
  }
  const stored = await readStored(familiesPath(userHome)).catch((error: unknown): Stored => {
    errors.push(String(error))
    return {}
  })
  const user = await readSettings(userSettingsPath(userHome)).catch(
    (error: unknown): JsonObject => {
      errors.push(`${userSettingsPath(userHome)}: ${String(error)}`)
      return {}
    },
  )
  const own = isObject(stored.projects) ? stored.projects[projectKey(projectRoot)] : undefined
  const from = own !== undefined ? 'project' : stored.recent !== undefined ? 'recent' : 'builtin'
  return {
    user: parseLayerOrReportEmpty(user.modelFamilies, 'user settings: modelFamilies'),
    base: parseLayerOrReportEmpty(own ?? stored.recent, `${familiesPath(userHome)} (${from})`),
    from,
    project: parseLayerOrReportEmpty(
      (settings ?? (await projectSettings(projectRoot, userHome))).modelFamilies,
      'project settings: modelFamilies',
    ),
    errors,
  }
}

export const mergeLayers = ({ user, base, from, project }: FamilyLayers) =>
  from === 'project' ? mergeFamilies(user, project, base) : mergeFamilies(user, base, project)

export async function readFamilies(
  userHome: string,
  projectRoot: string,
  settings?: JsonObject,
): Promise<Families> {
  return mergeLayers(await readFamilyLayers(userHome, projectRoot, settings))
}

export async function writeFamilies(userHome: string, projectRoot: string, value: JsonObject) {
  parseFamilies(value)
  await updateJson(familiesPath(userHome), readStored, (stored) => {
    stored.recent = value
    stored.projects = {
      ...(isObject(stored.projects) ? stored.projects : {}),
      [projectKey(projectRoot)]: value,
    }
  })
}
