/** @jsxImportSource @solidjs/web */
import type { AgentState, ConversationId, InboxItem } from '@earendil-works/pi-durable'
import {
  CornerDownRight,
  ListPlus,
  LoaderCircle,
  Paperclip,
  ArrowUp,
  Square,
  X,
} from '@lucide/solid'
import { Portal } from '@solidjs/web'
import type { JSX } from '@solidjs/web'
import { cn } from 'cn'
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onSettled,
  Show,
  useContext,
} from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Form } from '@/components/ui/form.solid.tsx'
import { Textarea } from '@/components/ui/input.solid.tsx'
import { Kbd } from '@/components/ui/kbd.solid.tsx'
import {
  api,
  column,
  ComposerPlaceholder,
  ComposerRedirect,
  composerRenderers,
  ConversationScope,
  createTranscriptFrame,
  errorMessage,
  events,
  FileUpload,
  formatBytes,
  inboxRenderer,
  isMac,
  touchKeyboard,
  Transcript,
  useConversation,
  useExtensions,
  useModels,
  useStore,
  useViewport,
  writerNow,
  writingAs,
} from '@/sdk/solid'
import type { ModelsResponse } from '../../../shared/protocol.ts'
import { imageMimeTypes } from '../../../shared/protocol.ts'
import {
  Contributed,
  Contribution,
  Slot,
  useAllProvided,
  useProvided,
} from '../sdk/react-island.solid.tsx'
import { Attached, createAttach } from './attach.solid.tsx'
import { splitAttachments, withAttachments } from './attachments.ts'
import type { DraftFile, PastedImage } from './attachments.ts'
import { ContributionError } from './contribution-error.solid.tsx'
import { clearDraft, getDraft } from './drafts.ts'
import type { Draft } from './drafts.ts'
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
const androidImagePasteStyle: JSX.CSSProperties = { '-webkit-user-modify': 'read-write' }

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
  const frame = createTranscriptFrame()
  createEffect(
    () => conversation().entries,
    (entries) => frame.setEntries(entries),
  )
  return (
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

function createDraftState(id: () => number | undefined) {
  const draft = createMemo(() => getDraft(id()))
  const [changes, setChanges] = createSignal(0)
  const value = createMemo((): Draft => {
    changes()
    return draft().get()
  })
  createEffect(draft, (current) => {
    const unsubscribe = current.subscribe(() => setChanges((n) => n + 1))
    const stored = (current.key ? localStorage.getItem(current.key) : null) ?? ''
    if (stored !== current.get().text)
      current.set({ text: stored, revision: current.get().revision + 1 })
    return unsubscribe
  })
  return { draft, value }
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
  const { draft, value } = createDraftState(id)
  const text = () => value().text
  const images = () => value().images
  const files = () => value().files
  const sending = () => value().sending
  const upload = useProvided(FileUpload, () => null)
  const [placeholder, setPlaceholder] = createSignal<string>()
  const models = useModels()
  const viewport = useViewport()
  const [foldTarget, setFoldTarget] = createSignal(statusTarget())
  onSettled(() => subscribeStatusTarget(() => setFoldTarget(statusTarget())))
  const foldStatus = createMemo(() =>
    viewport() === 'phone' && scoped === null && !props.dock ? foldTarget() : null,
  )

  const setError = (message: string | undefined) => draft().set({ error: message })
  const revised = (change: Partial<Draft>) =>
    draft().set({ ...change, revision: draft().get().revision + 1 })
  const setImages = (change: (current: PastedImage[]) => PastedImage[]) =>
    revised({ images: change(draft().get().images) })
  const setFiles = (change: (current: DraftFile[]) => DraftFile[]) =>
    revised({ files: change(draft().get().files) })
  const attach = createAttach({
    images,
    setImages,
    setFiles,
    setError,
    disabled: () => loading() || draft().get().sending,
    upload,
  })
  const uploading = () => files().some((file) => !file.path)
  const blocked = () => (loading() ? undefined : blockedBy(conversation().agent, models()))
  const empty = () => !text().trim() && images().length === 0 && files().length === 0
  const inert = () => loading() || sending() || attach.reading()

  const update = (next: string) => {
    revised({ text: next })
    const key = draft().key
    if (!key) return
    if (next) localStorage.setItem(key, next)
    else localStorage.removeItem(key)
  }
  const restoreTextAndFileChips = (restored: string) => {
    const { text: rest, files: back } = splitAttachments(restored)
    update(rest)
    if (back.length)
      setFiles((current) => [
        ...back.map((file) => ({ ...file, id: crypto.randomUUID() })),
        ...current,
      ])
  }

  async function send(whenBusy?: 'steer' | 'followUp') {
    const conversationId = id()
    const current = draft()
    const redirect = target()
    if (
      loading() ||
      empty() ||
      blocked() ||
      uploading() ||
      current.get().sending ||
      attach.busy() ||
      conversationId === undefined
    )
      return
    const submitted = current.get()
    if (redirect && submitted.images.length) {
      setError('Images stay here: remove them to send elsewhere')
      return
    }
    const who = writerNow()
    current.set({ sending: true, error: undefined })
    const mode = busy() ? (whenBusy ?? 'steer') : undefined
    let input = {
      text: withAttachments(submitted.text.trim(), submitted.files),
      images: submitted.images,
    }
    let withdrawnSteerToRestoreOnFailure: typeof input | undefined
    try {
      if (redirect) await writingAs(who, () => redirect.send(input.text))
      else {
        withdrawnSteerToRestoreOnFailure =
          mode === 'steer' ? await withdrawQueuedSteer(api, conversationId, inbox()) : undefined
        if (withdrawnSteerToRestoreOnFailure)
          input = mergedSteer(withdrawnSteerToRestoreOnFailure, input)
        events.emit('ultimate:sent', { conversationId })
        await writingAs(who, () =>
          api.submit(
            input.text,
            mode,
            conversationId,
            input.images.map(({ data, mimeType }) => ({ data, mimeType })),
          ),
        )
      }
      clearDraft(current, submitted)
      if (current.get().images === submitted.images) current.set({ images: [] })
      if (current.get().files === submitted.files) current.set({ files: [] })
    } catch (failure) {
      if (current.key && current.get().revision === submitted.revision)
        current.set({ text: localStorage.getItem(current.key) ?? '' })
      const withdrawn = withdrawnSteerToRestoreOnFailure
      if (withdrawn) {
        restoreTextAndFileChips(
          mergedSteer(withdrawn, { text: current.get().text, images: [] }).text,
        )
        setImages((kept) => [...withdrawn.images, ...kept])
      }
      setError(errorMessage(failure))
    } finally {
      current.set({ sending: false })
    }
  }

  async function recall() {
    const conversationId = id()
    const current = draft()
    if (loading() || current.get().sending || conversationId === undefined) return
    if (queued().length === 0) return
    current.set({ sending: true, error: undefined })
    try {
      const recalled = await recallQueued(api, conversationId, queued())
      restoreTextAndFileChips(recalledText(current.get().text, recalled))
      setImages((kept) => [...kept, ...recalled.flatMap((input) => input.images)])
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      current.set({ sending: false })
    }
  }

  function onKeyDown(event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) {
    if (event.isComposing) return
    if (event.key === 'ArrowUp' && !target() && queued().length > 0) {
      const { value: typed, selectionStart } = event.currentTarget
      if (!atFirstLine(typed, selectionStart)) return
      event.preventDefault()
      void recall()
      return
    }
    if (event.key !== 'Enter' || event.shiftKey) return
    const touchReturnInsertsNewline = touchKeyboard() && !event.metaKey && !event.ctrlKey
    if (touchReturnInsertsNewline) return
    event.preventDefault()
    void send(event.altKey ? 'followUp' : 'steer')
  }

  const [dragging, setDragging] = createSignal(false)
  onSettled(() => {
    if (scoped !== null) return undefined
    let depth = 0
    const carriesFiles = (event: DragEvent) => !!event.dataTransfer?.types.includes('Files')
    const enter = (event: DragEvent) => {
      if (carriesFiles(event)) setDragging(++depth > 0)
    }
    const leave = (event: DragEvent) => {
      if (carriesFiles(event)) setDragging(--depth > 0)
    }
    const dropped = (event: DragEvent) => {
      depth = 0
      setDragging(false)
      const on = event.target instanceof Element ? event.target : null
      const ignoreNonFileOrEditorOwnedDrop =
        !carriesFiles(event) || on?.closest('[data-ui="composer"] textarea')
      if (ignoreNonFileOrEditorOwnedDrop) return
      void attach.drop(event)
    }
    document.addEventListener('dragenter', enter)
    document.addEventListener('dragleave', leave)
    document.addEventListener('drop', dropped)
    return () => {
      document.removeEventListener('dragenter', enter)
      document.removeEventListener('dragleave', leave)
      document.removeEventListener('drop', dropped)
    }
  })

  let editor: HTMLTextAreaElement | undefined
  onSettled(() => {
    if (!touchKeyboard()) editor?.focus()
  })

  const label = () => (id() === undefined ? 'the conversation' : `conversation #${id()}`)
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
      <Form
        class={cn(
          'flex w-full flex-col rounded-xl border border-input/80 bg-card shadow-sm transition-colors focus-within:border-ring/70',
          dragging() && 'ring-2 ring-brand/60',
        )}
      >
        <Attached
          disabled={inert()}
          files={files()}
          images={images()}
          remove={(index) => setImages((current) => current.filter((_, at) => at !== index))}
          removeFile={(fileId) =>
            setFiles((current) => current.filter((file) => file.id !== fileId))
          }
        />
        <Textarea
          aria-label={`Prompt for ${label()}`}
          autoResize
          class="block max-h-80 min-h-0 w-full resize-none rounded-none border-0 bg-transparent px-3.5 pt-3 pb-1 font-sans text-[14px] leading-relaxed outline-none focus-visible:border-0 focus-visible:ring-0 disabled:cursor-not-allowed"
          data-conversation={id()}
          id={scoped === null ? 'composer-input' : `composer-input-${scoped}`}
          onDrop={(event) => void attach.drop(event)}
          onKeyDown={onKeyDown}
          onPaste={(event) => void attach.paste(event)}
          onValueChange={update}
          placeholder={
            target()?.placeholder ??
            placeholder() ??
            (busy() ? 'Steer the run, or queue a follow-up…' : 'Ask Ultimate to change something…')
          }
          readonly={loading() || sending()}
          ref={(element) => {
            editor = element
          }}
          rows={1}
          style={touchKeyboard() ? androidImagePasteStyle : undefined}
          value={text()}
        />
        <div class="@container flex items-center justify-between gap-2 px-2 pt-1 pb-2">
          <div class="flex min-w-0 items-center gap-1 overflow-hidden">
            <Slot fallback={failed} name="composer.toolbar" />
          </div>
          <div class="flex max-w-full min-w-0 shrink-0 items-center gap-2">
            <span
              class={cn(
                'truncate font-mono text-[11px]',
                value().error || blocked() ? 'text-error' : 'text-muted-foreground/70',
              )}
            >
              <Show
                when={value().error ?? blocked()}
                fallback={
                  <Show when={busy() && !target()}>
                    <span class="pointer-coarse:hidden">
                      <Kbd>↵</Kbd> steer · <Kbd>{alt} ↵</Kbd> follow-up · <Kbd>esc</Kbd> stop
                    </span>
                  </Show>
                }
              >
                {(problem) => problem()}
              </Show>
            </span>
            <label
              aria-label={upload() ? 'Attach files' : 'Attach images'}
              class={cn(
                'flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground pointer-coarse:size-9',
                inert() && 'pointer-events-none opacity-50 hover:bg-transparent',
              )}
              title={
                upload()
                  ? `Attach files: images inline, others up to ${formatBytes(upload()!.maxBytes).replace('.0 ', ' ')}`
                  : 'Attach images'
              }
            >
              <Paperclip class="size-4" />
              <input
                accept={upload() ? undefined : imageMimeTypes.join(',')}
                class="sr-only"
                disabled={inert()}
                multiple
                onChange={(event) => {
                  const picked = Array.from(event.currentTarget.files ?? [])
                  event.currentTarget.value = ''
                  void attach.attach(picked)
                }}
                type="file"
              />
            </label>
            <Show when={!target()}>
              <Slot fallback={failed} name="composer.actions" />
            </Show>
            <Show when={busy()}>
              <Button
                aria-label={`Stop the run in ${label()}`}
                class={submitClass}
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
            <Show when={!busy() || !empty()}>
              <Button
                aria-label={loading() ? 'Loading conversation' : `Send prompt to ${label()}`}
                class={cn(submitClass, loading() && 'bg-muted text-muted-foreground')}
                disabled={
                  loading() ||
                  empty() ||
                  !!blocked() ||
                  sending() ||
                  attach.reading() ||
                  uploading()
                }
                onClick={() => send()}
                size="icon"
                title={
                  loading()
                    ? 'Loading conversation'
                    : uploading()
                      ? 'Uploading files…'
                      : busy() && !target()
                        ? 'Steer (Enter)'
                        : 'Send (Enter)'
                }
                type="submit"
              >
                <Show when={loading()} fallback={<ArrowUp class="size-4" />}>
                  <LoaderCircle class="size-4 motion-safe:animate-spin" />
                </Show>
              </Button>
            </Show>
          </div>
        </div>
      </Form>
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

const submitClass =
  'size-7 rounded-lg pointer-coarse:relative pointer-coarse:size-9 pointer-coarse:after:absolute pointer-coarse:after:-inset-1'
