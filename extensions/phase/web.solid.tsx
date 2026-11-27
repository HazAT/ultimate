import type { ConversationId } from '@earendil-works/pi-durable'
import type { Accessor } from 'solid-js'
import { createMemo } from 'solid-js'
import { defineWebExtension, provide, ROOT, useConversations, useDocOf } from '@/sdk/solid'
import { ConversationPhase } from '../conversations/ui.solid.tsx'
import { PhasesDoc } from './refs.ts'
import { subagentsBusy } from './subtree.web.ts'
import type { Phase } from './types.ts'

const words: Record<Phase | 'waiting', string> = {
  exploring: 'exploring',
  planning: 'planning',
  editing: 'editing',
  verifying: 'verifying',
  fixing: 'fixing',
  delegating: 'delegating',
  waiting: 'waiting',
  wrapping_up: 'wrapping up',
}

function conversationPhase(id: Accessor<ConversationId | undefined>) {
  const conversations = useConversations()
  const phases = useDocOf(() => ROOT, PhasesDoc)
  return createMemo(() => {
    const conversation = id()
    if (conversation === undefined) return undefined
    const phase = conversations().find((each) => each.id === conversation)?.busy
      ? phases()?.conversations[conversation]?.phase
      : subagentsBusy(conversations(), conversation)
        ? 'waiting'
        : undefined
    return phase && { word: words[phase], waiting: phase === 'waiting' }
  })
}

export default defineWebExtension({
  provides: [provide(ConversationPhase, conversationPhase)],
})
