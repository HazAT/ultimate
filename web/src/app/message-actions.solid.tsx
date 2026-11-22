import type { EntryRecord } from '@earendil-works/pi-durable'
import { Check, Copy, Link } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { cn } from 'cn'
import { Button } from '@/components/ui/button.solid.tsx'
import { createMemo, For, Show } from 'solid-js'
import { formatTime, MessageReference, messageItems, useCopy, useExtensions } from '../sdk/hooks.ts'
import { Contribution, useProvided } from '../sdk/contribution.solid.tsx'
import { ContributionError } from './contribution-error.solid.tsx'

export function MessageActions(props: {
  entry: EntryRecord
  text: string
  timestamp: number
  class?: string
  bubble?: boolean
  name?: string
}) {
  const extensions = useExtensions()
  const details = createMemo(() => messageItems(extensions(), 'messageDetails'))
  const actions = createMemo(() => messageItems(extensions(), 'messageActions'))
  const reference = useProvided(MessageReference, () => ({
    conversation: props.entry.conversationId,
    id: props.entry.id,
  }))
  const date = () => new Date(props.timestamp)
  const failed = (extension: string, error: unknown) => (
    <ContributionError error={error} extension={extension} inline />
  )
  return (
    <div
      class={cn(
        'flex flex-wrap items-center gap-2 font-mono text-[11px] text-muted-foreground/60 opacity-0 transition-opacity focus-within:opacity-100 pointer-coarse:opacity-100',
        props.bubble ? 'group-hover/bubble:opacity-100' : 'group-hover/message:opacity-100',
        props.class,
      )}
      data-message-actions={props.entry.id}
    >
      <For each={details()} keyed={(item) => item.key}>
        {(item) => <Contribution fallback={failed} item={item()} props={{ entry: props.entry }} />}
      </For>
      <time class="tabular-nums" datetime={date().toISOString()} title={date().toLocaleString()}>
        {formatTime(date())}
      </time>
      <Show when={props.text}>
        <CopyButton label={`Copy ${props.name ?? `message #${props.entry.id}`}`} value={props.text}>
          <Copy />
        </CopyButton>
      </Show>
      <For each={actions()} keyed={(item) => item.key}>
        {(item) => (
          <Contribution
            fallback={failed}
            item={item()}
            props={{ entry: props.entry, text: props.text }}
          />
        )}
      </For>
      <Show when={reference()}>
        {(value) => (
          <CopyButton
            label={`Copy reference to ${props.name ?? `message #${props.entry.id}`}`}
            value={value()}
          >
            <Link />
          </CopyButton>
        )}
      </Show>
    </div>
  )
}

function CopyButton(props: { value: string; label: string; children: JSX.Element }) {
  const { copied, copy } = useCopy()
  return (
    <Button
      aria-label={props.label}
      class="h-auto rounded p-0.5 font-normal hover:text-foreground [&_svg]:size-3"
      onClick={() => copy(props.value)}
      size={null}
      title={props.label}
      variant={null}
    >
      <Show when={copied()} fallback={props.children}>
        <Check class="text-success" />
      </Show>
    </Button>
  )
}
