import { ArrowUp, LoaderCircle, Paperclip } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { cn } from 'cn'
import { createEffect, createMemo, createSignal, onCleanup, onSettled, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Form } from '@/components/ui/form.solid.tsx'
import { Textarea } from '@/components/ui/input.solid.tsx'
import { Provided } from '../sdk/parts.solid.tsx'
import { escapeHeld } from '../sdk/shortcuts.ts'
import type { PromptBoxProps, UploadSource } from '../sdk/types.ts'
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
import { useAllProvided } from '../sdk/contribution.solid.tsx'
import { imageMimeTypes } from '../../../shared/protocol.ts'
import { Attached, cancelUpload, createAttach } from './attach.solid.tsx'
import { attached, withAttachments } from './attachments.ts'
import type { DraftFile, PastedImage } from './attachments.ts'
import {
  boundDraft,
  clearDraft,
  createLocalDraft,
  getDraft,
  insertIntoDraft,
  setDraftText,
  storedText,
} from './drafts.ts'
import type { Draft, DraftStore } from './drafts.ts'

const androidImagePasteStyle: JSX.CSSProperties = {
  '-webkit-user-modify': 'read-write',
}
const iconButton =
  'flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground pointer-coarse:size-9'
const submitClass =
  'size-7 rounded-md pointer-coarse:relative pointer-coarse:size-9 pointer-coarse:after:absolute pointer-coarse:after:-inset-1'

function createDraftState(props: PromptBoxProps) {
  const local = createLocalDraft()
  const bound = boundDraft(
    readValue(props),
    writeValue(props),
    cancelUpload,
    reportUploading(props),
  )
  onCleanup(bound.dispose)
  const draft = createMemo<DraftStore>(() =>
    props.onValue ? bound : props.draft === undefined ? local : getDraft(props.draft),
  )
  const [changes, setChanges] = createSignal(0)
  const value = createMemo((): Draft => {
    changes()
    void props.value
    return draft().get()
  })
  createEffect(draft, (current) => {
    const unsubscribe = current.subscribe(() => setChanges((n) => n + 1))
    if (!current.key) return unsubscribe
    const stored = storedText(current)
    if (stored !== current.get().text)
      current.set({ text: stored, revision: current.get().revision + 1 })
    return unsubscribe
  })
  return { draft, value, bound }
}

const readValue = (props: PromptBoxProps) => () => props.value ?? ''
const writeValue = (props: PromptBoxProps) => (next: string) => props.onValue?.(next)
const reportUploading = (props: PromptBoxProps) => (busy: boolean) => props.onUploading?.(busy)
function sent(target: DraftStore, gone: Promise<void>) {
  return new Promise<boolean>((resolve) => {
    if (!target.get().sending) return resolve(true)
    const stop = target.subscribe(() => {
      if (target.get().sending) return
      stop()
      resolve(true)
    })
    void gone.then(() => {
      stop()
      resolve(false)
    })
  })
}

export function PromptBox(props: PromptBoxProps) {
  const { draft, value, bound } = createDraftState(props)
  const minimal = () => !!props.minimal
  const text = () => value().text
  const images = () => value().images
  const files = () => value().files
  const sending = () => value().sending
  const provided = useAllProvided(FileUpload, () => null)
  const allowsFiles = () => props.accepts?.files !== false
  const allowsImages = () => props.accepts?.images !== false
  const uploads = createMemo(() =>
    allowsFiles() ? provided().filter((upload) => upload !== undefined) : [],
  )
  const general = () => uploads().findLast((upload) => !upload.accepts)
  const pickable = () =>
    general()
      ? undefined
      : [
          ...(allowsImages() ? imageMimeTypes : []),
          ...uploads().map((upload) => `${upload.accepts}*`),
        ].join(',')
  let mounted = true
  let unmount!: () => void
  const gone = new Promise<void>((resolve) => {
    unmount = resolve
  })
  onCleanup(() => {
    mounted = false
    unmount()
  })
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
    disabled: () => !!props.loading || !!props.disabled || draft().get().sending,
    uploads,
    inlineImages: allowsImages,
    conversation: () => props.conversation,
  })
  const uploading = () => files().some((file) => !attached(file))
  const empty = () =>
    !text().trim() && images().length === 0 && files().length === 0 && !props.ready?.()
  const inert = () => !!props.loading || !!props.disabled || sending() || attach.reading()
  const canAttach = () => allowsImages() || uploads().length > 0

  async function send(how?: 'followUp') {
    const current = draft()
    if (
      props.loading ||
      props.disabled ||
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
      if (current === bound) return
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
    if (event.isComposing || (event.key === 'Escape' && escapeHeld())) return
    if (props.onKeyDown?.(event)) return
    if (event.key !== 'Enter' || event.shiftKey) return
    const touchReturnInsertsNewline =
      !props.minimal && touchKeyboard() && !event.metaKey && !event.ctrlKey
    if (touchReturnInsertsNewline) return
    event.preventDefault()
    void send(event.altKey ? 'followUp' : undefined)
  }

  const label = () => props.label ?? `Prompt for ${props.name}`
  const attachName = () =>
    `${uploads().length ? 'Attach files' : 'Attach images'}${props.minimal ? ` to ${props.name}` : ''}`

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

  const attachButton = () => (
    <Show when={canAttach()}>
      <label
        aria-label={attachName()}
        class={cn(iconButton, inert() && 'pointer-events-none opacity-50 hover:bg-transparent')}
        title={
          general()
            ? `Attach files: ${allowsImages() ? 'images inline, others' : 'files'} up to ${formatBytes(general()!.maxBytes).replace('.0 ', ' ')}`
            : uploads().length
              ? 'Attach files'
              : 'Attach images'
        }
      >
        <Paperclip class="size-3.5" />
        <input
          accept={pickable()}
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
  )
  const controls = () => (
    <>
      {attachButton()}
      <Show when={canAttach()}>
        <Provided
          input={{
            name: props.name,
            draft: props.draft ?? `box:${props.name}`,
            attach: async (picked: readonly File[], source: UploadSource = 'recording') => {
              const target = draft()
              const settled = await sent(target, gone)
              return settled && mounted && draft() === target && attach.attach(picked, source)
            },
            recording: setRecording,
          }}
          last
          point={PromptRecorder}
        />
      </Show>
      <Show when={props.dictation !== false && !props.disabled}>
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
            get sink() {
              return props.dictation || undefined
            },
          }}
          last
          point={Dictation}
        />
      </Show>
      {props.actions}
      <Show when={props.sendButton !== false && (!props.running || !empty())}>
        <Button
          aria-label={
            props.loading
              ? `Loading ${props.name}`
              : (props.sendLabel ?? `Send prompt to ${props.name}`)
          }
          class={cn(
            'ml-1',
            submitClass,
            minimal() && 'size-6',
            props.loading && 'bg-muted text-muted-foreground',
          )}
          disabled={
            !!props.loading ||
            !!props.disabled ||
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
          type={minimal() ? 'button' : 'submit'}
        >
          <Show
            when={props.loading}
            fallback={<ArrowUp class={minimal() ? 'size-3.5' : 'size-4'} />}
          >
            <LoaderCircle class="size-4 motion-safe:animate-spin" />
          </Show>
        </Button>
      </Show>
    </>
  )
  const status = () => value().error ?? props.blocked ?? props.hint
  const textarea = () => (
    <Textarea
      aria-label={label()}
      autoResize
      class={cn(
        'block min-h-0 w-full resize-none rounded-none border-0 bg-transparent font-sans leading-relaxed outline-none focus-visible:border-0 focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-60',
        minimal()
          ? 'max-h-60 min-w-48 flex-1 px-3 py-1.5 text-[13px]'
          : 'max-h-80 px-3.5 pt-3 pb-1 text-[14px]',
      )}
      data-conversation={props.conversation}
      data-resume={`prompt:${props.draft ?? props.name}`}
      disabled={!!props.disabled}
      id={props.id}
      onKeyDown={onKeyDown}
      onPaste={(event) => void attach.paste(event)}
      onValueChange={(next, details) => {
        if (setDraftText(draft(), next)) return
        details.cancel()
        const field = details.event?.target
        if (field instanceof HTMLTextAreaElement) field.value = text()
      }}
      placeholder={props.placeholder}
      readonly={!!props.loading || sending()}
      ref={(element) => {
        editor = element
        props.ref?.(element)
      }}
      rows={1}
      style={touchKeyboard() ? androidImagePasteStyle : undefined}
      value={text()}
    />
  )
  const frameClass = () =>
    cn(
      'group/keel relative flex w-full flex-col overflow-hidden rounded-lg border border-border bg-card transition-colors focus-within:border-foreground/25',
      minimal() && 'rounded-md bg-background/40',
      dragging() && 'ring-2 ring-brand/60',
    )
  const dropped = (event: DragEvent) => {
    if (!event.dataTransfer?.types.includes('Files')) return
    event.preventDefault()
    void attach.drop(event)
  }
  const chips = () => (
    <Attached
      disabled={inert()}
      files={files()}
      images={images()}
      name={minimal() ? props.name : undefined}
      remove={(index) => setImages((current) => current.filter((_, at) => at !== index))}
      removeFile={(fileId) => {
        cancelUpload(fileId)
        setFiles((current) => current.filter((file) => file.id !== fileId))
      }}
    />
  )

  return (
    <Show
      when={!minimal()}
      fallback={
        <div class="flex flex-col gap-1">
          <div
            class={frameClass()}
            data-minimal
            data-signal={signal()}
            data-ui="prompt-box"
            onDragOver={(event) => {
              if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
            }}
            onDrop={dropped}
          >
            {chips()}
            <div class="flex flex-wrap items-end justify-end gap-1">
              {textarea()}
              <div class="flex min-w-0 shrink-0 items-center gap-0.5 pr-1 pb-1">{controls()}</div>
            </div>
            <Hairline level={level()} signal={signal()} />
          </div>
          <Show when={value().error ?? props.blocked}>
            {(message) => (
              <p class="px-1 font-mono text-[11px] break-words text-error" role="alert">
                {message()}
              </p>
            )}
          </Show>
        </div>
      }
    >
      <Form class={frameClass()} data-signal={signal()} data-ui="prompt-box" onDrop={dropped}>
        {chips()}
        {textarea()}
        <div class="@container flex items-center justify-between gap-2 px-2 pt-1 pb-2">
          <div class="flex min-w-0 items-center gap-1 overflow-hidden">{props.toolbar}</div>
          <div class="flex max-w-full min-w-0 shrink-0 items-center gap-0.5">
            <span
              class={cn(
                'mr-1.5 truncate font-mono text-[11px]',
                value().error || props.blocked ? 'text-error' : 'text-muted-foreground/70',
              )}
            >
              {status()}
            </span>
            {controls()}
          </div>
        </div>
        <Hairline level={level()} signal={signal()} />
      </Form>
    </Show>
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
        'pointer-events-none absolute inset-x-0 bottom-0 h-[2px] overflow-hidden transition-colors',
        props.signal === 'idle' && 'bg-brand/0 group-focus-within/keel:bg-brand/70',
        props.signal === 'recording' && 'bg-error',
      )}
      data-ui="prompt-hairline"
    >
      <Show when={props.signal === 'running'}>
        <span class="absolute inset-y-0 left-0 w-2/5 bg-[linear-gradient(90deg,transparent,var(--brand),transparent)] motion-safe:animate-glide" />
      </Show>
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
