import type { UserMessage } from '@earendil-works/pi-ai'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { island } from './island.tsx'
import { MessageActions as SolidActions } from '../app/message-actions.solid.tsx'
import { UserText as SolidText, UserView as SolidView } from '../app/user-turn.solid.tsx'

const Actions = island(SolidActions)
const Text = island(SolidText)
const View = island(SolidView)

export function MessageActions({
  className,
  ...props
}: {
  entry: EntryRecord
  text: string
  timestamp: number
  className?: string
  bubble?: boolean
}) {
  return <Actions {...props} class={className} />
}

export function UserText({ className, text }: { text: string; className?: string }) {
  return <Text class={className} text={text} />
}

export function UserView(props: { entry: EntryRecord; message: UserMessage; text?: string }) {
  return <View {...props} />
}
