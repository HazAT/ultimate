import type { AgentState, InboxItem } from '@earendil-works/pi-durable'
import { cn } from 'cn'
import { CornerDownRightIcon, ListPlusIcon, LoaderCircleIcon, XIcon } from 'lucide-react'
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react'
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
import { errorMessage } from '../sdk/format.ts'
import { events } from '../sdk/events.ts'
import {
  TranscriptContext,
  useConversation,
  useExtensions,
  useIntro,
  useModels,
  useStore,
} from '../sdk/hooks.ts'
import { isMac } from '../sdk/keys.ts'
import { touchKeyboard } from '../sdk/viewport.ts'
import type { ModelsResponse } from '../../../shared/protocol.ts'
import { ExtensionBoundary, Slot } from './boundary.tsx'
import { composerRenderers, inboxRenderer } from '../sdk/registry.ts'
import { column } from './layout.ts'
import { pasted, ShownInput, useComposerInput } from './composer-input.tsx'
import { storeImages, storedImages } from './draft-images.ts'
import {
  atFirstLine,
  mergedSteer,
  previewParts,
  recallQueued,
  recalledText,
  spliced,
  withdrawQueuedSteer,
} from './queued.ts'

const alt = isMac ? '⌥' : 'Alt'

function blockedBy(agent: AgentState, models: ModelsResponse | undefined): string | undefined {
  const model = agent.model
  if (!model) return 'No model configured. Log in with pi, or pick a model.'
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
  return typeof content === 'string'
    ? content
    : content.flatMap((block) => (block.type === 'text' ? [block.text] : ['[image]'])).join(' ')
}

/** A queued text on one line that keeps its start and its end: the head gives way, the tail always shows. */
function QueuedPreview({ text }: { text: string }) {
  const parts = previewParts(text)
  return (
    <span className="flex min-w-0 flex-1" title={text}>
      <span className="min-w-0 truncate">{parts.head}</span>
      {parts.tail && <span className="shrink-0 whitespace-pre">{parts.tail}</span>}
    </span>
  )
}

/** Steers and follow-ups waiting for the run, as Pi lists them above its editor. */
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

/** Where a composer sends instead of its conversation, such as a new side chat: `send` gets the text; images stay. */
export interface ComposerTarget {
  placeholder: string
  send: (text: string) => Promise<unknown>
}
const ComposerTargetContext = createContext<ComposerTarget | undefined>(undefined)
/** Redirects the composer inside it to `to` while it is set; a composer renderer wraps `core` in it. */
export function ComposerRedirect({ to, children }: { to?: ComposerTarget; children: ReactNode }) {
  return <ComposerTargetContext value={to}>{children}</ComposerTargetContext>
}

export function Composer({ dock }: { dock?: boolean }) {
  const { id, entries } = useConversation()
  // Keyed by the conversation it is for, also while that one loads: one mount per switch, not one for the loading state.
  const scoped = useContext(ConversationIdContext)
  const requested = useStore((state) => state.requested)
  const renderers = composerRenderers(useExtensions())
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
    <ConversationComposer dock={dock} key={id ?? scoped ?? requested} />,
  )
  return <TranscriptContext value={entries}>{core}</TranscriptContext>
}

type Draft = {
  text: string
  images: { data: string; mimeType: string }[]
  error?: string
  sending: boolean
  revision: number
}

// In-flight submissions and retryable failures belong to the conversation, not its mounted editor.
const drafts = new Map<number | undefined, ReturnType<typeof createDraft>>()
function createDraft(id: number | undefined) {
  const key = id === undefined ? undefined : `ultimate.draft.${id}`
  let value: Draft = {
    text: key ? (localStorage.getItem(key) ?? '') : '',
    images: key ? storedImages(key) : [],
    sending: false,
    revision: 0,
  }
  const listeners = new Set<() => void>()
  return {
    key,
    get: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set: (change: Partial<Draft>) => {
      const images = value.images
      value = { ...value, ...change }
      if (key && value.images !== images) storeImages(key, value.images)
      for (const listener of listeners) listener()
    },
  }
}

function getDraft(id: number | undefined) {
  if (!drafts.has(id)) drafts.set(id, createDraft(id))
  return drafts.get(id)!
}

/** Replace conversation `id`'s draft with `text`, as typing it would; the caller focuses the composer. */
export function fillComposer(id: number, text: string) {
  const draft = getDraft(id)
  draft.set({ text, revision: draft.get().revision + 1 })
  if (draft.key) localStorage.setItem(draft.key, text)
}

/**
 * Insert `text` into conversation `id`'s draft at its editor's cursor (or at the end without one), with a space on
 * each side where the neighbouring text needs one, as typing it would, and focus the editor it lands in.
 */
export function insertIntoComposer(id: number, text: string) {
  const draft = getDraft(id)
  const current = draft.get().text
  const editor = document.querySelector<HTMLTextAreaElement>(`textarea[data-conversation="${id}"]`)
  const start = editor?.selectionStart ?? current.length
  const end = editor?.selectionEnd ?? current.length
  const { text: next, cursor } = spliced(current, start, end, text)
  draft.set({ text: next, revision: draft.get().revision + 1 })
  if (draft.key) localStorage.setItem(draft.key, next)
  editor?.focus()
  // The cursor follows the inserted text once React has rendered the new value.
  requestAnimationFrame(() => editor?.setSelectionRange(cursor, cursor))
}

function clearDraft(
  draft: ReturnType<typeof createDraft>,
  snapshot: { text: string; revision: number },
) {
  const stored = draft.key ? (localStorage.getItem(draft.key) ?? '') : ''
  if (draft.get().revision !== snapshot.revision) return
  if (draft.key && stored === snapshot.text) localStorage.removeItem(draft.key)
  draft.set({ text: stored === snapshot.text ? '' : stored })
}

function ConversationComposer({ dock }: { dock?: boolean }) {
  const { id, agent, busy, loading, inbox } = useConversation()
  const queued = inbox.filter((item) => item.mode !== 'write')
  const scoped = useContext(ConversationIdContext)
  const target = useContext(ComposerTargetContext)
  const intro = useIntro()
  const draft = getDraft(id)
  const { text, images, error, sending } = useSyncExternalStore(draft.subscribe, draft.get)
  const setError = (message: string | undefined) => draft.set({ error: message })
  const setImages = (change: (images: Draft['images']) => Draft['images']) =>
    draft.set({ images: change(draft.get().images), revision: draft.get().revision + 1 })
  const { paste, add, reading, pending } = useImagePaste({
    images,
    setImages,
    setError,
    disabled: () => loading || draft.get().sending,
  })
  const composerInput = useComposerInput({
    conversationId: id,
    insert: (inserted) => {
      if (id !== undefined) insertIntoComposer(id, inserted)
    },
    addImages: add,
    setError,
    disabled: loading || sending,
  })
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
  const blocked = loading ? undefined : blockedBy(agent, models)
  const empty = !text.trim() && images.length === 0

  async function send(whenBusy?: 'steer' | 'followUp') {
    if (loading || empty || blocked || draft.get().sending || pending.current || id === undefined)
      return
    const submitted = draft.get()
    if (target && images.length) {
      setError('Images stay here: remove them to send elsewhere')
      return
    }
    draft.set({ sending: true, error: undefined })
    const mode = busy ? (whenBusy ?? 'steer') : undefined
    let input = { text: text.trim(), images }
    let previous: typeof input | undefined
    try {
      if (target) await target.send(input.text)
      else {
        // A steer queued behind another joins it as one: the run reads a single steer at its next boundary.
        previous = mode === 'steer' ? await withdrawQueuedSteer(api, id, inbox) : undefined
        if (previous) input = mergedSteer(previous, input)
        // Sending means following the run from here, wherever the reader had scrolled to.
        events.emit('ultimate:sent', { conversationId: id })
        await api.submit(input.text, mode, id, input.images)
      }
      clearDraft(draft, submitted)
      if (draft.get().images === submitted.images) draft.set({ images: [] })
    } catch (failure) {
      if (key && draft.get().revision === submitted.revision)
        draft.set({ text: localStorage.getItem(key) ?? '' })
      // A steer withdrawn for a merge that then failed to send would be lost: it comes back into the draft.
      if (previous) {
        update(mergedSteer(previous, { text: draft.get().text, images: [] }).text)
        setImages((current) => [...previous!.images, ...current])
      }
      setError(errorMessage(failure))
    } finally {
      draft.set({ sending: false })
    }
  }
  /** ↑ on the first line brings every queued input back into the editor to edit and send again. */
  async function recall() {
    if (loading || draft.get().sending || id === undefined || queued.length === 0) return
    draft.set({ sending: true, error: undefined })
    try {
      const recalled = await recallQueued(api, id, queued)
      update(recalledText(draft.get().text, recalled))
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
      // oxlint-disable-next-line typescript/no-floating-promises -- recall catches failures and displays them in the draft's error state.
      void recall()
      return
    }
    if (event.key !== 'Enter' || event.shiftKey) return
    // A touch keyboard's return key writes a new line; the send button sends.
    if (touchKeyboard()) return
    event.preventDefault()
    // oxlint-disable-next-line typescript/no-floating-promises -- send catches submission failures and displays them in the draft's error state.
    void send(event.altKey ? 'followUp' : 'steer')
  }

  return (
    // Only the shown conversation's composer takes typing shortcuts (Escape, Shift+Tab): they act on that conversation.
    <div
      data-composer-target={scoped === undefined ? 'conversation' : 'scope'}
      className={cn(column(dock), 'pb-2')}
      ref={composerInput.ref}
    >
      <Inbox items={inbox} />
      {composerInput.shown && <ShownInput shown={composerInput.shown} />}
      <PromptInput
        onSubmit={(event) => {
          event.preventDefault()
          // oxlint-disable-next-line typescript/no-floating-promises -- send catches submission failures and displays them in the draft's error state.
          void send()
        }}
      >
        <ImagePreviews
          images={images}
          disabled={loading || sending || reading}
          remove={(index) => setImages((current) => current.filter((_, i) => i !== index))}
        />
        <PromptInputTextarea
          autoFocus={!touchKeyboard()}
          readOnly={loading || sending}
          onPaste={(event) => {
            // A handler that takes the paste replaces the composer's own handling of it.
            if (composerInput.took(pasted(event))) {
              event.preventDefault()
              return
            }
            // oxlint-disable-next-line typescript/no-floating-promises -- the image hook catches its own failures into the draft's error state.
            void paste(event)
          }}
          id={scoped === undefined ? 'composer-input' : `composer-input-${scoped}`}
          data-conversation={id}
          onChange={(event) => update(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            target?.placeholder ??
            (busy
              ? 'Steer the run, or queue a follow-up…'
              : (intro?.placeholder ?? 'Ask Ultimate to change something…'))
          }
          value={text}
        />
        <PromptInputFooter className="@container">
          {/* The toolbar gives way first, so Send and the composer actions always stay in reach. */}
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
                disabled={loading || empty || !!blocked || sending || reading}
                aria-label={loading ? 'Loading conversation' : 'Send'}
                title={
                  loading
                    ? 'Loading conversation'
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
      <div className="flex items-center gap-3 overflow-hidden pt-1.5 font-mono text-[11px] whitespace-nowrap text-muted-foreground empty:hidden">
        <Slot name="composer.status" variant="inline" />
      </div>
    </div>
  )
}
