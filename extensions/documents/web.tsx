import { BracesIcon, ChevronRightIcon, FileStackIcon } from 'lucide-react'
import { JsonTree } from '@/components/json-tree'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  ExtensionBoundary,
  defineWebExtension,
  useConversations,
  useDocKind,
  useDocumentRenderers,
  useExtensionUiState,
  useSystem,
  useUltimate,
} from '@/sdk'
import type { DocumentItem } from '@/sdk'

/** The value as a JSON tree, the view of every kind without a renderer. */
function Json({ value }: { value: object }) {
  if (Object.keys(value).length === 0)
    return <p className="px-3 font-mono text-[0.7188rem] text-muted-foreground">empty</p>
  return <JsonTree className="px-2" open={1} value={value} />
}

/**
 * One document of the shown conversation: a header naming it, then its renderer, which a throw turns into an error
 * card above the JSON tree, or the JSON tree alone. Nothing until the stream delivers a value.
 */
function Document({
  kind,
  owner,
  renderer,
  open,
  setOpen,
}: {
  kind: string
  owner: string
  renderer?: DocumentItem
  open: boolean
  setOpen: (open: boolean) => void
}) {
  const value = useDocKind(kind)
  const { conversationId } = useUltimate()
  if (!value || conversationId === undefined) return null
  const Icon = renderer?.icon ?? BracesIcon
  const Renderer = renderer?.component
  return (
    <Collapsible
      className="group/document border-t border-border/70 first:border-t-0"
      onOpenChange={setOpen}
      open={open}
    >
      <CollapsibleTrigger
        className="flex h-8 w-full min-w-0 items-center gap-1.5 px-3 text-left section-label hover:bg-accent/40"
        title={`${kind} · ${owner}`}
      >
        <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/document:rotate-90" />
        <Icon className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate text-foreground/85">{renderer?.title ?? kind}</span>
        <span className="ml-auto shrink-0 pl-2 text-muted-foreground">
          {renderer ? kind : owner}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pb-2 [&>[data-extension-error]]:mx-3 [&>[data-extension-error]]:mb-2">
        {Renderer ? (
          <ExtensionBoundary
            extension={renderer.extension}
            fallback={<Json value={value} />}
            key={renderer.extension}
            version={renderer.version}
          >
            <Renderer conversationId={conversationId} value={value} />
          </ExtensionBoundary>
        ) : (
          <Json value={value} />
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * Every kind the server facets export (`docs`), for the shown conversation: kinds with a renderer first and open, the
 * rest as JSON and folded. Folding is durable per kind.
 */
function DocumentsPanel() {
  const system = useSystem()
  const renderers = useDocumentRenderers()
  const { conversationId } = useUltimate()
  const conversations = useConversations()
  const [folds, setFolds] = useExtensionUiState<Record<string, boolean>>('open', {})
  const kinds = (system?.extensions ?? [])
    .flatMap((extension) =>
      (extension.server?.docs ?? []).map((kind) => ({ kind, owner: extension.name })),
    )
    .toSorted(
      (a, b) =>
        Number(renderers.has(b.kind)) - Number(renderers.has(a.kind)) ||
        a.kind.localeCompare(b.kind),
    )
  const shown = conversations.find((conversation) => conversation.id === conversationId)
  return (
    <div className="py-2">
      <div className="flex items-center gap-2 px-3 pb-2 section-label">
        Documents
        {conversationId !== undefined && (
          <span className="ml-auto text-muted-foreground">
            {conversationId === 1 ? 'main' : (shown?.label ?? 'conversation')} #{conversationId}
          </span>
        )}
      </div>
      {kinds.length > 0 && (
        <div className="border-y border-border/70">
          {kinds.map(({ kind, owner }) => (
            <Document
              key={kind}
              kind={kind}
              open={folds[kind] ?? renderers.has(kind)}
              owner={owner}
              renderer={renderers.get(kind)}
              setOpen={(open) => setFolds((previous) => ({ ...previous, [kind]: open }))}
            />
          ))}
        </div>
      )}
      {system && kinds.length === 0 && (
        <p className="px-3 pt-3 font-sans text-[0.75rem] leading-relaxed text-muted-foreground">
          Documents are durable state that extensions keep with a conversation, such as the plan;
          they appear here when a server facet exports them as{' '}
          <code className="font-mono">docs</code>.
        </p>
      )}
    </div>
  )
}

export default defineWebExtension({
  panels: [
    {
      id: 'documents',
      title: 'Documents',
      icon: FileStackIcon,
      component: DocumentsPanel,
      order: 4,
    },
  ],
  commands: [
    {
      id: 'documents.open',
      title: "Show the conversation's documents",
      run: (context) => context.openPanel('documents'),
    },
  ],
})
