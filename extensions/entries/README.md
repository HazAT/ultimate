Entry kinds that core extensions on both sides of a dependency read. The extension that writes an entry and the one
that renders or routes it may not import each other (`pnpm deps` fails on a cycle), so the token lives here, below
both: `refs.ts` defines it with `defineEntry`, `api.ts` passes it on to server code and `ui.tsx` to browser code. Each
reader narrows with `Token.is(entry)` instead of casting `entry.data`.

Today: `lineage.note` (lineage writes it, workspaces renders landings), `board.message` and `board.reply` (messages
writes them, subagents reads them) and `automations.fired` (automations writes it, messages routes its answer), with
their data types (`NoteData`, `DeliveredMessage`, `Remote`, `Serves`, `AutomationInput`). The stored kind names stay
those of the extension that writes them. An entry moves here only when an import cycle blocks its reader; otherwise
it stays in its owner's `refs.ts`.

No facets, no service: a core-tier folder of contracts.
