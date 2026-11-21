/** @jsxImportSource @solidjs/web */
import { Check, Copy } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { Show } from 'solid-js'
import { useCopy } from '../../sdk/hooks.ts'
import { Button } from './button.solid.tsx'

function CopyValue(props: { value: string; field: string; children?: JSX.Element }) {
  const { copied, copy } = useCopy()
  return (
    <Button
      aria-label={`Copy ${props.field}: ${props.value}`}
      class="group/copy flex min-w-0 max-w-full shrink items-center justify-start gap-1 rounded-sm text-left font-[inherit] text-[length:inherit] leading-[inherit] font-normal hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
      onClick={() => copy(props.value)}
      size={null}
      title={`${props.value}\nclick to copy`}
      variant={null}
    >
      <span class="truncate">{props.children ?? props.value}</span>
      <Show
        when={copied()}
        fallback={
          <Copy class="size-3 shrink-0 opacity-0 transition-opacity group-hover/copy:opacity-50 group-focus-visible/copy:opacity-50" />
        }
      >
        <Check class="size-3 shrink-0 text-success" />
      </Show>
    </Button>
  )
}

export { CopyValue }
