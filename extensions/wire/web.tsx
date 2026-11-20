import { useEffect } from 'react'
import {
  Conversation,
  Dock,
  defineWebExtension,
  island,
  provide,
  useConversation,
  useDialog,
  useViewport,
} from '@/sdk'
import { SystemTab } from '../system/ui.tsx'
import { useOpenWire, WireLink } from './link.tsx'
import { WireTab } from './tab.solid.tsx'

const Tab = island(WireTab)

function Wire() {
  const busy = useConversation((conversation) => conversation.busy)
  const phone = useViewport() === 'phone'
  return (
    <div className="flex min-h-0 flex-1">
      <Tab busy={busy} phone={phone} />
      <Dock>
        <Conversation variant="dock" />
      </Dock>
    </div>
  )
}

const openDialog = 'wire.open'

function OpenOnCommand() {
  const [open, setOpen] = useDialog(openDialog)
  const openWire = useOpenWire()
  useEffect(() => {
    if (!open) return
    setOpen(false)
    openWire()
  }, [open, setOpen, openWire])
  return null
}

const tab = { id: 'wire', title: 'Wire', component: Wire }

export default defineWebExtension({
  provides: [provide(SystemTab, () => tab)],
  commands: [{ id: 'wire.open', title: 'Open Wire', run: (context) => context.open(openDialog) }],
  slots: { overlay: [OpenOnCommand] },
  entries: { 'pi.assistant': WireLink },
})
