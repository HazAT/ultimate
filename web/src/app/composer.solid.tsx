import type { AgentState, ConversationId, InboxItem } from '@earendil-works/pi-durable'
import { CornerDownRight, ListPlus, Square, X } from '@lucide/solid'
import { Portal } from '@solidjs/web'
import type { JSX } from '@solidjs/web'
import { cn } from 'cn'
import { createEffect, createMemo, createSignal, For, onCleanup, Show, useContext } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Kbd } from '@/components/ui/kbd.solid.tsx'
import {
  api,
  column,
  ComposerPlaceholder,
  ComposerRedirect,
  composerRenderers,
  ConversationScope,
  createTranscriptFrame,
  DictationShortcut,
  errorMessage,
  events,
  inboxRenderer,
  isMac,
  Transcript,
  useConversation,
  useExtensions,
  useModels,
  useStore,
  useViewport,
  writerNow,
  writingAs,
} from '../sdk/hooks.ts'
import type { ComposerTarget } from '../sdk/hooks.ts'
import type { PromptInput } from '../sdk/types.ts'
import type { ModelsResponse } from '../../../shared/protocol.ts'
import {
  Contributed,
  Contribution,
  Slot,
  useAllProvided,
  useProvided,
} from '../sdk/contribution.solid.tsx'
import { useExternal } from '../sdk/page.ts'
import { splitAttachments } from './attachments.ts'
import { ContributionError } from './contribution-error.solid.tsx'
import { getDraft, restoreDraft, storedText } from './drafts.ts'
import { PromptBox } from './prompt-box.solid.tsx'
import {
  atFirstLine,
  mergedSteer,
  previewParts,
  recallQueued,
  recalledText,
  withdrawQueuedSteer,
} from './queued.ts'
import { statusTarget, subscribeStatusTarget } from './status-target.ts'

const alt = isMac ? '⌥' : 'Alt'

function blockedBy(agent: AgentState, models: ModelsResponse | undefined): string | undefined {
  const model = agent.model
  if (!model) return `No model yet: ${isMac ? '⌘K' : 'Ctrl+K'} → Log in`
  const found = models?.models.find(
    (candidate) => candidate.provider === model.provider && candidate.id === model.modelId,
  )
  if (models && !found?.available)
    return `${model.provider}/${model.modelId} is not available. Log in to ${model.provider}.`
  return undefined
}

function inboxText(item: InboxItem): string {
  if (item.mode === 'write') return 'entry write'
  const content = item.content
  const blocks = typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content
  return blocks
    .flatMap((block) => {
      if (block.type !== 'text') return ['[image]']
      const { text, files } = splitAttachments(block.text)
      return [text, ...files.map((file) => `[${file.name}]`)].filter(Boolean)
    })
    .join(' ')
}

const failed = (extension: string, error: unknown) => (
  <ContributionError error={error} extension={extension} inline />
)

export function Composer(props: { dock?: boolean }) {
  const conversation = useConversation()
  const scoped = useContext(ConversationScope)
  const requested = useStore((state) => state.requested)
  const mountKey = createMemo(() => conversation().id ?? scoped ?? requested())
  const extensions = useExtensions()
  const frame = createTranscriptFrame(() => conversation().entries)
  const target = useContext(ComposerRedirect)
  return (
    <Show when={target()?.draft === undefined} fallback={<DraftComposer dock={props.dock} />}>
      <Transcript value={frame.frame}>
        <Contributed
          core={() => <For each={[mountKey()]}>{() => <ComposerEditor dock={props.dock} />}</For>}
          fallback={(extension, error, inner) => (
            <>
              {failed(extension, error)}
              {inner()}
            </>
          )}
          props={{ dock: props.dock }}
          renderers={composerRenderers(extensions())}
        />
      </Transcript>
    </Show>
  )
}

function Inbox(props: { items: readonly InboxItem[] }) {
  const conversation = useConversation()
  const extensions = useExtensions()
  const renderer = createMemo(() => inboxRenderer(extensions()))
  const [error, setError] = createSignal<string>()
  const queued = createMemo(() => props.items.filter((item) => item.mode !== 'write'))
  const cancel = (submissionId: number) => {
    setError(undefined)
    return api
      .cancelSubmission(submissionId, conversation().id)
      .catch((failure: unknown) => setError(errorMessage(failure)))
  }
  return (
    <Show when={queued().length > 0}>
      <div class="mb-2 font-mono text-[12px]">
        <div class="max-h-40 space-y-1 overflow-y-auto">
          <For each={queued()} keyed={(item) => item.id}>
            {(item) => {
              const cancellation = () => (
                <Button
                  aria-label={`Cancel queued input ${item().id}: ${inboxText(item())}`}
                  data-agent-confirm="Removes this message from the queue before the agent reads it."
                  class="size-6 rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => cancel(item().id)}
                  size={null}
                  title="Cancel queued input"
                  variant={null}
                >
                  <X class="size-3" />
                </Button>
              )
              const core = () => <QueuedRow cancel={cancellation()} item={item()} />
              return (
                <Show when={renderer()} fallback={core()}>
                  {(found) => (
                    <Contribution
                      fallback={(extension, failure) => (
                        <>
                          {failed(extension, failure)}
                          {core()}
                        </>
                      )}
                      elements={{ core, cancel: cancellation }}
                      item={found()}
                      props={{
                        get item() {
                          return item()
                        },
                      }}
                    />
                  )}
                </Show>
              )
            }}
          </For>
        </div>
        <div class="mt-0.5 flex justify-end text-[11px] text-muted-foreground/70 pointer-coarse:hidden">
          <span>
            <Kbd>↑</Kbd> edit queued
          </span>
        </div>
        <Show when={error()}>
          <p class="mt-1 text-error">{error()}</p>
        </Show>
      </div>
    </Show>
  )
}

function Placeholder(props: {
  conversation: ConversationId
  busy: boolean
  report: (text: string | undefined) => void
}) {
  const answers = useAllProvided(ComposerPlaceholder, () => ({
    conversation: props.conversation,
    busy: props.busy,
  }))
  createEffect(
    () => answers().findLast((text) => text !== undefined),
    (text) => {
      props.report(text)
    },
  )
  onCleanup(() => props.report(undefined))
  return null
}

function QueuedRow(props: { item: InboxItem; cancel: JSX.Element }) {
  const parts = createMemo(() => previewParts(inboxText(props.item)))
  return (
    <div class="flex min-w-0 items-center gap-2 text-muted-foreground">
      <Show when={props.item.mode === 'steer'} fallback={<ListPlus class="size-3 shrink-0" />}>
        <CornerDownRight class="size-3 shrink-0 text-brand" />
      </Show>
      <span class="shrink-0 text-foreground/80">
        {props.item.mode === 'steer' ? 'steer' : 'follow-up'}
      </span>
      <span class="flex min-w-0 flex-1" title={inboxText(props.item)}>
        <span class="min-w-0 truncate">{parts().head}</span>
        <Show when={parts().tail}>
          <span class="shrink-0 whitespace-pre">{parts().tail}</span>
        </Show>
      </span>
      {props.cancel}
    </div>
  )
}

function redirected(redirect: ComposerTarget, input: PromptInput) {
  if (!redirect.images && input.images.length)
    throw new Error('Images stay here: remove them to send elsewhere')
  return redirect.send(input.text, input.images)
}

function DraftComposer(props: { dock?: boolean }) {
  const target = useContext(ComposerRedirect)
  return (
    <div class={cn(column(props.dock), 'pb-2')} data-composer-target="draft" data-ui="composer">
      <PromptBox
        accepts={{ images: !!target()?.images }}
        autofocus
        dictation={target()?.dictation}
        draft={target()?.draft}
        id={`composer-input-${target()?.draft}`}
        name={target()?.name ?? 'the new conversation'}
        onSubmit={(input) => redirected(target()!, input)}
        placeholder={target()?.placeholder ?? ''}
        ready={target()?.ready}
        toolbar={target()?.toolbar}
      />
    </div>
  )
}

function ComposerEditor(props: { dock?: boolean }) {
  const conversation = useConversation()
  const scoped = useContext(ConversationScope)
  const target = useContext(ComposerRedirect)
  const id = createMemo(() => conversation().id)
  const loading = createMemo(() => conversation().loading)
  const busy = createMemo(() => conversation().busy)
  const inbox = createMemo(() => conversation().inbox)
  const queued = createMemo(() => inbox().filter((item) => item.mode !== 'write'))
  const draft = createMemo(() => getDraft(id()))
  const [placeholder, setPlaceholder] = createSignal<string>()
  const talk = useProvided(DictationShortcut, () => null)
  const idlePlaceholder = () =>
    talk()
      ? `Ask Ultimate anything, paste a screenshot, or ${talk()} to dictate…`
      : 'Ask Ultimate anything or paste a screenshot…'
  const models = useModels()
  const viewport = useViewport()
  const foldTarget = useExternal(statusTarget, subscribeStatusTarget)
  const foldStatus = createMemo(() =>
    viewport() === 'phone' && scoped === null && !props.dock ? foldTarget() : null,
  )
  const setError = (message: string | undefined) => draft().set({ error: message })
  const blocked = () => (loading() ? undefined : blockedBy(conversation().agent, models()))

  async function submit(typed: PromptInput, how: 'followUp' | undefined) {
    const redirect = target()
    if (redirect) return redirected(redirect, typed)
    const conversationId = id()
    if (conversationId === undefined) throw new Error('No conversation to send to yet')
    const who = writerNow()
    const current = draft()
    const typedAt = current.get().revision
    const mode = busy() ? (how ?? 'steer') : undefined
    const withdrawn =
      mode === 'steer' ? await withdrawQueuedSteer(api, conversationId, inbox()) : undefined
    const input = withdrawn ? mergedSteer(withdrawn, typed) : typed
    events.emit('ultimate:sent', { conversationId })
    try {
      return await writingAs(who, () => api.submit(input.text, mode, conversationId, input.images))
    } catch (failure) {
      if (withdrawn) {
        const kept = current.get().revision === typedAt ? storedText(current) : current.get().text
        restoreDraft(current, mergedSteer(withdrawn, { text: kept, images: [] }).text)
        current.set({ images: [...withdrawn.images, ...current.get().images] })
      }
      throw failure
    }
  }

  async function recall() {
    const conversationId = id()
    const current = draft()
    if (loading() || current.get().sending || conversationId === undefined) return
    current.set({ sending: true, error: undefined })
    try {
      const recalled = await recallQueued(api, conversationId, queued())
      restoreDraft(current, recalledText(current.get().text, recalled))
      current.set({
        images: [...current.get().images, ...recalled.flatMap((input) => input.images)],
      })
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      current.set({ sending: false })
    }
  }

  function recallOnUp(event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) {
    if (event.key !== 'ArrowUp' || target() || queued().length === 0) return false
    const { value: typed, selectionStart } = event.currentTarget
    if (!atFirstLine(typed, selectionStart)) return false
    event.preventDefault()
    void recall()
    return true
  }

  const label = () =>
    target()?.name ?? (id() === undefined ? 'the conversation' : `conversation #${id()}`)
  const status = () => <Slot fallback={failed} name="composer.status" />

  return (
    <div
      class={cn(column(props.dock), 'pb-2')}
      data-composer-target={scoped === null ? 'conversation' : 'scope'}
      data-ui="composer"
    >
      <Show when={id()} keyed>
        {(conversationId) => (
          <Placeholder busy={busy()} conversation={conversationId} report={setPlaceholder} />
        )}
      </Show>
      <Inbox items={inbox()} />
      <PromptBox
        actions={
          <Show when={busy()}>
            <Button
              aria-label={`Stop the run in ${label()}`}
              data-agent-confirm="Stops the current run in this conversation."
              class="ml-1 size-7 rounded-md pointer-coarse:size-9"
              onClick={() =>
                api.abort(id()).catch((failure: unknown) => setError(errorMessage(failure)))
              }
              size="icon"
              title="Stop (Esc)"
              variant="secondary"
            >
              <Square class="size-3 fill-current" />
            </Button>
          </Show>
        }
        accepts={{ images: !target() || !!target()?.images }}
        autofocus
        blocked={blocked()}
        dictation={target()?.dictation}
        conversation={id()}
        draft={id()}
        hint={
          <Show when={busy() && !target()}>
            <span class="pointer-coarse:hidden">
              <Kbd>↵</Kbd> steer · <Kbd>{alt} ↵</Kbd> follow-up · <Kbd>esc</Kbd> stop
            </span>
          </Show>
        }
        id={scoped === null ? 'composer-input' : `composer-input-${scoped}`}
        loading={loading()}
        name={label()}
        onKeyDown={recallOnUp}
        onSubmit={submit}
        pageDrop={scoped === null}
        placeholder={
          target()?.placeholder ??
          placeholder() ??
          (busy() ? 'Steer the run, or queue a follow-up…' : idlePlaceholder())
        }
        ready={target()?.ready}
        running={busy()}
        sendTitle={busy() && !target() ? 'Steer (Enter)' : undefined}
        toolbar={<Slot fallback={failed} name="composer.toolbar" />}
      />
      <Show
        when={foldStatus()}
        keyed
        fallback={
          <div class="flex items-center gap-3 overflow-hidden pt-1.5 font-mono text-[11px] whitespace-nowrap text-muted-foreground empty:hidden">
            {status()}
          </div>
        }
      >
        {(mount) => <Portal mount={mount}>{status()}</Portal>}
      </Show>
    </div>
  )
}
