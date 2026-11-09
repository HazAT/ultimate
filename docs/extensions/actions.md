# Actions

Part of the [extension guide](../../extensions/README.md).

A web facet runs in the browser; its server facet runs in Ultimate's Node process, next to the project's files, its
command-line tools, and the network. Actions connect the two: `server.ts` exports `actions`, plain async functions, and
the UI calls them through a typed ref, JSON in and JSON out.

```ts
// server.ts
import type { JsonValue } from '@earendil-works/chord'
import { defineExtension } from '@earendil-works/pi-durable'
import type { ActionContext } from '../../../server/actions.ts'

export default defineExtension({ name: 'todos' })

export const actions = {
  async list(_args: JsonValue, ctx: ActionContext) {
    const { stdout } = await ctx.exec('git', ['grep', '-n', 'TODO'])
    return stdout.split('\n').filter(Boolean)
  },
}
```

```tsx
// web.tsx
import { actionRef, useAction } from '@/sdk'

/** No arguments → every `TODO` line as `file:line:text`. */
const ListAction = actionRef<null, string[]>('todos', 'list')

const todos = useAction(ListAction)
// todos.data, todos.error, todos.loading, todos.refetch()
```

An action is `(args, ctx)`; `ctx` has:

| Field                                     | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exec(command, args, { cwd?, timeout? })` | Runs a program without a shell, in the conversation's freshly admitted workspace/cwd when `conversationId` is supplied, otherwise the project root; explicit `cwd` overrides it. Each conversation-aware execution fails closed on workspace preparation/discard/lifecycle state and reserves execution until exit. Read-only or lifecycle actions that do not call `exec` remain callable. Resolves `{ stdout, stderr }`; rejects on a non-zero exit, after `timeout` (default and maximum 30 s), or past 1 MiB of output. |
| `signal`                                  | Aborted when the UI stops waiting (a newer call, an unmount, a closed tab); `exec` honours it. Pass it on to your own `fetch`.                                                                                                                                                                                                                                                                                                                                                                                              |
| `conversationId`                          | The conversation the UI showed when it called.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `host`                                    | The extension host: `projectRoot`, `ultimateRoot`, `system()`, `uiState(context)`, `harness()`, and more (see `AGENTS.md`).                                                                                                                                                                                                                                                                                                                                                                                                 |

The `ActionContext` import is type-only. The path above is right for `.ultimate/extensions/<name>/` in Ultimate's clone
(built-ins use `../../server/actions.ts`); in another project nothing type-checks it and the import is erased, so it
runs either way. A project extension keeps its refs in `web.tsx`, from `@/sdk`; built-ins keep them in `refs.ts` and
check their handlers against them with `implementAction` (see [contracts](contracts.md#the-browser-side-refsts-and-uitsx)).

- **Arguments are untrusted, from the browser or an agent**: make actions safe to call from an agent and validate args before they reach a command line. `exec` takes an argument list,
  never a shell string, so quoting is never the problem; meaning is.
- **Return small JSON shaped for the UI**, not raw command output. Ask CLIs for JSON (`gh … --json`) and limit how much
  they return.
- **Throw clear messages; return states as data.** A thrown error's message, up to 500 characters, reaches the UI as
  `error.message` and in the notice (`todos/list: <message>`, HTTP 500); the whole error goes to the server log. Throw
  for faults, with a message that says what went wrong. Return states the user should see and act on as data instead,
  such as `{ status: 'setup', reason: 'gh is not installed' }`, and render them as a screen of their own.
- **Live**: saving `server.ts` reinstalls it and the next call runs the new code. No restart.
- **Quick**: an action holds a request open, and `exec` stops at 30 s. Hand long work to the agent (`api.submit`).

Call actions from the UI in one of two ways:

- `useAction(ref, args?, { enabled?, onError?, on?, every?, focus? })` reads. It calls on mount and again whenever
  the action or `args` (compared as JSON) change, when `on` changes (a document, an event id, a busy flag: anything
  that means the answer may be stale), every `every` ms, on window focus with `focus`, and after the server restarts;
  never while `enabled` is false. Every component reading the same action and args shares one call and one result,
  so a remount shows the last answer at once while it asks again. It returns `{ data, error, loading, refetch }`:
  `data` stays while a refetch runs; `refetch()` calls again, also when not `enabled`. A failure shows as a notice
  unless a reader passes `onError`. Pass the signal as `on` rather than calling `refetch()` from an effect.
- `api.action(ref, args?, { conversationId?, signal?, keepalive? })` acts, once: a click that saves,
  closes, or labels something; `keepalive` lets a call sent on `pagehide` outlive the page. It returns a promise of
  the result; afterwards, `refetch()` what changed. A rejection (an `ActionError` with `extension`, `action`,
  `status`, `message`) that nothing catches shows as a notice; catch it to handle it yourself.

```tsx
<Button
  onClick={async () => {
    await api.action(ResolveAction, { line })
    await todos.refetch()
  }}
>
  Resolve
</Button>
```

Agents call actions in codemode with `await ultimate.action('todos', 'list', args)`, returning the result directly
or throwing the action's error. Calls run in-process on behalf of the calling conversation, with the sandbox abort
signal; omitted args become null. `ultimate.extensions()` lists actions; document their args in your README.

A server facet may export `userActions: string[]` alongside `actions` to reserve named actions for the UI.
Every name must refer to a registered action; invalid declarations fail facet installation. Use this for choices
only the user should make, such as granting project trust, managing secrets, or logging in to providers:

```ts
export const userActions = ['decide']
```

Codemode rejects these calls with `<extension>/<action> is a user-only action`; the HTTP path still calls them.

Likewise `pollActions: string[]` names read-only actions a surface polls with changing arguments (cursors, windows):
the call trace counts their successful calls in `host.trace.polls()` instead of writing them, with the plain action
and service calls they make; a failure, a model call or a tool call under one is written with the chain above it.
This is an explicit opt-out from agent action dispatch, not a security sandbox against arbitrary agent code.

The HTTP endpoint remains browser-only: requests require `Sec-Fetch-Site: same-origin` or a loopback `Origin`
matching the server's port. A plain agent `curl` receives 403; use `ultimate.action` instead of forging browser headers.
