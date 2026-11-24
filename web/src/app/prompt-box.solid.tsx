import { ArrowUp, LoaderCircle, Paperclip } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { cn } from 'cn'
import { createEffect, createMemo, createSignal, onSettled, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Form } from '@/components/ui/form.solid.tsx'
import { Textarea } from '@/components/ui/input.solid.tsx'
import { Provided } from '../sdk/parts.solid.tsx'
import type { PromptBoxProps } from '../sdk/types.ts'
import {
  Dictation,
  errorMessage,
  FileUpload,
  formatBytes,
  PromptRecorder,
  touchKeyboard,
  writerNow,
  writingAs,
} from '../sdk/hooks.ts'
import { useProvided } from '../sdk/contribution.solid.tsx'
import { imageMimeTypes } from '../../../shared/protocol.ts'
import { Attached, createAttach } from './attach.solid.tsx'
import { withAttachments } from './attachments.ts'
import type { DraftFile, PastedImage } from './attachments.ts'
import {
  clearDraft,
  createLocalDraft,
  getDraft,
  insertIntoDraft,
  setDraftText,
  storedText,
} from './drafts.ts'
import type { Draft } from './drafts.ts'

const androidImagePasteStyle: JSX.CSSProperties = {
  '-webkit-user-modify': 'read-write',
}
const iconButton =
  'flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground pointer-coarse:size-9'
const submitClass =
  'size-7 rounded-md pointer-coarse:relative pointer-coarse:size-9 pointer-coarse:after:absolute pointer-coarse:after:-inset-1'

function createDraftState(id: () => number | string | undefined) {
  const local = createLocalDraft()
  const draft = createMemo(() => (id() === undefined ? local : getDraft(id())))
  const [changes, setChanges] = createSignal(0)
  const value = createMemo((): Draft => {
    changes()
    return draft().get()
  })
  createEffect(draft, (current) => {
    const unsubscribe = current.subscribe(() => setChanges((n) => n + 1))
    const stored = storedText(current)
    if (stored !== current.get().text)
      current.set({ text: stored, revision: current.get().revision + 1 })
    return unsubscribe
  })
  return { draft, value }
}

export function PromptBox(props: PromptBoxProps) {
  const { draft, value } = createDraftState(() => props.draft)
  const text = () => value().text
  const images = () => value().images
  const files = () => value().files
  const sending = () => value().sending
  const upload = useProvided(FileUpload, () => null)
  const allowsFiles = () => props.accepts?.files !== false
  const allowsImages = () => props.accepts?.images !== false
  const uploadTarget = () => (allowsFiles() ? upload() : undefined)
  const [level, setLevel] = createSignal<number>()
  const [recording, setRecording] = createSignal(false)
  const [dragging, setDragging] = createSignal(false)

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
    disabled: () => !!props.loading || draft().get().sending,
    upload: uploadTarget,
    inlineImages: allowsImages,
  })
  const uploading = () => files().some((file) => !file.path)
  const empty = () =>
    !text().trim() && images().length === 0 && files().length === 0 && !props.ready?.()
  const inert = () => !!props.loading || sending() || attach.reading()
  const canAttach = () => allowsImages() || !!uploadTarget()

  async function send(how?: 'followUp') {
    const current = draft()
    if (
      props.loading ||
      empty() ||
      props.blocked ||
      uploading() ||
      current.get().sending ||
      attach.busy()
    )
      return
    const submitted = current.get()
    const who = writerNow()
    current.set({ sending: true, error: undefined })
    const input = {
      text: withAttachments(submitted.text.trim(), submitted.files),
      images: submitted.images.map(({ data, mimeType }) => ({
        data,
        mimeType,
      })),
    }
    const submit = props.onSubmit
    try {
      await writingAs(who, () => submit(input, how))
      clearDraft(current, submitted)
      if (current.get().images === submitted.images) current.set({ images: [] })
      if (current.get().files === submitted.files) current.set({ files: [] })
    } catch (failure) {
      if (current.key && current.get().revision === submitted.revision)
        current.set({ text: localStorage.getItem(current.key) ?? '' })
      setError(errorMessage(failure))
    } finally {
      current.set({ sending: false })
    }
  }

  function onKeyDown(event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) {
    if (event.isComposing) return
    if (props.onKeyDown?.(event)) return
    if (event.key !== 'Enter' || event.shiftKey) return
    const touchReturnInsertsNewline = touchKeyboard() && !event.metaKey && !event.ctrlKey
    if (touchReturnInsertsNewline) return
    event.preventDefault()
    void send(event.altKey ? 'followUp' : undefined)
  }

  let editor: HTMLTextAreaElement | undefined
  onSettled(() => {
    if (props.autofocus && !touchKeyboard()) editor?.focus()
  })
  onSettled(() => {
    if (!props.pageDrop) return undefined
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
      const ignoreNonFileOrBoxOwnedDrop =
        !carriesFiles(event) || on?.closest('[data-ui="prompt-box"]')
      if (ignoreNonFileOrBoxOwnedDrop) return
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

  const signal = () =>
    recording()
      ? 'recording'
      : level() !== undefined
        ? 'listening'
        : props.running
          ? 'running'
          : 'idle'

  return (
    <Form
      class={cn(
        'group/keel relative flex w-full flex-col overflow-hidden rounded-lg border border-border bg-card transition-colors focus-within:border-foreground/25',
        dragging() && 'ring-2 ring-brand/60',
      )}
      data-signal={signal()}
      data-ui="prompt-box"
      onDrop={(event) => {
        if (!event.dataTransfer?.types.includes('Files')) return
        event.preventDefault()
        void attach.drop(event)
      }}
    >
      <Attached
        disabled={inert()}
        files={files()}
        images={images()}
        remove={(index) => setImages((current) => current.filter((_, at) => at !== index))}
        removeFile={(fileId) => setFiles((current) => current.filter((file) => file.id !== fileId))}
      />
      <Textarea
        aria-label={`Prompt for ${props.name}`}
        autoResize
        class="block max-h-80 min-h-0 w-full resize-none rounded-none border-0 bg-transparent px-3.5 pt-3 pb-1 font-sans text-[14px] leading-relaxed outline-none focus-visible:border-0 focus-visible:ring-0 disabled:cursor-not-allowed"
        data-conversation={props.conversation}
        id={props.id}
        onKeyDown={onKeyDown}
        onPaste={(event) => void attach.paste(event)}
        onValueChange={(next) => setDraftText(draft(), next)}
        placeholder={props.placeholder}
        readonly={!!props.loading || sending()}
        ref={(element) => {
          editor = element
        }}
        rows={1}
        style={touchKeyboard() ? androidImagePasteStyle : undefined}
        value={text()}
      />
      <div class="@container flex items-center justify-between gap-2 px-2 pt-1 pb-2">
        <div class="flex min-w-0 items-center gap-1 overflow-hidden">{props.toolbar}</div>
        <div class="flex max-w-full min-w-0 shrink-0 items-center gap-0.5">
          <span
            class={cn(
              'mr-1.5 truncate font-mono text-[11px]',
              value().error || props.blocked ? 'text-error' : 'text-muted-foreground/70',
            )}
          >
            {value().error ?? props.blocked ?? props.hint}
          </span>
          <Show when={canAttach()}>
            <label
              aria-label={uploadTarget() ? 'Attach files' : 'Attach images'}
              class={cn(
                iconButton,
                inert() && 'pointer-events-none opacity-50 hover:bg-transparent',
              )}
              title={
                uploadTarget()
                  ? `Attach files: ${allowsImages() ? 'images inline, others' : 'files'} up to ${formatBytes(uploadTarget()!.maxBytes).replace('.0 ', ' ')}`
                  : 'Attach images'
              }
            >
              <Paperclip class="size-3.5" />
              <input
                accept={uploadTarget() ? undefined : imageMimeTypes.join(',')}
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
          </Show>
          <Provided
            input={{
              name: props.name,
              attach: (picked: readonly File[]) => void attach.attach(picked),
              recording: setRecording,
            }}
            last
            point={PromptRecorder}
          />
          <Show when={props.dictation !== false}>
            <Provided
              input={{
                get name() {
                  return props.name
                },
                get conversation() {
                  return props.conversation
                },
                get insert() {
                  const target = draft()
                  return (words: string) =>
                    insertIntoDraft(target, draft() === target ? editor : undefined, words)
                },
                level: setLevel,
              }}
              last
              point={Dictation}
            />
          </Show>
          {props.actions}
          <Show when={!props.running || !empty()}>
            <Button
              aria-label={props.loading ? `Loading ${props.name}` : `Send prompt to ${props.name}`}
              class={cn('ml-1', submitClass, props.loading && 'bg-muted text-muted-foreground')}
              disabled={
                !!props.loading ||
                empty() ||
                !!props.blocked ||
                sending() ||
                attach.reading() ||
                uploading()
              }
              onClick={() => send()}
              size="icon"
              title={
                props.loading
                  ? `Loading ${props.name}`
                  : uploading()
                    ? 'Uploading files…'
                    : (props.sendTitle ?? 'Send (Enter)')
              }
              type="submit"
            >
              <Show when={props.loading} fallback={<ArrowUp class="size-4" />}>
                <LoaderCircle class="size-4 motion-safe:animate-spin" />
              </Show>
            </Button>
          </Show>
        </div>
      </div>
      <Hairline level={level()} signal={signal()} />
    </Form>
  )
}

function Hairline(props: {
  signal: 'idle' | 'running' | 'listening' | 'recording'
  level: number | undefined
}) {
  return (
    <span
      aria-hidden="true"
      class={cn(
        'pointer-events-none absolute inset-x-0 bottom-0 h-[2px] transition-colors',
        props.signal === 'idle' && 'bg-brand/0 group-focus-within/keel:bg-brand/70',
        props.signal === 'running' &&
          'bg-[linear-gradient(90deg,transparent,var(--brand),transparent)] bg-size-[200%_100%] motion-safe:animate-sweep',
        props.signal === 'recording' && 'bg-error',
      )}
      data-ui="prompt-hairline"
    >
      <Show when={props.signal === 'listening'}>
        <span
          class="absolute inset-0 origin-center bg-brand transition-transform duration-75"
          style={{
            transform: `scaleX(${0.08 + 0.92 * (props.level ?? 0)})`,
          }}
        />
      </Show>
    </span>
  )
}
