The UI change log: every change to a ui-sdk component (a switch turned off, a select set), who made it (a person, with their device, or an agent) and where. Optional; turning it off stops the log and nothing else.

## How a change gets here

Every page creates one agent bridge from `@ui-sdk/core/agent` at start (`uiAgent` from `@/sdk`, `web/src/sdk/agent.ts`). This extension's web facet (`Recorder` in `web.tsx`, batching in `recorder.ts`) subscribes to every change a component reports, from a person or an agent, notes the surface shown at that moment and the conversation of the control (the `ConversationScope` around it, such as a side chat's, or else the shown one), and sends them to `record` in batches of one location each: 500 ms after the first, on `pagehide`, and when the browser tool closes the page (`uiAgent.onFlush`); a flush waits for batches already on their way. Labels and names are cut to the server's limits (`limits.ts`) before they are queued, so one long name never loses a batch. Values inside `data-agent-secret` (and password, card and one-time-code fields) arrive as `"[redacted]"`; components inside `data-agent-hidden` report nothing. With this extension off, nothing records; the bridge and the browser tool's `ui` steps keep working.

A text field (an `input` or `textarea`, or any string a person types, `reason: 'input-change'`) never records its text: `value` is `"[text]"` (`"[redacted]"` for a secret field) and `previous` is left out. A person's typing is recorded once, when the field commits it (its `change` event: blur, or Enter in an input); an agent's `setValue` is recorded at once. There is no opt-in for recording text.

The same bridge is what the browser tool's `ui` steps drive: `{ ui: 'snapshot' }`, `{ ui: 'query', … }` and `{ ui: 'act', steps }` (see `extensions/browser/README.md`). A change made that way has `source: 'agent'`.

## Event

`ui.changed` (`ChangedEvent` in `refs.ts`): `{ component, label?, key, value, previous?, source, reason?, surface?, conversation?, driven?, device, login?, address? }`.

- `source` is `agent` for a change an agent made through the bridge, otherwise how a person made it (`mouse`, `keyboard`, `touch`, `pen`, `virtual`, `programmatic`).
- `driven: true` when the page was an agent's (the browser tool marks it `ultimate.driven`), so a click in an agent's tab is still the agent's tab.
- `device` (and `login`, `address` through Tailscale Serve) is the browser that reported it, as for `ui.navigated`.

## Action

- `record { changes, surface?, conversation?, driven? }` → `{ recorded }` (user-only): one `ui.changed` per change, all in one commit. At most 50 changes; `component`, `key`, `source` and `reason` up to 64 characters, `label` up to 200; `value` is required (`null` for none); a `value` or `previous` over 2048 UTF-8 bytes of JSON is recorded as `"[too large]"`. User-only so an agent's codemode cannot write history in a person's name; pages the browser tool drives are UI pages and call it over HTTP like any other.

## In the UI

**UI changes**, a tab of the System surface (the `system.tab` point): the changes among the root's newest 100 events, newest first, one dense row each: time, who (`agent` in the brand colour, `agent tab` in a fainter brand colour for a person-like click in a driven page, or `person` with the device), the control's label, the key, and previous → value. Hovering a row shows its source, reason, surface and conversation.
