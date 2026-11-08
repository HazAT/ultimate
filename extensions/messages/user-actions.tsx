/** Live, extension-owned actions that wait on the user without creating another question or running an agent. */
import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import { AllProvided, definePoint, events, useConversations, useNow, useUltimate } from '@/sdk'
import { liveUserActions } from './data.tsx'

/** An extension's existing card, not a second approval record. Omit it as soon as it is no longer actionable. */
export type PendingUserAction = {
  /** Stable and namespaced by the provider, such as `deploy:<proposal id>`. */
  id: string
  label: string
  /** The existing transcript card; absent for records that predate the provider's entry references. */
  entry?: number
  /** Unix milliseconds; the host stops counting the action at this deadline even without another document update. */
  expiresAt?: number
}
export type UserAction = PendingUserAction & { conversation: number }

/** Conversation ID → its pending user actions. Providers read their own live documents; all providers combine. */
export const PendingUserActions = definePoint<number, readonly PendingUserAction[]>(
  'messages.pending-user-actions',
)
const ActionsContext = createContext<readonly UserAction[]>([])

/** The live actions collected by UserActionsProvider, across conversations or just `conversation`. */
export function useUserActions(conversation?: number) {
  const actions = useContext(ActionsContext)
  return conversation === undefined
    ? actions
    : actions.filter((a) => a.conversation === conversation)
}

/** Share the collected actions across a status view. No source state is copied or persisted here. */
export function UserActionsProvider({ children }: { children: ReactNode }) {
  const ids = useConversations()
    .filter((conversation) => conversation.ownerTaskId === undefined)
    .map((conversation) => conversation.id)
  return (
    <Collect ids={ids} index={0} actions={[]}>
      {(actions) => <LiveActions actions={actions}>{children}</LiveActions>}
    </Collect>
  )
}

function Collect({
  ids,
  index,
  actions,
  children,
}: {
  ids: readonly number[]
  index: number
  actions: readonly UserAction[]
  children: (actions: readonly UserAction[]) => ReactNode
}) {
  const id = ids[index]
  if (id === undefined) return children(actions)
  return (
    <AllProvided input={id} point={PendingUserActions}>
      {(values) => (
        <Collect
          ids={ids}
          index={index + 1}
          actions={[
            ...actions,
            ...values.flatMap((value) => value.map((a) => ({ ...a, conversation: id }))),
          ]}
        >
          {children}
        </Collect>
      )}
    </AllProvided>
  )
}

function LiveActions({
  actions,
  children,
}: {
  actions: readonly UserAction[]
  children: ReactNode
}) {
  const now = useNow(
    1000,
    actions.some((action) => action.expiresAt !== undefined),
  )
  const live = liveUserActions(actions, now)
  return <ActionsContext.Provider value={live}>{children}</ActionsContext.Provider>
}

/** Open the action's own conversation and reveal its existing card, including older paged-out entries. */
export function useOpenUserAction() {
  const { showSurface, switchConversation } = useUltimate()
  return (action: UserAction) => {
    showSurface('agent')
    switchConversation(action.conversation)
    if (action.entry !== undefined)
      events.emit('messages:open', { conversation: action.conversation, entry: action.entry })
  }
}
