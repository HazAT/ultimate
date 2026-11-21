/** @jsxImportSource @solidjs/web */
import type { JsonObject } from '@earendil-works/pi-durable'
import { Braces, ChevronRight } from '@lucide/solid'
import { createMemo, For, Show } from 'solid-js'
import { JsonTree } from '@/components/json-tree.solid.tsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import type { DocumentItem } from '@/sdk'
import { ContributedIcon, Contribution, ErrorCard } from '@/sdk/parts.solid.tsx'
import {
  documentItems,
  errorMessage,
  useConversationId,
  useConversationSummary,
  useDocKind,
  useExtensions,
  useExtensionUiState,
  useSystem,
} from '@/sdk/solid'

function Json(props: { value: Readonly<JsonObject>; kind: string }) {
  return (
    <Show
      when={Object.keys(props.value).length}
      fallback={<p class="px-3 font-mono text-[11.5px] text-muted-foreground/70">empty</p>}
    >
      <JsonTree class="px-2" name={props.kind} open={1} value={props.value} />
    </Show>
  )
}

function Document(props: {
  kind: string
  owner?: string
  renderer?: DocumentItem
  open: boolean
  setOpen: (open: boolean) => void
}) {
  const value = useDocKind(() => props.kind)
  const id = useConversationId()
  return (
    <Show when={value() && id()}>
      {(conversation) => (
        <Collapsible
          class="group/document border-t border-border/70 first:border-t-0"
          bind={[() => props.open, (open) => props.setOpen(open)]}
        >
          <CollapsibleTrigger
            aria-label={`Document ${props.kind}`}
            class="flex h-8 w-full min-w-0 items-center gap-1.5 px-3 text-left section-label hover:bg-accent/40"
            title={`${props.kind} · ${props.owner}`}
          >
            <ChevronRight class="size-3 shrink-0 text-muted-foreground/70 transition-transform group-data-open/document:rotate-90" />
            <Show when={props.renderer?.icon} fallback={<Braces class="size-3.5 shrink-0" />}>
              {(icon) => <ContributedIcon class="size-3.5 shrink-0" icon={icon()} />}
            </Show>
            <span class="min-w-0 truncate text-foreground/85">
              {props.renderer?.title ?? props.kind}
            </span>
            <span class="ml-auto shrink-0 pl-2 text-muted-foreground/60">
              {props.renderer ? props.kind : props.owner}
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent class="pb-2 [&_[data-extension-error]]:mx-3 [&_[data-extension-error]]:mb-2">
            <Show when={props.renderer} fallback={<Json kind={props.kind} value={value()!} />}>
              {(renderer) => (
                <Contribution
                  fallback={(extension, error) => (
                    <>
                      <ErrorCard error={errorMessage(error)} extension={extension} />
                      <Json kind={props.kind} value={value()!} />
                    </>
                  )}
                  fallbackOnly
                  item={renderer()}
                  props={{ conversationId: conversation(), value: value()! }}
                />
              )}
            </Show>
          </CollapsibleContent>
        </Collapsible>
      )}
    </Show>
  )
}

export function DocumentsPanel() {
  const system = useSystem()
  const extensions = useExtensions()
  const renderers = createMemo(() => documentItems(extensions()))
  const id = useConversationId()
  const shown = useConversationSummary(id)
  const [folds, setFolds] = useExtensionUiState<Record<string, boolean>>('open', {})
  const owners = createMemo(
    () =>
      new Map(
        (system()?.extensions ?? []).flatMap((extension) =>
          (extension.server?.docs ?? []).map((kind) => [kind, extension.name] as const),
        ),
      ),
  )
  const kinds = createMemo(() => {
    const views = renderers()
    return [...owners().keys()].toSorted(
      (a, b) => Number(views.has(b)) - Number(views.has(a)) || a.localeCompare(b),
    )
  })
  return (
    <div class="py-2">
      <div class="flex items-center gap-2 px-3 pb-2 section-label">
        Documents
        <Show when={id()}>
          {(conversation) => (
            <span class="ml-auto text-muted-foreground/70">
              {conversation() === 1 ? 'main' : (shown()?.label ?? 'conversation')} #{conversation()}
            </span>
          )}
        </Show>
      </div>
      <Show
        when={kinds().length > 0}
        fallback={
          system() && (
            <p class="px-3 pt-3 font-sans text-[12px] leading-relaxed text-muted-foreground/70">
              Documents are durable state that extensions keep with a conversation, such as the
              plan; they appear here when a server facet exports them as{' '}
              <code class="font-mono">docs</code>.
            </p>
          )
        }
      >
        <div class="border-y border-border/70">
          <For each={kinds()}>
            {(kind) => (
              <Document
                kind={kind}
                owner={owners().get(kind)}
                open={folds()[kind] ?? renderers().has(kind)}
                renderer={renderers().get(kind)}
                setOpen={(open) => setFolds((previous) => ({ ...previous, [kind]: open }))}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
