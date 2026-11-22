/** Side chats for other extensions' browser code: opening one, their document, and which one is in front. */
import { useUiState } from '@/sdk/solid'
import { FRONT_KEY } from './front.ts'

export { OpenAction, SideChatsDoc } from './refs.ts'

/** The side chat in front, durable UI state shared by every tab. */
export const useSideChatFront = () => useUiState<number | null>(FRONT_KEY, null)
