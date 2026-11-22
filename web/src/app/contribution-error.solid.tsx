import { TriangleAlert } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { cn } from 'cn'
import { errorMessage } from '../sdk/hooks.ts'

export function ContributionError(props: {
  extension: string
  error: unknown
  inline?: boolean
  children?: JSX.Element
}) {
  return (
    <>
      <div
        class={cn(
          'flex items-start gap-2 font-mono text-[12px] text-error',
          props.inline
            ? 'inline-flex max-w-72 items-center gap-1 rounded-sm bg-error/12 px-1.5 text-[11px]'
            : 'rounded-md border border-error/30 bg-error/8 px-2.5 py-2',
        )}
        data-extension-error={props.extension}
        title={errorMessage(props.error)}
      >
        <TriangleAlert aria-hidden="true" class="mt-0.5 size-3.5 shrink-0" />
        <span class={cn('min-w-0', props.inline && 'truncate')}>
          extension <span class="font-semibold">{props.extension}</span> failed:{' '}
          {errorMessage(props.error)}
        </span>
      </div>
      {props.children}
    </>
  )
}
