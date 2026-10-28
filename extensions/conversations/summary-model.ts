import { clampThinkingLevel } from '@earendil-works/pi-ai'
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { JsonObject } from '@earendil-works/pi-durable'
import { readSettings, userSettingsPath } from '../../lib/settings.ts'
import { previewModel } from '../../lib/agents.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { parseSummaryModel } from './summary-model-ref.ts'
import { readFamilies } from '../../lib/families-settings.ts'
import { BUILTIN_FAMILIES, DEFAULT_FAMILY, FEATURES, mergeFamilies } from '../../lib/families.ts'

/** Titles, summaries and reply summaries use the summaries family's model unless settings pin another. */
const tiny = BUILTIN_FAMILIES[FEATURES.summaries.family]
const DEFAULT_SUMMARY_MODEL = `${tiny.model}:${tiny.thinking ?? 'medium'}`

/** A resolved summary model, kept in a task's memo so a resumed task asks the same one. */
export type SummaryModel = { provider: string; id: string; thinking: ModelThinkingLevel }

export type SummaryModelHost = Pick<ExtensionHost, 'userHome' | 'projectSettings' | 'notice'> & {
  modelRuntime: Pick<ExtensionHost['modelRuntime'], 'getAvailableSnapshot'>
  settings?: Pick<ExtensionHost['settings'], 'getDefaultProvider' | 'getDefaultModel'>
  /** The project whose model families apply; without it, the built-in ones. */
  projectRoot?: string
}

/**
 * The configured value and where it comes from: a `summaryModel` pin, the project's over the user's, else the model of
 * the family summaries are assigned to (`modelFamilies`, default `tiny`).
 */
export async function summaryModelSetting(
  host: Pick<SummaryModelHost, 'userHome' | 'projectSettings' | 'settings' | 'projectRoot'>,
) {
  // Invalid settings JSON is reported where settings load; here it counts as unset.
  const user: JsonObject = await readSettings(userSettingsPath(host.userHome)).catch(() => ({}))
  const project = await host.projectSettings()
  for (const [source, settings] of [
    ['project', project],
    ['user', user],
  ] as const)
    if (Object.hasOwn(settings, 'summaryModel'))
      return { value: settings.summaryModel, source, default: DEFAULT_SUMMARY_MODEL }
  const families = host.projectRoot
    ? await readFamilies(host.userHome, host.projectRoot, project)
    : mergeFamilies()
  const assigned = families.assign.summaries ?? FEATURES.summaries.family
  const family = Object.hasOwn(families.families, assigned) ? assigned : DEFAULT_FAMILY
  const spec = families.families[family]
  // A default family without a model of its own runs Pi's default model.
  const model =
    spec.model ??
    (family === DEFAULT_FAMILY && host.settings?.getDefaultProvider()
      ? `${host.settings.getDefaultProvider()}/${host.settings.getDefaultModel()}`
      : undefined)
  return {
    value: model ? `${model}:${spec.thinking ?? 'medium'}` : DEFAULT_SUMMARY_MODEL,
    source: 'default' as const,
    family,
    default: DEFAULT_SUMMARY_MODEL,
  }
}

/** Cheap models known to write good summaries, tried in order when the default has no login here. */
export const FALLBACK_SUMMARY_MODELS = [
  'openai-codex/gpt-6-luna',
  'anthropic/claude-haiku-5-5',
  'openrouter/anthropic/claude-haiku-5.5',
  'openrouter/~openai/gpt-luna-latest',
  'openai/gpt-6-luna',
  'google/gemini-2.5-flash-lite',
]

type Available = ReturnType<SummaryModelHost['modelRuntime']['getAvailableSnapshot']>[number]

/** The fallback among `available`: the first known-good one, else the cheapest. */
export function fallbackModel(available: readonly Available[]) {
  for (const ref of FALLBACK_SUMMARY_MODELS) {
    const found = available.find((model) => `${model.provider}/${model.id}` === ref)
    if (found) return found
  }
  let best: Available | undefined
  for (const model of available)
    if (!best || model.cost.input + model.cost.output < best.cost.input + best.cost.output)
      best = model
  return best
}

/**
 * What the summary features run on, and why: `model` is undefined while they are off. `configured` is the setting's
 * `provider/id`; `fellBack` says the default had no login here and `model` is the fallback; `problem` is why none runs.
 */
export type SummaryModelStatus = {
  model?: SummaryModel
  configured: string
  source: 'default' | 'user' | 'project'
  fellBack?: true
  problem?: 'invalid' | 'unavailable'
}

const reported = new Set<string>()
const once = (host: Pick<SummaryModelHost, 'notice'>, message: string) => {
  if (reported.has(message)) return
  reported.add(message)
  host.notice(message)
}

/**
 * The summary model to ask now and why, read from settings at each request so a change applies to the next one. The
 * default falls back to an available model when it has no login here, said once as a notice; a model the settings name
 * never does, it is only reported (the setup check shows it).
 */
export async function summaryModelStatus(host: SummaryModelHost): Promise<SummaryModelStatus> {
  // A preview runs every model call on its one model.
  const preview = previewModel()
  const { value, source } = preview
    ? { value: `${preview.provider}/${preview.modelId}`, source: 'default' as const }
    : await summaryModelSetting(host)
  const configured = typeof value === 'string' ? value : JSON.stringify(value)
  const parsed = typeof value === 'string' ? parseSummaryModel(value) : undefined
  if (!parsed) {
    once(
      host,
      `Invalid summaryModel ${JSON.stringify(value)} in ${source} settings: expected "provider/id[:thinking]"; summaries are off`,
    )
    return { configured, source, problem: 'invalid' }
  }
  const available = host.modelRuntime.getAvailableSnapshot()
  const model = available.find(
    (candidate) => candidate.provider === parsed.provider && candidate.id === parsed.id,
  )
  const thinking = parsed.thinking ?? 'medium'
  if (model)
    return {
      model: {
        provider: model.provider,
        id: model.id,
        thinking: clampThinkingLevel(model, thinking),
      },
      configured,
      source,
    }
  const fallback = source === 'default' ? fallbackModel(available) : undefined
  if (!fallback) return { configured, source, problem: 'unavailable' }
  once(
    host,
    `Summary model ${configured} has no login here; using ${fallback.provider}/${fallback.id} instead. Choose one with ⌘K → Summary model.`,
  )
  return {
    model: {
      provider: fallback.provider,
      id: fallback.id,
      thinking: clampThinkingLevel(fallback, thinking),
    },
    configured,
    source,
    fellBack: true,
  }
}

/** The summary model to ask now; undefined while none is valid and available, so callers skip. */
export async function summaryModel(host: SummaryModelHost): Promise<SummaryModel | undefined> {
  return (await summaryModelStatus(host)).model
}
