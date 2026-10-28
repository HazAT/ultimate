/**
 * The families dialog's server side: what the families are, who runs on which, and saving them. Saving writes this
 * project's families and makes them the most recent ones, which projects without their own start from
 * (lib/families-settings.ts). A default family without a model of its own follows Pi's default model and thinking.
 * Saving can also move running conversations: each one on its family's old model moves to the family's new one.
 */
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { clampThinkingLevel } from '@earendil-works/pi-ai'
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import { AgentDoc } from '@earendil-works/pi-durable'
import type { ConversationId, Cursor, JsonObject } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { discoverAgents, hasLogin } from '../../lib/agents.ts'
import type { AgentDefinition } from '../../lib/agents.ts'
import {
  agentUser,
  BUILTIN_FAMILIES,
  DEFAULT_FAMILY,
  definitionRuns,
  FEATURES,
  mergeFamilies,
  parseFamilies,
  refName,
  refOf,
} from '../../lib/families.ts'
import type { Families, Feature, FamilySpec, ModelRef } from '../../lib/families.ts'
import { readFamilyLayers, writeFamilies } from '../../lib/families-settings.ts'
import { readSettings, updateSettings, userSettingsPath } from '../../lib/settings.ts'
import { Pin } from './api.ts'
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

/** The default family's model and thinking under `config`: its own, else Pi's. */
const defaultsOf = (host: Pick<ExtensionHost, 'settings'>, config: Families) => {
  const pi = piDefault(host)
  const own = config.families[DEFAULT_FAMILY]
  return { model: refOf(own.model) ?? pi.model, thinking: own.thinking ?? pi.thinking }
}

async function read(host: ExtensionHost) {
  const project = await host.projectSettings()
  const layers = await readFamilyLayers(host.userHome, host.projectRoot, project)
  const config = mergeFamilies(layers.base, layers.project)
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
  const families = Object.entries(config.families).map(([name, spec]) => {
    const follows = name === DEFAULT_FAMILY && !spec.model && pi.model
    return {
      name,
      color: spec.color,
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.thinking ? { thinking: spec.thinking } : {}),
      ...(follows ? { follows: refName(pi.model!), followsThinking: pi.thinking } : {}),
      builtin: Object.hasOwn(BUILTIN_FAMILIES, name),
      ...(Object.hasOwn(layers.project.families, name) ? { project: true as const } : {}),
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
      ...(Object.hasOwn(layers.project.assign, id) ? { project: true as const } : {}),
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
    limits: config.limits,
    from: layers.from,
    errors: layers.errors,
  }
}

/** Only what differs from the built-in families, so a later change of a built-in default still applies. */
function userFamilies(families: SaveFamilies['families']) {
  const saved: Record<string, FamilySpec> = {}
  for (const [name, spec] of Object.entries(families)) {
    const builtin = Object.hasOwn(BUILTIN_FAMILIES, name) ? BUILTIN_FAMILIES[name] : undefined
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
function compact(value: { families: object; assign: object; limits: object }): JsonObject {
  return Object.fromEntries(
    Object.entries(value).filter(([, part]) => Object.keys(part).length),
  ) as JsonObject
}

/** Where conversation `id` should run under `config`: its definition's family, else the default family. */
function target(
  config: Families,
  defaults: ReturnType<typeof defaultsOf>,
  definition: AgentDefinition | undefined,
): { model?: ModelRef; thinking?: ModelThinkingLevel } {
  if (!definition) return defaults
  const runs = definitionRuns(definition, config)
  return { model: runs.model ?? defaults.model, thinking: runs.thinking ?? defaults.thinking }
}

export async function saveFamilies(host: ExtensionHost, args: SaveFamilies) {
  const before = await read(host)
  const beforeDefault = defaultsOf(host, before.config)
  const families = userFamilies(args.families)
  const limits = {
    ...(args.limits.global ? { global: args.limits.global } : {}),
    models: Object.fromEntries(Object.entries(args.limits.models).filter(([, limit]) => limit > 0)),
  }
  const value = {
    families,
    assign: args.assign,
    limits: limits.global === undefined && !Object.keys(limits.models).length ? {} : limits,
  }
  // Throws on an invalid name, model or limit before anything is written.
  parseFamilies(value)
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
  if (!args.switchRunning) return { switched: 0 }
  const after = await read(host)
  const afterDefault = defaultsOf(host, after.config)
  const pin = host.want(Pin)
  const byName = (list: AgentDefinition[], name: string | undefined) =>
    name === undefined ? undefined : list.find((definition) => definition.name === name)
  const same = (a?: ModelRef, b?: ModelRef) => !!a && !!b && refName(a) === refName(b)
  const harness = host.harness()
  const available = host.modelRuntime.getAvailableSnapshot()
  let switched = 0
  let cursor: Cursor | undefined
  do {
    const page = await harness.commit((tx) => tx.scanConversations({}, 256, cursor), context)
    cursor = page.next
    const ids: ConversationId[] = page.items.map((record) => record.id)
    switched += await harness.commit(async (tx) => {
      let count = 0
      for (const id of ids) {
        const agent = await tx.doc(AgentDoc, id)
        const name = await pin?.definitionOf(tx, id)
        const from = target(before.config, beforeDefault, byName(before.definitions, name))
        const to = target(after.config, afterDefault, byName(after.definitions, name))
        // Only a conversation still on its family's old model: one switched by hand keeps its choice.
        if (!to.model || !same(agent.model ?? undefined, from.model)) continue
        if (same(from.model, to.model) && from.thinking === to.thinking) continue
        // A model without a login here would only fail; the conversation keeps the one it runs.
        const model = host.modelRuntime.getModel(to.model.provider, to.model.modelId)
        if (!model || !hasLogin(available, to.model)) continue
        agent.model = { ...to.model }
        const thinking = to.thinking ?? agent.thinkingLevel
        if (thinking) agent.thinkingLevel = clampThinkingLevel(model, thinking)
        count++
      }
      return count
    }, context)
  } while (cursor !== undefined)
  return { switched }
}
