/** The sidebar's points for other extensions' browser code. */
import type { ConversationId } from '@earendil-works/pi-durable'
import type { ReactNode } from 'react'
import { definePoint } from '@/sdk'

/**
 * Rows nested under @ultimate's row (`side-chat` lists its open side chats, `voice-live` the Voice conversation); several
 * extensions may provide it and their rows show in discovery order. Input is @ultimate's conversation id.
 */
export const UnderUltimate = definePoint<ConversationId | undefined, ReactNode>(
  'sidebar.under-ultimate',
)
/**
 * Rows nested under a standing agent's row in the Agents group (below the lander's Landed section); several extensions
 * may provide it and their rows show in discovery order. Input is the agent's name (`lander`, or its definition's
 * `name`, `shopify-lander`); a provider returns null for agents it does not serve.
 */
export const UnderAgent = definePoint<string, ReactNode>('sidebar.under-agent')
/**
 * Top-level conversations no section lists (`side-chat` names its side chats, open or ended, `voice-live` the Voice
 * conversation; both nest under @ultimate instead); several extensions may provide it and the sidebar takes the union.
 * Input is @ultimate's conversation id.
 */
export const Unlisted = definePoint<ConversationId | undefined, ReadonlySet<number>>(
  'sidebar.unlisted',
)
export { colourOf, GithubMark, ProjectSwatch, RepoLabel, stemOf } from './tile.tsx'
