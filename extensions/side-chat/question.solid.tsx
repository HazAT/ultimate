import type { ConversationId } from '@earendil-works/pi-durable'
import { GitForkIcon, LoaderCircleIcon } from '@lucide/solid'
import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js'
import type { JSX } from '@solidjs/web'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  api,
  errorMessage,
  ROOT,
  switchConversation,
  useConversationId,
  useDocOf,
  useSurface,
  useUiState,
  writerNow,
  writingAs,
} from '@/sdk/solid'
import type { QuestionMessage } from '../questions/ui.solid.tsx'
import { QuestionAction, SideChatSessionDoc } from './refs.ts'
import { hideSideChat, setSideChatOpen } from './dock.solid.tsx'
import { focusSideChat, openSideChat, SideChatBody } from './panel.solid.tsx'
import { setInboxChat } from './side.solid.tsx'

const PARKED = 'ext.side-chat.inbox-parked'

export function TalkItThrough(props: { message: QuestionMessage }) {
  const sessions = useDocOf(() => ROOT, SideChatSessionDoc)
  const [, setParked] = useUiState<number | null>(PARKED, null)
  const [opening, setOpening] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const surface = useSurface()
  const shown = useConversationId()
  const asker = () =>
    typeof props.message.from === 'number' ? (props.message.from as ConversationId) : undefined
  const open = () =>
    Object.values(sessions()?.sessions ?? {}).some(
      (each) => each?.id !== undefined && each.question === props.message.id,
    )
  const talk = async (message: number) => {
    const who = writerNow()
    setOpening(true)
    setFailure(undefined)
    try {
      const { source } = await api.action(QuestionAction, { message }, { who })
      const inInbox = surface() === 'inbox'
      const showAsker = surface() === 'agent' && shown() !== source
      writingAs(who, () => {
        if (inInbox) {
          setSideChatOpen(false)
          setParked(null)
          focusSideChat()
          return
        }
        if (showAsker) switchConversation(source)
        openSideChat(source)
      })
    } catch (error) {
      setFailure(errorMessage(error).replace(/^side-chat\/question: /, ''))
    } finally {
      setOpening(false)
    }
  }
  return (
    <Show when={asker()}>
      <Button
        aria-label={`Talk through question #${props.message.id}`}
        class="text-muted-foreground"
        data-talk-it-through={props.message.id}
        disabled={opening()}
        onClick={() => talk(props.message.id)}
        size="sm"
        title={
          failure() ??
          (open()
            ? 'Back to the side chat where you are talking this question through'
            : 'Talk this question through in a side chat forked from the agent that asked it')
        }
        variant="ghost"
      >
        <Show when={opening()} fallback={<GitForkIcon class="text-brand" />}>
          <LoaderCircleIcon class="motion-safe:animate-spin" />
        </Show>
        Talk it through
      </Button>
      <Show when={failure()}>
        <span class="font-mono text-[11px] text-error" role="alert">
          {failure()}
        </span>
      </Show>
    </Show>
  )
}

export function inboxSideChat(
  input: () => { message: QuestionMessage | undefined; phone: boolean; close: () => void },
) {
  const sessions = useDocOf(() => ROOT, SideChatSessionDoc)
  const [parked, setParked] = useUiState<number | null>(PARKED, null)
  const asker = createMemo(() => {
    const message = input().message
    if (!message || message.id === parked() || typeof message.from !== 'number') return undefined
    const session = sessions()?.sessions?.[message.from]
    return session?.id !== undefined && session.question === message.id
      ? (message.from as ConversationId)
      : undefined
  })
  const park = () => {
    const pane = input()
    setParked(pane.message?.id ?? null)
    pane.close()
  }
  const close = () => {
    park()
    hideSideChat()
  }
  createEffect(asker, (source) => {
    setInboxChat(source === undefined ? undefined : { source, park })
  })
  onCleanup(() => {
    setInboxChat(undefined)
  })
  return createMemo(() => {
    const staticSource = asker()
    if (staticSource === undefined) return undefined
    return () => (
      <section
        aria-label="Side chat"
        class="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
        data-side-chat-panel
      >
        <SideChatBody docked onClose={close} phone={input().phone} source={staticSource} />
      </section>
    )
  })
}

export function ForkStart(props: { conversation: ConversationId; core: JSX.Element }) {
  const sessions = useDocOf(() => ROOT, SideChatSessionDoc)
  const fork = () =>
    Object.values(sessions()?.sessions ?? {}).some(
      (each) => each?.id === props.conversation && each.question !== undefined,
    )
  return (
    <Show when={fork()} fallback={props.core}>
      <p class="px-5 pt-6 text-center font-mono text-[11px] text-muted-foreground/70">
        Nothing said yet: ask why, what an option means, or say what to pick.
      </p>
    </Show>
  )
}
