/** Live, extension-owned actions that wait on the user without creating another question or running an agent. */
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
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

/** Share live descriptors across a status view; pending state stays in the providers' durable documents. */
export function UserActionsProvider({ children }: { children: ReactNode }) {
  const ids = useConversations()
    .filter((conversation) => conversation.ownerTaskId === undefined)
    .map((conversation) => conversation.id)
  const [sources, setSources] = useState<Record<number, readonly PendingUserAction[]>>({})
  const update = useCallback((id: number, actions: readonly PendingUserAction[]) => {
    setSources((current) => {
      const previous = current[id] ?? []
      if (
        previous.length === actions.length &&
        previous.every((action, index) => {
          const candidate = actions[index]
          return (
            action.id === candidate.id &&
            action.label === candidate.label &&
            action.entry === candidate.entry &&
            action.expiresAt === candidate.expiresAt
          )
        })
      )
        return current
      const next = { ...current }
      if (actions.length) next[id] = actions
      else delete next[id]
      return next
    })
  }, [])
  const actions = Object.entries(sources).flatMap(([id, values]) =>
    values.map((action) => ({ ...action, conversation: Number(id) })),
  )
  return (
    <>
      <Observers ids={ids} update={update} />
      <LiveActions actions={actions}>{children}</LiveActions>
    </>
  )
}

type Update = (id: number, actions: readonly PendingUserAction[]) => void

/** Keep observers beside the view, not wrapped around it: changing conversations must not remount its drafts. */
function Observers({ ids, update }: { ids: readonly number[]; update: Update }) {
  return ids.map((id) => (
    <AllProvided key={id} input={id} point={PendingUserActions}>
      {(values) => <Observed id={id} values={values} update={update} />}
    </AllProvided>
  ))
}

function Observed({
  id,
  values,
  update,
}: {
  id: number
  values: readonly (readonly PendingUserAction[])[]
  update: Update
}) {
  useEffect(() => update(id, values.flat()), [id, values, update])
  useEffect(() => () => update(id, []), [id, update])
  return null
}

function LiveActions({
  actions,
  children,
}: {
  actions: readonly UserAction[]
  children: ReactNode
}) {
  useNow(
    1000,
    actions.some((action) => action.expiresAt !== undefined && action.expiresAt > Date.now()),
  )
  // A document update can cross the deadline before the clock's next tick.
  const live = liveUserActions(actions, Date.now())
  return <ActionsContext.Provider value={live}>{children}</ActionsContext.Provider>
}

/** Open the action's own conversation and reveal its existing card, including older paged-out entries. */
export function useOpenUserAction() {
  const { showSurface, switchConversation } = useUltimate()
  return (action: UserAction) => {
    if (action.entry !== undefined)
      events.emit('messages:open', { conversation: action.conversation, entry: action.entry })
    showSurface('agent')
    switchConversation(action.conversation)
  }
}
