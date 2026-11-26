import type { ConversationId } from '@earendil-works/pi-durable'
import { cell } from '../../lib/cell.ts'
import type { ConfigureRequest, ModelsResponse } from '../../shared/protocol.ts'

type OpenContext = { open: (id: string) => void; conversationId?: ConversationId }

export type ModelInfo = ModelsResponse['models'][number]
export type ProviderInfo = ModelsResponse['providers'][number]
export type ThinkingLevel = ModelInfo['thinkingLevels'][number]

export type ModelRef = NonNullable<ConfigureRequest['model']>
export type ModelPick = {
  name: string
  ref: () => ModelRef | undefined
  thinking: () => ThinkingLevel | undefined
  configure: (change: ConfigureRequest) => Promise<unknown>
}
export type PickerTarget = ConversationId | ModelPick | undefined

export const dialogs = { picker: 'models.picker', login: 'models.login' } as const
export const thinkingDialog = (id: ConversationId | string | undefined) => `models.thinking.${id}`

export const picks = cell(0)
export const notePick = () => picks.set(picks.get() + 1)
export const pickerTarget = cell<PickerTarget>(undefined)
export const conversationOf = (target: PickerTarget) =>
  typeof target === 'object' ? undefined : target
export const loginProvider = cell<string | undefined>(undefined)

export function openPicker(actions: OpenContext) {
  pickerTarget.set(actions.conversationId)
  actions.open(dialogs.picker)
}

export function openLogin(
  actions: OpenContext & { close: (id: string) => void },
  provider?: string,
) {
  pickerTarget.set(actions.conversationId)
  loginProvider.set(provider)
  actions.close(dialogs.picker)
  actions.open(dialogs.login)
}

export function nextThinking(current: ThinkingLevel | undefined, model: ModelInfo) {
  const levels = model.thinkingLevels
  return levels[(levels.indexOf(current ?? 'off') + 1) % levels.length]
}

function formatWindow(tokens: number) {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`
  return `${Math.round(tokens / 1000)}k`
}

const price = (dollarsPerMillionTokens: number) =>
  dollarsPerMillionTokens === 0 ? '0' : String(+dollarsPerMillionTokens.toFixed(3))

export function modelFacts(model: ModelInfo) {
  return {
    paid: model.provider === 'anthropic' ? 'paid API' : undefined,
    thinking: model.reasoning
      ? model.thinkingLevels.filter((level) => level !== 'off').at(-1)
      : 'no thinking',
    thinkingTitle: model.reasoning ? `thinking: ${model.thinkingLevels.join(' ')}` : undefined,
    context: formatWindow(model.contextWindow),
    cost: `$${price(model.cost.input)}/${price(model.cost.output)}`,
  }
}

export const termsOf = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean)

export const modelKey = (model: ModelInfo) => `${model.provider}/${model.id}`

export function matchesEveryQueryTerm(model: ModelInfo, terms: readonly string[]) {
  const haystack = `${modelKey(model)} ${model.name}`.toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

export function authLabel(provider: ProviderInfo | undefined) {
  if (!provider?.status.configured) return undefined
  const { source, label } = provider.status
  if (label) return label
  if (source === 'environment') return 'env'
  if (source === 'models_json_key' || source === 'models_json_command') return 'models.json'
  return source ?? 'configured'
}
