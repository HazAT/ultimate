The UI change log on the System surface: every change to stored UI state, who made it (a person, with their device, or an agent) and the value before and after. Optional; turning it off hides the tab, and the events are still recorded.

## How a change gets here

The server records it, in the commit that writes it (`ChangedEvent` in `shared/events.ts`, emitted by the core):

- a `/api/ui` post sets or deletes a key (every `useUiState`/`useExtensionUiState` write): one `ui.changed` per key whose stored value changed, except `shell.*` keys, the user's own navigation, which `ui.navigated` already covers;
- an action's own write, when the action records it with `ctx.uiChanged(tx, { key, value, previous })` (keep-warm's `set` records `keep-warm.on`).

Opening and closing a popover, hover and focus change nothing stored, so they are never recorded. Nothing in the browser observes or batches changes: a write and its event cannot be lost apart.

## Who

Each page request says who caused it, in headers the server reads with `sourceOf` (`server/request-security.ts`):

- `x-ultimate-source: agent` when a kit control's change handler ran for an agent's `act` (ui-sdk's `details.source === 'agent'`); the kit wraps its handlers in `writingAs(details.source, …)` from `@/sdk/solid`, and every write the handler starts synchronously carries it. `app` inside `writingAs('app', …)`. Otherwise `person`, or `agent` on a page an agent opened (the browser tool marks it `ultimate.driven`).

The server adds the device (`deviceOf`). An agent's own server-side action call (`tools.action`) is `agent` without asking the page. The page's claim is an attribution label for the log, not a permission: any page could send any value, and nothing is allowed or refused because of it.

## Event

`ui.changed`: `{ key, value?, previous?, source, device, login?, address?, conversation? }`.

- `value` is absent for a deleted key, `previous` for a new one; only a boolean, a number or null is kept as it is, anything else (a draft, an answer, an object) reads `"[value]"`, so no text a person typed reaches the permanent event history.
- One decision, `uiChange` in `server/events.ts`, serves both paths: it skips `shell.*` keys, `app` writes and values that are structurally unchanged.
- `source` is `agent` or `person`. Every write from a page an agent opened (the browser tool marks it `ultimate.driven`) is the agent's, a scripted click included: only the agent acts there.
- The app's own bookkeeping writes (the sidebar marking a conversation seen) and text saved as it is typed (question card answers and notes, a review's overall note, the System filter) run inside `writingAs('app', …)`: they are stored, and record no `ui.changed`, like `shell.*` keys. What the person then decides (a pick, a send, a dismiss) is recorded as usual.
- `conversation` is the conversation an action was called for.

## In the UI

**UI changes**, a tab of the System surface (the `system.tab` point): the changes among the root's newest 100 events, newest first, one dense row each: time, who (`agent` in the brand colour, or `person` with the device), the key, and previous → value. Hovering a row shows its source, device, login and conversation.
