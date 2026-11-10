/**
 * Model families: named roles (default, review, fast, tiny, design, and any the user adds) that each pick one model and
 * thinking level. Agents and features that call a model run on a family rather than a model, so changing a family's
 * model moves everything assigned to it. Pure and browser-safe: types, built-in defaults, parsing and merging of the
 * `modelFamilies` setting, and labels. Reading the settings files is `families-settings.ts`.
 */
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'

export type ModelRef = { provider: string; modelId: string }

/** One family as settings hold it: `model` is `provider/id`; the default family's model is Pi's default model. */
export type FamilySpec = { model?: string; thinking?: ModelThinkingLevel; color?: string }

/** The `modelFamilies` setting, merged over the built-in defaults. */
export type Families = {
  families: Record<string, FamilySpec & { color: string }>
  /** Which family each feature runs on (`summaries`, `preview`); an agent's family is in its definition. */
  assign: Record<string, string>
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
  review: { model: 'openai-codex/gpt-6-astra', thinking: 'high', color: 'violet' },
  fast: { model: 'openai-codex/gpt-6.1-sol', color: 'amber' },
  tiny: { model: 'openai-codex/gpt-6-luna', thinking: 'low', color: 'emerald' },
  design: { model: 'claude-code/claude-opus-5-5', color: 'pink' },
}

/** Feature users: what each runs when no setting pins a model, and how the Agents panel names it. */
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

/**
 * What Get ready pre-selects while no default model is configured: the first of these with a login here, at
 * `RECOMMENDED_THINKING` (clamped to what the model supports). Without either, the first model with a login.
 */
export const RECOMMENDED_MODELS = ['claude-code/claude-opus-5-5', 'openai-codex/gpt-6-astra']
export const RECOMMENDED_THINKING: ModelThinkingLevel = 'high'

/** The assignment key of an agent definition. */
export const agentUser = (name: string) => `agent/${name}`

const levels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
export const isFamilyName = (name: string) => /^[a-z][a-z0-9-]{0,23}$/.test(name)
const isRef = (value: string) => /^[^/\s]+\/\S+$/.test(value)

/** One settings layer's `modelFamilies`, checked; throws naming the first invalid field. */
export function parseFamilies(value: unknown): {
  families: Record<string, FamilySpec>
  assign: Record<string, string>
} {
  if (value === undefined) return { families: {}, assign: {} }
  if (!isObject(value)) throw new Error('modelFamilies must be an object')
  const families: Record<string, FamilySpec> = {}
  const assign: Record<string, string> = {}
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
  return { families, assign }
}

/** The built-in families, then each layer's (user, then project), field by field; later layers win. */
export function mergeFamilies(...layers: ReturnType<typeof parseFamilies>[]): Families {
  const families: Families['families'] = structuredClone(BUILTIN_FAMILIES)
  const assign: Record<string, string> = {}
  const palette = Object.keys(FAMILY_COLORS)
  for (const layer of layers) {
    for (const [name, spec] of Object.entries(layer.families)) {
      const color = families[name]?.color ?? palette[Object.keys(families).length % palette.length]
      families[name] = { ...families[name], ...spec, color: spec.color ?? color }
    }
    Object.assign(assign, layer.assign)
  }
  return { families, assign }
}

export const refOf = (value: string | undefined): ModelRef | undefined => {
  const slash = value?.indexOf('/') ?? -1
  return value && slash > 0
    ? { provider: value.slice(0, slash), modelId: value.slice(slash + 1) }
    : undefined
}
export const refName = (ref: ModelRef) => `${ref.provider}/${ref.modelId}`

/** "fast" → "Fast", "my-local" → "My local"; the default family is shown as "Ultimate". */
export const familyTitle = (name: string) =>
  name === DEFAULT_FAMILY
    ? 'Ultimate'
    : name.charAt(0).toUpperCase() + name.slice(1).replaceAll('-', ' ')

/** The CSS color of a family color name; an unknown name is slate. */
export const familyColor = (color: string | undefined) =>
  color && Object.hasOwn(FAMILY_COLORS, color)
    ? FAMILY_COLORS[color as FamilyColor]
    : FAMILY_COLORS.slate

/**
 * What a definition runs on given the families: its own model pin, else its `family`, else the default family; its own
 * thinking level wins over its family's. `model` undefined means the default family: the parent's model.
 */
export function definitionRuns(
  definition: { model?: ModelRef; thinking?: ModelThinkingLevel; family?: string },
  config: Families,
): { family?: string; model?: ModelRef; thinking?: ModelThinkingLevel; via: 'pin' | 'family' } {
  if (definition.model)
    return { model: definition.model, thinking: definition.thinking, via: 'pin' }
  const wanted = definition.family ?? DEFAULT_FAMILY
  const family = Object.hasOwn(config.families, wanted) ? wanted : DEFAULT_FAMILY
  const spec = config.families[family]
  const model = family === DEFAULT_FAMILY ? undefined : refOf(spec.model)
  const thinking = definition.thinking ?? spec.thinking
  return { family, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), via: 'family' }
}
