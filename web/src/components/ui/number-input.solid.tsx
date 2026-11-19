/** @jsxImportSource @solidjs/web */
import { NumberInput as NumberInputRoot, NumberInputControl } from '@ui-sdk/solid/number-input'
import { cn } from 'cn'
import { omit } from 'solid-js'
import type { ComponentProps } from 'solid-js'
import { writingAs } from '@/sdk/solid'

type NumberInputProps = ComponentProps<typeof NumberInputRoot> & {
  class?: string
  'aria-label': string
}

function NumberInput(props: NumberInputProps) {
  const rest = omit(props, 'class', 'aria-label', 'onValueChange', 'onValueCommit')
  return (
    <NumberInputRoot
      {...rest}
      onValueChange={(value, details) => {
        const change = props.onValueChange
        writingAs(details.source, () => change?.(value, details))
      }}
      onValueCommit={(value, details) => {
        const commit = props.onValueCommit
        writingAs(details.source, () => commit?.(value, details))
      }}
    >
      <NumberInputControl
        aria-label={props['aria-label']}
        class={cn('rounded-sm border border-border bg-transparent px-1 tabular-nums', props.class)}
      />
    </NumberInputRoot>
  )
}

export { NumberInput }
