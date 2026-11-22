/** @jsxImportSource @solidjs/web */
import { Ellipsis } from '@lucide/solid'
import { createMemo, For, Show } from 'solid-js'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.solid.tsx'
import { Toggle } from '@/components/ui/toggle.solid.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.solid.tsx'
import {
  closePanel,
  cn,
  openPanel,
  usePanels,
  useStore,
  useViewport,
  ContributedIcon,
} from '@/sdk/solid'

const quickPanels = ['todos', 'tasks', 'activity', 'info']

const action =
  'flex size-7 items-center justify-center rounded-md p-0 font-normal transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring'

export function PanelActions() {
  const { open, active, tabs } = usePanels()
  const surface = useStore((state) => state.ui.surface?.id ?? 'agent')
  const viewport = useViewport()
  const quick = createMemo(() => tabs().filter((panel) => quickPanels.includes(panel.id)))
  const more = createMemo(() => tabs().filter((panel) => !quickPanels.includes(panel.id)))
  return (
    <Show when={viewport() === 'tablet' && surface() === 'agent'}>
      <nav class="flex items-center gap-0.5">
        <For each={quick()} keyed={(panel) => `${panel.extension}:${panel.id}`}>
          {(panel) => {
            const shown = () => open() && panel().id === active()?.id
            return (
              <Tooltip delay={400}>
                <TooltipTrigger
                  aria-label={`Show ${panel().title} panel`}
                  render={(trigger) => (
                    <Toggle
                      {...trigger}
                      pressed={shown()}
                      onPressedChange={(pressed) =>
                        pressed ? openPanel(panel().id) : closePanel()
                      }
                      class={action}
                      size={null}
                      variant={null}
                    />
                  )}
                >
                  <Show when={panel().icon} fallback={panel().title}>
                    {(icon) => <ContributedIcon class="size-4" icon={icon()} />}
                  </Show>
                </TooltipTrigger>
                <TooltipContent data-agent-hidden side="bottom">
                  {panel().title}
                </TooltipContent>
              </Tooltip>
            )
          }}
        </For>
        <Show when={more().length > 0}>
          <DropdownMenu modal={false} onAction={(id) => openPanel(id)}>
            <DropdownMenuTrigger
              aria-label="More panels"
              class={cn(
                action,
                'data-open:bg-accent data-open:text-foreground',
                open() && more().some((panel) => panel === active()) && 'bg-accent text-foreground',
              )}
            >
              <Ellipsis aria-hidden="true" class="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="min-w-44">
              <For each={more()} keyed={(panel) => `${panel.extension}:${panel.id}`}>
                {(panel) => (
                  <DropdownMenuItem class="gap-2 py-1.5 font-mono text-[12px]" value={panel().id}>
                    <Show when={panel().icon}>
                      {(icon) => <ContributedIcon class="size-3.5" icon={icon()} />}
                    </Show>
                    {panel().title}
                  </DropdownMenuItem>
                )}
              </For>
            </DropdownMenuContent>
          </DropdownMenu>
        </Show>
      </nav>
    </Show>
  )
}
