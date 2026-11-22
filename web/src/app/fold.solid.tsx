import { ChevronRight } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { createMemo, createSignal, createUniqueId, Show } from 'solid-js'
import { Collapsible, CollapsibleTrigger } from '@/components/ui/collapsible.solid.tsx'
import { useCompact, useConversationId } from '../sdk/hooks.ts'
import { foldKey, readFold, writeFold } from './fold-state.ts'

export function useFold(card: () => string | number, always: () => boolean = () => false) {
  const compact = useCompact()
  const id = useConversationId()
  const folds = () => always() || !!compact()
  const key = createMemo(() => foldKey(id(), card()))
  const [opened, setOpened] = createSignal<{ key: string; open: boolean }>()
  const open = () => {
    const stored = opened()
    return !folds() || (stored?.key === key() ? stored.open : readFold(key()))
  }
  return {
    folds,
    open,
    setOpen: (next: boolean) => {
      writeFold(key(), next)
      setOpened({ key: key(), open: next })
    },
  }
}

export function Fold(props: {
  card: string | number
  summary: JSX.Element
  label: string
  keep?: boolean
  always?: boolean
  children: JSX.Element
}) {
  const body = createUniqueId()
  const fold = useFold(
    () => props.card,
    () => !!props.always,
  )
  return (
    <Show fallback={props.children} when={fold.folds() && !props.keep}>
      <Collapsible
        bind={[fold.open, fold.setOpen]}
        class="min-w-0"
        data-fold={fold.open() ? 'open' : 'closed'}
      >
        <CollapsibleTrigger
          aria-controls={fold.open() ? body : undefined}
          aria-label={props.label}
          class="group/fold flex h-auto w-fit max-w-full min-w-0 shrink-0 items-center justify-start gap-1.5 overflow-hidden rounded-none p-0 font-mono text-[11px] font-normal whitespace-nowrap text-muted-foreground/70 transition-colors outline-none hover:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {props.summary}
          <ChevronRight class="size-3 shrink-0 transition-transform group-data-open/fold:rotate-90" />
        </CollapsibleTrigger>
        <Show when={fold.open()}>
          <div class="mt-3" id={body}>
            {props.children}
          </div>
        </Show>
      </Collapsible>
    </Show>
  )
}
