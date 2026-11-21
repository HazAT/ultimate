import { Header as SolidHeader } from '../app/header.solid.tsx'
import {
  Conversation as SolidConversation,
  Dock as SolidDock,
  Sidebar as SolidSidebar,
  StatusLine as SolidStatusLine,
} from '../app/shell.solid.tsx'
import { Wordmark as SolidWordmark } from '../app/titlebar.solid.tsx'
import { island } from './island.tsx'

/** The surface's top bar: its children (by default the shown conversation's trail) and the `header.right` slot. */
export const Header = island(SolidHeader)
/** The bottom line with the `statusline.left` and `statusline.right` slots. */
export const StatusLine = island(SolidStatusLine)
/** The shown conversation: transcript and composer, filling their box; `dock` fits a narrow region. */
export const Conversation = island(SolidConversation)
/** A collapsible, resizable side region that keeps its open state and width per surface and side. */
export const Dock = island(SolidDock)
/** The `sidebar` slot as a left column, toggled with `mod+b`. */
export const Sidebar = island(SolidSidebar)
/** The ULTIMATE wordmark; with `onClick` a button that `label` names. */
export const Wordmark = island(SolidWordmark, { inline: true })
