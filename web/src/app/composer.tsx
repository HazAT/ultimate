import type { AgentState, InboxItem } from '@earendil-works/pi-durable'
import { cn } from 'cn'
import {
  CornerDownRightIcon,
  ListPlusIcon,
  LoaderCircleIcon,
  PaperclipIcon,
  XIcon,
} from 'lucide-react'
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { ImagePreviews, useImagePaste } from '@/components/image-paste'
import type { KeyboardEvent, ReactNode } from 'react'
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@/components/ai/prompt-input'
import { Kbd } from '@/components/ui/kbd'
import { api } from '../sdk/client.ts'
import { ConversationIdContext } from '../sdk/conversation-scope.tsx'
import { errorMessage, formatBytes } from '../sdk/format.ts'
import { events } from '../sdk/events.ts'
import {
  TranscriptContext,
  useConversation,
  useExtensions,
  useModels,
  useStore,
} from '../sdk/hooks.ts'
import { isMac } from '../sdk/keys.ts'
import { touchKeyboard, useViewport } from '../sdk/viewport.ts'
import { createPortal } from 'react-dom'
import { useStatusTarget } from './status-target.ts'
import { imageMimeTypes, type ModelsResponse } from '../../../shared/protocol.ts'
import { AllProvided, ExtensionBoundary, Provided, Slot } from './boundary.tsx'
import { composerRenderers, inboxRenderer } from '../sdk/registry.ts'
import { ComposerPlaceholder, FileUpload } from '../sdk/types.ts'
import { column } from './layout.ts'
import { splitAttachments, withAttachments } from './attachments.ts'
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

const alt = isMac ? '⌥' : 'Alt'
const androidImagePasteStyle = { WebkitUserModify: 'read-write' } as const

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

function QueuedPreview({ text }: { text: string }) {
  const parts = previewParts(text)
  return (
    <span className="flex min-w-0 flex-1" title={text}>
      <span className="min-w-0 truncate">{parts.head}</span>
      {parts.tail && <span className="shrink-0 whitespace-pre">{parts.tail}</span>}
    </span>
  )
}

function Inbox({ items }: { items: readonly InboxItem[] }) {
  const { id } = useConversation()
  const [error, setError] = useState<string>()
  const renderer = inboxRenderer(useExtensions())
  const queued = items.filter((item) => item.mode !== 'write')
  if (queued.length === 0) return null
  const cancel = async (submissionId: number) => {
    setError(undefined)
    try {
      await api.cancelSubmission(submissionId, id)
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }
  return (
    <div className="mb-2 font-mono text-[12px]">
      <div className="max-h-40 space-y-1 overflow-y-auto">
        {queued.map((item) => {
          const cancellation = (
            <button
              aria-label={`Cancel queued input: ${inboxText(item)}`}
              className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm hover:bg-accent hover:text-foreground"
              onClick={() => void cancel(item.id)}
              title="Cancel queued input"
              type="button"
            >
              <XIcon className="size-3" />
            </button>
          )
          const core = (
            <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
              {item.mode === 'steer' ? (
                <CornerDownRightIcon className="size-3 shrink-0 text-brand" />
              ) : (
                <ListPlusIcon className="size-3 shrink-0" />
              )}
              <span className="shrink-0 text-foreground/80">
                {item.mode === 'steer' ? 'steer' : 'follow-up'}
              </span>
              <QueuedPreview text={inboxText(item)} />
              {cancellation}
            </div>
          )
          if (!renderer) return <div key={item.id}>{core}</div>
          const Renderer = renderer.component
          return (
            <ExtensionBoundary
              key={`${renderer.extension}:${item.id}`}
              extension={renderer.extension}
              version={renderer.version}
              fallback={core}
            >
              <Renderer item={item} core={core} cancel={cancellation} />
            </ExtensionBoundary>
          )
        })}
      </div>
      <div className="mt-0.5 flex justify-end text-[11px] text-muted-foreground/70 pointer-coarse:hidden">
        <span>
          <Kbd>↑</Kbd> edit queued
        </span>
      </div>
      {error && <p className="mt-1 text-error">{error}</p>}
    </div>
  )
}

export interface ComposerTarget {
  placeholder: string
  send: (text: string) => Promise<unknown>
}
const ComposerTargetContext = createContext<ComposerTarget | undefined>(undefined)
export function ComposerRedirect({ to, children }: { to?: ComposerTarget; children: ReactNode }) {
  const outer = useContext(ComposerTargetContext)
  return <ComposerTargetContext value={to ?? outer}>{children}</ComposerTargetContext>
}

export function Composer({ dock }: { dock?: boolean }) {
  const { id, entries } = useConversation()
  const scoped = useContext(ConversationIdContext)
  const requested = useStore((state) => state.requested)
  const renderers = composerRenderers(useExtensions())
  const loadingAwareMountKey = id ?? scoped ?? requested
  const core = renderers.reduce<ReactNode>(
    (previous, renderer) => {
      const Renderer = renderer.component
      return (
        <ExtensionBoundary
          key={renderer.extension}
          extension={renderer.extension}
          fallback={previous}
          version={renderer.version}
        >
          <Renderer core={previous} dock={dock} />
        </ExtensionBoundary>
      )
    },
    <ConversationComposer dock={dock} key={loadingAwareMountKey} />,
  )
  return <TranscriptContext value={entries}>{core}</TranscriptContext>
}

type Upload = typeof FileUpload.value
function StableEditorUploadBridge({ value, set }: { value: Upload; set: (value: Upload) => void }) {
  useEffect(() => set(value), [value, set])
  return null
}

function BeforePaintPlaceholderBridge({
  values,
  set,
}: {
  values: readonly (string | undefined)[]
  set: (value: string | undefined) => void
}) {
  const value = values.findLast((candidate) => candidate !== undefined)
  useLayoutEffect(() => set(value), [value, set])
  return null
}

function ConversationComposer({ dock }: { dock?: boolean }) {
  const { id, busy } = useConversation()
  const [upload, setUpload] = useState<Upload>()
  const [placeholder, setPlaceholder] = useState<string>()
  return (
    <>
      <Provided input={null} point={FileUpload}>
        {(value) => <StableEditorUploadBridge set={setUpload} value={value} />}
      </Provided>
      {id !== undefined && (
        <AllProvided input={{ conversation: id, busy }} point={ComposerPlaceholder}>
          {(values) => <BeforePaintPlaceholderBridge set={setPlaceholder} values={values} />}
        </AllProvided>
      )}
      <ComposerEditor dock={dock} placeholder={placeholder} upload={upload} />
    </>
  )
}

function ComposerEditor({
  dock,
  placeholder,
  upload,
}: {
  dock?: boolean
  placeholder: string | undefined
  upload: Upload
}) {
  const { id, agent, busy, loading, inbox } = useConversation()
  const queued = inbox.filter((item) => item.mode !== 'write')
  const scoped = useContext(ConversationIdContext)
  const target = useContext(ComposerTargetContext)
  const statusTarget = useStatusTarget()
  const phone = useViewport() === 'phone'
  const foldStatus = phone && scoped === undefined && !dock ? statusTarget : null
  const draft = getDraft(id)
  const { text, images, files, error, sending } = useSyncExternalStore(draft.subscribe, draft.get)
  const setError = (message: string | undefined) => draft.set({ error: message })
  const setImages = (change: (images: Draft['images']) => Draft['images']) =>
    draft.set({ images: change(draft.get().images), revision: draft.get().revision + 1 })
  const setFiles = (change: (files: Draft['files']) => Draft['files']) =>
    draft.set({ files: change(draft.get().files), revision: draft.get().revision + 1 })
  const { paste, drop, attach, reading, pending } = useImagePaste({
    images,
    setImages,
    setFiles,
    setError,
    disabled: () => loading || draft.get().sending,
    upload,
  })
  const uploading = files.some((file) => !file.path)
  const [dragging, setDragging] = useState(false)
  const dropRef = useRef(drop)
  dropRef.current = drop
  useEffect(() => {
    if (scoped !== undefined) return undefined
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
      void dropRef.current(event)
    }
    document.addEventListener('dragenter', enter)
    document.addEventListener('dragleave', leave)
    document.addEventListener('drop', dropped)
    return () => {
      document.removeEventListener('dragenter', enter)
      document.removeEventListener('dragleave', leave)
      document.removeEventListener('drop', dropped)
    }
  }, [scoped])
  const models = useModels()
  const key = draft.key
  useEffect(() => {
    const stored = (key ? localStorage.getItem(key) : null) ?? ''
    if (stored !== draft.get().text) draft.set({ text: stored, revision: draft.get().revision + 1 })
  }, [draft, key])
  const update = (value: string) => {
    draft.set({ text: value, revision: draft.get().revision + 1 })
    if (!key) return
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  }
  const restoreTextAndFileChips = (value: string) => {
    const { text: rest, files: back } = splitAttachments(value)
    update(rest)
    if (back.length)
      setFiles((current) => [
        ...back.map((file) => ({ ...file, id: crypto.randomUUID() })),
        ...current,
      ])
  }
  const blocked = loading ? undefined : blockedBy(agent, models)
  const empty = !text.trim() && images.length === 0 && files.length === 0

  async function send(whenBusy?: 'steer' | 'followUp') {
    if (
      loading ||
      empty ||
      blocked ||
      uploading ||
      draft.get().sending ||
      pending.current ||
      id === undefined
    )
      return
    const submitted = draft.get()
    if (target && images.length) {
      setError('Images stay here: remove them to send elsewhere')
      return
    }
    draft.set({ sending: true, error: undefined })
    const mode = busy ? (whenBusy ?? 'steer') : undefined
    let input = { text: withAttachments(text.trim(), files), images }
    let withdrawnSteerToRestoreOnFailure: typeof input | undefined
    try {
      if (target) await target.send(input.text)
      else {
        withdrawnSteerToRestoreOnFailure =
          mode === 'steer' ? await withdrawQueuedSteer(api, id, inbox) : undefined
        if (withdrawnSteerToRestoreOnFailure)
          input = mergedSteer(withdrawnSteerToRestoreOnFailure, input)
        events.emit('ultimate:sent', { conversationId: id })
        await api.submit(
          input.text,
          mode,
          id,
          input.images.map(({ data, mimeType }) => ({ data, mimeType })),
        )
      }
      clearDraft(draft, submitted)
      if (draft.get().images === submitted.images) draft.set({ images: [] })
      if (draft.get().files === submitted.files) draft.set({ files: [] })
    } catch (failure) {
      if (key && draft.get().revision === submitted.revision)
        draft.set({ text: localStorage.getItem(key) ?? '' })
      if (withdrawnSteerToRestoreOnFailure) {
        restoreTextAndFileChips(
          mergedSteer(withdrawnSteerToRestoreOnFailure, { text: draft.get().text, images: [] })
            .text,
        )
        setImages((current) => [...withdrawnSteerToRestoreOnFailure!.images, ...current])
      }
      setError(errorMessage(failure))
    } finally {
      draft.set({ sending: false })
    }
  }
  async function recall() {
    if (loading || draft.get().sending || id === undefined || queued.length === 0) return
    draft.set({ sending: true, error: undefined })
    try {
      const recalled = await recallQueued(api, id, queued)
      restoreTextAndFileChips(recalledText(draft.get().text, recalled))
      setImages((current) => [...current, ...recalled.flatMap((input) => input.images)])
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      draft.set({ sending: false })
    }
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowUp' && !target && queued.length > 0) {
      const { value, selectionStart } = event.currentTarget
      if (!atFirstLine(value, selectionStart)) return
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

  return (
    <div
      data-composer-target={scoped === undefined ? 'conversation' : 'scope'}
      data-ui="composer"
      className={cn(column(dock), 'pb-2')}
    >
      <Inbox items={inbox} />
      <PromptInput
        className={cn(dragging && 'ring-2 ring-brand/60')}
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <ImagePreviews
          images={images}
          files={files}
          disabled={loading || sending || reading}
          remove={(index) => setImages((current) => current.filter((_, i) => i !== index))}
          removeFile={(fileId) =>
            setFiles((current) => current.filter((file) => file.id !== fileId))
          }
        />
        <PromptInputTextarea
          autoFocus={!touchKeyboard()}
          readOnly={loading || sending}
          onPaste={(event) => void paste(event)}
          onDrop={(event) => void drop(event)}
          style={touchKeyboard() ? androidImagePasteStyle : undefined}
          id={scoped === undefined ? 'composer-input' : `composer-input-${scoped}`}
          data-conversation={id}
          onChange={(event) => update(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            target?.placeholder ??
            placeholder ??
            (busy ? 'Steer the run, or queue a follow-up…' : 'Ask Ultimate to change something…')
          }
          value={text}
        />
        <PromptInputFooter className="@container">
          <PromptInputTools className="overflow-hidden">
            <Slot name="composer.toolbar" variant="inline" />
          </PromptInputTools>
          <div className="flex max-w-full min-w-0 shrink-0 items-center gap-2">
            <span
              className={cn(
                'truncate font-mono text-[11px]',
                error || blocked ? 'text-error' : 'text-muted-foreground/70',
              )}
            >
              {error ??
                blocked ??
                (busy && !target ? (
                  <span className="pointer-coarse:hidden">
                    <Kbd>↵</Kbd> steer · <Kbd>{alt} ↵</Kbd> follow-up · <Kbd>esc</Kbd> stop
                  </span>
                ) : null)}
            </span>
            <label
              aria-label={upload ? 'Attach files' : 'Attach images'}
              className={cn(
                'flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground pointer-coarse:size-9',
                (loading || sending || reading) &&
                  'pointer-events-none opacity-50 hover:bg-transparent',
              )}
              title={
                upload
                  ? `Attach files: images inline, others up to ${formatBytes(upload.maxBytes).replace('.0 ', ' ')}`
                  : 'Attach images'
              }
            >
              <PaperclipIcon className="size-4" />
              <input
                accept={upload ? undefined : imageMimeTypes.join(',')}
                className="sr-only"
                disabled={loading || sending || reading}
                multiple
                onChange={(event) => {
                  const picked = Array.from(event.target.files ?? [])
                  event.target.value = ''
                  void attach(picked)
                }}
                type="file"
              />
            </label>
            {!target && <Slot name="composer.actions" variant="inline" />}
            {busy && (
              <PromptInputSubmit
                mode="stop"
                onClick={() =>
                  void api.abort(id).catch((failure: Error) => setError(failure.message))
                }
                title="Stop (Esc)"
              />
            )}
            {(!busy || !empty) && (
              <PromptInputSubmit
                disabled={loading || empty || !!blocked || sending || reading || uploading}
                aria-label={loading ? 'Loading conversation' : 'Send'}
                title={
                  loading
                    ? 'Loading conversation'
                    : uploading
                      ? 'Uploading files…'
                      : busy && !target
                        ? 'Steer (Enter)'
                        : 'Send (Enter)'
                }
                className={loading ? 'bg-muted text-muted-foreground' : undefined}
              >
                {loading ? (
                  <LoaderCircleIcon className="size-4 motion-safe:animate-spin" />
                ) : undefined}
              </PromptInputSubmit>
            )}
          </div>
        </PromptInputFooter>
      </PromptInput>
      {foldStatus ? (
        createPortal(<Slot name="composer.status" variant="inline" />, foldStatus)
      ) : (
        <div className="flex items-center gap-3 overflow-hidden pt-1.5 font-mono text-[11px] whitespace-nowrap text-muted-foreground empty:hidden">
          <Slot name="composer.status" variant="inline" />
        </div>
      )}
    </div>
  )
}
