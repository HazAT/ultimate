import { createContext, createEffect, createMemo, onSettled, useContext } from 'solid-js'
import {
  api,
  cn,
  useAgent,
  useConversation,
  useConversationId,
  useDoc,
  useExternal,
  useModels,
  useSystem,
  writingAs,
} from '@/sdk/solid'
import type { ConversationId } from '@earendil-works/pi-durable'
import { familyColor } from '../../lib/families.shared.ts'
import { familiesCache, refresh, refreshFor, thinkingOf } from './family-state.web.ts'
import { FamiliesAction, FamilyDoc, SetFamilyAction } from './refs.ts'
import type { FamilyView } from './refs.ts'
import { notePick, thinkingDialog } from './state.web.ts'
import type { ModelPick, ModelRef, PickerTarget, ThinkingLevel } from './state.web.ts'

const fetchFamilies = () => api.action(FamiliesAction, null)

export function useFamilies() {
  const families = useExternal(familiesCache.get, familiesCache.subscribe)
  const system = useSystem()
  const revision = createMemo(
    () => `${system()?.code.sha} ${JSON.stringify(system()?.project.settings)}`,
  )
  createEffect(revision, (next) => {
    void refreshFor(next, fetchFamilies)
  })
  onSettled(() => {
    const reload = () => void refresh(fetchFamilies)
    addEventListener('focus', reload)
    return () => removeEventListener('focus', reload)
  })
  return families
}

export function FamilyDot(props: { color: string | undefined; class?: string }) {
  return (
    <span
      aria-hidden="true"
      class={cn('inline-block size-2 shrink-0 rounded-full', props.class)}
      style={{ 'background-color': familyColor(props.color) }}
    />
  )
}

export async function selectModel(
  model: ModelRef,
  id: ConversationId | undefined,
  source: string,
  family: FamilyView | null = null,
) {
  const level = family && thinkingOf(family)
  await api.configure({ model, ...(level ? { thinkingLevel: level } : {}) }, id)
  await writingAs(source, () =>
    api.action(SetFamilyAction, { family: family?.name ?? null }, { conversationId: id }),
  )
  notePick()
}

export const PickContext = createContext<ModelPick | null>(null)

export function useCurrentModel() {
  const pick = useContext(PickContext)
  return pick ? pickedModel(pick) : conversationModel()
}

function useCatalogModel(ref: () => ModelRef | undefined) {
  const models = useModels()
  return createMemo(() =>
    models()?.models.find(
      (candidate) => candidate.provider === ref()?.provider && candidate.id === ref()?.modelId,
    ),
  )
}

function conversationModel() {
  const id = useConversationId()
  const agent = useAgent()
  const conversation = useConversation()
  const recorded = useDoc(FamilyDoc)
  const ref = () => agent().model
  return {
    label: 'Model and thinking',
    dialog: () => (id() === undefined ? undefined : thinkingDialog(id())),
    target: (): PickerTarget => id(),
    ref,
    model: useCatalogModel(ref),
    thinking: () => agent().thinkingLevel,
    recorded: () => recorded()?.name,
    loading: () => conversation().loading,
    select: (model: ModelRef, source: string, family: FamilyView | null = null) =>
      selectModel(model, id(), source, family),
    setThinking: (level: ThinkingLevel) => api.configure({ thinkingLevel: level }, id()),
    cycles: true,
  }
}

function pickedModel(pick: ModelPick) {
  return {
    label: `${pick.name} model`,
    dialog: () => thinkingDialog(pick.name),
    target: (): PickerTarget => pick,
    ref: pick.ref,
    model: useCatalogModel(pick.ref),
    thinking: pick.thinking,
    recorded: () => undefined,
    loading: () => pick.ref() === undefined,
    select: (model: ModelRef, source: string, family: FamilyView | null = null) => {
      const level = family && thinkingOf(family)
      return writingAs(source, () =>
        pick.configure({ model, ...(level ? { thinkingLevel: level } : {}) }),
      )
    },
    setThinking: (level: ThinkingLevel) => pick.configure({ thinkingLevel: level }),
    cycles: false,
  }
}
