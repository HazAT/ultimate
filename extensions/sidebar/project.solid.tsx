/** @jsxImportSource @solidjs/web */
import type { ConversationId } from '@earendil-works/pi-durable'
import { Brain, ChevronRight } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { createMemo, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import { cn, formatTokens, prettyName, shortenPath, useSystem } from '@/sdk/solid'
import { MEMORY_SURFACE, useOpenMemory } from '../lineage/ui.solid.tsx'
import type { GithubRepo } from '../workspaces/refs.ts'
import { useProjectRepo } from '../workspaces/ui.solid.tsx'
import { useMemorySummary } from './root.solid.tsx'
import { shell, useSidebarState, useSurface } from './state.solid.tsx'
import { ProjectSwatch, RepoLabel } from './ui.solid.tsx'

function Repo(props: { repo: GithubRepo }) {
  return (
    <div class="mx-2 flex min-w-0 pr-2 pl-[24px]">
      <a
        class="group/repo flex min-w-0 items-center gap-1.5 self-start rounded-sm font-mono text-[10px] leading-4 text-muted-foreground/80 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        data-project-repo={props.repo.key}
        href={props.repo.url}
        rel="noreferrer"
        target="_blank"
        title={`Open ${props.repo.name} on GitHub`}
      >
        <RepoLabel repo={props.repo} />
        <Show when={props.repo.visibility}>
          {(visibility) => (
            <span class="shrink-0 text-muted-foreground/60 group-hover/repo:text-muted-foreground">
              {visibility()}
            </span>
          )}
        </Show>
      </a>
    </div>
  )
}

export function Project(props: { root?: ConversationId; shown: boolean; children?: JSX.Element }) {
  const system = useSystem()
  const repo = useProjectRepo()
  const bind = useSidebarState('projectOpen', false)
  const [open] = bind
  const heading = createMemo(() => {
    const current = system()
    if (!current) return undefined
    const home = current.machine.home
    const worktree = /\/\.ultimate\/projects\/(.+)-[\da-f]{8}\/worktrees\/(\d+)$/.exec(
      current.project.root,
    )
    const path = worktree ? `#${worktree[2]}` : shortenPath(current.project.root, { home })
    const folder = worktree?.[1] ?? current.project.name
    return {
      folder,
      name: prettyName(folder),
      path: current.persistence.path.startsWith(`${home}/.ultimate/projects/`)
        ? path
        : `preview · ${path}`,
    }
  })
  const name = () => (
    <>
      <ProjectSwatch class="h-8 w-1 rounded-full" folder={heading()?.folder ?? ''} />
      <span class="flex min-w-0 flex-1 flex-col">
        <span class="truncate text-[14px] leading-5 font-semibold tracking-tight text-foreground">
          {heading()?.name}
        </span>
        <span class="truncate font-mono text-[10px] leading-4 font-normal text-muted-foreground/70">
          {heading()?.path}
        </span>
      </span>
    </>
  )
  return (
    <Collapsible
      bind={bind}
      aria-label="Fold project block"
      class="mb-1.5 border-b border-border/70 pt-1.5 pb-2"
    >
      <Show
        when={props.root}
        fallback={
          <div class="mx-2 flex h-12 items-center gap-2.5 px-2.5" title={system()?.project.root}>
            {name()}
          </div>
        }
      >
        {(root) => (
          <div
            class={cn(
              'group/project mx-2 flex h-12 min-w-0 items-center rounded-md transition-colors has-[[data-root-context]:hover]:bg-sidebar-accent/50',
              props.shown && 'bg-sidebar-accent has-[[data-root-context]:hover]:bg-sidebar-accent',
            )}
          >
            <Button
              aria-current={props.shown ? 'true' : undefined}
              aria-label={`Project History #${root()}`}
              class="flex h-full min-w-0 flex-1 items-center justify-start gap-2.5 rounded-md pr-1 pl-2.5 text-left font-normal outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
              data-root-context={root()}
              onClick={() => shell.switchConversation(root())}
              size={null}
              title={`${system()?.project.root ?? ''}\nOpen the project's History (#${root()}): every branch, abstract and landing`}
              variant={null}
            >
              {name()}
            </Button>
            <Show when={!open()}>
              <MemoryHint root={root()} />
            </Show>
            <CollapsibleTrigger
              aria-label={open() ? 'Hide the project memory' : 'Show the project memory'}
              class="group/project-toggle mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
              data-project-toggle="true"
              title={open() ? 'Hide Memory' : 'Show Memory'}
            >
              <ChevronRight class="size-3.5 transition-transform group-data-open/project-toggle:rotate-90" />
            </CollapsibleTrigger>
          </div>
        )}
      </Show>
      <Show when={repo()}>{(found) => <Repo repo={found()} />}</Show>
      <Show when={props.root !== undefined} fallback={<div class="mt-1.5">{props.children}</div>}>
        <CollapsibleContent class="mt-1.5">{props.children}</CollapsibleContent>
      </Show>
    </Collapsible>
  )
}

function MemoryHint(props: { root: ConversationId }) {
  const openMemory = useOpenMemory()
  const surface = useSurface()
  const shown = () => surface() === MEMORY_SURFACE
  const memory = useMemorySummary(() => props.root)
  return (
    <Button
      aria-current={shown() ? 'page' : undefined}
      aria-label="Open the project memory"
      class={cn(
        'flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 font-mono text-[10px] font-normal text-muted-foreground/60 outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring',
        shown() &&
          'bg-sidebar-accent text-foreground hover:bg-sidebar-accent hover:text-foreground',
      )}
      data-memory-hint={props.root}
      onClick={() => openMemory()}
      size={null}
      title={`Memory · ${memory().counts}${memory().tokens === undefined ? '' : ` · ${formatTokens(memory().tokens!)} tokens every new branch starts from`}`}
      variant={null}
    >
      <Brain class="size-3" />
      {memory().total || ''}
    </Button>
  )
}
