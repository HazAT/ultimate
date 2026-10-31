import { CheckIcon, FolderGitIcon, FolderInputIcon, HistoryIcon } from 'lucide-react'
import { useState } from 'react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import {
  actionRef,
  api,
  cn,
  defineWebExtension,
  errorMessage,
  formatAgo,
  shortenPath,
  useAction,
  useDialog,
  useNow,
} from '@/sdk'

type Project = { path: string; name: string; openedAt?: number }
type Projects = { current: string; home: string; opened: Project[]; repos: Project[] }

/** No arguments → the current project, projects opened before, and git repos under the home folder. */
const ListAction = actionRef<null, Projects>('project-switch', 'list')
/** `{ path }` → records the project and restarts the service into it. */
const OpenAction = actionRef<{ path: string }, { path: string }>('project-switch', 'open')

const dialog = 'project-switch.picker'

const matches = (project: Project, terms: readonly string[]) =>
  terms.every((term) => project.path.toLowerCase().includes(term))

function ProjectRow({
  project,
  projects,
  icon: Icon,
  now,
  onSelect,
}: {
  project: Project
  projects: Projects
  icon: typeof HistoryIcon
  now: number
  onSelect: () => void
}) {
  const current = project.path === projects.current
  return (
    <CommandItem
      className="gap-2 py-1 font-mono text-[12px]"
      onSelect={onSelect}
      value={project.path}
    >
      <CheckIcon className={cn('size-3.5', current ? 'text-brand' : 'opacity-0')} />
      <Icon className="size-3.5 text-muted-foreground" />
      <span className={cn('shrink-0', current ? 'text-brand' : 'text-foreground')}>
        {project.name}
      </span>
      <span className="min-w-0 truncate text-[11px] text-muted-foreground/80">
        {shortenPath(project.path, { home: projects.home })}
      </span>
      <span className="ml-auto shrink-0 pl-3 text-[11px] text-muted-foreground tabular-nums">
        {current ? 'current' : project.openedAt ? formatAgo(project.openedAt, now) : ''}
      </span>
    </CommandItem>
  )
}

/** Projects opened before, git repos in the home folder, or a typed absolute path; picking one restarts into it. */
function ProjectPicker() {
  const [open, setOpen] = useDialog(dialog)
  const list = useAction(ListAction, null, { enabled: open })
  const now = useNow(60_000, open)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string>()
  const [switching, setSwitching] = useState<string>()
  const projects = list.data
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const opened = projects?.opened.filter((project) => matches(project, terms)) ?? []
  const repos = projects?.repos.filter((project) => matches(project, terms)) ?? []
  const typed = query.trim().startsWith('/') ? query.trim() : undefined

  function choose(path: string) {
    if (switching) return
    if (path === projects?.current) return setOpen(false)
    setError(undefined)
    setSwitching(path)
    // The service restarts a moment after this answers: the connection drops and the page reloads into `path`.
    api.action(OpenAction, { path }).then(
      () => undefined,
      (failure: unknown) => {
        setSwitching(undefined)
        setError(errorMessage(failure))
      },
    )
  }

  return (
    <Dialog
      onOpenChange={(next) => {
        if (switching) return
        setOpen(next)
        if (!next) {
          setQuery('')
          setError(undefined)
        }
      }}
      open={open}
    >
      <DialogContent
        className="top-[16%] translate-y-0 gap-0 overflow-hidden p-0 font-mono sm:max-w-2xl"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Open a project</DialogTitle>
        <DialogDescription className="sr-only">
          Pick a project opened before or a git repository in your home folder, or type an absolute
          folder path. Ultimate restarts in that project.
        </DialogDescription>
        <Command
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:uppercase"
          shouldFilter={false}
        >
          <CommandInput
            className="text-[13px]"
            disabled={!!switching}
            onValueChange={(value) => {
              setQuery(value)
              setError(undefined)
            }}
            placeholder="Search projects, or type an absolute path…"
            value={query}
          />
          <CommandList className="max-h-[55vh]">
            <CommandEmpty className="py-6 text-center text-[12px] text-muted-foreground">
              {list.loading ? 'Loading projects…' : 'No project matches. Type an absolute path.'}
            </CommandEmpty>
            {typed && (
              <CommandGroup heading="Path">
                <CommandItem
                  className="gap-2 py-1 font-mono text-[12px]"
                  onSelect={() => choose(typed)}
                  value={`path:${typed}`}
                >
                  <CheckIcon className="size-3.5 opacity-0" />
                  <FolderInputIcon className="size-3.5 text-muted-foreground" />
                  <span className="min-w-0 truncate text-foreground">Open {typed}</span>
                </CommandItem>
              </CommandGroup>
            )}
            {projects && opened.length > 0 && (
              <CommandGroup heading="Opened before">
                {opened.map((project) => (
                  <ProjectRow
                    icon={HistoryIcon}
                    key={project.path}
                    now={now}
                    onSelect={() => choose(project.path)}
                    project={project}
                    projects={projects}
                  />
                ))}
              </CommandGroup>
            )}
            {projects && repos.length > 0 && (
              <CommandGroup heading="Git repositories in ~">
                {repos.map((project) => (
                  <ProjectRow
                    icon={FolderGitIcon}
                    key={project.path}
                    now={now}
                    onSelect={() => choose(project.path)}
                    project={project}
                    projects={projects}
                  />
                ))}
              </CommandGroup>
            )}
          </CommandList>
          <div className="flex items-center gap-3 border-t border-border/70 px-3 py-1.5 text-[11px] text-muted-foreground">
            {error ? (
              <span className="truncate text-error">{error}</span>
            ) : switching ? (
              <span className="truncate text-brand">
                Restarting in {shortenPath(switching, { home: projects?.home })}… the page reloads
                when it is back
              </span>
            ) : (
              <>
                <span>
                  <Kbd>↵</Kbd> open
                </span>
                <span>
                  <Kbd>esc</Kbd> close
                </span>
                <span className="ml-auto">restarts Ultimate in the project, at this URL</span>
              </>
            )}
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

export default defineWebExtension({
  slots: { overlay: [ProjectPicker] },
  commands: [
    { id: 'project-switch.open', title: 'Open project…', run: (context) => context.open(dialog) },
  ],
})
