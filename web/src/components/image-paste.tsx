import { cn } from 'cn'
import { XIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ClipboardEvent, DragEvent } from 'react'
import { ToolImage } from '@/components/ai/tool'
import { imageMimeTypes, maxImages } from '../../../shared/protocol.ts'
import { errorMessage } from '../sdk/format.ts'
import { fitImage } from './image-resize.ts'

/** An attached image; `note` says how it was resized and stays in the composer, never sent. */
export type PastedImage = { data: string; mimeType: string; note?: string }

export function useImagePaste({
  images,
  setImages,
  setError,
  disabled,
}: {
  images: PastedImage[]
  setImages: (change: (images: PastedImage[]) => PastedImage[]) => void
  setError: (message: string | undefined) => void
  disabled: () => boolean
}) {
  const [reading, setReading] = useState(false)
  const pending = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  async function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (disabled()) {
      event.preventDefault()
      return
    }
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .flatMap((item) => {
        const file = item.getAsFile()
        return file ? [file] : []
      })
    if (!files.length) return
    event.preventDefault()
    await add(files)
  }

  /** Attach the images dropped on the editor; the page itself never navigates to a dropped file (`main.tsx`). */
  async function drop(event: DragEvent<HTMLElement> | globalThis.DragEvent) {
    const files = Array.from(event.dataTransfer?.files ?? []).filter((file) =>
      file.type.startsWith('image/'),
    )
    if (files.length) await add(files)
  }

  async function add(files: readonly File[]) {
    if (pending.current || disabled()) return
    const supported = files.filter((file) => imageMimeTypes.includes(file.type))
    const accepted = supported.slice(0, Math.max(0, maxImages - images.length))
    const problems = [
      ...(supported.length < files.length ? ['Only PNG, JPEG, WebP and GIF images attach.'] : []),
      ...(accepted.length < supported.length ? [`Attach up to ${maxImages} images.`] : []),
    ]
    setError(problems.join(' ') || undefined)
    if (!accepted.length) return
    pending.current = true
    setReading(true)
    try {
      const results = await Promise.allSettled(accepted.map(read))
      const added = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      )
      const failed = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      )
      if (!alive.current) return
      setImages((current) => [...current, ...added])
      if (failed.length) setError([...problems, ...failed.map(errorMessage)].join(' '))
    } finally {
      pending.current = false
      if (alive.current) setReading(false)
    }
  }

  return { paste, drop, reading, pending }
}

/** `file` fitted to the attachment limits, as base64. */
async function read(file: File): Promise<PastedImage> {
  const { blob, note } = await fitImage(file)
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
  return { data, mimeType: blob.type, ...(note && { note }) }
}

export function ImagePreviews({
  images,
  remove,
  disabled,
  className,
}: {
  images: PastedImage[]
  remove: (index: number) => void
  disabled: boolean
  className?: string
}) {
  return images.length > 0 ? (
    <div className={cn('flex flex-wrap gap-2 px-3 pt-3', className)}>
      {images.map((image, index) => (
        <div
          className="relative w-38 rounded-md border border-border/80 bg-terminal p-1"
          // oxlint-disable-next-line react/no-array-index-key -- Pasted images have no id and may repeat.
          key={index}
        >
          <ToolImage
            alt={`Pasted image ${index + 1}`}
            className="flex h-24 w-full items-center justify-center border-0 [&_img]:max-h-24"
            image={image}
          />
          {image.note && (
            <p
              className="mt-1 pb-0.5 text-center text-[11px] leading-4 text-muted-foreground"
              title={image.note}
            >
              {image.note.split(' · ').map((line) => (
                <span className="block whitespace-nowrap" key={line}>
                  {line}
                </span>
              ))}
            </p>
          )}
          <button
            aria-label={`Remove image ${index + 1}`}
            className="absolute -top-2 -right-2 flex size-5 cursor-pointer items-center justify-center rounded-full border bg-background hover:bg-accent"
            disabled={disabled}
            onClick={() => remove(index)}
            type="button"
          >
            <XIcon className="size-3" />
          </button>
        </div>
      ))}
    </div>
  ) : null
}
