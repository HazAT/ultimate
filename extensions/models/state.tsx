import type { ConversationId } from '@earendil-works/pi-durable'
import { useSyncExternalStore } from 'react'
import { api, getConversation, useConversation, useDocOf, useModels, useStore } from '@/sdk'
import type { ModelsResponse, UltimateActions } from '@/sdk'
import { FamilyDoc, SetFamilyAction } from './refs.ts'

export type ModelInfo = ModelsResponse['models'][number]
export type ProviderInfo = ModelsResponse['providers'][number]
export type ThinkingLevel = ModelInfo['thinkingLevels'][number]

export const dialogs = {
  picker: 'models.picker',
  login: 'models.login',
} as const
export const thinkingDialog = (scopedConversationId: number | undefined) =>
  `models.thinking.${scopedConversationId}`

export function useCurrentModel(target?: ConversationId) {
  const scopedOrShownConversation = useConversation()
  const targetConversation = useStore(() =>
    target === undefined ? undefined : getConversation(target),
  )
  const { id, agent, loading } = targetConversation ?? scopedOrShownConversation
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

export async function selectModel(model: ModelInfo, id: ConversationId | undefined) {
  await api.configure({ model: { provider: model.provider, modelId: model.id } }, id)
  await api.action(SetFamilyAction, { family: null }, { conversationId: id })
  notePick()
}

let explicitPickerChoiceCount = 0
const pickListeners = new Set<() => void>()
export function notePick() {
  explicitPickerChoiceCount++
  for (const listener of pickListeners) listener()
}
export function usePicks() {
  return useSyncExternalStore(
    (listener) => {
      pickListeners.add(listener)
      return () => {
        pickListeners.delete(listener)
      }
    },
    () => explicitPickerChoiceCount,
  )
}

let conversationThatOpenedPicker: ConversationId | undefined
const targetListeners = new Set<() => void>()
export function usePickerTarget() {
  return useSyncExternalStore(
    (listener) => {
      targetListeners.add(listener)
      return () => {
        targetListeners.delete(listener)
      }
    },
    () => conversationThatOpenedPicker,
  )
}

function setPickerTarget(target: ConversationId | undefined) {
  conversationThatOpenedPicker = target
  for (const listener of targetListeners) listener()
}
export function openPicker(
  actions: Pick<UltimateActions, 'open'> & { conversationId?: ConversationId },
) {
  setPickerTarget(actions.conversationId)
  actions.open(dialogs.picker)
}
export function reopenPicker(actions: Pick<UltimateActions, 'open'>) {
  actions.open(dialogs.picker)
}

export function nextThinking(current: ThinkingLevel | undefined, model: ModelInfo) {
  const levels = model.thinkingLevels
  return levels[(levels.indexOf(current ?? 'off') + 1) % levels.length]
}

let loginProvider: string | undefined
const listeners = new Set<() => void>()
export function openLogin(
  actions: Pick<UltimateActions, 'open' | 'close'> & { conversationId?: ConversationId },
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

export function formatWindow(tokens: number) {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`
  return `${Math.round(tokens / 1000)}k`
}

export const price = (dollarsPerMillionTokens: number) =>
  dollarsPerMillionTokens === 0 ? '0' : String(+dollarsPerMillionTokens.toFixed(3))

export function authLabel(provider: ProviderInfo | undefined) {
  if (!provider?.status.configured) return undefined
  const { source, label } = provider.status
  if (label) return label
  if (source === 'environment') return 'env'
  if (source === 'models_json_key' || source === 'models_json_command') return 'models.json'
  return source ?? 'configured'
}
