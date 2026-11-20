/** @jsxImportSource @solidjs/web */
import type { ConversationId } from '@earendil-works/pi-durable'
import { Pause, Play } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { Show, createMemo } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Card } from '@/sdk/parts.solid.tsx'
import { ROOT, cn, switchConversation, useDocOf, useNow } from '@/sdk/solid'
import type { EntryRecord } from '@/sdk'
import { ConversationRef } from '../conversations/ui.solid.tsx'
import { lasted, unwrappedProviderError } from './lasted.ts'
import { PauseDoc } from './refs.ts'
import type { AutoPlayed, HeldNote, PauseNote, RateLimit } from './refs.ts'
import { playConfirmation, playPausedWork } from './status.solid.tsx'

function Divider(props: { kind: 'note' | 'held' | 'autoplayed'; children: JSX.Element }) {
  return (
    <div
      class="flex items-center gap-3 font-mono text-[11px] text-muted-foreground/80 before:h-px before:flex-1 before:bg-warning/25 after:h-px after:flex-1 after:bg-warning/25"
      data-pause-autoplayed={props.kind === 'autoplayed' || undefined}
      data-pause-held={props.kind === 'held' || undefined}
      data-pause-note={props.kind === 'note' || undefined}
    >
      <span class="flex min-w-0 items-center gap-1.5">
        {props.kind === 'held' ? (
          <Pause class="size-3 shrink-0 text-warning" />
        ) : (
          <Play class="size-3 shrink-0 text-warning" />
        )}
        {props.children}
      </span>
    </div>
  )
}

function OpenConversation(props: { id: ConversationId; label: string; truncate?: boolean }) {
  return (
    <Button
      aria-label={props.label}
      class={cn(
        'min-w-0 font-[inherit] text-foreground hover:underline',
        props.truncate && 'truncate',
      )}
      onClick={() => switchConversation(props.id)}
      size={null}
      variant={null}
    >
      <ConversationRef id={props.id} />
    </Button>
  )
}

export function Note(props: { entry: EntryRecord }) {
  const note = () => (props.entry.data ?? {}) as Partial<PauseNote>
  return (
    <Show when={note().since !== undefined && note().until !== undefined}>
      <Divider kind="note">
        <span class="text-warning">Paused for {lasted(note().until! - note().since!)}</span>
        <span class="truncate">
          ·{' '}
          {note().finished
            ? 'after its last answer'
            : note().auto
              ? 'played by itself'
              : 'continued after Play'}
        </span>
      </Divider>
    </Show>
  )
}

export function Held(props: { entry: EntryRecord }) {
  const data = () => (props.entry.data ?? {}) as Partial<HeldNote>
  return (
    <Show when={data().child !== undefined && data().provider !== undefined}>
      <Divider kind="held">
        <OpenConversation
          id={data().child!}
          label={`Open held run for entry #${props.entry.id}`}
          truncate
        />
        <span class="truncate">
          hit {data().provider}’s rate limit ·{' '}
          <span class="text-warning">Ultimate paused until Play</span>
        </span>
      </Divider>
    </Show>
  )
}

export function Limit(props: { entry: EntryRecord }) {
  const limit = () => (props.entry.data ?? {}) as Partial<RateLimit>
  const doc = useDocOf(() => ROOT, PauseDoc)
  const holding = createMemo(() => doc()?.paused === true && doc()?.limit?.at === limit().at)
  const now = useNow(1000, holding)
  const autoPlay = () => (holding() && !doc()?.manual ? doc()?.autoPlay : undefined)
  return (
    <Show when={limit().error !== undefined && limit().conversationId !== undefined}>
      <Card attention={holding()} class="border-l-warning/60" data-pause-limit>
        <header class="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
          <Pause class="size-3.5 text-warning" />
          <span class="text-foreground">{limit().provider}</span>
          <span>rate limited · Ultimate paused</span>
          <span class="ml-auto truncate">{limit().model}</span>
        </header>
        <div class="space-y-2 px-3 py-3 text-[13px] leading-relaxed">
          <p class="whitespace-pre-wrap text-warning" title={limit().error}>
            {unwrappedProviderError(limit().error!)}
          </p>
          <p class="flex flex-wrap items-center gap-1 font-mono text-[11px] text-muted-foreground">
            first hit in
            <OpenConversation
              id={limit().conversationId!}
              label={`Open rate-limited run for entry #${props.entry.id}`}
            />
            · no reset time given
          </p>
          <p class="text-[12px] text-muted-foreground">
            {autoPlay()
              ? `Plays by itself ${autoPlay()} min after the limit, or press Play`
              : 'Nothing retries until you press Play'}
            ; held runs then continue where they stopped. A model you switch meanwhile applies on
            Play.
          </p>
        </div>
        <footer class="flex items-center justify-between gap-2 border-t border-border/60 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
          <Show
            when={holding()}
            fallback={
              <span class="flex items-center gap-1.5">
                <Play class="size-3" /> continued after Play
              </span>
            }
          >
            <span>paused for {lasted(Math.max(0, now() - (doc()?.since ?? now())))}</span>
            <Button
              aria-label="Play after rate limit"
              class="h-7 font-sans text-[12px]"
              data-agent-confirm={playConfirmation}
              onClick={playPausedWork}
              size="sm"
              variant="outline"
            >
              <Play class="size-3" />
              Play
            </Button>
          </Show>
        </footer>
      </Card>
    </Show>
  )
}

export function AutoPlayedNote(props: { entry: EntryRecord }) {
  const data = () => (props.entry.data ?? {}) as Partial<AutoPlayed>
  return (
    <Show when={data().since !== undefined && data().at !== undefined}>
      <Divider kind="autoplayed">
        <span class="text-warning">Played by itself</span>
        <span class="truncate">
          · {lasted(data().at! - data().since!)} after the rate limit ·{' '}
          {new Date(data().at!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </Divider>
    </Show>
  )
}
