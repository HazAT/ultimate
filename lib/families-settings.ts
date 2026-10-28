/**
 * Where model families live: `~/.ultimate/model-families.json` keeps each project's families (keyed like its trust
 * decision, so a linked worktree shares its main checkout's) and the most recently saved ones, which every project
 * without its own starts from. A project's `.ultimate/settings.json` `modelFamilies` applies over either, for a team.
 */
import { join, resolve } from 'node:path'
import type { JsonObject } from '@earendil-works/pi-durable'
import { mergeFamilies, parseFamilies } from './families.ts'
import type { Families } from './families.ts'
import { readJson, updateJson } from './json-file.ts'
// oxlint-disable-next-line no-restricted-imports -- family settings follow the core project trust decision, as definitions do
import { decisionRoot, projectSettings } from '../server/project-setup.ts'

/** The families file of this machine. */
export const familiesPath = (userHome: string) => join(userHome, '.ultimate/model-families.json')

type Stored = { recent?: unknown; projects?: Record<string, unknown> }
type Layer = ReturnType<typeof parseFamilies>

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** The key of a project's families: its main checkout for a linked worktree, as its trust decision is. */
export function projectKey(projectRoot: string) {
  try {
    return decisionRoot(projectRoot)
  } catch {
    // A project folder that is gone or unreadable has no main checkout to share: its own path keys it.
    return resolve(projectRoot)
  }
}

async function readStored(path: string): Promise<Stored> {
  const value = await readJson<unknown>(path, {})
  if (!isObject(value)) throw new Error(`${path} must be a JSON object`)
  return value
}

export type FamilyLayers = {
  /** The project's own families, else the most recent ones; `from` says which. */
  base: Layer
  from: 'project' | 'recent' | 'builtin'
  /** The project's `.ultimate/settings.json` `modelFamilies`, over the base. */
  project: Layer
  /** A layer that failed to parse counts as empty; its error is here. */
  errors: string[]
}

/**
 * Each layer of `projectRoot`'s families. `settings` is the gated project settings (`host.projectSettings()`) when the
 * caller has them; otherwise they are read once the project's setup is chosen.
 */
export async function readFamilyLayers(
  userHome: string,
  projectRoot: string,
  settings?: JsonObject,
): Promise<FamilyLayers> {
  const errors: string[] = []
  const layer = (value: unknown, where: string) => {
    try {
      return parseFamilies(value)
    } catch (error) {
      errors.push(`${where}: ${error instanceof Error ? error.message : String(error)}`)
      return parseFamilies(undefined)
    }
  }
  // An unreadable file counts as none here, and saving over it fails.
  const stored = await readStored(familiesPath(userHome)).catch((error: unknown): Stored => {
    errors.push(String(error))
    return {}
  })
  const own = isObject(stored.projects) ? stored.projects[projectKey(projectRoot)] : undefined
  const from = own !== undefined ? 'project' : stored.recent !== undefined ? 'recent' : 'builtin'
  return {
    base: layer(own ?? stored.recent, `${familiesPath(userHome)} (${from})`),
    from,
    project: layer(
      (settings ?? (await projectSettings(projectRoot, userHome))).modelFamilies,
      'project settings: modelFamilies',
    ),
    errors,
  }
}

/** The effective families of `projectRoot`: the built-ins, its own (or the most recent) ones, its team settings. */
export async function readFamilies(
  userHome: string,
  projectRoot: string,
  settings?: JsonObject,
): Promise<Families> {
  const { base, project } = await readFamilyLayers(userHome, projectRoot, settings)
  return mergeFamilies(base, project)
}

/** Save `value` as `projectRoot`'s families and as the most recent ones, which new projects start from. */
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
