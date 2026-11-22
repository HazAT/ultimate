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
import { imageMimeTypes, maxImages } from '../../../shared/protocol.ts'
import type { DraftFile, PastedImage } from './attachments.ts'

export type Upload = NonNullable<typeof FileUpload.value>

export function createAttach(options: {
  images: Accessor<readonly PastedImage[]>
  setImages: (change: (images: PastedImage[]) => PastedImage[]) => void
  setFiles: (change: (files: DraftFile[]) => DraftFile[]) => void
  setError: (message: string | undefined) => void
  disabled: () => boolean
  upload: Accessor<Upload | undefined>
}) {
  const [reading, setReading] = createSignal(false)
  let pending = false
  let alive = true
  onCleanup(() => {
    alive = false
  })

  function send(files: readonly File[], { upload: put, maxBytes }: Upload) {
    const fitting = files.filter((file) => file.size <= maxBytes)
    for (const file of fitting) {
      const id = crypto.randomUUID()
      const mimeType = file.type || 'application/octet-stream'
      const name = file.name || 'file'
      options.setFiles((current) => [
        ...current,
        { id, name, size: formatBytes(file.size), mimeType, path: '' },
      ])
      put(file).then(
        (path) =>
          options.setFiles((current) =>
            current.map((item) => (item.id === id ? { ...item, path } : item)),
          ),
        (failure: unknown) => {
          options.setFiles((current) => current.filter((item) => item.id !== id))
          options.setError(`${name}: ${errorMessage(failure)}`)
        },
      )
    }
    return fitting.length < files.length
      ? [`Files up to ${formatBytes(maxBytes).replace('.0 ', ' ')} attach.`]
      : []
  }

  async function attach(dropped: readonly File[]) {
    if (pending || options.disabled()) return
    const upload = options.upload()
    const files = upload ? dropped.filter((file) => imageMimeTypes.includes(file.type)) : dropped
    const others = dropped.filter((file) => !files.includes(file))
    const supported = files.filter((file) => imageMimeTypes.includes(file.type))
    const accepted = supported.slice(0, Math.max(0, maxImages - options.images().length))
    const problems = [
      ...(upload && others.length ? send(others, upload) : []),
      ...(supported.length < files.length ? ['Only PNG, JPEG, WebP and GIF images attach.'] : []),
      ...(accepted.length < supported.length ? [`Attach up to ${maxImages} images.`] : []),
    ]
    options.setError(problems.join(' ') || undefined)
    if (!accepted.length) return
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
      if (!alive) return
      options.setImages((current) => [...current, ...added])
      if (failed.length) options.setError([...problems, ...failed.map(errorMessage)].join(' '))
    } finally {
      pending = false
      if (alive) setReading(false)
    }
  }

  const accepts = (file: { type: string }) => !!options.upload() || file.type.startsWith('image/')

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
    await attach(files)
  }

  async function drop(event: DragEvent) {
    const files = Array.from(event.dataTransfer?.files ?? []).filter(accepts)
    if (files.length) await attach(files)
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
                aria-label={`Remove image ${index() + 1}`}
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
              busy={!file().path}
              mimeType={file().mimeType}
              name={file().name}
              note={
                file().path
                  ? `${file().size} · ${typeLabel(file().name, file().mimeType)}`
                  : 'Uploading…'
              }
              title={file().path || file().name}
            >
              <Button
                aria-label={`Remove file ${index() + 1}: ${file().name}`}
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
