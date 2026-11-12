# Example: a Commits app

Part of the [extension guide](../../extensions/README.md).

A complete app: the project's recent commits in a list, the selected one beside it with a button that hands it to the
agent, and the agent docked on the right. It needs nothing but `git`. Put the three files in
`<project>/.ultimate/extensions/commits/`; on save, Commits appears in the switcher (`mod+2`).

`server.ts`, the data:

```ts
import type { JsonValue } from '@earendil-works/chord/json'
import { defineExtension } from '@earendil-works/pi-durable'
import type { ActionContext } from '../../../server/actions.ts'

export default defineExtension({ name: 'commits' })

/** The UI calls these through the refs in `web.tsx`; each returns JSON. */
export const actions = {
  /** The latest 50 commits of the project. */
  async list(_args: JsonValue, ctx: ActionContext) {
    const format = '--format=%H%x1f%s%x1f%an%x1f%ar'
    const { stdout } = await ctx.exec('git', ['log', '-n', '50', format])
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, subject, author, when] = line.split('\x1f')
        return { sha, subject, author, when }
      })
  },
  /** One commit: its message and the files it changed. */
  async show(sha: JsonValue, ctx: ActionContext) {
    if (typeof sha !== 'string' || !/^[0-9a-f]{7,40}$/.test(sha)) throw new Error('Expected a sha')
    const { stdout } = await ctx.exec('git', ['show', '--stat', '--format=%B', sha])
    return { sha, text: stdout.trim() }
  },
}
```

`web.tsx`, the surface:

```tsx
import { GitCommitHorizontalIcon, MessageSquarePlusIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Conversation,
  Dock,
  Header,
  StatusLine,
  actionRef,
  api,
  cn,
  defineWebExtension,
  useAction,
  useExtensionUiState,
} from '@/sdk'

type Commit = { sha: string; subject: string; author: string; when: string }

/** The actions of `server.ts`, typed: no arguments → the latest 50 commits; a sha → its message and files. */
const ListAction = actionRef<null, Commit[]>('commits', 'list')
const ShowAction = actionRef<string, { sha: string; text: string }>('commits', 'show')

/** One commit, and a button that hands it to the agent. */
function Detail({ sha, text }: { sha: string; text: string }) {
  return (
    <>
      <div className="flex items-center gap-3">
        <h1 className="font-mono text-[13px] text-muted-foreground">{sha.slice(0, 12)}</h1>
        <Button
          className="ml-auto"
          onClick={() => void api.submit(`Review commit ${sha}.`, 'followUp')}
          size="sm"
          variant="outline"
        >
          <MessageSquarePlusIcon />
          Ask the agent
        </Button>
      </div>
      <pre className="mt-4 font-mono text-[12px] whitespace-pre-wrap text-foreground/90">
        {text}
      </pre>
    </>
  )
}

/** Recent commits on the left, the selected one in the middle, the agent docked on the right. */
function Commits() {
  const commits = useAction(ListAction)
  const [selected, setSelected] = useExtensionUiState<string | null>('selected', null)
  const sha = selected ?? commits.data?.[0]?.sha ?? null
  const commit = useAction(ShowAction, sha ?? '', { enabled: sha !== null })
  return (
    <>
      <Header />
      <div className="flex min-h-0 flex-1">
        <nav className="w-72 shrink-0 overflow-y-auto border-r border-border/70 bg-sidebar py-1">
          {commits.loading && !commits.data && (
            <p className="px-3 py-2 font-mono text-[12px] text-muted-foreground">loading…</p>
          )}
          {commits.data?.map((item) => (
            <button
              className={cn(
                'block w-full px-3 py-1.5 text-left hover:bg-accent/60',
                item.sha === sha && 'bg-accent',
              )}
              key={item.sha}
              onClick={() => setSelected(item.sha)}
              type="button"
            >
              <span className="block truncate text-[13px]">{item.subject}</span>
              <span className="block font-mono text-[11px] text-muted-foreground">
                {item.sha.slice(0, 7)} · {item.author} · {item.when}
              </span>
            </button>
          ))}
        </nav>
        <main className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
          {commit.data && <Detail {...commit.data} />}
        </main>
        <Dock>
          <Conversation variant="dock" />
        </Dock>
      </div>
      <StatusLine />
    </>
  )
}

export default defineWebExtension({
  surfaces: [
    {
      id: 'commits',
      title: 'Commits',
      icon: GitCommitHorizontalIcon,
      description: 'Recent commits; hand one to the agent',
      component: Commits,
    },
  ],
})
```

`README.md`:

```md
Browse the project's recent commits and hand one to the agent.
```

What it shows: `useAction` loads the list on mount and the detail whenever the selection changes (disabled until there
is one); the selection lives in `useExtensionUiState`, so it survives reloads; `api.submit(text, 'followUp')` sends a
message to the shown conversation, queued as a follow-up if the agent is busy, and the dock shows it arrive.

## Build an app, step by step

For a request such as "build a triage surface for this repo's GitHub issues":

1. **Place it.** One folder, `<project>/.ultimate/extensions/<name>/` (in Ultimate's own repository:
   `.ultimate/extensions/<name>/`). The surface id is `<name>`.
2. **Find the data first.** Run the commands in a shell (`gh issue list --limit 50 --json number,title,labels`), prefer
   JSON output and bounded results, and find out what happens when the tool is missing or logged out.
3. **Write `server.ts`**: `defineExtension({ name })` and `actions` that wrap those commands with `ctx.exec`, validate
   their args, and return small JSON shaped for the UI. Return setup states (missing tool, no login, no repository)
   as data, so the UI can say what to do.
4. **Check each action with codemode `ultimate.action`** (see [actions](actions.md)) before any UI exists.
5. **Write `web.tsx`** from the Commits example: a typed ref per action; keep `Header`, `Dock`
   with `Conversation variant="dock"`, and `StatusLine`; replace the list and the detail. Read with `useAction`, act with `api.action` then `refetch`, keep
   the selection and filters in `useExtensionUiState`, and hand work to the agent with `api.submit(text, 'followUp')`,
   saying exactly what to do with which item.
6. **Write `README.md`**, opening with one sentence; the Info panel shows it.
7. **Look at it.** Switch to it, take a screenshot, and go through every state: loading, empty, error, setup, many
   items, a long title; then the light theme (⌘K, "Theme:" cycles System → Light → Dark). Fix what looks off.
8. **Verify and commit**: `pnpm check` in the clone (it covers `.ultimate/extensions/`), then commit the folder with the
   project.

Keep in mind:

- Ids are global: surface ids, command ids, and dialog ids start with your extension name.
- Keep the agent on screen: a surface without a `Dock` holding `Conversation` makes the user switch away to talk.
- Reach your server only through actions: no `fetch` to your own endpoints, no secrets in the browser.
- One extension stays one folder. Prefer documents, commands, events, or the SDK to cross-extension imports; another
  extension's browser code comes only from its `ui.tsx` (see [contracts](contracts.md#the-browser-side-refsts-and-uitsx)).
  Lint enforces these declarations and forbids cycles.
- The Agent surface is an extension too: to change it for one project, copy `extensions/agent` to the project's
  `.ultimate/extensions/agent/`.
