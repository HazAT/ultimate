import { ROOT } from '@/sdk'
import { useConversations, useDocOf } from '@/sdk'
import type { ConversationSummary } from '@/sdk'
import { WorkspacesDoc } from './refs.ts'
import type { Workspace, WorkspaceIndex } from './types.ts'

export type WorkspaceConversation = ConversationSummary & { workspace?: Workspace }
const none: WorkspaceIndex = {
  items: {},
  queue: [],
  landers: {},
  landerConversations: {},
  results: {},
}
export function useWorkspaces() {
  return useWorkspaceIndex().items
}
/** The whole root index: queue, lander conversations and recent outcomes. */
export function useWorkspaceIndex() {
  return useDocOf(ROOT, WorkspacesDoc) ?? none
}
/** Submissions waiting for or being processed by a lander, oldest first. */
export function useLanderQueue() {
  return useWorkspaceIndex().queue
}
export function useWorkspaceConversations(): WorkspaceConversation[] {
  const records = useWorkspaces()
  return useConversations().map((conversation) => ({
    ...conversation,
    workspace: records[String(conversation.id)],
  }))
}

export const stateLabel = (workspace: Workspace) =>
  ({ preparing: 'Setting up…', ready: 'Ready', failed: 'Setup failed', removed: 'Removed' })[
    workspace.state
  ]
