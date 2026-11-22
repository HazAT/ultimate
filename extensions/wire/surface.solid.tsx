import { Conversation, Dock, useConversation, useViewport } from '@/sdk/solid'
import { WireTab } from './tab.solid.tsx'

export function Wire() {
  const conversation = useConversation()
  const viewport = useViewport()
  return (
    <div class="flex min-h-0 flex-1">
      <WireTab busy={conversation().busy} phone={viewport() === 'phone'} />
      <Dock>
        <Conversation variant="dock" />
      </Dock>
    </div>
  )
}
