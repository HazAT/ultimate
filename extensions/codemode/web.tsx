import type { ConversationId } from '@earendil-works/pi-durable'
import { DatabaseIcon } from 'lucide-react'
import { defineWebExtension, island, MessageReference, provide } from '@/sdk'
import { CodemodeCall, CodemodeLine } from './call.solid.tsx'
import { StoreDocument } from './store.solid.tsx'

const messageReference = ({ conversation, id }: { conversation: ConversationId; id: number }) =>
  `Ultimate conversation #${conversation}, message #${id}. Read it in codemode with ultimate.entries(${conversation}, { before: ${id + 1}, limit: 1 }).`

export default defineWebExtension({
  provides: [provide(MessageReference, messageReference)],
  tools: { codemode: island(CodemodeCall) },
  toolLines: { codemode: island(CodemodeLine) },
  documents: [
    {
      kind: 'codemode.store',
      title: 'Store',
      icon: DatabaseIcon,
      component: island(StoreDocument),
    },
  ],
})
