/** @jsxImportSource @solidjs/web */
import { ArrowLeft, ExternalLink, GitBranch } from '@lucide/solid'
import { createMemo, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  Provided,
  ProvidedValue,
  cn,
  column,
  events,
  formatAgo,
  showSurface,
  switchConversation,
} from '@/sdk/solid'
import { ConversationRef } from '../conversations/ui.solid.tsx'
import { Body, MessageExtras, MessageImages } from '../messages/ui.solid.tsx'
import { MessageQuestions } from '../questions/ui.solid.tsx'
import { WAIT_WARNING_AFTER_MS, amber, lead, previewUrl, senderOf, tagOf } from './items.ts'
import type { Entry } from './items.ts'

export function Reading(props: { entry: Entry; now: number; phone: boolean; onBack: () => void }) {
  const message = () => props.entry.message
  const text = createMemo(() => {
    const item = props.entry
    return item.message ? lead(item.message.text) : { title: item.item.title, body: '' }
  })
  const preview = createMemo(() => message() && previewUrl(message()!.text))
  const images = createMemo(() => {
    const item = message()
    return item?.images && typeof item.from === 'number'
      ? { from: item.from, entry: item.images.entry }
      : undefined
  })
  const sender = createMemo(() => senderOf(props.entry))
  const time = createMemo(() => new Date(props.entry.at))
  const openBranch = () => {
    const { conversation } = sender()
    if (conversation === undefined) return
    const item = message()
    if (item) events.emit('messages:open', { conversation, message: item.id })
    showSurface('agent')
    switchConversation(conversation)
  }
  return (
    <div class="flex min-h-0 flex-1 flex-col" data-inbox-item={message()?.id ?? props.entry.key}>
      <Show when={props.phone}>
        <div class="flex h-10 shrink-0 items-center gap-2 border-b border-border/70 px-2">
          <Button
            aria-label="Back to the Inbox"
            onClick={() => props.onBack()}
            size="icon"
            variant="ghost"
          >
            <ArrowLeft class="size-4" />
          </Button>
          <span class="section-label">Inbox</span>
        </div>
      </Show>
      <div class="relative min-h-0 flex-1 overflow-y-auto">
        <div
          class={
            props.phone
              ? 'px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]'
              : cn(column(), 'pt-8 pb-12')
          }
        >
          <header class="flex min-w-0 flex-wrap items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <Show when={sender().conversation} fallback={sender().from}>
              {(conversation) => (
                <>
                  <ConversationRef id={conversation()} />
                  <span>·</span>
                </>
              )}
            </Show>
            <span class="shrink-0 rounded border border-border/70 px-1 font-mono text-[10px] leading-4 text-muted-foreground">
              {tagOf(props.entry)}
            </span>
            <span class="ml-auto flex items-center gap-1">
              waited
              <time
                class={cn(
                  'shrink-0 font-mono text-[11px] tabular-nums',
                  props.now - props.entry.at > WAIT_WARNING_AFTER_MS && amber,
                )}
                datetime={time().toISOString()}
                title={`Asked ${time().toLocaleString()}`}
              >
                {formatAgo(props.entry.at, props.now)}
              </time>
            </span>
          </header>
          <h2 class="mt-3 text-[17px] leading-7 font-semibold tracking-[-0.01em]">
            {text().title}
          </h2>
          <Show when={text().body}>
            {(body) => <Body class="mt-1 px-0 py-0 text-[15px] leading-6" text={body()} />}
          </Show>
          <Show when={images()}>
            {(image) => (
              <div class="mt-4 overflow-hidden rounded-lg border border-border/70 bg-card/60 [&>div]:border-t-0">
                <MessageImages conversation={image().from} entry={image().entry} />
              </div>
            )}
          </Show>
          <div class="mt-4 flex flex-wrap items-center gap-2">
            <Show when={preview()}>
              {(url) => (
                <Button
                  render={(attrs) => (
                    <a
                      {...attrs}
                      aria-label="Open preview"
                      href={url()}
                      rel="noreferrer"
                      target="_blank"
                    />
                  )}
                  size="sm"
                  variant="outline"
                >
                  <ExternalLink class="size-3.5" /> Open preview
                </Button>
              )}
            </Show>
            <Show when={sender().conversation}>
              {(conversation) => (
                <Button
                  class="text-muted-foreground"
                  onClick={openBranch}
                  size="sm"
                  variant="ghost"
                >
                  <GitBranch class="size-3.5" /> Open in branch #{conversation()}
                </Button>
              )}
            </Show>
          </div>
          <div class={props.phone ? 'mt-5' : 'mt-6'}>
            <Show when={message()} fallback={<ProvidedValue value={props.entry.item?.pane} />}>
              {(question) => (
                <div class="overflow-hidden rounded-lg border border-border/70 bg-card/60">
                  <Provided input={{ message: question() }} point={MessageExtras} />
                  <MessageQuestions keys={!props.phone} message={question()} />
                </div>
              )}
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}
