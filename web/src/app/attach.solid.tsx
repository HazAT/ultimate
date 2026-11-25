import { X } from '@lucide/solid'
import { createSignal, For, onCleanup, Show } from 'solid-js'
import type { Accessor } from 'solid-js'
import { ToolImage } from '@/components/ai/tool.solid.tsx'
import { FileChip } from '@/components/file-chip.solid.tsx'
import { typeLabel } from '@/components/file-kind.ts'
import { fitImage } from '@/components/image-resize.ts'
import { Button } from '@/components/ui/button.solid.tsx'
import { errorMessage, formatBytes } from '../sdk/hooks.ts'
import type { FileUpload } from '../sdk/hooks.ts'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { UploadSource } from '../sdk/types.ts'
import { imageMimeTypes, maxImages } from '../../../shared/protocol.ts'
import { attached, uploadFor } from './attachments.ts'
import type { DraftFile, PastedImage } from './attachments.ts'

export type Upload = NonNullable<typeof FileUpload.value>

const limit = (bytes: number) => formatBytes(bytes).replace('.0 ', ' ')
const inFlight = new Map<string, AbortController>()

export function cancelUpload(id: string) {
  inFlight.get(id)?.abort(new Error('Removed'))
  inFlight.delete(id)
}

export function createAttach(options: {
  images: Accessor<readonly PastedImage[]>
  setImages: (change: (images: PastedImage[]) => PastedImage[]) => void
  setFiles: (change: (files: DraftFile[]) => DraftFile[]) => void
  setError: (message: string | undefined) => void
  disabled: () => boolean
  uploads: Accessor<readonly Upload[]>
  inlineImages: Accessor<boolean>
  conversation: Accessor<ConversationId | undefined>
}) {
  const [reading, setReading] = createSignal(false)
  let pending = false
  let alive = true
  onCleanup(() => {
    alive = false
  })

  const change = (id: string, update: Partial<DraftFile>) =>
    options.setFiles((current) =>
      current.map((item) => (item.id === id ? { ...item, ...update } : item)),
    )

  function send(file: File, upload: Upload, source: UploadSource) {
    const id = crypto.randomUUID()
    const mimeType = file.type || 'application/octet-stream'
    const name = file.name || 'file'
    options.setFiles((current) => [
      ...current,
      { id, name, size: formatBytes(file.size), mimeType, path: '' },
    ])
    const controller = new AbortController()
    inFlight.set(id, controller)
    return upload
      .upload(file, {
        source,
        conversation: options.conversation(),
        status: (note, progress) => change(id, { note, progress }),
        signal: controller.signal,
      })
      .then(
        ({ path, line, note, image }) =>
          change(id, { path, line, note, image, progress: undefined }),
        (failure: unknown) => {
          options.setFiles((current) => current.filter((item) => item.id !== id))
          if (!controller.signal.aborted) options.setError(`${name}: ${errorMessage(failure)}`)
        },
      )
      .finally(() => inFlight.delete(id))
  }

  function sendAll(files: readonly File[], source: UploadSource) {
    const tooLarge = new Set<number>()
    const sent: Promise<void>[] = []
    for (const file of files) {
      const upload = uploadFor(options.uploads(), file.type)!
      if (file.size <= upload.maxBytes) sent.push(send(file, upload, source))
      else tooLarge.add(upload.maxBytes)
    }
    return { sent, problems: [...tooLarge].map((bytes) => `Files up to ${limit(bytes)} attach.`) }
  }

  async function attach(dropped: readonly File[], source: UploadSource = 'file') {
    const busyBoxRefuses = source !== 'recording' && (pending || options.disabled())
    if (busyBoxRefuses) return false
    const uploads = options.uploads()
    const uploadable = (file: File) =>
      !!uploadFor(uploads, file.type) &&
      !(options.inlineImages() && imageMimeTypes.includes(file.type))
    const files = options.inlineImages() ? dropped.filter((file) => !uploadable(file)) : []
    const others = dropped.filter(uploadable)
    const supported = files.filter((file) => imageMimeTypes.includes(file.type))
    const accepted = supported.slice(0, Math.max(0, maxImages - options.images().length))
    const uploading = sendAll(others, source)
    const problems = [
      ...uploading.problems,
      ...(supported.length < files.length ? ['Only PNG, JPEG, WebP and GIF images attach.'] : []),
      ...(accepted.length < supported.length ? [`Attach up to ${maxImages} images.`] : []),
    ]
    options.setError(problems.join(' ') || undefined)
    if (!accepted.length) {
      await Promise.all(uploading.sent)
      return true
    }
    pending = true
    setReading(true)
    try {
      const results = await Promise.allSettled(accepted.map(read))
      const added = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      )
      const failed = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      )
      if (!alive) return true
      options.setImages((current) => [...current, ...added])
      if (failed.length) options.setError([...problems, ...failed.map(errorMessage)].join(' '))
    } finally {
      pending = false
      if (alive) setReading(false)
    }
    await Promise.all(uploading.sent)
    return true
  }

  const accepts = (file: { type: string }) =>
    !!uploadFor(options.uploads(), file.type) ||
    (options.inlineImages() && file.type.startsWith('image/'))

  async function paste(event: ClipboardEvent) {
    if (options.disabled()) {
      event.preventDefault()
      return
    }
    const files = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === 'file' && accepts(item))
      .flatMap((item) => {
        const file = item.getAsFile()
        return file ? [file] : []
      })
    if (!files.length) return
    event.preventDefault()
    await attach(files, 'paste')
  }

  async function drop(event: DragEvent) {
    const files = Array.from(event.dataTransfer?.files ?? []).filter(accepts)
    if (files.length) await attach(files, 'drop')
  }

  return { paste, drop, attach, reading, busy: () => pending }
}

async function read(file: File): Promise<PastedImage> {
  const { blob, note: composerOnlyResizeNote } = await fitImage(file)
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () =>
      typeof reader.result === 'string'
        ? resolve(reader.result.split(',')[1])
        : reject(new Error('Could not read pasted image')),
    )
    reader.addEventListener('error', () => reject(new Error('Could not read pasted image')))
    reader.readAsDataURL(blob)
  })
  return {
    data,
    mimeType: blob.type,
    ...(composerOnlyResizeNote && { note: composerOnlyResizeNote }),
  }
}

const removeClass =
  'absolute -top-2 -right-2 size-5 rounded-full border bg-background p-0 text-foreground hover:bg-accent'

export function Attached(props: {
  images: readonly PastedImage[]
  files: readonly DraftFile[]
  name?: string
  disabled: boolean
  remove: (index: number) => void
  removeFile: (id: string) => void
}) {
  return (
    <Show when={props.images.length + props.files.length > 0}>
      <div class="flex flex-wrap gap-2 px-3 pt-3">
        <For each={props.images}>
          {(image, index) => (
            <div class="relative w-38 rounded-md border border-border/80 bg-terminal p-1">
              <ToolImage
                alt={`Pasted image ${index() + 1}`}
                class="flex h-24 w-full items-center justify-center border-0 [&_img]:max-h-24"
                image={image}
              />
              <Show when={image.note}>
                {(note) => (
                  <p
                    class="mt-1 pb-0.5 text-center text-[11px] leading-4 text-muted-foreground"
                    title={note()}
                  >
                    <For each={note().split(' · ')}>
                      {(line) => <span class="block whitespace-nowrap">{line}</span>}
                    </For>
                  </p>
                )}
              </Show>
              <Button
                aria-label={`Remove image ${index() + 1}${props.name ? ` from ${props.name}` : ''}`}
                class={removeClass}
                disabled={props.disabled}
                onClick={() => props.remove(index())}
                size={null}
                variant={null}
              >
                <X class="size-3" />
              </Button>
            </div>
          )}
        </For>
        <For each={props.files} keyed={(file) => file.id}>
          {(file, index) => (
            <FileChip
              busy={!attached(file())}
              image={file().image}
              mimeType={file().mimeType}
              name={file().name}
              note={
                file().note ??
                (attached(file())
                  ? `${file().size} · ${typeLabel(file().name, file().mimeType)}`
                  : 'Uploading…')
              }
              progress={file().progress}
              title={file().path || file().name}
            >
              <Button
                aria-label={`Remove file ${index() + 1}: ${file().name}${props.name ? ` from ${props.name}` : ''}`}
                class={removeClass}
                disabled={props.disabled}
                onClick={() => props.removeFile(file().id)}
                size={null}
                variant={null}
              >
                <X class="size-3" />
              </Button>
            </FileChip>
          )}
        </For>
      </div>
    </Show>
  )
}
