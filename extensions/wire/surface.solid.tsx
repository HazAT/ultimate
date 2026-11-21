/** @jsxImportSource @solidjs/web */
import { createEffect } from 'solid-js'
import { Conversation, Dock } from '@/sdk/parts.solid.tsx'
import { useConversation, useDialog, useViewport } from '@/sdk/solid'
import { useOpenWire } from './link.solid.tsx'
import { WireTab } from './tab.solid.tsx'

export const openDialog = 'wire.open'

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

export function OpenOnCommand() {
  const [open, setOpen] = useDialog(openDialog)
  const openWire = useOpenWire()
  createEffect(open, (shown) => {
    if (!shown) return
    setOpen(false)
    openWire()
  })
  return null
}
