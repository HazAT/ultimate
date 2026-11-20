import type { ConversationId } from '@earendil-works/pi-durable'
import { DatabaseIcon } from 'lucide-react'
import { defineWebExtension, island, MessageReference, provide } from '@/sdk'
import type { DocumentProps } from '@/sdk'
import { JsonTree as SolidJsonTree } from '@/components/json-tree.solid.tsx'
import { CodemodeCall, CodemodeLine } from './call.solid.tsx'

const JsonTree = island(SolidJsonTree)

function StoreDocument({ value }: DocumentProps) {
  if (Object.keys(value).length > 0)
    return <JsonTree class="px-2" name="codemode store" open={1} value={value} />
  return (
    <p className="px-3 font-sans text-[12px] leading-relaxed text-muted-foreground/70">
      Empty. Codemode scripts keep values across runs with{' '}
      <code className="font-mono">store(key, value)</code> and read them with{' '}
      <code className="font-mono">load(key)</code>; they live with this conversation.
    </p>
  )
}

const messageReference = ({ conversation, id }: { conversation: ConversationId; id: number }) =>
  `Ultimate conversation #${conversation}, message #${id}. Read it in codemode with ultimate.entries(${conversation}, { before: ${id + 1}, limit: 1 }).`

export default defineWebExtension({
  provides: [provide(MessageReference, messageReference)],
  tools: { codemode: island(CodemodeCall) },
  toolLines: { codemode: island(CodemodeLine) },
  documents: [
    { kind: 'codemode.store', title: 'Store', icon: DatabaseIcon, component: StoreDocument },
  ],
})
