/**
 * The families' server side: what the families are, who runs on which, and saving them. Saving writes this project's
 * families and makes them the most recent ones, which projects without their own start from
 * (lib/families-settings.ts). A default family without a model of its own follows Pi's default model and thinking.
 * A change applies to conversations started after it; open ones keep their model. An agent's family is its
 * definition's; settings assign only features.
 */
import { clampThinkingLevel } from '@earendil-works/pi-ai'
import type { JsonObject } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { discoverAgents } from '../../lib/agents.ts'
import {
  agentUser,
  BUILTIN_FAMILIES,
  DEFAULT_FAMILY,
  definitionRuns,
  FEATURES,
  mergeFamilies,
  parseFamilies,
  RECOMMENDED_THINKING,
  refName,
  refOf,
} from '../../lib/families.ts'
import type { Families, Feature, FamilySpec } from '../../lib/families.ts'
import { mergeLayers, readFamilyLayers, writeFamilies } from '../../lib/families-settings.ts'
import { readSettings, updateSettings, userSettingsPath } from '../../lib/settings.ts'
import type { FamiliesView, FamilyUser, SaveFamilies } from './refs.ts'

/** Where a feature's pin lives in settings, and its value there. */
const pins: Record<Feature, { key: string; read: (settings: JsonObject) => unknown }> = {
  summaries: { key: 'summaryModel', read: (settings) => settings.summaryModel },
  preview: {
    key: 'instance.model',
    read: (settings) => {
      const instance = settings.instance
      return instance && typeof instance === 'object' && !Array.isArray(instance)
        ? instance.model
        : undefined
    },
  },
}
const pinned = (value: unknown) =>
  value === undefined
    ? undefined
    : value === null
      ? 'off'
      : typeof value === 'string'
        ? value
        : JSON.stringify(value)

/** Pi's default model and thinking, which a default family without its own follows. */
const piDefault = (host: Pick<ExtensionHost, 'settings'>) => {
  const provider = host.settings.getDefaultProvider()
  const modelId = host.settings.getDefaultModel()
  return {
    model: provider && modelId ? { provider, modelId } : undefined,
    thinking: host.settings.getDefaultThinkingLevel(),
  }
}

async function read(host: ExtensionHost) {
  const project = await host.projectSettings()
  const layers = await readFamilyLayers(host.userHome, host.projectRoot, project)
  const config = mergeLayers(layers)
  const { definitions } = await discoverAgents(
    host.ultimateRoot,
    host.projectRoot,
    host.userHome,
    host.modelRuntime,
  )
  return { project, layers, config, definitions }
}

export async function familiesView(host: ExtensionHost): Promise<FamiliesView> {
  const { project, layers, config, definitions } = await read(host)
  const user: JsonObject = await readSettings(userSettingsPath(host.userHome)).catch(() => ({}))
  const pi = piDefault(host)
  // The project's settings change a family where one of its fields is in effect, not overridden by the person's own.
  const own = layers.from === 'project' ? layers.base.families : {}
  const projectApplies = (name: string) =>
    Object.entries(layers.project.families[name] ?? {}).some(
      ([field, value]) =>
        value !== undefined && own[name]?.[field as keyof FamilySpec] === undefined,
    )
  const families = Object.entries(config.families).map(([name, spec]) => {
    const follows = name === DEFAULT_FAMILY && !spec.model && pi.model
    return {
      name,
      color: spec.color,
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.thinking ? { thinking: spec.thinking } : {}),
      ...(follows ? { follows: refName(pi.model!), followsThinking: pi.thinking } : {}),
      builtin: Object.hasOwn(BUILTIN_FAMILIES, name),
      ...(projectApplies(name) ? { project: true as const } : {}),
    }
  })
  const agents: FamilyUser[] = definitions.map((definition) => {
    const runs = definitionRuns(definition, config)
    const id = agentUser(definition.name)
    return {
      id,
      kind: 'agent',
      label: definition.name,
      description: definition.description,
      ...(runs.family ? { family: runs.family } : {}),
      natural: definition.family ?? DEFAULT_FAMILY,
      ...(definition.model
        ? {
            pinned: refName(definition.model),
            pinnedIn: definition.overlays?.at(-1) ?? definition.path,
          }
        : {}),
      source: definition.source,
    }
  })
  const features: FamilyUser[] = (Object.keys(FEATURES) as Feature[]).map((id) => {
    const { label, description, family } = FEATURES[id]
    const projectPin = pinned(pins[id].read(project))
    const pin = projectPin ?? pinned(pins[id].read(user))
    const assigned = config.assign[id] ?? family
    return {
      id,
      kind: 'feature',
      label,
      description,
      ...(pin
        ? {}
        : { family: Object.hasOwn(config.families, assigned) ? assigned : DEFAULT_FAMILY }),
      natural: family,
      ...(pin
        ? { pinned: pin, pinnedIn: `${projectPin ? 'project' : 'user'} settings: ${pins[id].key}` }
        : {}),
      ...(projectPin || Object.hasOwn(layers.project.assign, id) ? { project: true as const } : {}),
    }
  })
  return {
    families,
    users: [...agents, ...features],
    assign: layers.base.assign,
    from: layers.from,
    errors: layers.errors,
  }
}

/** Only what differs from the defaults (built-ins and team settings), so a later change of a default still applies. */
function userFamilies(families: SaveFamilies['families'], defaults: Families['families']) {
  const saved: Record<string, FamilySpec> = {}
  for (const [name, spec] of Object.entries(families)) {
    const builtin = Object.hasOwn(defaults, name) ? defaults[name] : undefined
    const own: FamilySpec = { model: spec.model, thinking: spec.thinking, color: spec.color }
    const changed = Object.fromEntries(
      Object.entries(own).filter(
        ([key, value]) =>
          value !== undefined && (!builtin || builtin[key as keyof FamilySpec] !== value),
      ),
    )
    if (!builtin || Object.keys(changed).length) saved[name] = changed
  }
  return saved
}

/** A saved value without its empty parts. */
function compact(value: { families: object; assign: object }): JsonObject {
  return Object.fromEntries(
    Object.entries(value).filter(([, part]) => Object.keys(part).length),
  ) as JsonObject
}

/**
 * Make `name` (`provider/id`, with a login here) the default family's model for this project and the most recent
 * families, at the recommended thinking level: what new conversations and branches start on. The other families stay.
 */
export async function setDefault(host: ExtensionHost, name: string) {
  const ref = refOf(name)
  const model = ref && host.modelRuntime.getModel(ref.provider, ref.modelId)
  if (
    !ref ||
    !model ||
    !(await host.models()).some(
      (item) => item.available && item.provider === ref.provider && item.id === ref.modelId,
    )
  )
    throw new Error(`Model ${name} is not available`)
  const thinkingLevel = clampThinkingLevel(model, RECOMMENDED_THINKING)
  const layers = await readFamilyLayers(
    host.userHome,
    host.projectRoot,
    await host.projectSettings(),
  )
  const effective = mergeLayers(layers).families
  // Saved like the panel's families: what differs from the team's defaults. The most recent families become this
  // project's own, which apply over the team's, so an assignment the team makes stays the team's.
  const families = userFamilies(
    {
      ...effective,
      [DEFAULT_FAMILY]: { ...effective[DEFAULT_FAMILY], model: name, thinking: thinkingLevel },
    },
    mergeFamilies(layers.project).families,
  )
  const assign =
    layers.from === 'project'
      ? layers.base.assign
      : Object.fromEntries(
          Object.entries(layers.base.assign).filter(
            ([user]) => !Object.hasOwn(layers.project.assign, user),
          ),
        )
  await writeFamilies(host.userHome, host.projectRoot, compact({ families, assign }))
  return { model: ref, thinkingLevel }
}

export async function saveFamilies(host: ExtensionHost, args: SaveFamilies) {
  const { project } = await readFamilyLayers(
    host.userHome,
    host.projectRoot,
    await host.projectSettings(),
  )
  const families = userFamilies(args.families, mergeFamilies(project).families)
  const value = { families, assign: args.assign }
  // Throws on an invalid name or model before anything is written.
  parseFamilies(value)
  for (const user of Object.keys(args.assign))
    if (!Object.hasOwn(FEATURES, user))
      throw new Error(
        `${user}: only features are assigned here; an agent's family is its definition's`,
      )
  for (const name of Object.values(args.assign))
    if (!Object.hasOwn(args.families, name) && !Object.hasOwn(BUILTIN_FAMILIES, name))
      throw new Error(`Unknown family ${name}`)
  await writeFamilies(host.userHome, host.projectRoot, compact(value))
  if (args.unpin.length)
    await updateSettings(userSettingsPath(host.userHome), (settings) => {
      for (const feature of args.unpin) {
        if (feature === 'summaries') delete settings.summaryModel
        if (feature === 'preview') {
          const instance = settings.instance
          if (instance && typeof instance === 'object' && !Array.isArray(instance)) {
            delete instance.model
            if (!Object.keys(instance).length) delete settings.instance
          }
        }
      }
    })
  return null
}
