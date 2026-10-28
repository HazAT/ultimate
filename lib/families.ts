/**
 * Model families: named roles (default, slow, fast, tiny, design, and any the user adds) that each pick one model and
 * thinking level. Agents and features that call a model run on a family rather than a model, so changing a family's
 * model moves everything assigned to it. Pure and browser-safe: types, built-in defaults, parsing and merging of the
 * `modelFamilies` setting, and labels. Reading the settings files is `families-settings.ts`.
 */
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'

export type ModelRef = { provider: string; modelId: string }

/** One family as settings hold it: `model` is `provider/id`; the default family's model is Pi's default model. */
export type FamilySpec = { model?: string; thinking?: ModelThinkingLevel; color?: string }

/** Request concurrency caps; a missing or zero value is unlimited. `models` is keyed by `provider/id`. */
export type Limits = { global?: number; models: Record<string, number> }

/** The `modelFamilies` setting, merged over the built-in defaults. */
export type Families = {
  families: Record<string, FamilySpec & { color: string }>
  /** Who runs on which family, by user id (`agent/<definition>`, `summaries`, `preview`). */
  assign: Record<string, string>
  limits: Limits
}

/** The family a conversation, definition or feature falls back to. Its model is Pi's default model. */
export const DEFAULT_FAMILY = 'default'

/** Colors a family may take, as names; `familyColor` gives each one's CSS color. */
export const FAMILY_COLORS = {
  sky: '#38bdf8',
  violet: '#a78bfa',
  amber: '#f59e0b',
  emerald: '#34d399',
  pink: '#f472b6',
  orange: '#fb923c',
  teal: '#2dd4bf',
  rose: '#fb7185',
  lime: '#a3e635',
  indigo: '#818cf8',
  slate: '#94a3b8',
} as const
export type FamilyColor = keyof typeof FAMILY_COLORS

/** The built-in families, in display order. */
export const BUILTIN_FAMILIES: Record<string, FamilySpec & { color: FamilyColor }> = {
  default: { color: 'sky' },
  slow: { model: 'openai-codex/gpt-6.1-sol', thinking: 'xhigh', color: 'violet' },
  fast: { model: 'openai-codex/gpt-6.1-sol', color: 'amber' },
  tiny: { model: 'openai-codex/gpt-6-luna', thinking: 'low', color: 'emerald' },
  design: { model: 'claude-code/claude-opus-5-5', color: 'pink' },
}

/** Feature users: what each runs when no setting pins a model, and how the families dialog names it. */
export const FEATURES = {
  summaries: {
    family: 'tiny',
    label: 'Summaries',
    description: 'Titles, summaries, reply summaries and tree abstracts',
  },
  preview: {
    family: 'fast',
    label: 'Previews',
    description: 'The one model every agent of an `instance start` preview runs on',
  },
} as const
export type Feature = keyof typeof FEATURES

/** The assignment key of an agent definition. */
export const agentUser = (name: string) => `agent/${name}`

const levels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
export const isFamilyName = (name: string) => /^[a-z][a-z0-9-]{0,23}$/.test(name)
const isRef = (value: string) => /^[^/\s]+\/\S+$/.test(value)
const isLimit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0

/** One settings layer's `modelFamilies`, checked; throws naming the first invalid field. */
export function parseFamilies(value: unknown): {
  families: Record<string, FamilySpec>
  assign: Record<string, string>
  limits: Partial<Limits>
} {
  if (value === undefined) return { families: {}, assign: {}, limits: {} }
  if (!isObject(value)) throw new Error('modelFamilies must be an object')
  const families: Record<string, FamilySpec> = {}
  const assign: Record<string, string> = {}
  const limits: Partial<Limits> = {}
  if (value.families !== undefined && !isObject(value.families))
    throw new Error('modelFamilies.families must be an object')
  for (const [name, spec] of Object.entries(value.families ?? {})) {
    if (!isFamilyName(name))
      throw new Error(`modelFamilies.families.${name}: lowercase letters, digits and - only`)
    if (!isObject(spec)) throw new Error(`modelFamilies.families.${name} must be an object`)
    const { model, thinking, color } = spec
    if (model !== undefined && (typeof model !== 'string' || !isRef(model)))
      throw new Error(`modelFamilies.families.${name}.model must be "provider/id"`)
    if (thinking !== undefined && (typeof thinking !== 'string' || !levels.has(thinking)))
      throw new Error(
        `modelFamilies.families.${name}.thinking must be one of ${[...levels].join(', ')}`,
      )
    if (color !== undefined && (typeof color !== 'string' || !Object.hasOwn(FAMILY_COLORS, color)))
      throw new Error(
        `modelFamilies.families.${name}.color must be one of ${Object.keys(FAMILY_COLORS).join(', ')}`,
      )
    families[name] = {
      ...(model ? { model } : {}),
      ...(thinking ? { thinking: thinking as ModelThinkingLevel } : {}),
      ...(color ? { color } : {}),
    }
  }
  if (value.assign !== undefined && !isObject(value.assign))
    throw new Error('modelFamilies.assign must be an object')
  for (const [user, family] of Object.entries(value.assign ?? {})) {
    if (typeof family !== 'string' || !isFamilyName(family))
      throw new Error(`modelFamilies.assign.${user} must be a family name`)
    assign[user] = family
  }
  if (value.limits !== undefined) {
    if (!isObject(value.limits)) throw new Error('modelFamilies.limits must be an object')
    const { global, models } = value.limits
    if (global !== undefined) {
      if (!isLimit(global)) throw new Error('modelFamilies.limits.global must be a whole number')
      limits.global = global
    }
    if (models !== undefined) {
      if (!isObject(models)) throw new Error('modelFamilies.limits.models must be an object')
      limits.models = {}
      for (const [ref, limit] of Object.entries(models)) {
        if (!isRef(ref)) throw new Error(`modelFamilies.limits.models: ${ref} is not "provider/id"`)
        if (!isLimit(limit))
          throw new Error(`modelFamilies.limits.models.${ref} must be a whole number`)
        limits.models[ref] = limit
      }
    }
  }
  return { families, assign, limits }
}

/** The built-in families, then each layer's (user, then project), field by field; later layers win. */
export function mergeFamilies(...layers: ReturnType<typeof parseFamilies>[]): Families {
  const families: Families['families'] = structuredClone(BUILTIN_FAMILIES)
  const assign: Record<string, string> = {}
  const limits: Limits = { models: {} }
  const palette = Object.keys(FAMILY_COLORS)
  for (const layer of layers) {
    for (const [name, spec] of Object.entries(layer.families)) {
      const color = families[name]?.color ?? palette[Object.keys(families).length % palette.length]
      families[name] = { ...families[name], ...spec, color: spec.color ?? color }
    }
    Object.assign(assign, layer.assign)
    if (layer.limits.global !== undefined) limits.global = layer.limits.global
    Object.assign(limits.models, layer.limits.models)
  }
  return { families, assign, limits }
}

export const refOf = (value: string | undefined): ModelRef | undefined => {
  const slash = value?.indexOf('/') ?? -1
  return value && slash > 0
    ? { provider: value.slice(0, slash), modelId: value.slice(slash + 1) }
    : undefined
}
export const refName = (ref: ModelRef) => `${ref.provider}/${ref.modelId}`

/** "fast" → "Fast", "my-local" → "My local". */
export const familyTitle = (name: string) =>
  name.charAt(0).toUpperCase() + name.slice(1).replaceAll('-', ' ')

/** The CSS color of a family color name; an unknown name is slate. */
export const familyColor = (color: string | undefined) =>
  color && Object.hasOwn(FAMILY_COLORS, color)
    ? FAMILY_COLORS[color as FamilyColor]
    : FAMILY_COLORS.slate

/**
 * What a definition runs on given the families: an assignment in settings wins, then the definition's own model pin,
 * then its `family`, then the default family. `model` undefined means the default family: the parent's model.
 */
export function definitionRuns(
  definition: { name: string; model?: ModelRef; thinking?: ModelThinkingLevel; family?: string },
  config: Families,
): {
  family?: string
  model?: ModelRef
  thinking?: ModelThinkingLevel
  via: 'assigned' | 'pin' | 'family'
} {
  const assigned = config.assign[agentUser(definition.name)]
  if (!assigned && definition.model)
    return { model: definition.model, thinking: definition.thinking, via: 'pin' }
  const wanted = assigned ?? definition.family ?? DEFAULT_FAMILY
  const family = Object.hasOwn(config.families, wanted) ? wanted : DEFAULT_FAMILY
  const spec = config.families[family]
  const model = family === DEFAULT_FAMILY ? undefined : refOf(spec.model)
  // An assignment from the families dialog takes the family's thinking; a definition's own level wins over its family.
  const thinking = assigned
    ? (spec.thinking ?? definition.thinking)
    : (definition.thinking ?? spec.thinking)
  return {
    family,
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    via: assigned ? 'assigned' : 'family',
  }
}
