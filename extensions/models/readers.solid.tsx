/** @jsxImportSource @solidjs/web */
import { createMemo } from 'solid-js'
import {
  ROOT,
  cn,
  keepLast,
  useAction,
  useAgent,
  useConversation,
  useConversationId,
  useDoc,
  useModels,
  useSystem,
} from '@/sdk/solid'
import { familyColor } from '../../lib/families.ts'
import { FamiliesAction, FamilyDoc } from './refs.ts'

export function useFamilies() {
  const system = useSystem()
  return useAction(FamiliesAction, null, {
    conversation: ROOT,
    onError: keepLast,
    focus: true,
    on: () => [system()?.code.sha, system()?.project.settings],
  }).data
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
