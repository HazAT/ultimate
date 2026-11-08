# Events

Part of the [extension guide](../../extensions/README.md). The server has durable events; the browser has an
ephemeral bus and the readiness events.

## Durable events

For "this happened" that other extensions act on or people read later, use a durable event. Define its token once
with `defineEvent<Data>('<extension>.<event>', { version? })` from `shared/events.ts` in the emitter's `refs.ts`, so
the browser can use it too, and re-export it from `api.ts` (for server code) and `ui.tsx` (for other extensions'
browser code). The names an extension's `api.ts` and `refs.ts` define are listed in its `ExtensionInfo.events`, so a
wait on any other name fails at once. `{ fails: '<event>' }` marks an event that rules another one out
(`workspaces.landing-failed` fails `workspaces.landed`): a wait on that one ends with it. Then:

- `host.emit(tx, Event, data)` appends it inside your commit, so it exists exactly when your state change does.
- `host.react(name, [Event, …], (tx, event) => …)` runs the handler once per event, oldest first: those emitted before
  it started, then each new one, serially per name (`<extension>/<name>`). The cursor advances in the handler's
  transaction, so writes through `tx` happen exactly once across crashes, reloads and failures; side effects outside
  `tx` (files, processes, network) are at least once. A throw rolls back the handler and the cursor, records the
  failure, and retries the event on the next matching commit or harness open. Reactors run while the harness is open
  and stop with their facet; a reloaded facet registering the same name continues from the cursor. Pass
  `{ from: 'now' }` as a fourth argument when past events must not be handled: a reactor without a cursor then starts
  after the newest event instead of replaying the log.
- `host.eventLog.recent({ events?, since?, before?, order?, limit })` reads the newest first (oldest first with
  `order: 'ascending'`) as plain copies, `since` and `before` exclusive event ids; `host.eventLog.reactors()`
  shows each reactor's cursor, lag and last failure. In the browser, `useEvents({ events?, limit })` from `@/sdk` streams
  the root's feed of the latest 100 events.

Each distinct `host.notice` message of a facet is also recorded as an `ultimate.notice` event while storage is open.
Keep events few and small: they are history.

The events today: `lineage.branched` and `lineage.rooted` (lineage has conversations mark the intent title as
generated), `workspaces.landed` (lineage notes the submitter's tree root) and `models.login-changed` (health resets
the provider's record). Recorded for the history and
the system stream: `ultimate.started` (storage opened: generation, build), `subagents.started` (a subagent,
automation run, new standing agent or branch configured: agent, model, thinking, parent), `board.sent` (a message
posted: ids, `reply`, `steer`, never the text), `workspaces.check` (each lander check run: command, result, ms),
`conversations.compacted`, `health.changed` (a provider's state flipped), `cloud.backup` (started, done or failed),
`coding-tools.committed` (a commit made through bash: full sha, repo, worktree, branch). The last four follow state
outside the caller's commit (Pi's compaction, the machine's health file, an upload, a git repository), so each commits on
its own right after it. For debugging what the user did: `user.input` (a typed prompt, steer or follow-up, an
answer or dismissal, a review: its conversation, entry or message and length, never the text) and
`ui.navigated` (the surface or Agent's conversation changed, reported by the browser after a second and deduped),
each with the browser's `device` label and, through Tailscale Serve, the `login` and the client's tailnet `address`
(`100.64.0.0/10` or `fd7a:115c:a1e0::/48`, for example `100.64.0.2`; any other forwarded address is dropped). UI
action calls get the same `Device` as `ctx.device`. A `beforeInput` hook gets no device: it sees only the input entry
and runs for queued inputs too, so record the device from a UI action instead. A typed input and a review commit
right after Pi admits them, which has no hook for queued inputs; answers commit with their reply. Something the user must see
exactly once and that feeds the result the owner reports, like the lander waking a landed branch's starter, stays a
call, idempotent by request id; when it calls up the layering, it goes through an
[extension point](contracts.md#services-in-apits).
`onCommit(host.harness(), …)` (`lib/commits.ts`, over Pi Durable's `Session.observeCommits`) remains for watching Pi's
own records (entries, tasks, submissions, conversation records, usage and live documents), which are no domain events;
each such watcher says so in a comment above it. Do not invent an event only to replace one.

## Browser events

The browser
has an ephemeral `events` bus from `@/sdk`: it queues and replays nothing, catches and logs handler errors with the
channel while other handlers continue, and `on(channel, handler)` returns an unsubscribe; clean it up when its owner
is removed.

Name channels `<extension>:<event>`; `ultimate:*` is reserved for the core. Keep durable state in documents, not on the
bus. In a web component, use
`useEvent(channel, handler)` to subscribe for its mount and always call the latest handler:

```tsx
import { events, useEvent, useReady } from '@/sdk'

function Receiver() {
  useEvent('hello:selected', (data) => console.log(data))
  const { ready, timedOut, failed, pending } = useReady()
  return (
    <span>
      {ready ? 'Ready' : 'Loading'} {failed.join(', ')}
      {timedOut && `Still loading: ${pending.join(', ')}`}
    </span>
  )
}
// From another facet:
events.emit('hello:selected', { name: 'example' })
```

The registry emits `ultimate:extension-loaded { name }` or `ultimate:extension-failed { name, error }` as each
facet settles. `ultimate:ready { failed, pending, timedOut }` fires once per page load when
the current loader generation has settled (loaded or failed) and the first system snapshot has arrived, or after
an 8 s deadline from the first loader map. Superseded imports do not determine readiness. `useReady()` returns
`{ ready, timedOut, failed, pending }`, even for a subscriber mounted after the event. `ready` and `timedOut` stay
sticky for the page; `failed` names current load failures and `pending` names current unsettled imports.
The deadline reveals even without a system snapshot; `timedOut` distinguishes that reveal from normal readiness.
Facets import in parallel and their contributions render as soon as they install, except the app itself: the shell
shows the surface and starts its shortcuts only once ready. In particular, root overlays can render while another
facet is still loading; they need not wait for ready.
A reload of a rendered page (a core restart, a switch to a new web bundle, F5) paints the previous page's view from
`sessionStorage` before any module loads and fades it out once the app has rendered and settled
(`web/src/sdk/resume.ts`); `resumed` from `@/sdk` is true on such a load, so a loading overlay can stay away.
