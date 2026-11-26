# Actions

Part of the [extension guide](../../extensions/README.md).

A web facet runs in the browser; its server facet runs in Ultimate's Node process, next to the project's files, its
command-line tools, and the network. Actions connect the two: `server.ts` exports `actions`, plain async functions, and
the UI calls them through a typed ref, JSON in and JSON out.

```ts
// server.ts
import type { JsonValue } from '@earendil-works/chord/json'
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
// web.solid.tsx
import { actionRef, useAction } from '@/sdk/solid'

/** No arguments → every `TODO` line as `file:line:text`. */
const ListAction = actionRef<null, string[]>('todos', 'list')

function TodoCount() {
  const todos = useAction(ListAction)
  return <span>{todos.loading() ? 'Loading…' : (todos.data()?.length ?? 0)}</span>
}
```

An action is `(args, ctx)`; `ctx` has:

| Field                                       | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exec(command, args, { cwd?, timeout? })`   | Runs a program without a shell, in the conversation's freshly admitted workspace/cwd when `conversationId` is supplied, otherwise the project root; explicit `cwd` overrides it. Each conversation-aware execution fails closed on workspace preparation/discard/lifecycle state and reserves execution until exit. Read-only or lifecycle actions that do not call `exec` remain callable. Resolves `{ stdout, stderr }`; rejects on a non-zero exit, after `timeout` (default and maximum 30 s), or past 1 MiB of output. |
| `signal`                                    | Aborted when the UI stops waiting (a newer call, an unmount, a closed tab); `exec` honours it. Pass it on to your own `fetch`.                                                                                                                                                                                                                                                                                                                                                                                              |
| `conversationId`                            | The conversation the UI showed when it called.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `by`                                        | UI attribution, including `source` (`person`, `agent` or `app`) and any device label. In-process agent calls always have source `agent`.                                                                                                                                                                                                                                                                                                                                                                                    |
| `uiChanged(tx, { key, value?, previous? })` | For an action that changes stored state a control shows (a switch, a choice): records a `ui.changed` event in the commit `tx` that makes the write, as keep-warm's `set` does, by who made the call (an agent's call on the server is `agent`; a page's call carries its claimed `source` and device, a label and not a permission). Records nothing for an unchanged value or an `app` write; values other than a boolean, a number or null read `"[value]"`.                                                              |
| `host`                                      | The extension host: `projectRoot`, `ultimateRoot`, `system()`, `uiState(context)`, `harness()`, and more (see `AGENTS.md`).                                                                                                                                                                                                                                                                                                                                                                                                 |

The `ActionContext` import is type-only. The path above is right for `.ultimate/extensions/<name>/` in Ultimate's clone
(built-ins use `../../server/actions.ts`); in another project the path does not resolve and the import is erased, so it
runs either way (`scripts/check-extension.ts` reports it there; type `ctx` by hand or leave the import out). A project extension can keep its refs in `web.solid.tsx`, from `@/sdk/solid`; built-ins keep them in `refs.ts` and
check their handlers against them with `implementAction` (see [contracts](contracts.md#the-browser-side-refsts-and-uisolidtsx)).

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

- `useAction(ref, args?, { conversation?, onError?, on?, every?, focus? })` reads. It subscribes over the page's one
  stream: the server runs the read once for every tab and device reading the same action, args (compared as JSON)
  and conversation, again `every` ms after its last answer while anyone reads it, and pushes an answer only when it
  changed; a reconnect or restart brings the values back. `on()` changing (a document, an event id, a busy flag),
  window focus with `focus`, and `refetch()` ask again at once, and that answer reaches every reader; asked while a
  request runs, it lets that request finish, and every refetch asked meanwhile shares one request after it. It follows the
  scoped or shown conversation unless `conversation` is set. A remount shows the last answer at once. Never poll with
  a timer of your own that calls `api.action` or `refetch`: lint rejects it (`no-raw-stream`), since it runs once per
  page instead of once for all. It returns `{ data, error, loading, refetch }`: the first three are accessors, and
  `data()` stays while a refetch runs. A failure shows as a notice unless a reader passes `onError`. Pass an accessor
  as `on` rather than refetching from an effect. Mount the reader only when its arguments are ready; for changing
  object arguments, use getters or remount the reader on the new input (see the [Commits example](example-app.md)).
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

Agents call actions in codemode with `await tools.action({extension: 'todos', action: 'list', args})`, returning the result directly
or throwing the action's error. Calls run in-process on behalf of the calling conversation, with the sandbox abort
signal; omitted args become null. `ultimate.extensions()` lists actions; document their args in your README.

A server facet may export `userActions: string[]` alongside `actions` to reserve named actions for the UI.
Every name must refer to a registered action; invalid declarations fail facet installation. Use this for choices
only the user should make, such as granting project trust, managing secrets, or logging in to providers:

```ts
export const userActions = ['decide']
```

Codemode rejects these calls with `<extension>/<action> is a user-only action`; the HTTP path still calls them.
`userActions` restrict codemode and tools, not pages: a page an agent drives with the browser tool may press the
control that calls one, by design. To have the UI ask a person, mark that control `data-agent-confirm="what it does"`:
the browser tool's step on it fails with "Needs a person" (`skills/solid-ui/SKILL.md`).

Likewise `pollActions: string[]` names read-only actions a surface polls with changing arguments (cursors, windows):
the call trace counts their successful calls in `host.trace.polls()` instead of writing them, with the plain action
and service calls they make; a failure, a model call or a tool call under one is written with the chain above it.
This is an explicit opt-out from agent action dispatch, not a security sandbox against arbitrary agent code.

The HTTP endpoint remains browser-only: requests require `Sec-Fetch-Site: same-origin` or a loopback `Origin`
matching the server's port. A plain agent `curl` receives 403; use `tools.action` instead of forging browser headers.
