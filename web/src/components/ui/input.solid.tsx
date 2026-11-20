/** @jsxImportSource @solidjs/web */
import { Eye, EyeOff } from '@lucide/solid'
import { Input as InputRoot } from '@ui-sdk/solid/input'
import {
  PasswordInput,
  PasswordInputControl,
  PasswordInputToggle,
} from '@ui-sdk/solid/password-input'
import { cn } from 'cn'
import { omit } from 'solid-js'
import type { ComponentProps } from 'solid-js'
import { writingAs } from '@/sdk/solid'

const field =
  'h-7 w-full min-w-0 rounded-md border border-input bg-background px-2 font-mono text-[12px] outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 aria-invalid:border-error data-disabled:opacity-60'

type InputProps = ComponentProps<typeof InputRoot> & { class?: string }

function Input(props: InputProps) {
  const rest = omit(props, 'class', 'onValueChange')
  return (
    <InputRoot
      autocomplete="off"
      spellcheck={false}
      {...rest}
      class={cn(field, props.class)}
      onValueChange={(value, details) => {
        const change = props.onValueChange
        writingAs(details.source, () => change?.(value, details))
      }}
    />
  )
}

type SecretInputProps = Omit<ComponentProps<typeof PasswordInput>, 'children'> & {
  'aria-label': string
  placeholder?: string
  class?: string
  ref?: (element: HTMLInputElement) => void
  onKeyDown?: (event: KeyboardEvent) => void
}

function SecretInput(props: SecretInputProps) {
  const rest = omit(
    props,
    'aria-label',
    'placeholder',
    'class',
    'ref',
    'onKeyDown',
    'onValueChange',
  )
  return (
    <PasswordInput
      autoComplete="one-time-code"
      {...rest}
      onValueChange={(value, details) => {
        const change = props.onValueChange
        writingAs(details.source, () => change?.(value, details))
      }}
    >
      <span class={cn('flex min-w-0 flex-1 items-center gap-1', props.class)}>
        <PasswordInputControl
          aria-label={props['aria-label']}
          class={field}
          data-1p-ignore
          data-bwignore
          data-lpignore="true"
          onKeyDown={props.onKeyDown}
          placeholder={props.placeholder}
          ref={props.ref}
          spellcheck={false}
        />
        <PasswordInputToggle
          aria-label={`Show ${props['aria-label']}`}
          class="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {(state) => (state.visible ? <EyeOff class="size-3.5" /> : <Eye class="size-3.5" />)}
        </PasswordInputToggle>
      </span>
    </PasswordInput>
  )
}

export { Input, SecretInput }
