import { EllipsisIcon } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn, usePanels, useUltimate, useViewport } from '@/sdk'

/** The panels a tablet's title bar shows as icons; the rest go behind its `⋯` menu. */
const quickPanels = ['todos', 'tasks', 'activity', 'info']

const action =
  'flex size-7 items-center justify-center rounded-md transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring'

/**
 * On a tablet (an unfolded foldable) the panels overlay the conversation and the header's toggle sits far from the
 * hand, so the title bar's right end gets the `quickPanels` as icons, each opening its panel or closing it when
 * shown, and a `⋯` menu with the rest. Only on the Agent surface, whose panels they are.
 */
export function PanelActions() {
  const { open, active, tabs } = usePanels()
  const { surface, openPanel, closePanel } = useUltimate()
  const tablet = useViewport() === 'tablet'
  if (!tablet || surface !== 'agent') return null
  const quick = tabs.filter((panel) => quickPanels.includes(panel.id))
  const more = tabs.filter((panel) => !quickPanels.includes(panel.id))
  return (
    <nav className="flex items-center gap-0.5">
      {quick.map((panel) => {
        const Icon = panel.icon
        const shown = open && panel.id === active?.id
        return (
          <Tooltip key={`${panel.extension}:${panel.id}`}>
            <TooltipTrigger asChild>
              <button
                aria-label={panel.title}
                aria-pressed={shown}
                className={cn(action, shown && 'bg-accent text-foreground')}
                onClick={() => (shown ? closePanel() : openPanel(panel.id))}
                type="button"
              >
                {Icon ? <Icon className="size-4" /> : panel.title}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{panel.title}</TooltipContent>
          </Tooltip>
        )
      })}
      {more.length > 0 && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              aria-label="More panels"
              className={cn(
                action,
                'data-[state=open]:bg-accent data-[state=open]:text-foreground',
                open && active && more.includes(active) && 'bg-accent text-foreground',
              )}
              type="button"
            >
              <EllipsisIcon className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            {more.map((panel) => {
              const Icon = panel.icon
              return (
                <DropdownMenuItem
                  className="gap-2 py-1.5 font-mono text-[0.75rem]"
                  key={`${panel.extension}:${panel.id}`}
                  onSelect={() => openPanel(panel.id)}
                >
                  {Icon && <Icon className="size-3.5" />}
                  {panel.title}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </nav>
  )
}
