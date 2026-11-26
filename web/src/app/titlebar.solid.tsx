import { Command as CommandIcon } from '@lucide/solid'
import { cn } from 'cn'
import { createMemo, For, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.solid.tsx'
import { useExtensions, useStore, useSystem, useViewport } from '../sdk/hooks.ts'
import { actions } from '../sdk/actions.ts'
import { Contribution, ContributedIcon, Slot } from '../sdk/contribution.solid.tsx'
import { HOME, slotItems, surfaceItems } from '../sdk/registry.ts'
import { inlineFailure, SurfaceMenu, useHeaderShown, wordmark } from './header.solid.tsx'
import { Shortcut } from './palette.solid.tsx'
import { isPreview, projectName } from './project.ts'
import { sidebarWidthBeyondPhone as alignSurfaceTabsWithSidebar } from './shell.solid.tsx'

export function ProjectChip() {
  const system = useSystem()
  const name = () => projectName(system())
  const preview = () => {
    const info = system()
    return info !== undefined && isPreview(info)
  }
  return (
    <Show when={system() && (name() || preview())}>
      <span
        class="flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md px-2 font-sans text-[13px] font-medium text-foreground/90"
        title={system()?.project.root}
      >
        <Show when={preview()}>
          <span class="text-muted-foreground max-md:hidden">preview{name() && ' ·'}</span>
        </Show>
        <Show when={name()}>
          <span class="truncate">{name()}</span>
        </Show>
      </span>
    </Show>
  )
}

function Project() {
  const extensions = useExtensions()
  const replaced = () => slotItems(extensions(), 'titlebar.project').length > 0
  return (
    <Show when={replaced()} fallback={<ProjectChip />}>
      <Slot fallback={inlineFailure} name="titlebar.project" />
    </Show>
  )
}

export function Wordmark(props: { onClick?: () => void; label?: string }) {
  return (
    <Show
      when={props.onClick}
      fallback={
        <span class={wordmark} data-ui="wordmark">
          ULTIMATE
        </span>
      }
    >
      {(click) => (
        <Tooltip delay={400}>
          <TooltipTrigger
            aria-label={props.label}
            onClick={() => click()()}
            render={(trigger) => (
              <Button
                {...trigger}
                class={cn(
                  wordmark,
                  'h-6 px-1.5 transition-colors outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring',
                )}
                data-ui="wordmark"
                size={null}
                variant={null}
              />
            )}
          >
            ULTIMATE
          </TooltipTrigger>
          <Show when={props.label}>
            <TooltipContent>{props.label}</TooltipContent>
          </Show>
        </Tooltip>
      )}
    </Show>
  )
}

function Brand() {
  const extensions = useExtensions()
  const surfaces = createMemo(() => surfaceItems(extensions()))
  const shown = useStore((state) => state.ui.surface?.id)
  const current = () => surfaces().find((surface) => surface.id === shown())
  const replaced = () => slotItems(extensions(), 'titlebar.brand').length > 0
  return (
    <>
      <span class="contents max-md:hidden">
        <Show when={replaced()} fallback={<Wordmark />}>
          <Slot fallback={inlineFailure} name="titlebar.brand" />
        </Show>
      </span>
      <SurfaceMenu
        class={cn(
          wordmark,
          'transition-opacity outline-none hover:opacity-80 focus-visible:ring-1 focus-visible:ring-ring md:hidden',
        )}
        data="wordmark"
        label="Switch surface"
      >
        ULTIMATE
        <Show when={current()?.id !== HOME && current()}>
          {(surface) => (
            <span class="flex items-center gap-1.5 text-[12px] font-medium tracking-normal text-foreground">
              <Show when={surface().icon}>
                {(icon) => <ContributedIcon class="size-3.5 text-muted-foreground" icon={icon()} />}
              </Show>
              {surface().title}
            </span>
          )}
        </Show>
      </SurfaceMenu>
    </>
  )
}

function SurfaceItems() {
  const extensions = useExtensions()
  const surfaces = createMemo(() => surfaceItems(extensions()))
  const shown = useStore((state) => state.ui.surface?.id)
  return (
    <nav class="flex h-[35px] shrink-0 items-stretch gap-4 max-md:hidden" data-ui="surface-tabs">
      <For each={surfaces()} keyed={(surface) => `${surface.extension}:${surface.id}`}>
        {(surface, index) => {
          const active = () => surface().id === shown()
          const show = () => actions.showSurface(surface().id)
          const tab = (trigger: Record<string, unknown> = { onClick: show }) => (
            <Button
              {...trigger}
              aria-current={active() ? 'page' : undefined}
              class={cn(
                'h-auto items-center gap-1.5 rounded-none border-y-2 border-transparent px-0.5 font-mono text-[11.5px] font-normal lowercase transition-colors outline-none hover:text-foreground focus-visible:border-transparent focus-visible:text-foreground focus-visible:ring-0',
                active() && 'border-b-brand text-foreground focus-visible:border-b-brand',
              )}
              data-selected={active() || undefined}
              data-surface={surface().id}
              size={null}
              variant={null}
            >
              {surface().title}
              <Show when={surface().badge}>
                {(badge) => (
                  <Contribution
                    fallback={inlineFailure}
                    item={{
                      extension: surface().extension,
                      version: surface().version,
                      component: badge(),
                    }}
                    props={{}}
                  />
                )}
              </Show>
            </Button>
          )
          return (
            <Show when={index() < 9} fallback={tab()}>
              <Tooltip delay={400}>
                <TooltipTrigger onClick={show} render={(trigger) => tab(trigger)} />
                <TooltipContent class="flex items-center gap-2">
                  {surface().description ?? surface().title}
                  <Shortcut keys={`mod+${index() + 1}`} />
                </TooltipContent>
              </Tooltip>
            </Show>
          )
        }}
      </For>
    </nav>
  )
}

export function TitleBar() {
  const viewport = useViewport()
  const header = useHeaderShown()
  return (
    <Show when={viewport() !== 'phone' || !header()}>
      <div
        class="flex h-9 shrink-0 items-center gap-3 overflow-hidden border-b border-border/70 bg-sidebar pr-3 font-mono text-[11.5px] text-muted-foreground"
        data-ui="titlebar"
      >
        <div class="flex min-w-0 flex-1 items-center overflow-hidden whitespace-nowrap">
          <div
            class={cn(
              'flex min-w-0 items-center gap-2 overflow-hidden pr-3 pl-3 md:shrink-0 md:pr-2',
              alignSurfaceTabsWithSidebar,
            )}
          >
            <Brand />
            <Project />
            <Slot fallback={inlineFailure} name="titlebar.left" />
          </div>
          <div class="flex shrink-0 items-center pl-2">
            <SurfaceItems />
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-3 whitespace-nowrap">
          <Slot fallback={inlineFailure} name="titlebar.right" />
          <Button
            aria-label="Command palette"
            class="-mr-1 h-6 gap-1.5 px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground max-lg:hidden"
            onClick={actions.openPalette}
            size="sm"
            variant="ghost"
          >
            commands
            <Shortcut keys="mod+k" />
          </Button>
          <Button
            aria-label="Show commands"
            class="-mr-1 size-6 text-muted-foreground hover:text-foreground md:max-lg:size-7 lg:hidden"
            onClick={actions.openPalette}
            size="icon"
            variant="ghost"
          >
            <CommandIcon aria-hidden="true" class="size-3.5" />
          </Button>
        </div>
      </div>
    </Show>
  )
}
