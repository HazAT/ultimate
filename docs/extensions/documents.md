# Documents

Part of the [extension guide](../../extensions/README.md).

Extension documents are durable state on a conversation: a ledger, a store, login flows. The Documents tab
(the `documents` extension) lists every kind the server facets export for the shown conversation and shows each through
the renderer a web facet registers for it, or as a JSON tree without one. To give yours a view:

1. Export the document from `server.ts`: `export const docs = [Plan]`, conversation-scoped tokens from `defineDoc`.
   The Info panel then lists the kind under the extension.
2. Register a renderer in `web.tsx`. It receives the live `value` and the shown `conversationId`; cast the value to
   your document's shape.

```tsx
import { ClipboardListIcon } from 'lucide-react'
import { defineWebExtension } from '@/sdk'
import type { DocumentProps } from '@/sdk'

function PlanDocument({ value }: DocumentProps) {
  const plan = value as unknown as { epics: Record<string, { title: string }> }
  return Object.values(plan.epics).map((epic) => <p key={epic.title}>{epic.title}</p>)
}

export default defineWebExtension({
  documents: [
    { kind: 'ultimate.plan', title: 'Plan', icon: ClipboardListIcon, component: PlanDocument },
  ],
})
```

A later facet in discovery order wins a kind. A renderer that throws shows an error card with the JSON tree below it;
the other documents keep working. To render another extension's component yourself, wrap it in `ExtensionBoundary`
from `@/sdk`, as the Documents tab does, and look renderers up with `useDocumentRenderers()`. Opening the tab streams
every exported kind, which creates a missing document with its initial value, as `useDoc` does.

## The stream underneath

Extensions read documents through the SDK (`useDoc`, `useDocOf`; see [contracts](contracts.md)), never the stream
itself. Their `doc` snapshots and `docOps` batches come from `/api/events`. A browser tab keeps one such stream; its
first event, `stream`, carries the id with which `POST /api/events/<stream>/<sub>` (`{ conversation?, docs?, view? }`)
subscribes to a conversation and `DELETE` ends that (`ServerEvents` in `shared/protocol.ts`). A subscription's
`view`, `ops`, `doc` and `docOps` events carry its id on their first data line, so their `data` reads `<sub>\n{…}`:
parse what follows the first newline.
