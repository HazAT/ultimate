import { useSyncExternalStore } from 'react'
import { api, getConversation, useConversation, useDocOf, useModels, useStore } from '@/sdk'
import type { ModelsResponse, UltimateActions } from '@/sdk'
import { FamilyDoc, SetFamilyAction } from './refs.ts'

export type ModelInfo = ModelsResponse['models'][number]
export type ProviderInfo = ModelsResponse['providers'][number]
export type ThinkingLevel = ModelInfo['thinkingLevels'][number]

/** Dialog ids this extension's overlays read with `useDialog`. */
export const dialogs = {
  picker: 'models.picker',
  login: 'models.login',
} as const
/** The thinking popover of conversation `id`'s toolbar: a side chat's has its own, apart from main's. */
export const thinkingDialog = (id: number | undefined) => `models.thinking.${id}`

/**
 * The scoped (or shown) conversation's model, thinking and recorded family, or those of `target`, and its id to
 * configure.
 */
export function useCurrentModel(target?: number) {
  const own = useConversation()
  const other = useStore(() => (target === undefined ? undefined : getConversation(target)))
  const { id, agent, loading } = other ?? own
  const models = useModels()
  const family = useDocOf(id, FamilyDoc)?.name
  const ref = agent.model
  const model = models?.models.find(
    (candidate) => candidate.provider === ref?.provider && candidate.id === ref.modelId,
  )
  return {
    id,
    ref,
    model,
    thinking: agent.thinkingLevel,
    family,
    models,
    loading,
  }
}

/** Run conversation `id` on `model`, picked by id: it runs as no family now. */
export async function selectModel(model: ModelInfo, id: number | undefined) {
  await api.configure({ model: { provider: model.provider, modelId: model.id } }, id)
  await api.action(SetFamilyAction, { family: null }, { conversationId: id })
}

/**
 * The conversation the picker configures: the one whose toolbar or shortcut opened it, which is a scoped conversation
 * (a side chat) rather than the shown one when opened inside its scope. Undefined targets the shown conversation.
 */
let pickerTarget: number | undefined
const targetListeners = new Set<() => void>()
export function usePickerTarget() {
  return useSyncExternalStore(
    (listener) => {
      targetListeners.add(listener)
      return () => {
        targetListeners.delete(listener)
      }
    },
    () => pickerTarget,
  )
}

function setPickerTarget(target: number | undefined) {
  pickerTarget = target
  for (const listener of targetListeners) listener()
}
export function openPicker(actions: Pick<UltimateActions, 'open'> & { conversationId?: number }) {
  setPickerTarget(actions.conversationId)
  actions.open(dialogs.picker)
}
/** Back to the picker after a login, still configuring the conversation the login started from. */
export function reopenPicker(actions: Pick<UltimateActions, 'open'>) {
  actions.open(dialogs.picker)
}

/** The supported level after `current` in Pi's order, wrapping around, as Pi's Shift+Tab does. */
export function nextThinking(current: ThinkingLevel | undefined, model: ModelInfo) {
  const levels = model.thinkingLevels
  return levels[(levels.indexOf(current ?? 'off') + 1) % levels.length]
}

/** Which provider the login dialog should open on; set just before it opens. */
let loginProvider: string | undefined
const listeners = new Set<() => void>()
/** `actions.conversationId` is the conversation a model picked after this login configures. */
export function openLogin(
  actions: Pick<UltimateActions, 'open' | 'close'> & { conversationId?: number },
  provider?: string,
) {
  setPickerTarget(actions.conversationId)
  loginProvider = provider
  for (const listener of listeners) listener()
  actions.close(dialogs.picker)
  actions.open(dialogs.login)
}
export function useLoginProvider() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => loginProvider,
  )
}

/** 128k, 1M: a context window. */
export function formatWindow(tokens: number) {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`
  return `${Math.round(tokens / 1000)}k`
}

/** Dollars per million tokens, compact: 0.1, 2, 12.5. */
export const price = (value: number) => (value === 0 ? '0' : String(+value.toFixed(3)))

/** How a provider is configured, for labels: `stored`, `env`, … */
export function authLabel(provider: ProviderInfo | undefined) {
  if (!provider?.status.configured) return undefined
  const { source, label } = provider.status
  if (label) return label
  if (source === 'environment') return 'env'
  if (source === 'models_json_key' || source === 'models_json_command') return 'models.json'
  return source ?? 'configured'
}
