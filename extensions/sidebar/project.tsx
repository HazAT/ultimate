import type { ConversationId } from '@earendil-works/pi-durable'
import { BrainIcon, ChevronRightIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn, formatTokens, projectHeading, useSystem } from '@/sdk'
import { MEMORY_SURFACE, useOpenMemory } from '../lineage/ui.tsx'
import { useProjectRepo } from '../workspaces/ui.tsx'
import type { GithubRepo } from '../workspaces/refs.ts'
import { useMemorySummary } from './root.tsx'
import { useShell, useSidebarState } from './state.tsx'
import { ProjectSwatch, RepoLabel } from './tile.tsx'

function Repo({ repo }: { repo: GithubRepo }) {
  return (
    <a
      className="group/repo flex min-w-0 items-center gap-1.5 self-start rounded-sm font-mono text-[10px] leading-4 text-muted-foreground/80 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
      data-project-repo={repo.key}
      href={repo.url}
      rel="noreferrer"
      target="_blank"
      title={`Open ${repo.name} on GitHub`}
    >
      <RepoLabel repo={repo} />
      {repo.visibility && (
        <span className="shrink-0 text-muted-foreground/60 group-hover/repo:text-muted-foreground">
          {repo.visibility}
        </span>
      )}
    </a>
  )
}

export function Project({
  root,
  shown,
  children,
}: {
  root?: ConversationId
  shown: boolean
  children?: ReactNode
}) {
  const system = useSystem()
  const actions = useShell()
  const heading = projectHeading(system)
  const repo = useProjectRepo()
  const [open, setOpen] = useSidebarState('projectOpen', false)
  const name = (
    <>
      <ProjectSwatch className="h-8 w-1 rounded-full" folder={heading?.folder ?? ''} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[14px] leading-5 font-semibold tracking-tight text-foreground">
          {heading?.name}
        </span>
        <span className="truncate font-mono text-[10px] leading-4 font-normal text-muted-foreground/70">
          {heading?.path}
        </span>
      </span>
    </>
  )
  return (
    <div aria-label="Project" className="mb-1.5 border-b border-border/70 pt-1.5 pb-2" role="group">
      {root === undefined ? (
        <div className="mx-2 flex h-12 items-center gap-2.5 px-2.5" title={system?.project.root}>
          {name}
        </div>
      ) : (
        <div
          className={cn(
            'group/project mx-2 flex h-12 min-w-0 items-center rounded-md transition-colors has-[[data-root-context]:hover]:bg-sidebar-accent/50',
            shown && 'bg-sidebar-accent has-[[data-root-context]:hover]:bg-sidebar-accent',
          )}
        >
          <button
            aria-current={shown ? 'true' : undefined}
            className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-md pr-1 pl-2.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
            data-root-context={root}
            onClick={() => actions.switchConversation(root)}
            title={`${system?.project.root ?? ''}\nOpen the project's History (#${root}): every branch, abstract and landing`}
            type="button"
          >
            {name}
          </button>
          {!open && <MemoryHint root={root} />}
          <button
            aria-expanded={open}
            aria-label={open ? 'Hide the project memory' : 'Show the project memory'}
            className="mr-1 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
            data-project-toggle
            onClick={() => setOpen(!open)}
            title={open ? 'Hide Memory' : 'Show Memory'}
            type="button"
          >
            <ChevronRightIcon
              className={cn('size-3.5 transition-transform', open && 'rotate-90')}
            />
          </button>
        </div>
      )}
      {repo && (
        <div className="mx-2 flex min-w-0 pr-2 pl-[24px]">
          <Repo repo={repo} />
        </div>
      )}
      {(open || root === undefined) && <div className="mt-1.5">{children}</div>}
    </div>
  )
}

function MemoryHint({ root }: { root: ConversationId }) {
  const openMemory = useOpenMemory()
  const shown = useShell().surface === MEMORY_SURFACE
  const { total, tokens, counts } = useMemorySummary(root)
  return (
    <button
      aria-current={shown ? 'page' : undefined}
      aria-label="Open the project memory"
      className={cn(
        'flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 font-mono text-[10px] font-normal text-muted-foreground/60 outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring',
        shown && 'bg-sidebar-accent text-foreground hover:bg-sidebar-accent hover:text-foreground',
      )}
      data-memory-hint={root}
      onClick={() => openMemory()}
      title={`Memory · ${counts}${tokens === undefined ? '' : ` · ${formatTokens(tokens)} tokens every new branch starts from`}`}
      type="button"
    >
      <BrainIcon className="size-3" />
      {total > 0 && total}
    </button>
  )
}
