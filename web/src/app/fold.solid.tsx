/** @jsxImportSource @solidjs/web */
import { ChevronRight } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { cn } from 'cn'
import { createMemo, createSignal, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
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
  const fold = useFold(
    () => props.card,
    () => !!props.always,
  )
  return (
    <Show fallback={props.children} when={fold.folds() && !props.keep}>
      <div class="min-w-0" data-fold={fold.open() ? 'open' : 'closed'}>
        <Button
          aria-expanded={fold.open() ? 'true' : 'false'}
          aria-label={props.label}
          class="flex h-auto w-fit max-w-full min-w-0 justify-start gap-1.5 overflow-hidden rounded-none p-0 font-mono text-[11px] font-normal whitespace-nowrap text-muted-foreground/70 hover:text-muted-foreground"
          onClick={() => fold.setOpen(!fold.open())}
          size={null}
          variant={null}
        >
          {props.summary}
          <ChevronRight
            class={cn('size-3 shrink-0 transition-transform', fold.open() && 'rotate-90')}
          />
        </Button>
        <Show when={fold.open()}>
          <div class="mt-3">{props.children}</div>
        </Show>
      </div>
    </Show>
  )
}
