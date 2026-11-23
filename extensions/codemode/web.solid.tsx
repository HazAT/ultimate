import type { ConversationId } from '@earendil-works/pi-durable'
import { DatabaseIcon } from '@lucide/solid'
import { defineWebExtension, MessageReference, provide } from '@/sdk/solid'
import { CodemodeCall, CodemodeLine } from './call.solid.tsx'
import { StoreDocument } from './store.solid.tsx'

const messageReference = ({ conversation, id }: { conversation: ConversationId; id: number }) =>
  `Ultimate conversation #${conversation}, message #${id}. Read it in codemode with ultimate.entries(${conversation}, { before: ${id + 1}, limit: 1 }).`

export default defineWebExtension({
  provides: [provide(MessageReference, (input) => () => messageReference(input()))],
  tools: { codemode: CodemodeCall },
  toolLines: { codemode: CodemodeLine },
  documents: [
    {
      kind: 'pi.codemode.store',
      title: 'Store',
      icon: DatabaseIcon,
      component: StoreDocument,
    },
  ],
})
