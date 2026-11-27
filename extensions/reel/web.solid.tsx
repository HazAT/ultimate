import type { ConversationId } from '@earendil-works/pi-durable'
import { FilmIcon, LoaderCircleIcon, PlayIcon } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { For, Show, createSignal } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  Provided,
  ROOT,
  cn,
  defineWebExtension,
  provide,
  useAction,
  useConversationSummary,
} from '@/sdk/solid'
import { meansNone } from '../../lib/errors.shared.ts'
import { MessageAnswers, MessageExtras } from '../messages/ui.solid.tsx'
import type { Message } from '../messages/refs.ts'
import { LandingExtras } from '../workspaces/ui.solid.tsx'
import { Peek, Player } from './player.solid.tsx'
import { FramesAction } from './refs.ts'
import type { Reel } from './refs.ts'

const PEEKS = 3

function Watch(props: {
  conversation: ConversationId
  reel: Reel
  answer?: () => JSX.Element
  onClose: () => void
}) {
  const summary = useConversationSummary(() => props.conversation)
  return (
    <Player
      answer={props.answer}
      earlier={props.reel.earlier}
      frames={props.reel.frames}
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
      title={summary()?.title ?? `#${props.conversation}`}
    />
  )
}

function RoundChip(props: { conversation: ConversationId; message: Message }) {
  const [open, setOpen] = createSignal(false)
  const { data } = useAction(
    FramesAction,
    () => ({ conversation: props.conversation, message: props.message.id }),
    { conversation: ROOT, onError: meansNone },
  )
  return (
    <Show when={(data()?.frames.length ?? 0) > 1 && data()}>
      {(reel) => (
        <>
          <Button
            aria-label={`Watch the reel for message #${props.message.id}`}
            class="group/reel flex h-auto w-full justify-start gap-2.5 border-t border-border/60 px-3 py-2 text-left font-mono text-[11px] font-normal whitespace-normal text-muted-foreground transition-colors hover:bg-muted/40"
            data-reel-chip
            onClick={() => setOpen(true)}
            size={null}
            variant={null}
          >
            <span class="flex shrink-0 gap-1">
              <For
                each={reel().frames.slice(0, PEEKS)}
                keyed={(frame) => `${frame.entry}:${frame.image}`}
              >
                {(frame) => <Peek frame={frame()} />}
              </For>
            </span>
            <span class="flex min-w-0 flex-col gap-0.5">
              <span class="flex items-center gap-1.5 text-foreground/90 group-hover/reel:text-foreground">
                <PlayIcon class="size-3 fill-current text-brand" />
                Watch the reel
              </span>
              <span class="truncate">
                {reel().frames.length} screenshots
                {reel().earlier > 0 && ` · +${reel().earlier} earlier`}
              </span>
            </span>
          </Button>
          <Show when={open()}>
            <Watch
              answer={() => <Provided input={{ message: props.message }} point={MessageAnswers} />}
              conversation={props.conversation}
              onClose={() => setOpen(false)}
              reel={reel()}
            />
          </Show>
        </>
      )}
    </Show>
  )
}

function RoundExtras(props: { message: Message }) {
  const branch = () =>
    typeof props.message.from === 'number' &&
    props.message.to === 'user' &&
    props.message.reply &&
    props.message.from
  return (
    <Show when={branch()}>
      {(conversation) => <RoundChip conversation={conversation()} message={props.message} />}
    </Show>
  )
}

function BranchChip(props: { conversation: ConversationId }) {
  const [asked, setAsked] = createSignal(false)
  const [open, setOpen] = createSignal(false)
  const ask = () => {
    setAsked(true)
    setOpen(true)
  }
  return (
    <Show
      when={asked()}
      fallback={<BranchButton conversation={props.conversation} onClick={ask} />}
    >
      <BranchWatch conversation={props.conversation} open={open()} onOpenChange={setOpen} />
    </Show>
  )
}

function BranchWatch(props: {
  conversation: ConversationId
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { data, loading } = useAction(FramesAction, () => ({ conversation: props.conversation }), {
    conversation: ROOT,
    onError: meansNone,
  })
  const enough = () => (data()?.frames.length ?? 0) > 1
  return (
    <>
      <BranchButton
        conversation={props.conversation}
        loading={loading()}
        none={!loading() && !enough()}
        onClick={() => props.onOpenChange(true)}
      />
      <Show when={props.open && enough() && data()}>
        {(reel) => (
          <Watch
            conversation={props.conversation}
            onClose={() => props.onOpenChange(false)}
            reel={reel()}
          />
        )}
      </Show>
    </>
  )
}

function BranchButton(props: {
  conversation: ConversationId
  loading?: boolean
  none?: boolean
  onClick: () => void
}) {
  return (
    <Button
      aria-label={`Watch the reel for branch #${props.conversation}`}
      class={cn(
        'flex items-center gap-1.5 text-[11px] font-normal text-muted-foreground hover:text-foreground',
        props.none && 'cursor-default hover:text-muted-foreground',
      )}
      data-reel-branch
      disabled={props.none}
      onClick={() => props.onClick()}
      size={null}
      variant={null}
    >
      {props.loading ? (
        <LoaderCircleIcon class="size-3 motion-safe:animate-spin" />
      ) : (
        <FilmIcon class="size-3 text-brand" />
      )}
      {props.none ? 'No screenshots to replay' : "Watch the branch's reel"}
    </Button>
  )
}

export default defineWebExtension({
  provides: [provide(MessageExtras, RoundExtras), provide(LandingExtras, BranchChip)],
})
