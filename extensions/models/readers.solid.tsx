/** @jsxImportSource @solidjs/web */
import { createEffect, createMemo, onSettled } from 'solid-js'
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
} from '@/sdk/solid'
import { familyColor } from '../../lib/families.ts'
import { familiesCache, refresh, refreshFor } from './family-state.ts'
import { FamiliesAction, FamilyDoc } from './refs.ts'

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

export function useCurrentModel() {
  const id = useConversationId()
  const agent = useAgent()
  const conversation = useConversation()
  const recorded = useDoc(FamilyDoc)
  const models = useModels()
  const ref = () => agent().model
  const thinking = () => agent().thinkingLevel
  const model = createMemo(() =>
    models()?.models.find(
      (candidate) => candidate.provider === ref()?.provider && candidate.id === ref()?.modelId,
    ),
  )
  return { id, ref, model, thinking, recorded, loading: () => conversation().loading }
}
