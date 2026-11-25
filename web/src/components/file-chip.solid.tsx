import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  LoaderCircle,
} from '@lucide/solid'
import { dynamic } from '@solidjs/web'
import type { JSX } from '@solidjs/web'
import { cn } from 'cn'
import { createEffect, createMemo, createSignal, Show } from 'solid-js'
import { fileChipClass, fileKind } from './file-kind.ts'

const icons = {
  image: FileImage,
  audio: FileAudio,
  video: FileVideo,
  archive: FileArchive,
  sheet: FileSpreadsheet,
  code: FileCode,
  text: FileText,
  file: File,
}

export function FileChip(props: {
  name: string
  mimeType: string
  note: string
  title?: string
  busy?: boolean
  gone?: boolean
  progress?: number
  image?: string
  thumbnail?: Promise<Blob | undefined>
  children?: JSX.Element
}) {
  const Icon = dynamic(() => icons[fileKind(props.name, props.mimeType)])
  const [thumbnail, setThumbnail] = createSignal<{ of: Promise<unknown>; url: string }>()
  const made = createMemo(() => ({ pending: props.thumbnail }), {
    equals: (before, after) => before.pending === after.pending,
  })
  createEffect(made, ({ pending }) => {
    let url: string | undefined
    let gone = false
    void pending?.then((blob) => {
      if (gone || !blob) return
      url = URL.createObjectURL(blob)
      setThumbnail({ of: pending, url })
    })
    return () => {
      gone = true
      if (url) URL.revokeObjectURL(url)
    }
  })
  const shown = () => {
    const current = thumbnail()
    return current && current.of === made().pending ? current.url : undefined
  }
  const image = () => props.image ?? shown()
  return (
    <div
      class={cn(fileChipClass, props.gone && 'opacity-60')}
      data-ui="file-chip"
      title={props.title}
    >
      <div class="flex h-14 w-full items-center justify-center text-muted-foreground">
        <Show
          when={image()}
          fallback={
            <Show
              when={props.busy}
              fallback={<Icon aria-hidden="true" class="size-7" stroke-width={1.5} />}
            >
              <LoaderCircle aria-hidden="true" class="size-6 motion-safe:animate-spin" />
            </Show>
          }
        >
          {(src) => (
            <img
              alt=""
              class="h-14 w-full rounded-sm object-cover"
              data-ui="file-chip-image"
              decoding="async"
              src={src()}
            />
          )}
        </Show>
      </div>
      <p class="w-full truncate px-1 text-center text-[12px] leading-4 text-foreground/90">
        {props.name}
      </p>
      <p class="mt-0.5 w-full truncate pb-0.5 text-center text-[11px] leading-4 text-muted-foreground">
        {props.note}
      </p>
      <Show when={props.progress !== undefined}>
        <span
          aria-hidden="true"
          class="absolute inset-x-1 bottom-0.5 h-0.5 overflow-hidden rounded-full bg-border"
        >
          <span
            class="block h-full origin-left bg-brand transition-transform"
            style={{ transform: `scaleX(${props.progress})` }}
          />
        </span>
      </Show>
      {props.children}
    </div>
  )
}
