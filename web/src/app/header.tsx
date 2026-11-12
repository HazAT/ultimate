import { cn } from 'cn'
import { PanelLeftIcon, PanelRightIcon } from 'lucide-react'
import { Fragment } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ConversationSummary } from '../../../shared/protocol.ts'
import { actions } from '../sdk/actions.ts'
import { ROOT } from '../sdk/api.ts'
import {
  useConversation,
  useConversations,
  useExtensions,
  useStore,
  useRegionOpen,
} from '../sdk/hooks.ts'
import { panelItems, slotItems } from '../sdk/registry.ts'
import { ConversationKind } from '../sdk/types.ts'
import { Provided, Slot } from './boundary.tsx'
import { Shortcut } from './palette.tsx'
import { useRegion } from './surface.ts'

export function IconButton({
  label,
  keys,
  onClick,
  children,
  active,
}: {
  label: string
  keys?: string
  onClick: () => void
  children: ReactNode
  active?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          className={cn(
            'size-7 text-muted-foreground hover:text-foreground pointer-coarse:size-9',
            active && 'text-foreground',
          )}
          onClick={onClick}
          size="icon"
          variant="ghost"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="flex items-center gap-2">
        {label}
        {keys && <Shortcut keys={keys} />}
      </TooltipContent>
    </Tooltip>
  )
}

/** The conversations above `id`, root first, by their parent links. */
function ancestors(id: number | undefined, conversations: readonly ConversationSummary[]) {
  const chain: ConversationSummary[] = []
  let parent = conversations.find((conversation) => conversation.id === id)?.parentConversationId
  while (parent !== undefined && !chain.some((conversation) => conversation.id === parent)) {
    const found = conversations.find((conversation) => conversation.id === parent)
    if (!found) break
    chain.unshift(found)
    parent = found.parentConversationId
  }
  return chain
}

/** The root is named by role rather than by its first prompt. */
const nameOf = (conversation: ConversationSummary) =>
  conversation.id === ROOT ? 'main' : (conversation.label ?? `#${conversation.id}`)

/** Where the shown conversation sits: its ancestors (beyond a phone), a busy dot, and its title. */
function Trail() {
  const { busy } = useConversation()
  // The requested conversation while its snapshot loads, so a switch keeps naming where it goes.
  const id = useStore((state) => state.view?.conversation.id ?? state.requested)
  const conversations = useConversations()
  const summary = conversations.find((conversation) => conversation.id === id)
  const trail = ancestors(id, conversations)
  const root = id === ROOT
  // A conversation just started is named once its summary arrives, not given a placeholder before that.
  const title =
    id === undefined ? 'connecting…' : summary ? (summary.title ?? 'Untitled conversation') : ''
  return (
    <>
      {trail.map((conversation) => (
        <Fragment key={conversation.id}>
          <button
            className="shrink-0 rounded-sm px-1 font-mono text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground max-md:hidden"
            onClick={() => actions.switchConversation(conversation.id)}
            title={conversation.id === ROOT ? 'The main conversation' : conversation.title}
            type="button"
          >
            {nameOf(conversation)}
          </button>
          <span className="-mx-1 shrink-0 text-muted-foreground/40 max-md:hidden">/</span>
        </Fragment>
      ))}
      {busy && <span className="size-1.5 shrink-0 animate-pulse-dot rounded-full bg-brand" />}
      {root ? (
        <span className="font-mono text-[12px] text-foreground/85">main</span>
      ) : (
        <>
          <Provided input={summary} point={ConversationKind}>
            {(kind) =>
              (kind ?? summary?.label) && (
                <span className="max-w-1/2 shrink-0 truncate font-mono text-[12px] text-brand">
                  {kind ?? summary?.label}
                </span>
              )
            }
          </Provided>
          <span className="truncate text-[13px] font-medium" title={title}>
            {title}
          </span>
          {id !== undefined && (
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70">#{id}</span>
          )}
        </>
      )}
    </>
  )
}

/**
 * The top bar of a surface: `children` (the shown conversation's trail by default) and the `header.right` slot. It
 * toggles the sidebar and panel when the surface renders them.
 */
export function Header({ children }: { children?: ReactNode }) {
  const records = useExtensions()
  const sidebar = useRegion('sidebar') && slotItems(records, 'sidebar').length > 0
  const panels = useRegion('panels') && panelItems(records).length > 0
  const panelOpen = useRegionOpen('panels')
  return (
    <header
      className="flex h-10 shrink-0 items-center gap-2 border-b border-border/70 px-2"
      data-ui="conversation-header"
    >
      {sidebar && (
        <IconButton keys="mod+b" label="Toggle sidebar" onClick={actions.toggleSidebar}>
          <PanelLeftIcon className="size-4" />
        </IconButton>
      )}
      <div className="flex min-w-0 items-center gap-2">{children ?? <Trail />}</div>
      <div className="ml-auto flex items-center gap-1">
        <Slot name="header.right" variant="inline" />
        {panels && (
          <IconButton
            active={panelOpen}
            keys="mod+alt+b"
            label="Toggle panel"
            onClick={actions.togglePanel}
          >
            <PanelRightIcon className="size-4" />
          </IconButton>
        )}
      </div>
    </header>
  )
}
