import { clampThinkingLevel } from '@earendil-works/pi-ai'
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { JsonObject } from '@earendil-works/pi-durable'
import { readSettings, userSettingsPath } from '../../lib/settings.ts'
import { previewModel } from '../../lib/agents.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { parseSummaryModel } from './summary-model-ref.shared.ts'
import { readFamilies } from '../../lib/families-settings.ts'
import {
  BUILTIN_FAMILIES,
  DEFAULT_FAMILY,
  FEATURES,
  mergeFamilies,
} from '../../lib/families.shared.ts'

const builtinSummaryFamily = BUILTIN_FAMILIES[FEATURES.summaries.family]
const DEFAULT_SUMMARY_MODEL = `${builtinSummaryFamily.model}:${builtinSummaryFamily.thinking ?? 'medium'}`

export type SummaryModel = { provider: string; id: string; thinking: ModelThinkingLevel }

export type SummaryModelHost = Pick<ExtensionHost, 'userHome' | 'projectSettings' | 'notice'> & {
  modelRuntime: Pick<ExtensionHost['modelRuntime'], 'getAvailableSnapshot'>
  settings?: Pick<ExtensionHost['settings'], 'getDefaultProvider' | 'getDefaultModel'>
  projectRoot?: string
}

export async function summaryModelSetting(
  host: Pick<SummaryModelHost, 'userHome' | 'projectSettings' | 'settings' | 'projectRoot'>,
) {
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
  const familyModelOrPiDefault =
    spec.model ??
    (family === DEFAULT_FAMILY && host.settings?.getDefaultProvider()
      ? `${host.settings.getDefaultProvider()}/${host.settings.getDefaultModel()}`
      : undefined)
  return {
    value: familyModelOrPiDefault
      ? `${familyModelOrPiDefault}:${spec.thinking ?? 'medium'}`
      : DEFAULT_SUMMARY_MODEL,
    source: 'default' as const,
    family,
    default: DEFAULT_SUMMARY_MODEL,
  }
}

export const FALLBACK_SUMMARY_MODELS = [
  'openai-codex/gpt-6-luna',
  'anthropic/claude-haiku-5-5',
  'openrouter/anthropic/claude-haiku-5.5',
  'openrouter/~openai/gpt-luna-latest',
  'openai/gpt-6-luna',
  'google/gemini-2.5-flash-lite',
]

type Available = ReturnType<SummaryModelHost['modelRuntime']['getAvailableSnapshot']>[number]

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

export async function summaryModelStatus(host: SummaryModelHost): Promise<SummaryModelStatus> {
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
  const usesDefault = source === 'default'
  const fallback = usesDefault ? fallbackModel(available) : undefined
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

export async function summaryModel(host: SummaryModelHost): Promise<SummaryModel | undefined> {
  return (await summaryModelStatus(host)).model
}
