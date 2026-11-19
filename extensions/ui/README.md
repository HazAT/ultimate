The UI change log on the System surface: every change to stored UI state, who made it (a person, with their device, or an agent) and the value before and after. Optional; turning it off hides the tab, and the events are still recorded.

## How a change gets here

The server records it, in the commit that writes it (`ChangedEvent` in `shared/events.ts`, emitted by the core):

- a `/api/ui` post sets or deletes a key (every `useUiState`/`useExtensionUiState` write): one `ui.changed` per key whose stored value changed, except `shell.*` keys, the user's own navigation, which `ui.navigated` already covers;
- an action's own write, when the action records it with `ctx.uiChanged(tx, { key, value, previous })` (keep-warm's `set` records `keep-warm.on`).

Opening and closing a popover, hover and focus change nothing stored, so they are never recorded. Nothing in the browser observes or batches changes: a write and its event cannot be lost apart.

## Who

Each page request says who caused it, in headers the server reads with `sourceOf` (`server/request-security.ts`):

- `x-ultimate-source: agent` when a kit control's change handler ran for an agent's `act` (ui-sdk's `details.source === 'agent'`); the kit wraps its handlers in `writingAs(details.source, …)` from `@/sdk/solid`, and every write the handler starts synchronously carries it. Otherwise `person`.
- `x-ultimate-driven: 1` from a tab an agent drives (the browser tool marks it `ultimate.driven`), on every write.

The server adds the device (`deviceOf`). An agent's own server-side action call (`ultimate.action`) is `agent` without asking the page. The page's claim is an attribution label for the log, not a permission: any page could send either header, and nothing is allowed or refused because of it.

## Event

`ui.changed`: `{ key, value?, previous?, source, driven?, device, login?, address?, conversation? }`.

- `value` is absent for a deleted key, `previous` for a new one; values over 2048 UTF-8 bytes of JSON read `"[too large]"`.
- `source` is `agent` or `person`; `driven: true` when the page was an agent's, so a click in an agent's tab is still the agent's tab.
- `conversation` is the conversation an action was called for.

## In the UI

**UI changes**, a tab of the System surface (the `system.tab` point): the changes among the root's newest 100 events, newest first, one dense row each: time, who (`agent` in the brand colour, `agent tab` in a fainter brand colour for a person-like write in a driven page, or `person` with the device), the key, and previous → value. Hovering a row shows its source, device, login and conversation.
